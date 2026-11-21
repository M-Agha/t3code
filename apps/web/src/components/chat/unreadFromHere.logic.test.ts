// Fork (Mark unread from here). FORK.md, "Mark unread from here".
import { MessageId, RunAttemptId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import {
  deriveMessagesTimelineRows,
  type MessagesTimelineRow,
  type TimelineLatestRun,
} from "./MessagesTimeline.logic";
import {
  earlierTime,
  firstUnreadEntryId,
  nextUnreadDivider,
  nextUnreadMarker,
  rowHoldingEntry,
  type UnreadDivider,
} from "./unreadFromHere.logic";

const at = (second: number) => `2026-11-21T10:00:${String(second).padStart(2, "0")}.000Z`;
const lessOneMs = (time: string) => new Date(Date.parse(time) - 1).toISOString();

const chatMessage = (
  id: string,
  role: "user" | "assistant",
  second: number,
  run: string,
  updatedSecond = second,
) => ({
  id: MessageId.make(id),
  role,
  text: id,
  runId: RunId.make(run),
  createdAt: at(second),
  updatedAt: at(updatedSecond),
  streaming: false,
});

/** A message; `updatedSecond` is when its writing ended (its start for one written at once). */
const entry = (
  id: string,
  role: "user" | "assistant",
  second: number,
  run: string,
  updatedSecond = second,
) =>
  ({
    kind: "message",
    id,
    createdAt: at(second),
    message: chatMessage(id, role, second, run, updatedSecond),
  }) satisfies TimelineEntry;

const messageRow = (id: string, role: "user" | "assistant", second: number, run: string) =>
  ({
    kind: "message",
    id,
    createdAt: at(second),
    message: chatMessage(id, role, second, run),
    showAssistantMeta: role === "assistant",
    showAssistantCopyButton: role === "assistant",
    assistantCopyStreaming: false,
  }) satisfies MessagesTimelineRow;

const fold = (run: string, second: number) =>
  ({
    kind: "turn-fold",
    id: `turn-fold:${run}`,
    createdAt: at(second),
    runId: RunId.make(run),
    label: "Worked",
    expanded: false,
  }) satisfies MessagesTimelineRow;

/** An error, drawn as its own row. */
const work = (id: string, second: number, run: string) =>
  ({
    kind: "work",
    id,
    createdAt: at(second),
    entry: { id, createdAt: at(second), label: "Failed", tone: "error", runId: RunId.make(run) },
  }) satisfies TimelineEntry;

/** Reasoning with nothing to show: upstream draws no row for its group. */
const emptyReasoning = (id: string, second: number, run: string) =>
  ({
    kind: "work",
    id,
    createdAt: at(second),
    entry: {
      id,
      createdAt: at(second),
      label: "Thinking",
      tone: "info",
      itemType: "reasoning",
      runId: RunId.make(run),
    },
  }) satisfies TimelineEntry;

const command = (id: string, second: number, run: string) =>
  ({
    kind: "work",
    id,
    createdAt: at(second),
    entry: {
      id,
      createdAt: at(second),
      label: "Ran command",
      tone: "tool",
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
      runId: RunId.make(run),
    },
  }) satisfies TimelineEntry;

/** The rows upstream draws, so a change to its row ids turns these tests red. */
const upstreamRows = (
  timelineEntries: ReadonlyArray<TimelineEntry>,
  latestRun: TimelineLatestRun,
  options: Partial<Parameters<typeof deriveMessagesTimelineRows>[0]> = {},
) =>
  deriveMessagesTimelineRows({
    timelineEntries,
    latestRun,
    isWorking: false,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    ...options,
  });

const run = (
  id: string,
  completedSecond: number | null,
  status: TimelineLatestRun["status"] = "completed",
) =>
  ({
    runId: RunId.make(id),
    status: completedSecond === null ? "running" : status,
    startedAt: at(0),
    completedAt: completedSecond === null ? null : at(completedSecond),
  }) satisfies TimelineLatestRun;

// Run 2 is a finished turn whose first message a2 is folded under its "Worked" row.
const ENTRIES: ReadonlyArray<TimelineEntry> = [
  entry("u1", "user", 1, "run-1"),
  entry("a1", "assistant", 2, "run-1"),
  entry("u2", "user", 3, "run-2"),
  entry("a2", "assistant", 4, "run-2"),
  // Written from 5 s until the run ended at 6 s.
  entry("a3", "assistant", 5, "run-2", 6),
];
const ROWS: ReadonlyArray<MessagesTimelineRow> = [
  messageRow("u1", "user", 1, "run-1"),
  messageRow("a1", "assistant", 2, "run-1"),
  messageRow("u2", "user", 3, "run-2"),
  fold("run-2", 3),
  messageRow("a3", "assistant", 5, "run-2"),
];
const RUN_2 = run("run-2", 6);

describe("earlierTime", () => {
  it("is the message's time, unless the latest run ended earlier, as the server clamps", () => {
    expect(earlierTime(at(4), at(6))).toBe(at(4));
    expect(earlierTime(at(9), at(6))).toBe(at(6));
    expect(earlierTime(undefined, at(6))).toBe(at(6));
  });

  it("is none without a completed latest run, so the local path refuses as the server does", () => {
    expect(earlierTime(at(4), null)).toBeNull();
    expect(earlierTime(at(4), undefined)).toBeUndefined();
  });
});

describe("firstUnreadEntryId", () => {
  it("is the first agent message started after the watermark, skipping the user's", () => {
    expect(firstUnreadEntryId(ENTRIES, ROWS, lessOneMs(at(2)), RUN_2)).toBe("a1");
    expect(firstUnreadEntryId(ENTRIES, ROWS, at(4), RUN_2)).toBe("a3");
  });

  it("is the start of the latest run's reply after the thread menu's Mark unread", () => {
    // The menu rewinds to just before the run's end, after all its messages started.
    expect(firstUnreadEntryId(ENTRIES, ROWS, lessOneMs(at(6)), RUN_2)).toBe("a2");
    // As the sidebar: an interrupted run does not read unread.
    expect(
      firstUnreadEntryId(ENTRIES, ROWS, lessOneMs(at(6)), run("run-2", 6, "interrupted")),
    ).toBe(null);
  });

  it("is the message being written at any other watermark the run ended after", () => {
    // A visit while a3 was being written: a3 is the one left unread, not the whole reply.
    expect(firstUnreadEntryId(ENTRIES, ROWS, "2026-11-21T10:00:05.500Z", RUN_2)).toBe("a3");
  });

  it("is an earlier run's message being written at the watermark, when the latest wrote none", () => {
    const failedRun = run("run-3", 9, "failed");
    const failed = [...ENTRIES, entry("u3", "user", 7, "run-3"), work("e3", 8, "run-3")];
    const rows = upstreamRows(failed, failedRun);
    expect(firstUnreadEntryId(failed, rows, "2026-11-21T10:00:05.500Z", failedRun)).toBe("a3");
    // Visited after a3 was written: nothing above the latest run's error is unread.
    expect(firstUnreadEntryId(failed, rows, "2026-11-21T10:00:06.500Z", failedRun)).toBe("e3");
  });

  it("is the latest run's first entry with a row, when it wrote no agent message", () => {
    // Zen view: no folds, and the empty reasoning's group has no row to hold the divider.
    const thought = [
      ...ENTRIES,
      entry("u3", "user", 7, "run-3"),
      emptyReasoning("r3", 8, "run-3"),
      work("e3", 9, "run-3"),
    ];
    const run3 = run("run-3", 10);
    const rows = upstreamRows(thought, run3, { toolCallVisibility: "zen" });
    expect(rows.map((row) => row.id)).not.toContain("r3");
    expect(firstUnreadEntryId(thought, rows, at(6), run3)).toBe("e3");
  });

  it("is none when every agent message and the latest run were read", () => {
    expect(firstUnreadEntryId(ENTRIES, ROWS, at(6), RUN_2)).toBeNull();
    expect(firstUnreadEntryId(ENTRIES, ROWS, at(5), run("run-2", null))).toBeNull();
  });
});

describe("rowHoldingEntry", () => {
  it("is the message's own row, or the turn fold that hides it", () => {
    expect(rowHoldingEntry(ENTRIES, ROWS, "a3")).toBe("a3");
    expect(rowHoldingEntry(ENTRIES, ROWS, "a2")).toBe("turn-fold:run-2");
  });

  it("is the row of the tool group an entry starts, as upstream names it", () => {
    const run3 = run("run-3", 10);
    const tools = [
      ...ENTRIES,
      entry("u3", "user", 7, "run-3"),
      command("t1", 8, "run-3"),
      command("t2", 9, "run-3"),
    ];
    const rows = upstreamRows(tools, run3, { expandedRunIds: new Set([run3.runId]) });
    expect(rowHoldingEntry(tools, rows, "t1")).toBe("work-toggle:t1");
  });

  it("follows the user collapsing the turn, and finds a superseded attempt's fold", () => {
    const collapsed = ROWS.filter((row) => row.id !== "a3");
    expect(rowHoldingEntry(ENTRIES, collapsed, "a3")).toBe("turn-fold:run-2");
    // The turn is open; a2 belongs to a superseded attempt folded inside it.
    const attemptFold = {
      kind: "attempt-fold",
      id: "attempt-fold:attempt-1",
      createdAt: at(4),
      runId: RunId.make("run-2"),
      attemptId: RunAttemptId.make("attempt-1"),
      label: "Superseded attempt",
      expanded: false,
    } satisfies MessagesTimelineRow;
    const expanded = [
      ...ROWS.slice(0, 3),
      { ...fold("run-2", 3), expanded: true },
      attemptFold,
      ROWS[4]!,
    ];
    expect(rowHoldingEntry(ENTRIES, expanded, "a2")).toBe("attempt-fold:attempt-1");
  });
});

describe("nextUnreadMarker", () => {
  it("captures the watermark at open, once the shell is there", () => {
    expect(nextUnreadMarker(null, "t", false, true, undefined)).toBeNull();
    expect(nextUnreadMarker(null, "t", true, false, at(2))).toEqual({
      threadKey: "t",
      since: at(2),
      last: at(2),
    });
  });

  it("does not take a null before the detail has loaded for never visited", () => {
    // ChatView's stand-in shell, built from a cached detail, has no watermark yet.
    expect(nextUnreadMarker(null, "t", true, false, undefined)).toBeNull();
    expect(nextUnreadMarker(null, "t", true, true, undefined)).toEqual({
      threadKey: "t",
      since: null,
      last: null,
    });
  });

  it("keeps the marker when the visit moves the watermark forward", () => {
    const opened = nextUnreadMarker(null, "t", true, true, at(2));
    expect(nextUnreadMarker(opened, "t", true, true, at(9))).toEqual({
      threadKey: "t",
      since: at(2),
      last: at(9),
    });
  });

  it("follows a rewind while open, and starts over on another thread", () => {
    const opened = nextUnreadMarker(null, "t", true, true, at(2));
    const visited = nextUnreadMarker(opened, "t", true, true, at(9));
    expect(nextUnreadMarker(visited, "t", true, true, at(3))?.since).toBe(at(3));
    expect(nextUnreadMarker(visited, "other", true, true, at(7))).toEqual({
      threadKey: "other",
      since: at(7),
      last: at(7),
    });
  });
});

describe("nextUnreadDivider", () => {
  const decide = (
    current: UnreadDivider | null,
    since: string | null | undefined,
    options: {
      readonly entries?: ReadonlyArray<TimelineEntry>;
      readonly syncing?: boolean;
      readonly hasMoreHistory?: boolean;
      readonly latestRun?: TimelineLatestRun | null;
      readonly identity?: string;
    } = {},
  ) =>
    nextUnreadDivider(current, {
      identity: options.identity ?? "t",
      marker: since === undefined ? null : { threadKey: "t", since },
      entries: options.entries ?? ENTRIES,
      rows: ROWS,
      syncing: options.syncing ?? false,
      hasMoreHistory: options.hasMoreHistory ?? false,
      latestRun: options.latestRun === undefined ? RUN_2 : options.latestRun,
    });

  it("waits for the marker and for settled rows, then jumps on the opening's divider", () => {
    expect(decide(null, undefined).entryId).toBeUndefined();
    expect(decide(null, at(2), { syncing: true }).entryId).toBeUndefined();
    expect(decide(null, at(4))).toMatchObject({ entryId: "a3", jump: true });
    expect(decide(null, at(6))).toMatchObject({ entryId: null, jump: false });
  });

  it("shows the divider without a jump while the latest run is under way", () => {
    const live = [
      ...ENTRIES,
      entry("u3", "user", 7, "run-3"),
      entry("a4", "assistant", 8, "run-3"),
    ];
    expect(decide(null, at(6), { entries: live, latestRun: run("run-3", null) })).toMatchObject({
      entryId: "a4",
      jump: false,
    });
  });

  it("waits until the loaded history reaches the watermark, then decides", () => {
    const newest = ENTRIES.slice(3);
    const waiting = decide(null, at(1), { entries: newest, hasMoreHistory: true });
    expect(waiting).toMatchObject({ entryId: undefined, decided: false });
    const paged = decide(waiting, at(1), { hasMoreHistory: true });
    expect(paged).toMatchObject({ entryId: "a1", jump: true });
  });

  it("stays put as the visit is recorded and as new messages arrive", () => {
    const opened = decide(null, at(6));
    const later = [...ENTRIES, entry("a4", "assistant", 9, "run-3")];
    expect(decide(opened, at(6), { entries: later, latestRun: run("run-3", 10) })).toBe(opened);
  });

  it("moves without a jump on a rewind while open, and jumps again on the next opening", () => {
    const opened = decide(null, at(6));
    expect(decide(opened, at(4))).toMatchObject({ entryId: "a3", jump: false });
    const elsewhere = decide(opened, undefined, { identity: "other" });
    const back = decide(elsewhere, at(4));
    expect(back).toMatchObject({ entryId: "a3", jump: true });
    expect(back.openId).toBeGreaterThan(opened.openId);
  });
});
