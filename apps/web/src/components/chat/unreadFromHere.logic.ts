// Fork (Mark unread from here). FORK.md, "Mark unread from here".
import type { ThreadRunSummary } from "@t3tools/client-runtime/state/shell";

import type { TimelineEntry } from "../../session-logic";
import { hasUnseenCompletion } from "../Sidebar.logic";
import {
  type MessagesTimelineRow,
  type TimelineLatestRun,
  timelineEntryRunId,
} from "./MessagesTimeline.logic";

/**
 * The time the local path marks unread from, as the server: the message's, unless the latest run
 * ended earlier; the latest run's end without a message; none without a completed latest run, so
 * the local path refuses as the server does.
 */
export const earlierTime = (
  from: string | undefined,
  completedAt: string | null | undefined,
): string | null | undefined =>
  completedAt == null || from === undefined || Date.parse(completedAt) < Date.parse(from)
    ? completedAt
    : from;

type MessageEntry = Extract<TimelineEntry, { kind: "message" }>;

const isAgentMessage = (entry: TimelineEntry): entry is MessageEntry =>
  entry.kind === "message" && entry.message.role === "assistant";

/** A run that has not ended: the server refuses a mark then, and the opening does not jump. */
export const runUnderWay = (latestRun: Pick<ThreadRunSummary, "completedAt"> | null): boolean =>
  latestRun !== null && latestRun.completedAt === null;

/**
 * The first agent message started after the watermark; with none, a latest run ended after it
 * is unread from its reply's start at the menu's mark (its end less 1 ms), else from the message
 * being written at the watermark in any run, or from the run's first entry the rows can place.
 */
export const firstUnreadEntryId = (
  entries: ReadonlyArray<TimelineEntry>,
  rows: ReadonlyArray<MessagesTimelineRow>,
  since: string,
  latestRun: TimelineLatestRun | null,
): string | null => {
  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) return null;
  const started = entries.find(
    (entry) => isAgentMessage(entry) && Date.parse(entry.message.createdAt) > sinceMs,
  );
  if (started !== undefined) return started.id;
  if (latestRun === null || !hasUnseenCompletion({ latestRun, lastVisitedAt: since })) return null;
  const menuMark =
    latestRun.completedAt !== null && Date.parse(latestRun.completedAt) - 1 === sinceMs;
  // None started after the watermark, so one updated after it was being written at it; one
  // written before it (updatedAt is createdAt for a message written at once) was read.
  const unread = menuMark
    ? entries.find((entry) => isAgentMessage(entry) && entry.message.runId === latestRun.runId)
    : entries.findLast(
        (entry) => isAgentMessage(entry) && Date.parse(entry.message.updatedAt) > sinceMs,
      );
  return (
    unread?.id ??
    // A work group upstream draws no row for (nothing visible in it) cannot hold the divider.
    entries.find(
      (entry) =>
        timelineEntryRunId(entry) === latestRun.runId &&
        rowHoldingEntry(entries, rows, entry.id) !== null,
    )?.id ??
    null
  );
};

/**
 * The visible row holding an entry: its own row (a tool group's row is its first entry's id
 * after upstream's work-toggle: or work-live: prefix), or the turn or superseded-attempt fold
 * that hides it (the innermost one shown). Read on every render, so collapsing the turn moves
 * the divider to its fold.
 */
export const rowHoldingEntry = (
  entries: ReadonlyArray<TimelineEntry>,
  rows: ReadonlyArray<MessagesTimelineRow>,
  entryId: string,
): string | null => {
  const ownIds = [entryId, `work-toggle:${entryId}`, `work-live:${entryId}`];
  const own = rows.find((row) => ownIds.includes(row.id));
  if (own !== undefined) return own.id;
  const entry = entries.find((candidate) => candidate.id === entryId);
  const runId = entry === undefined ? null : timelineEntryRunId(entry);
  if (entry === undefined || runId === null) return null;
  const createdMs = Date.parse(entry.createdAt);
  const fold = rows.findLast(
    (row) =>
      (row.kind === "turn-fold" || row.kind === "attempt-fold") &&
      (row.runId === runId || row.runId.startsWith(`${runId}:steer:`)) &&
      Date.parse(row.createdAt) <= createdMs,
  );
  return fold?.id ?? null;
};

/** The watermark a thread had when it was opened, for that thread. */
export interface UnreadMarker {
  readonly threadKey: string;
  /** Null when the thread had never been visited (nothing reads as unread then). */
  readonly since: string | null;
  /** The watermark last seen, so a rewind can be told from the visit moving it forward. */
  readonly last: string | null;
}

/**
 * Captures the watermark when the open thread's shell is there, before the visit's echo moves it
 * forward; a null waits for the detail (a stand-in shell from a cached detail has none yet). A
 * rewind while open (either Mark unread) moves the marker; the visit moving it forward never does.
 */
export const nextUnreadMarker = (
  current: UnreadMarker | null,
  threadKey: string | null,
  shellLoaded: boolean,
  detailLoaded: boolean,
  lastVisitedAt: string | undefined,
): UnreadMarker | null => {
  const last = lastVisitedAt ?? null;
  if (threadKey === null) return null;
  if (current?.threadKey !== threadKey) {
    return shellLoaded && (last !== null || detailLoaded) ? { threadKey, since: last, last } : null;
  }
  if (last === current.last) return current;
  if (last !== null && current.last !== null && Date.parse(last) < Date.parse(current.last)) {
    return { threadKey, since: last, last };
  }
  return { ...current, last };
};

/** One opening of a thread in the timeline, and its first unread entry. */
export interface UnreadDivider {
  readonly identity: string;
  /** Counts openings, so a jump done for one never stands for the next. */
  readonly openId: number;
  /** The marker this was decided from; undefined until the thread's marker is captured. */
  readonly since: string | null | undefined;
  /** The first unread entry's id; undefined until decided, null for no divider. */
  readonly entryId: string | null | undefined;
  /** The opening's first decision found a divider with no run under way, so the list jumps once. */
  readonly jump: boolean;
  readonly decided: boolean;
}

/**
 * Decides once per marker, when the rows have settled and loaded history reaches the watermark;
 * later messages never move it. Only the opening's first decision jumps, and not while the latest
 * run is under way (its visits are throttled, so the marker may be stale, and the user watches the
 * live end). A rewind while open moves the divider without scrolling.
 */
export const nextUnreadDivider = (
  current: UnreadDivider | null,
  input: {
    readonly identity: string;
    readonly marker: Pick<UnreadMarker, "threadKey" | "since"> | null;
    readonly entries: ReadonlyArray<TimelineEntry>;
    readonly rows: ReadonlyArray<MessagesTimelineRow>;
    readonly syncing: boolean;
    readonly hasMoreHistory: boolean;
    readonly latestRun: TimelineLatestRun | null;
  },
): UnreadDivider => {
  const since = input.marker?.threadKey === input.identity ? input.marker.since : undefined;
  let next: UnreadDivider =
    current?.identity === input.identity
      ? current
      : {
          identity: input.identity,
          openId: (current?.openId ?? 0) + 1,
          since: undefined,
          entryId: undefined,
          jump: false,
          decided: false,
        };
  if (since !== next.since) next = { ...next, since, entryId: undefined };
  if (
    next.entryId !== undefined ||
    since === undefined ||
    input.rows.length === 0 ||
    input.syncing
  ) {
    return next;
  }
  if (since === null) return { ...next, entryId: null, jump: false, decided: true };
  const firstAt = input.entries[0]?.createdAt;
  const historyReaches =
    !input.hasMoreHistory || (firstAt !== undefined && Date.parse(firstAt) <= Date.parse(since));
  if (!historyReaches) return next;
  const entryId = firstUnreadEntryId(input.entries, input.rows, since, input.latestRun);
  return {
    ...next,
    entryId,
    jump: !next.decided && entryId !== null && !runUnderWay(input.latestRun),
    decided: true,
  };
};
