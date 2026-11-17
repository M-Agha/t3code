// Fork-only decision tracking on top of the verbatim session-kit parser in ./reply.ts and judge in ./judge.ts.
import type { Question } from "../types/index.d.ts";
import { JUDGE_SYSTEM, judgePrompt, parseVerdict, scopeVerdict } from "./judge.ts";
import {
  type Asked,
  DECIDED_HEADING,
  labelMentions,
  Q_LINE,
  readReply,
  settles,
  trailingQuestions,
} from "./reply.ts";

export { JUDGE_SYSTEM, Q_LINE, readReply };

export interface QuestionParts {
  readonly keyWords: string;
  readonly question: string;
  readonly pick: string;
  readonly reason: string;
}

// The global rule's shape: `Q<n>, <key words>: <question> My pick is <pick>: <reason>`.
const SHAPED = /^Q\d+,\s*([^:]+?):\s+(.+?)\s+My pick is\s+(.+?):\s+(.+)$/is;
const LABEL_PREFIX = /^Q\d+[\s:,.)—–-]*/i;

export const splitQuestion = (text: string): QuestionParts => {
  const plain = text.replace(/\*\*/g, "").trim();
  const shaped = SHAPED.exec(plain);
  if (shaped !== null) {
    const [, keyWords = "", question = "", pick = "", reason = ""] = shaped;
    return { keyWords: keyWords.trim(), question: question.trim(), pick: pick.trim(), reason };
  }
  return { keyWords: "", question: plain.replace(LABEL_PREFIX, ""), pick: "", reason: "" };
};

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;

/** The bullets under a reply's last "Decided without asking" heading, before or after its Q-block. */
export const decidedWithoutAsking = (reply: string): string[] => {
  const lines = reply.replace(/\s+$/, "").split("\n");
  const at = lines.findLastIndex((line) => DECIDED_HEADING.test(line));
  if (at === -1) return [];
  const items: string[] = [];
  // The heading's own line may carry the first choice: "**Decided without asking:** x".
  const inline = lines[at]!.replace(DECIDED_HEADING, "")
    .replace(/^\**:?\**\s*\**\s*/, "")
    .trim();
  if (inline) items.push(inline);
  for (const line of lines.slice(at + 1)) {
    if (Q_LINE.test(line)) break;
    const bullet = BULLET.exec(line);
    if (bullet) {
      items.push(bullet[1]!.trim());
    } else if (/^\s+\S/.test(line) && items.length > 0) {
      items[items.length - 1] = `${items.at(-1)} ${line.trim()}`;
    } else if (line.trim() !== "") {
      break;
    }
  }
  return items.filter((item) => item !== "");
};

export interface ReplyDecisions {
  readonly questions: ReadonlyArray<Asked>;
  readonly decidedWithoutAsking: ReadonlyArray<string>;
}

export const readReplyDecisions = (reply: string): ReplyDecisions => ({
  questions: trailingQuestions(reply),
  decidedWithoutAsking: decidedWithoutAsking(reply),
});

export interface OpenQuestion {
  readonly label: string;
  readonly sourceMessageId: string;
  /** UTC ISO, which sorts as text. */
  readonly askedAt: string;
}

export interface Closing {
  readonly answered: ReadonlyArray<string>;
  readonly dropped: ReadonlyArray<string>;
}

/** Labels a user message closes: session-kit's `settles`, over this server's open-question rows. */
export const closingFor = (message: string, open: ReadonlyArray<OpenQuestion>): Closing => {
  const settled = settles(
    open.map((q) => ({ label: q.label, turn: q.sourceMessageId, at: q.askedAt })),
    readReply(message),
  );
  return {
    answered: settled.answered.map((q) => q.label),
    dropped: settled.dropped.map((q) => q.label),
  };
};

// A label or range at the start of a stretch, what may join two labels one answer covers, and what
// follows a label that opens its own answer.
const LEADING_LABEL = /^Q\d+(?:\s*(?:[-\u2013\u2014]|\bto\b|\bthrough\b)\s*Q\d+)?/i;
// Same-line only: a newline between two labels ends the first's answer, it does not join them.
const JOINER = /^[ \t,&/]*(?:\b(?:and|or)\b)?[ \t,&/]*$/i;
const OPENS_ANSWER = /^\s*:/;

/**
 * A label's answer: from where it opens one (`Q6: …`, else its first mention) to the next label that
 * opens its own; labels joined by "and" or commas on one line share it ("Q3 and Q4: yes"), and a cited
 * label ("Same as Q27") neither ends it nor starts its own. The whole message when it names no label.
 */
export const answerPart = (message: string, label: string): string => {
  const mentions = labelMentions(message);
  const after = (index: number) => message.slice(index).replace(LEADING_LABEL, "");
  const named = mentions.findIndex((mention) => mention.labels.includes(label));
  if (named === -1) return message.trim();
  const opening = mentions.findIndex(
    (mention) => mention.labels.includes(label) && OPENS_ANSWER.test(after(mention.index)),
  );
  const at = opening === -1 ? named : opening;
  let next = at + 1;
  for (; next < mentions.length; next += 1) {
    const between = message.slice(mentions[next - 1]!.index, mentions[next]!.index);
    if (JOINER.test(between.replace(LEADING_LABEL, ""))) continue;
    if (OPENS_ANSWER.test(after(mentions[next]!.index))) break;
  }
  return message.slice(mentions[at]!.index, mentions[next]?.index ?? message.length).trim();
};

/** An open question with its text, which the judge reads. */
export interface JudgedQuestion extends OpenQuestion {
  readonly text: string;
}

/** A row as session-kit's board holds one: key words apart, the question with its pick as the text. */
const boardQuestion = (row: JudgedQuestion, id: number): Question => {
  const parts = splitQuestion(row.text);
  return {
    id,
    label: row.label,
    keys: parts.keyWords,
    text:
      parts.pick === ""
        ? parts.question
        : `${parts.question} My pick is ${parts.pick}: ${parts.reason}`,
    turn: row.sourceMessageId,
    at: row.askedAt,
    state: "open",
  };
};

/** The judge's input, as the terminal builds it: the open questions, the last reply when known, the message. */
export const judgeInput = (
  open: ReadonlyArray<JudgedQuestion>,
  reply: string | undefined,
  message: string,
): string => judgePrompt(open.map(boardQuestion), reply, message);

/**
 * The judge's answer as a closing, narrowed as the terminal narrows it (`scopeVerdict` only removes
 * labels); undefined when the answer is not the asked JSON, and the caller falls back to `closingFor`.
 */
export const judgedClosing = (
  answer: string,
  open: ReadonlyArray<JudgedQuestion>,
  message: string,
  reply: string | undefined,
): Closing | undefined =>
  scopeVerdict(
    parseVerdict(
      answer,
      open.map((q) => q.label),
    ),
    open.map(boardQuestion),
    message,
    reply,
  );
