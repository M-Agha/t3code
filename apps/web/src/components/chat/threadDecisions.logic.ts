import {
  ENDED_RUN_STATUSES,
  type ParkedContextRecord,
  type ThreadArtifact,
  type ThreadDecidedWithoutAsking,
  type ThreadDecisionQuestion,
  type ThreadDecisionsSnapshot,
  type ThreadParkedItem,
  type ThreadParkedKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { parkKind } from "@t3tools/shared/sessionKit/parks";
import { answerPart, closingFor, readReply } from "@t3tools/shared/sessionKit/decisions";

import type { ComposerThreadDraftState } from "../../composerDraftStore";
import { buildDocJson } from "../../composer-rich-text-doc";
import { collectInlineContextIds } from "../../lib/composerContextReferences";

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

/** `draftSummary` of a draft with no Tracker line in it. */
export const DRAFT_PLAIN_TEXT = "text";

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
  if (parts.length === 0) return DRAFT_PLAIN_TEXT;
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

/** Who sent a message, as the server's `userAuthored` reads it (ThreadDecisions.ts). */
interface Authorship {
  readonly runId: string | null;
  readonly createdBy?: string | undefined;
  readonly idleCompaction?: unknown;
  readonly senderThreadId?: unknown;
  readonly scheduledTaskId?: unknown;
  readonly linkedSender?: unknown;
  readonly delegatedCompletion?: unknown;
  readonly notification?: unknown;
}

/** A projected or optimistic message (an optimistic one has no `createdBy` yet: the composer's own). */
export interface HoldMessage extends Authorship {
  readonly id: string;
  readonly role: string;
}

/** A timeline turn item; only `user_message` and `assistant_message` items carry a message. */
export interface HoldTurnItem {
  readonly item: Authorship & { readonly type: string; readonly messageId?: string };
}

const typedByUser = (message: Authorship) =>
  (message.createdBy === undefined || message.createdBy === "user") &&
  message.idleCompaction === undefined &&
  message.senderThreadId === undefined &&
  message.scheduledTaskId === undefined &&
  message.linkedSender === undefined &&
  message.delegatedCompletion === undefined &&
  message.notification === undefined;

/**
 * True while open questions are held back: the user's newest typed message (an unsent one, else the
 * newest in the server's order of those queued outside the timeline and the timeline's last) is neither
 * read by the server nor done. Read: the snapshot's `lastTypedMessageRead`, the newest typed message the
 * server has read in that same order, names it. FORK.md, "Hidden while a send is judged".
 */
export const questionsHeld = (input: {
  readonly snapshot: ThreadDecisionsSnapshot | null;
  /** The timeline's turn items, in order. */
  readonly timeline: ReadonlyArray<HoldTurnItem>;
  /** The projection's messages, which may be partial, with the server's times. */
  readonly projected: ReadonlyArray<HoldMessage & { readonly createdAt: DateTime.Utc }>;
  readonly optimistic: ReadonlyArray<HoldMessage>;
  readonly runs: ReadonlyArray<{ readonly id: string; readonly status: string }>;
}) => {
  const { snapshot } = input;
  if (snapshot === null || snapshot.openCount === 0) return false;
  const inTimeline = new Set(
    input.timeline.flatMap(({ item }) => (item.messageId === undefined ? [] : [item.messageId])),
  );
  const typed = (message: HoldMessage) => message.role === "user" && typedByUser(message);
  const timelineSent = input.timeline.findLast(
    ({ item }) => item.type === "user_message" && typedByUser(item),
  )?.item;
  // The server's (created_at, message_id) order: a steer typed after a queued message is newer, though
  // the queued one is outside the timeline. The timeline's message can lack a projected time; it then
  // counts as newest, so the hold waits for it rather than lifting on an older message.
  const timelineAt = input.projected.find((message) => message.id === timelineSent?.messageId);
  const candidates = [
    ...input.projected
      .filter((message) => typed(message) && !inTimeline.has(message.id))
      .map((message) => ({ ...message, at: DateTime.toEpochMillis(message.createdAt) })),
    ...(timelineSent?.messageId === undefined
      ? []
      : [
          {
            id: timelineSent.messageId,
            runId: timelineSent.runId,
            at: timelineAt === undefined ? Infinity : DateTime.toEpochMillis(timelineAt.createdAt),
          },
        ]),
  ];
  const sent =
    input.optimistic.findLast(typed) ??
    candidates.toSorted((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).at(-1);
  if (sent === undefined) return false;
  const status = input.runs.find((run) => run.id === sent.runId)?.status;
  if (status !== undefined && ENDED_RUN_STATUSES.has(status)) return false;
  return snapshot.lastTypedMessageRead !== sent.id;
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

/** A parked item with its kind read (the snapshot carries a kind word: `ThreadParkedItem`'s `kind`). */
export type ParkedItem = Omit<ThreadParkedItem, "kind"> & { readonly kind: ThreadParkedKind };

/** The snapshot's items, each kind word read through session-kit's `parkKind`; any other, the person's. */
export const readParked = (items: ReadonlyArray<ThreadParkedItem>): ReadonlyArray<ParkedItem> =>
  items.map((item) => ({ ...item, kind: parkKind(item.kind) ?? "me" }));

export type ParkedGroup = "open" | "resolved";

export const parkedGroupOf = (item: ThreadParkedItem | ParkedItem): ParkedGroup =>
  item.state === "open" ? "open" : "resolved";

/**
 * The Parked surface's groups, each in the snapshot's order. A row being edited stays in the group it
 * was in (`pin`), in its place by when it was parked, so a send recorded meanwhile (it turns Sent)
 * neither remounts nor hides its editor.
 */
export const parkedGroups = <Item extends ThreadParkedItem | ParkedItem>(
  parked: ReadonlyArray<Item>,
  pin: { readonly id: number; readonly group: ParkedGroup } | null = null,
) => {
  const groupOf = (item: Item) => (item.id === pin?.id ? pin.group : parkedGroupOf(item));
  const placed = (group: ParkedGroup) => {
    const items = parked.filter((item) => groupOf(item) === group);
    const pinned = items.find((item) => item.id === pin?.id);
    if (pinned === undefined || parkedGroupOf(pinned) === group) return items;
    // Open lists oldest first: the pinned row goes back where it stood.
    const others = items.filter((item) => item !== pinned);
    const at = others.findIndex((item) => item.createdAt > pinned.createdAt);
    return at === -1 ? [...others, pinned] : others.toSpliced(at, 0, pinned);
  };
  return { open: placed("open"), resolved: placed("resolved") };
};

/**
 * The parked items a composer draft holds as chips (Add to draft): the records whose chips its text
 * still references, as a send would carry them. In draft is read from here, never stored.
 */
export const parkedIdsInDraft = (
  draft: Pick<ComposerThreadDraftState, "prompt" | "parkedContexts"> | null | undefined,
): ReadonlyArray<number> => {
  if (draft == null || draft.parkedContexts.length === 0) return [];
  const referenced = new Set(collectInlineContextIds(draft.prompt));
  return draft.parkedContexts
    .filter((record) => referenced.has(record.contextId))
    .map((record) => record.payload.itemId);
};

/**
 * Whether an undo or redo may bring back a parked chip the draft lost (its record retained by the
 * composer): only while its item is still open for the agent with the words the chip holds. In a
 * queued message's edit, whose chips' items that message Sent, a Sent item with the same words counts
 * too. Otherwise the chip stays out, since nothing rewrites a draft's chips (FORK.md, "Parked items").
 */
export const parkedChipRestorable = (
  record: ParkedContextRecord,
  items: ReadonlyArray<ParkedItem>,
  editingQueuedRun: boolean,
): boolean =>
  items.some(
    (item) =>
      item.id === record.payload.itemId &&
      (item.state === "open" || (editingQueuedRun && item.state === "sent")) &&
      item.kind === "agent" &&
      item.text === record.payload.text,
  );

/**
 * Whether `prompt` ends on a line closing a fenced code block, as the composer's document builder reads
 * it: a chip appended after a space there would join the fence line and reopen the block (Sol round 3,
 * S4), so Add to draft puts it on a line of its own.
 */
export const endsAtClosingFence = (prompt: string): boolean => {
  const last = buildDocJson(prompt, () => null, { styling: true }).content.at(-1);
  const attrs = last?.type === "codeBlock" ? last.attrs : null;
  // An unclosed block has `close: ""`: its fence line is still to come.
  return typeof attrs === "object" && attrs !== null && "close" in attrs && attrs.close !== "";
};

/** Where an item stands; null for a plain open item. ThreadParked.tsx words it. */
export type ParkedStatus = "draft" | "done" | "dropped" | "sent";

export const parkedStatus = (item: ThreadParkedItem, inDraft: boolean): ParkedStatus | null => {
  switch (item.state) {
    case "open":
      return inDraft ? "draft" : null;
    case "done":
    case "dropped":
    case "sent":
      return item.state;
  }
};

/** The time at a row's right: when it was parked, or resolved (Sent: when its message was sent). */
export const parkedTime = (item: ThreadParkedItem) =>
  item.state === "open" ? item.createdAt : (item.resolvedAt ?? item.updatedAt);

/**
 * The row to focus once `leaving` leaves a list (Parked's open items, Artifacts' rows): in `order`, the
 * rows as they showed when the user acted, the next one still `shown`, else the nearest before it.
 * A neighbour another client took out meanwhile is passed over.
 */
export const rowFocusAfter = <Id>(
  order: ReadonlyArray<Id>,
  leaving: Id,
  shown: ReadonlyArray<Id>,
): Id | null => {
  const index = order.indexOf(leaving);
  if (index === -1) return null;
  const still = (id: Id) => shown.includes(id);
  return order.slice(index + 1).find(still) ?? order.slice(0, index).reverse().find(still) ?? null;
};

/** The neighbour that takes focus when `leaving` goes and the rest of `order` stays. */
export const neighbourOf = <Id>(order: ReadonlyArray<Id>, leaving: Id) =>
  rowFocusAfter(
    order,
    leaving,
    order.filter((id) => id !== leaving),
  );

/**
 * The Artifacts surface's groups, each in the snapshot's order (latest first). Not found comes first
 * of the three tests: a published artifact a read could not find is listed there, not as published.
 */
export const artifactGroups = (artifacts: ReadonlyArray<ThreadArtifact>) => ({
  published: artifacts.filter(
    (artifact) => artifact.notFoundAt === null && !artifact.mentionedOnly,
  ),
  linked: artifacts.filter((artifact) => artifact.notFoundAt === null && artifact.mentionedOnly),
  notFound: artifacts.filter((artifact) => artifact.notFoundAt !== null),
});
