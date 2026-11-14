// Fork-only decision tracking on top of the verbatim session-kit parser in ./reply.ts.
import {
  type Asked,
  DECIDED_HEADING,
  Q_LINE,
  readReply,
  settles,
  trailingQuestions,
} from "./reply.ts";

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
