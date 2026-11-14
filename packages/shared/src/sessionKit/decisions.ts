// Fork-only decision tracking on top of the verbatim session-kit parser in ./reply.ts.
import { readReply, trailingQuestions } from "./reply.ts";

export interface AskedQuestion {
  readonly label: string;
  readonly text: string;
}

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

// Same heading and Q-line patterns as reply.ts, which keeps them private.
const DECIDED_HEADING = /^\s*(?:#+\s*)?\**Decided without asking\b\**:?\**\s*(.*)$/i;
const Q_LINE = /^\s*(?:[-*]\s+|\d+\.\s+)?(?:\*\*)?Q\d+(?=\**[\s:,.)—–-]|$)/;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;

/** The bullets under a reply's last "Decided without asking" heading, before or after its Q-block. */
export const decidedWithoutAsking = (reply: string): string[] => {
  const lines = reply.replace(/\s+$/, "").split("\n");
  const at = lines.findLastIndex((line) => DECIDED_HEADING.test(line));
  if (at === -1) return [];
  const items: string[] = [];
  const inline = DECIDED_HEADING.exec(lines[at] ?? "")?.[1]
    ?.replace(/^\**\s*/, "")
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
  readonly questions: ReadonlyArray<AskedQuestion>;
  readonly decidedWithoutAsking: ReadonlyArray<string>;
}

// "Q6, Q7 and Q8 are still open." or "Q4 (the 19 rows), Q6 …" names labels; trailingQuestions reads
// it as asking the first.
const LISTS_LABELS = /^Q\d+\**(?:\s*\([^)]*\))?[\s,]+(?:and\s+)?Q\d+\b/i;

export const readReplyDecisions = (reply: string): ReplyDecisions => ({
  questions: trailingQuestions(reply).filter(
    (question) => !LISTS_LABELS.test(question.text.replace(/\*\*/g, "")),
  ),
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

/**
 * Labels a user message closes, as session-kit's board-file.ts `closes` reads readReply: "your picks"
 * and a bare "not a decision" settle the rest of the newest reply with a question still open.
 */
export const closingFor = (message: string, open: ReadonlyArray<OpenQuestion>): Closing => {
  const reply = readReply(message);
  const openLabels = new Set(open.map((question) => question.label));
  const dropped = reply.drop.filter((label) => openLabels.has(label));
  const answered = reply.answer.filter((label) => openLabels.has(label));
  const newest = open.reduce<OpenQuestion | undefined>(
    (best, question) => (best === undefined || question.askedAt >= best.askedAt ? question : best),
    undefined,
  );
  const settled = new Set([...dropped, ...answered]);
  const rest =
    reply.turn === null || newest === undefined
      ? []
      : open
          .filter((q) => q.sourceMessageId === newest.sourceMessageId && !settled.has(q.label))
          .map((q) => q.label);
  return {
    answered: reply.turn === "answer" ? [...answered, ...rest] : answered,
    dropped: reply.turn === "drop" ? [...dropped, ...rest] : dropped,
  };
};
