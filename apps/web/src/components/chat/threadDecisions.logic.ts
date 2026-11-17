import type {
  ThreadDecidedWithoutAsking,
  ThreadDecisionQuestion,
  ThreadDecisionsSnapshot,
  ThreadParkedItem,
} from "@t3tools/contracts";
import { answerPart, closingFor, readReply } from "@t3tools/shared/sessionKit/decisions";

/** The lines the decision buttons add to the composer; agents read them as ordinary replies. */
export const decisionMessages = {
  accept: (question: ThreadDecisionQuestion) => `${question.label}: ${question.pick}`,
  drop: (question: ThreadDecisionQuestion) => `${question.label}: not a decision`,
  answer: (question: ThreadDecisionQuestion) => `${question.label}: `,
  veto: (item: ThreadDecidedWithoutAsking) => `Veto: ${item.text}`,
};

/** `text` as the draft's next line, so answers chained in one message read one per line. */
export const asDraftLine = (draft: string, text: string) =>
  draft === "" || draft.endsWith("\n") ? text : `\n${text}`;

/** The option of a question's panel that the draft has chosen. */
export type DraftChoice = "accept" | "answer" | "drop";

/**
 * The lines one press adds for several questions, one per question as its own button writes it, in
 * order: the composer panel's "Yes to all", the Tracker's "Accept N picks" and Select mode's Add. A
 * question the draft already closes is skipped, and so is one with no pick for Accept; the lines
 * then close what they name, so a second press adds nothing.
 */
export const answerLines = (
  questions: ReadonlyArray<ThreadDecisionQuestion>,
  choice: "accept" | "drop",
  inDraft: Readonly<Record<string, DraftChoice>>,
): ReadonlyArray<string> =>
  questions
    .filter(
      (question) =>
        inDraft[question.label] === undefined && (choice === "drop" || question.pick !== ""),
    )
    .map(decisionMessages[choice]);

const trimmedLines = (text: string) => text.split("\n").map((line) => line.trim());

// An answer as compared with the pick: one line, any case, no trailing punctuation or spaces.
const comparable = (text: string) =>
  (text.split("\n")[0] ?? "")
    .toLowerCase()
    .replace(/[\s.!;,]+$/, "")
    .replace(/\s+/g, " ");

/**
 * Whether the message that answered `question` took the pick: its part's first line reads as the
 * Accept line ("Q6: Yes."), or, naming no label, it accepts the picks as a whole or repeats the pick.
 * Any other unlabelled answer the judge closed it with ("Use PostgreSQL instead") departed from it.
 */
export const acceptsPick = (message: string, question: ThreadDecisionQuestion) => {
  const reply = readReply(message);
  if (!reply.answer.includes(question.label)) {
    return (
      reply.turn === "answer" ||
      (question.pick !== "" && comparable(message) === comparable(question.pick))
    );
  }
  return (
    question.pick !== "" &&
    comparable(answerPart(message, question.label)) ===
      comparable(decisionMessages.accept(question))
  );
};

/**
 * The open questions the draft would close if sent now (the server's closingFor), by label, with the
 * option that says how: their buttons add nothing more. "Go with your picks", which names no label,
 * and a line that is exactly the Accept line accept.
 */
export const questionsClosedByDraft = (
  draft: string,
  snapshot: ThreadDecisionsSnapshot | null,
): Readonly<Record<string, DraftChoice>> => {
  const open = openQuestions(snapshot);
  if (draft.trim() === "" || open.length === 0) return {};
  const { answered, dropped } = closingFor(draft, open);
  const choices: Record<string, DraftChoice> = {};
  for (const label of dropped) choices[label] = "drop";
  for (const question of open) {
    if (!answered.includes(question.label)) continue;
    choices[question.label] = acceptsPick(draft, question) ? "accept" : "answer";
  }
  return choices;
};

export const openQuestions = (snapshot: ThreadDecisionsSnapshot | null) =>
  (snapshot?.questions ?? []).filter((question) => question.state === "open");

const closedBy = (line: string, open: ReadonlyArray<ThreadDecisionQuestion>) => {
  const { answered, dropped } = closingFor(line, open);
  return [...answered, ...dropped];
};

/** The draft line that closes a question; `own` when it is that question's line alone. */
export interface DraftLine {
  readonly line: string;
  readonly own: boolean;
}

/**
 * The draft line that closes `question` among the `open` ones: its own `Qn: …` line first, else the
 * first line that closes it with others or without naming it ("go with your picks"). None when only
 * lines read together close it.
 */
export const draftLineOf = (
  draft: string,
  question: ThreadDecisionQuestion,
  open: ReadonlyArray<ThreadDecisionQuestion>,
): DraftLine | null => {
  const closing = trimmedLines(draft).filter(
    (line) => line !== "" && closedBy(line, open).includes(question.label),
  );
  const own = closing.find(
    (line) =>
      line.toLowerCase().startsWith(`${question.label.toLowerCase()}:`) &&
      closedBy(line, open).length === 1,
  );
  if (own !== undefined) return { line: own, own: true };
  const [first] = closing;
  return first === undefined ? null : { line: first, own: false };
};

/** The draft without its first line that reads `line`, trimmed; unchanged when it has none. */
export const withoutLine = (draft: string, line: string) => {
  const lines = draft.split("\n");
  const at = lines.findIndex((candidate) => candidate.trim() === line);
  return at === -1 ? draft : lines.toSpliced(at, 1).join("\n");
};

/** Where the draft's first line that reads `line` ends, to put the caret there; none without one. */
export const lineEnd = (draft: string, line: string): number | null => {
  let start = 0;
  for (const candidate of draft.split("\n")) {
    if (candidate.trim() === line) return start + candidate.trimEnd().length;
    start += candidate.length + 1;
  }
  return null;
};

const VETO_PREFIX = "Veto: ";

export const vetoInDraft = (draft: string, item: ThreadDecidedWithoutAsking) =>
  trimmedLines(draft).includes(decisionMessages.veto(item));

/**
 * The Decisions tab's count: the choices the newest reply made without asking that are neither
 * vetoed in a sent message nor in the draft.
 */
export const choicesToReview = (snapshot: ThreadDecisionsSnapshot | null, draft: string) => {
  const items = snapshot?.decidedWithoutAsking ?? [];
  // Newest first, so the first item's reply is the newest with any.
  const newest = items[0]?.messageId;
  return items.filter(
    (item) => item.messageId === newest && !item.vetoed && !vetoInDraft(draft, item),
  ).length;
};

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

const BARE_LABEL = /^(Q\d+):$/i;

/**
 * Open questions whose line in the draft is only their label (Answer…'s `Qn: `) and whose answer
 * part has nothing after it either: the row reads In draft, but nothing answers them yet, so the
 * draft bar does not count them and will not send. An answer begun on the next line counts.
 */
export const unfinishedLabels = (draft: string, open: ReadonlyArray<ThreadDecisionQuestion>) => {
  const labels = new Set(open.map((question) => question.label));
  return [
    ...new Set(
      trimmedLines(draft).flatMap((line) => {
        const label = BARE_LABEL.exec(line)?.[1]?.toUpperCase();
        if (label === undefined || !labels.has(label)) return [];
        const rest = answerPart(draft, label)
          .replace(/^Q\d+\s*:/i, "")
          .trim();
        return rest === "" ? [label] : [];
      }),
    ),
  ];
};

/**
 * What the draft bar says the draft holds: the questions it answers (less unfinished ones), its veto
 * lines, the labels still waiting for an answer, and whether anything else is in it ("1 answer · 1
 * veto · Q5 unanswered + other text").
 */
export const draftSummary = (
  draft: string,
  open: ReadonlyArray<ThreadDecisionQuestion>,
  inDraft: Readonly<Record<string, DraftChoice>>,
) => {
  const lines = trimmedLines(draft).filter((line) => line !== "");
  const unfinished = unfinishedLabels(draft, open);
  const answers = Object.keys(inDraft).filter((label) => !unfinished.includes(label)).length;
  const vetoes = lines.filter((line) => line.startsWith(VETO_PREFIX)).length;
  const other = lines.some(
    (line) => !line.startsWith(VETO_PREFIX) && closedBy(line, open).length === 0,
  );
  const parts = [
    ...(answers > 0 ? [plural(answers, "answer")] : []),
    ...(vetoes > 0 ? [plural(vetoes, "veto", "vetoes")] : []),
    ...(unfinished.length > 0 ? [`${unfinished.join(", ")} unanswered`] : []),
  ];
  if (parts.length === 0) return "text";
  return `${parts.join(" · ")}${other ? " + other text" : ""}`;
};

/** A reply group's checkbox in Select mode, over the questions that can be selected. */
export const groupSelection = (
  selectable: ReadonlyArray<string>,
  selected: ReadonlySet<string>,
): boolean | "mixed" => {
  const count = selectable.filter((label) => selected.has(label)).length;
  return count === 0 ? false : count === selectable.length ? true : "mixed";
};

/**
 * The question to show after `from` was answered: the next one the draft does not close, wrapping
 * to the start; none when the draft closes them all.
 */
export const nextUndrafted = (
  labels: ReadonlyArray<string>,
  from: string,
  inDraft: Readonly<Record<string, DraftChoice>>,
): string | undefined => {
  const at = labels.indexOf(from);
  return [...labels.slice(at + 1), ...labels.slice(0, Math.max(at, 0))].find(
    (label) => inDraft[label] === undefined,
  );
};

export interface ReplyGroup<Item> {
  readonly messageId: string;
  readonly at: string;
  readonly items: ReadonlyArray<Item>;
}

// Snapshots arrive newest reply first, so grouping in order keeps that order.
const groupByReply = <Item>(
  items: ReadonlyArray<Item>,
  key: (item: Item) => { readonly messageId: string; readonly at: string },
): ReadonlyArray<ReplyGroup<Item>> => {
  const groups = new Map<string, { messageId: string; at: string; items: Item[] }>();
  for (const item of items) {
    const { messageId, at } = key(item);
    const group = groups.get(messageId) ?? { messageId, at, items: [] };
    group.items.push(item);
    groups.set(messageId, group);
  }
  return [...groups.values()];
};

export const openQuestionsByReply = (snapshot: ThreadDecisionsSnapshot | null) =>
  groupByReply(openQuestions(snapshot), (question) => ({
    messageId: question.sourceMessageId,
    at: question.askedAt,
  }));

/**
 * The open questions of the reply that asked the newest open one, which "go with your picks" settles
 * (closingFor); earlier open ones live in the panel.
 */
export const latestReplyOpenQuestions = (
  snapshot: ThreadDecisionsSnapshot | null,
): ReadonlyArray<ThreadDecisionQuestion> => {
  const newest = snapshot?.questions.find((question) => question.state === "open")?.sourceMessageId;
  return (snapshot?.questions ?? []).filter(
    (question) => question.sourceMessageId === newest && question.state === "open",
  );
};

export const resolvedQuestions = (snapshot: ThreadDecisionsSnapshot | null) =>
  (snapshot?.questions ?? [])
    .filter((question) => question.state !== "open")
    .toSorted((left, right) => (right.resolvedAt ?? "").localeCompare(left.resolvedAt ?? ""));

export const decidedWithoutAskingByReply = (snapshot: ThreadDecisionsSnapshot | null) =>
  groupByReply(snapshot?.decidedWithoutAsking ?? [], (item) => ({
    messageId: item.messageId,
    at: item.createdAt,
  }));

const ARIA_TEXT_MAX_LENGTH = 80;

/** An item's text short enough to read out as part of a button's name. */
export const ariaItemText = (text: string) =>
  text.length <= ARIA_TEXT_MAX_LENGTH ? text : `${text.slice(0, ARIA_TEXT_MAX_LENGTH - 1)}…`;

/**
 * Parked items with an action in flight, keyed by id, holding the `updatedAt` they had then.
 * A successful action stays recorded, so the item stays busy until the snapshot shows its result.
 */
export type ParkedBusy = ReadonlyMap<number, string>;

export const isParkedBusy = (busy: ParkedBusy, item: ThreadParkedItem) =>
  busy.get(item.id) === item.updatedAt;

/** The open item to focus once `leavingId` leaves the list: the next one, else the one before. */
export const parkedFocusAfter = (
  openIds: ReadonlyArray<number>,
  leavingId: number,
): number | null => {
  const index = openIds.indexOf(leavingId);
  if (index === -1) return null;
  return openIds[index + 1] ?? openIds[index - 1] ?? null;
};
