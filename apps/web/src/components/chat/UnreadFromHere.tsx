/* oxlint-disable t3code/no-untranslated-copy -- Fork-only English copy: upstream's translation catalogs have no entries for it, so wrapping it would change nothing on screen. FORK.md, "Translation". */
// Fork (Mark unread from here). FORK.md, "Mark unread from here".
import type { LegendListRef } from "@legendapp/list/react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { MailOpenIcon } from "lucide-react";
import { type RefObject, use, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useMarkThreadUnread } from "../../hooks/useThreadActions";
import { useQuietThreadShell } from "../../state/entities";
import type { TimelineEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { MessagesTimelineRow, TimelineLatestRun } from "./MessagesTimeline.logic";
import { CHAT_TIMELINE_ANCHOR_OFFSET } from "./timelineScrollAnchoring";
import { TimelineRowCtx } from "./timelineRowContext";
import type { TimelineViewport } from "./timelineViewport";
import {
  nextUnreadDivider,
  nextUnreadMarker,
  rowHoldingEntry,
  runUnderWay,
  type UnreadDivider,
  type UnreadMarker,
} from "./unreadFromHere.logic";
import { startTimelinePositionRestore } from "./useTimelinePositionRestore";

/** The open thread's watermark as it was at open; ChatView passes it to the timeline. */
export const useUnreadMarker = (
  threadKey: string | null,
  shell: Pick<EnvironmentThreadShell, "lastVisitedAt"> | null,
  detailLoaded: boolean,
): UnreadMarker | null => {
  const localLastVisitedAt = useUiStateStore((store) =>
    threadKey === null ? undefined : store.threadLastVisitedAtById[threadKey],
  );
  const lastVisitedAt = resolveThreadLastVisitedAt(shell?.lastVisitedAt, localLastVisitedAt);
  const [marker, setMarker] = useState<UnreadMarker | null>(null);
  const next = nextUnreadMarker(marker, threadKey, shell !== null, detailLoaded, lastVisitedAt);
  if (next !== marker) setMarker(next);
  return next;
};

/**
 * Decides the opened thread's first unread entry and returns the row its divider sits on.
 * Once per opening that found one, it scrolls the divider to the top with upstream's opening
 * restore, as a remembered position, once the list is positioned. A navigation of the user's
 * cancels the jump, even before the divider is decided.
 */
export const useUnreadDivider = ({
  identity,
  marker,
  entries,
  rows,
  syncing,
  hasMoreHistory,
  latestRun,
  listReady,
  listRef,
  viewportRef,
  viewportElement,
}: {
  readonly identity: string;
  readonly marker: UnreadMarker | null | undefined;
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly syncing: boolean;
  readonly hasMoreHistory: boolean;
  readonly latestRun: TimelineLatestRun | null;
  /** The list has loaded and its opening restore has positioned it. */
  readonly listReady: boolean;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly viewportRef: RefObject<TimelineViewport | null>;
  /** The timeline's viewport element: the list (and its viewport) attaches, or remounts, with it. */
  readonly viewportElement: HTMLElement | null;
}): string | null => {
  const [divider, setDivider] = useState<UnreadDivider | null>(null);
  const next = nextUnreadDivider(divider, {
    identity,
    marker: marker ?? null,
    entries,
    rows,
    syncing,
    hasMoreHistory,
    latestRun,
  });
  if (next !== divider) setDivider(next);
  const { jump, openId, entryId } = next;
  const rowId = entryId == null ? null : rowHoldingEntry(entries, rows, entryId);
  // The opening whose jump is done or given up.
  const settledOpenRef = useRef(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens to the timeline viewport, an external DOM source, so a user's navigation before the jump cancels it
  useEffect(() => {
    // Keyed on the element: a cold open attaches the list after the empty state, a remount anew.
    const viewport = viewportElement === null ? null : viewportRef.current;
    if (viewport === null || settledOpenRef.current === openId) return;
    // Until the list is positioned, commands are upstream's opening restore; after, every
    // navigation is the user's (scroll to end, the minimap, find, page keys, a citation).
    return viewport.subscribe((navigation) => {
      if (listReady || navigation.source !== "command") settledOpenRef.current = openId;
    });
  }, [listReady, openId, viewportElement, viewportRef]);

  // The jump in flight, stopped when its opening ends (another thread, or unmount).
  const jumpRef = useRef<{ readonly openId: number; readonly stop: () => void } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops an imperative LegendList scroll that belongs to an opening that has ended
  useEffect(
    () => () => {
      if (jumpRef.current?.openId === openId) jumpRef.current.stop();
    },
    [openId],
  );

  // As upstream's restore: after LegendList's own layout effects applied the rows, before paint.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls LegendList, an external imperative list, once the opening restore has positioned it
  useLayoutEffect(() => {
    const list = listRef.current;
    const viewport = viewportRef.current;
    if (!jump || rowId === null || !listReady || list === null || viewport === null) return;
    if (settledOpenRef.current === openId) return;
    settledOpenRef.current = openId;
    const stop = startTimelinePositionRestore({
      list,
      viewport,
      listIdentityKey: identity,
      listOpenedOn: null,
      rememberedPosition: {
        rowId,
        offsetWithinRow: -CHAT_TIMELINE_ANCHOR_OFFSET,
        scrollOffset: 0,
        atEnd: false,
      },
      citationPending: false,
      releaseForFind: false,
      onPositioned: () => {},
    });
    jumpRef.current = { openId, stop };
  }, [identity, jump, listReady, listRef, openId, rowId, viewportRef]);

  return rowId;
};

/** The "New" divider, above the row that holds (or folds) the first unread entry. */
export const NewMessagesDivider = () => (
  <div
    role="separator"
    aria-label="New messages"
    data-unread-divider="true"
    className="flex items-center gap-3 pb-2 text-info text-xs"
  >
    <span aria-hidden="true" className="h-px flex-1 bg-info/60" />
    <span aria-hidden="true" className="shrink-0 font-medium">
      New
    </span>
    <span aria-hidden="true" className="h-px flex-1 bg-info/60" />
  </div>
);

/** Leaves this agent message and everything after it unread, as the thread menu's Mark unread does. */
export const MarkUnreadFromHereButton = ({ message }: { readonly message: ChatMessage }) => {
  const { threadRef, canOperateThread } = use(TimelineRowCtx);
  const markThreadUnread = useMarkThreadUnread();
  const latestRun = useQuietThreadShell(threadRef)?.latestRun ?? null;
  // Not while the latest run is under way: the server refuses then, as for the thread menu's.
  if (threadRef === null || !canOperateThread || message.streaming || runUnderWay(latestRun)) {
    return null;
  }
  // Announced either way: the click changes nothing on screen.
  const markUnread = async () => {
    const result = await markThreadUnread(threadRef, message.createdAt);
    // Interrupted is cancelled, not refused: nothing to announce.
    if (result !== undefined && isAtomCommandInterrupted(result)) return;
    toastManager.add(
      result?._tag === "Failure"
        ? {
            type: "error",
            title: "Could not mark unread",
            description:
              thrownErrorMessage(squashAtomCommandFailure(result)) ?? "An error occurred.",
          }
        : { type: "success", title: "Marked unread from here" },
    );
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            onClick={() => void markUnread()}
            aria-label="Mark unread from here"
          />
        }
      >
        <MailOpenIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Mark unread from here</TooltipPopup>
    </Tooltip>
  );
};
