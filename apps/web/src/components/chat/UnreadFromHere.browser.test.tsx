// Fork (Mark unread from here). FORK.md, "Mark unread from here".
import { EnvironmentId, MessageId, RunId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type ComponentProps } from "react";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import "~/index.css";

import { act, fakeTimers, render } from "../../../test/render";
import { useUiStateStore } from "../../uiStateStore";
import { toastManager } from "../ui/toast";
import { MessagesTimeline } from "./MessagesTimeline";
import { CHAT_TIMELINE_ANCHOR_OFFSET, rememberTimelinePosition } from "./timelineScrollAnchoring";
import type { TimelineViewport } from "./timelineViewport";
import type { UnreadMarker } from "./unreadFromHere.logic";

// The latest run as the thread's shell reads it; null leaves the shell unloaded, as without an environment.
const shell = vi.hoisted(() => ({
  latestRun: null as { readonly completedAt: string | null } | null,
}));
vi.mock(import("../../state/entities"), async (importOriginal) => {
  const shellOf = (ref: unknown) =>
    ref === null || shell.latestRun === null ? null : { title: "", latestRun: shell.latestRun };
  return {
    ...(await importOriginal()),
    useQuietThreadShell: shellOf as never,
    readThreadShell: shellOf as never,
  };
});

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");

const at = (minute: number) => new Date(Date.UTC(2026, 10, 21, 10, minute)).toISOString();

// The timeline remembers scroll position per thread key, so every render gets a fresh thread.
const baseProps = (): Omit<TimelineProps, "timelineEntries"> => ({
  isWorking: false,
  listRef: createRef<LegendListRef | null>(),
  latestRun: null,
  turnDiffSummaries: [],
  runs: [],
  routeThreadKey: `environment-local:thread-${Math.random().toString(36).slice(2)}`,
  onOpenThread: () => {},
  supportsConversationRollback: false,
  onRevertToTurnCount: () => {},
  isRevertingCheckpoint: false,
  onImageExpand: () => {},
  activeThreadEnvironmentId: ENVIRONMENT_ID,
  markdownCwd: undefined,
  resolvedTheme: "light",
  timestampFormat: "locale",
  workspaceRoot: undefined,
  anchorMessageId: null,
  onAnchorReady: () => {},
  onAnchorSizeChanged: () => {},
  contentInsetEndAdjustment: 0,
  emptyPlaceholderInset: 0,
  liveFollowEnabled: true,
  onIsAtEndChange: () => {},
});

const message = (
  id: string,
  role: "user" | "assistant",
  minute: number,
  run: string,
  text = id,
): Entry => ({
  id: `entry-${id}`,
  kind: "message",
  createdAt: at(minute),
  message: {
    id: MessageId.make(id),
    role,
    text,
    runId: RunId.make(run),
    createdAt: at(minute),
    updatedAt: at(minute),
    streaming: false,
  },
});

/** Turns whose answers are tall enough that the thread scrolls. */
const longThread = (turns: number) =>
  Array.from({ length: turns }, (_, index) => [
    message(`u${index}`, "user", index * 2, `run-${index}`, `Question ${index}`),
    message(
      `a${index}`,
      "assistant",
      index * 2 + 1,
      `run-${index}`,
      `Answer ${index}\n\n${"line\n\n".repeat(8)}`,
    ),
  ]).flat();

const marker = (threadKey: string, since: string | null, last = since): UnreadMarker => ({
  threadKey,
  since,
  last,
});

const renderTimeline = async (props: TimelineProps) => {
  const container = document.createElement("div");
  container.style.cssText = "height: 800px; width: 900px; display: flex; flex-direction: column;";
  return render(<MessagesTimeline {...props} />, { container });
};

const divider = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[role="separator"][aria-label="New messages"]');

const rowOf = (element: HTMLElement | null) =>
  element?.closest<HTMLElement>("[data-timeline-row-id]")?.dataset.timelineRowId;

/** The divider sits beside the row it marks, in the same list item. */
const dividerRow = (container: HTMLElement) =>
  divider(container)?.parentElement?.querySelector<HTMLElement>("[data-timeline-row-id]")?.dataset
    .timelineRowId;

/** The divider is where the jump puts it, below the top fade, within `tolerance` px. */
const dividerAtTop = (container: HTMLElement, viewport: HTMLElement, tolerance = 2) => {
  const line = divider(container);
  return (
    line !== null &&
    Math.abs(
      line.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top -
        CHAT_TIMELINE_ANCHOR_OFFSET,
    ) <= tolerance
  );
};

describe("Mark unread from here: the New divider", () => {
  it("sits above the first agent message after the marker, as a labelled separator", async () => {
    const props = baseProps();
    await using screen = await renderTimeline({
      ...props,
      timelineEntries: [
        message("u1", "user", 1, "run-1"),
        message("a1", "assistant", 2, "run-1"),
        message("u2", "user", 3, "run-2"),
        message("a2", "assistant", 4, "run-2"),
      ],
      unreadMarker: marker(props.routeThreadKey, at(3)),
    });
    await vi.waitFor(() => expect(dividerRow(screen.container)).toBe("entry-a2"));
    expect(
      screen.container.querySelectorAll('[role="separator"][aria-label="New messages"]'),
    ).toHaveLength(1);
  });
});

describe("Mark unread from here: the opening jump", () => {
  const history = (hasMoreHistory: boolean) => ({
    hasMoreHistory,
    loading: false,
    error: null,
    onLoadEarlier: () => {},
  });
  let timelineViewport: TimelineViewport | null = null;
  const onViewportAttach = (viewport: TimelineViewport) => {
    timelineViewport = viewport;
    return () => {};
  };

  it("puts the divider at the top on open, instead of the end", async () => {
    const props = baseProps();
    await using screen = await renderTimeline({
      ...props,
      timelineEntries: longThread(30),
      // a10 (minute 21) is the first agent message after minute 20.
      unreadMarker: marker(props.routeThreadKey, at(20)),
    });
    const viewport = props.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => {
      expect(dividerRow(screen.container)).toBe("entry-a10");
      expect(dividerAtTop(screen.container, viewport)).toBe(true);
    });
  });

  it("leaves upstream's opening at the end when there is no divider", async () => {
    const props = baseProps();
    await using screen = await renderTimeline({
      ...props,
      timelineEntries: longThread(30),
      unreadMarker: marker(props.routeThreadKey, at(59)),
    });
    const viewport = props.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => {
      expect(screen.container.textContent).toContain("Answer 29");
      expect(
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight,
      ).toBeLessThanOrEqual(2);
    });
    // Past any jump's frames: the fake clock runs them all at once.
    using _timers = fakeTimers();
    await act(() => vi.advanceTimersByTime(1000));
    expect(divider(screen.container)).toBeNull();
    expect(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight).toBeLessThanOrEqual(
      2,
    );
  });

  it("jumps after upstream restores a remembered position with a command, once rows arrive", async () => {
    const props = baseProps();
    rememberTimelinePosition(
      props.routeThreadKey,
      { rowId: "entry-u25", offsetWithinRow: 0, scrollOffset: 0, atEnd: false },
      false,
    );
    // The list mounts before the rows, so the restore's command comes once the jump listens.
    await using screen = await renderTimeline({
      ...props,
      timelineEntries: [],
      historyControls: history(true),
      unreadMarker: marker(props.routeThreadKey, at(20)),
    });
    await vi.waitFor(() => expect(props.listRef.current).not.toBeNull());
    await screen.rerender(
      <MessagesTimeline
        {...props}
        timelineEntries={longThread(30)}
        historyControls={history(false)}
        unreadMarker={marker(props.routeThreadKey, at(20))}
      />,
    );
    const viewport = props.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => {
      expect(dividerRow(screen.container)).toBe("entry-a10");
      expect(dividerAtTop(screen.container, viewport)).toBe(true);
    });
  });

  it("jumps once: the user's own scroll afterwards stays, and a rewind moves only the divider", async () => {
    const props = baseProps();
    const entries = longThread(30);
    const ui = (unreadMarker: UnreadMarker) => (
      <MessagesTimeline {...props} timelineEntries={entries} unreadMarker={unreadMarker} />
    );
    await using screen = await renderTimeline({
      ...props,
      timelineEntries: entries,
      unreadMarker: marker(props.routeThreadKey, at(20)),
    });
    const viewport = props.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => expect(dividerAtTop(screen.container, viewport)).toBe(true));
    // The user scrolls to the top themselves (the wheel also stops the jump's settling).
    await act(async () => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
      viewport.scrollTop = 0;
    });
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[data-timeline-row-id="entry-a1"]')).not.toBeNull(),
    );
    using _timers = fakeTimers();
    // The visit's echo, then a rewind to an earlier message, while the thread stays open.
    await screen.rerender(ui(marker(props.routeThreadKey, at(20), at(59))));
    await screen.rerender(ui(marker(props.routeThreadKey, at(2), at(2))));
    await act(() => vi.advanceTimersByTime(1000));
    expect(dividerRow(screen.container)).toBe("entry-a1");
    expect(viewport.scrollTop).toBeLessThanOrEqual(2);
  });

  it("does not jump after the user scrolled to the end before the divider was decided", async () => {
    const props = baseProps();
    const all = longThread(30);
    const ui = (timelineEntries: Entry[], hasMoreHistory: boolean) => (
      <MessagesTimeline
        {...props}
        timelineEntries={timelineEntries}
        historyControls={history(hasMoreHistory)}
        unreadMarker={marker(props.routeThreadKey, at(4))}
        onViewportAttach={onViewportAttach}
      />
    );
    // The first unread message, a2 (minute 5), is not loaded yet, so nothing is decided.
    await using screen = await renderTimeline({
      ...props,
      timelineEntries: all.slice(20),
      historyControls: history(true),
      unreadMarker: marker(props.routeThreadKey, at(4)),
      onViewportAttach,
    });
    const viewport = props.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => expect(screen.container.textContent).toContain("Answer 29"));
    // Scroll to end, as ChatView's button sends it: a command, not a gesture.
    await act(async () => timelineViewport!.navigate({ releasesFollow: false }));
    await screen.rerender(ui(all, false));
    await vi.waitFor(() => expect(screen.container.textContent).toContain("Question 0"));
    using _timers = fakeTimers();
    await act(() => vi.advanceTimersByTime(1000));
    expect(dividerAtTop(screen.container, viewport)).toBe(false);
  });

  it("does not jump once the user has scrolled the viewport of a list that remounted", async () => {
    const props = baseProps();
    const all = longThread(30);
    const ui = (timelineEntries: Entry[], hasMoreHistory: boolean) => (
      <MessagesTimeline
        {...props}
        timelineEntries={timelineEntries}
        historyControls={history(hasMoreHistory)}
        unreadMarker={marker(props.routeThreadKey, at(4))}
      />
    );
    // Only turns 10 on are loaded; the first unread message, a2 (minute 5), is not.
    await using screen = await renderTimeline({
      ...props,
      timelineEntries: all.slice(20),
      historyControls: history(true),
      unreadMarker: marker(props.routeThreadKey, at(4)),
    });
    await vi.waitFor(() => expect(screen.container.textContent).toContain("Answer 29"));
    expect(divider(screen.container)).toBeNull();
    // The list remounts (the thread shows its empty state for a moment) with a new viewport.
    await screen.rerender(
      <MessagesTimeline
        {...props}
        timelineEntries={[]}
        unreadMarker={marker(props.routeThreadKey, at(4))}
      />,
    );
    await vi.waitFor(() => expect(props.listRef.current).toBeNull());
    await screen.rerender(ui(all.slice(20), true));
    await vi.waitFor(() => expect(screen.container.textContent).toContain("Answer 29"));
    const viewport = props.listRef.current!.getScrollableNode()!;
    // The user scrolls up and the earlier history loads.
    await act(async () => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
      viewport.scrollTop = Math.max(0, viewport.scrollTop - 400);
    });
    await screen.rerender(ui(all, false));
    await vi.waitFor(() => expect(screen.container.textContent).toContain("Question 0"));
    using _timers = fakeTimers();
    await act(() => vi.advanceTimersByTime(1000));
    // A jump right after a remount can land a few px off; none leaves the divider screens away.
    expect(dividerAtTop(screen.container, viewport, viewport.clientHeight / 2)).toBe(false);
  });
});

describe("Mark unread from here: the action", () => {
  it("rewinds the thread's watermark to the message's time less 1 ms", async () => {
    const props = baseProps();
    const entries = [
      message("u1", "user", 1, "run-1"),
      message("a1", "assistant", 2, "run-1"),
      message("u2", "user", 3, "run-2"),
      message("a2", "assistant", 4, "run-2"),
    ];
    // The local path, as the server, marks unread only after a completed run.
    shell.latestRun = { completedAt: at(9) };
    onTestFinished(() => {
      shell.latestRun = null;
    });
    await using screen = await renderTimeline({
      ...props,
      timelineEntries: entries,
      canOperateThread: true,
    });
    const buttons = () => [
      ...screen.container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Mark unread from here"]',
      ),
    ];
    await vi.waitFor(() => expect(buttons()).toHaveLength(2));
    const second = buttons().find((button) => rowOf(button) === "entry-a2");
    const addToast = vi.spyOn(toastManager, "add");
    await act(async () => second!.click());
    // No environment is connected here, so it takes the thread menu's local path.
    expect(useUiStateStore.getState().threadLastVisitedAtById[props.routeThreadKey]).toBe(
      new Date(Date.parse(at(4)) - 1).toISOString(),
    );
    // Announced, since nothing on screen changes.
    await vi.waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "success", title: "Marked unread from here" }),
      ),
    );
    addToast.mockRestore();
  });

  it("is not offered while the latest run is under way", async () => {
    const props = baseProps();
    shell.latestRun = { completedAt: null };
    try {
      await using screen = await renderTimeline({
        ...props,
        timelineEntries: [
          message("u1", "user", 1, "run-1"),
          message("a1", "assistant", 2, "run-1"),
        ],
        canOperateThread: true,
      });
      await vi.waitFor(() => expect(screen.container.textContent).toContain("a1"));
      expect(
        screen.container.querySelector('button[aria-label="Mark unread from here"]'),
      ).toBeNull();
    } finally {
      shell.latestRun = null;
    }
  });

  it("is not offered without the right to operate the thread", async () => {
    const props = baseProps();
    await using screen = await renderTimeline({
      ...props,
      timelineEntries: [message("u1", "user", 1, "run-1"), message("a1", "assistant", 2, "run-1")],
    });
    await vi.waitFor(() => expect(screen.container.textContent).toContain("a1"));
    expect(screen.container.querySelector('button[aria-label="Mark unread from here"]')).toBeNull();
  });
});
