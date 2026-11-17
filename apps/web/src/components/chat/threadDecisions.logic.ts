import type {
  ThreadDecidedWithoutAsking,
  ThreadDecisionQuestion,
  ThreadDecisionsSnapshot,
  ThreadParkedItem,
} from "@t3tools/contracts";
import { closingFor, readReply } from "@t3tools/shared/sessionKit/decisions";

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

const YES_TO_ALL = "Yes to your picks: ";

/**
 * The one line "Yes to all" adds, as the transcript mod's `yesToAll` writes it: the latest reply's
 * questions that have a pick and that the draft does not already close, in order. None when no
 * question is left, so a second press adds nothing: the labels the line names are then in the draft.
 */
export const yesToAllLine = (
  questions: ReadonlyArray<ThreadDecisionQuestion>,
  inDraft: Readonly<Record<string, DraftChoice>>,
): string | null => {
  const labels = questions
    .filter((question) => question.pick !== "" && inDraft[question.label] === undefined)
    .map((question) => question.label);
  return labels.length === 0 ? null : `${YES_TO_ALL}${labels.join(", ")}`;
};

/** The option of a question's panel that the draft has chosen. */
export type DraftChoice = "accept" | "answer" | "drop";

/**
 * The open questions the draft would close if sent now (the server's closingFor), by label, with the
 * option that says how: their buttons add nothing more. "Go with your picks", which names no label, a
 * line that is exactly the Accept line, and a "Yes to all" line naming the label all accept.
 */
export const questionsClosedByDraft = (
  draft: string,
  snapshot: ThreadDecisionsSnapshot | null,
): Readonly<Record<string, DraftChoice>> => {
  const open = (snapshot?.questions ?? []).filter((question) => question.state === "open");
  if (draft.trim() === "" || open.length === 0) return {};
  const { answered, dropped } = closingFor(draft, open);
  const named = readReply(draft).answer;
  const lines = draft.split("\n").map((line) => line.trim());
  const yesToAll = new Set(
    lines.flatMap((line) =>
      line.startsWith(YES_TO_ALL)
        ? line
            .slice(YES_TO_ALL.length)
            .split(",")
            .map((label) => label.trim())
        : [],
    ),
  );
  const choices: Record<string, DraftChoice> = {};
  for (const label of dropped) choices[label] = "drop";
  for (const question of open) {
    if (!answered.includes(question.label)) continue;
    const accepted =
      !named.includes(question.label) ||
      (question.pick !== "" &&
        (lines.includes(decisionMessages.accept(question)) || yesToAll.has(question.label)));
    choices[question.label] = accepted ? "accept" : "answer";
  }
  return choices;
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
  groupByReply(
    (snapshot?.questions ?? []).filter((question) => question.state === "open"),
    (question) => ({ messageId: question.sourceMessageId, at: question.askedAt }),
  );

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
