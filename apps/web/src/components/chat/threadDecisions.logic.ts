import type {
  ThreadDecidedWithoutAsking,
  ThreadDecisionQuestion,
  ThreadDecisionsSnapshot,
  ThreadParkedItem,
} from "@t3tools/contracts";

/** The messages the decision buttons send or prefill; agents read them as ordinary replies. */
export const decisionMessages = {
  accept: (question: ThreadDecisionQuestion) => `${question.label}: ${question.pick}`,
  drop: (question: ThreadDecisionQuestion) => `${question.label}: not a decision`,
  answer: (question: ThreadDecisionQuestion) => `${question.label}: `,
  veto: (item: ThreadDecidedWithoutAsking) => `Veto: ${item.text}`,
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
