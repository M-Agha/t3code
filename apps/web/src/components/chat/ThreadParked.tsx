/* oxlint-disable t3code/no-untranslated-copy -- Fork-only English copy: upstream's translation catalogs have no entries for it, so wrapping it would change nothing on screen. Copy they do hold goes through gt(), msg() or <T>. FORK.md, "Translation". */
import {
  type ScopedThreadRef,
  THREAD_PARKED_RESOLVED_LIMIT,
  THREAD_PARKED_TEXT_MAX_LENGTH,
  type ThreadParkedKind,
  type ThreadParkedUpdateInput,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isPlaceholder, KIND_LABEL, OLDER_KIND_WORD } from "@t3tools/shared/sessionKit/parks";
import {
  ArchiveIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  CopyIcon,
  CornerDownLeftIcon,
  type LucideProps,
  MoreHorizontalIcon,
  PencilIcon,
  RotateCcwIcon,
  SendIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import ChatMarkdown from "~/components/ChatMarkdown";
import { RelativeTime } from "~/components/RelativeTime";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { m } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { RadioGroup, SegmentedRadio } from "../ui/radio-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type ThreadDecisionActions, useThreadDecisions } from "./ThreadDecisions";
import {
  ariaItemText,
  isParkedBusy,
  type ParkedBusy,
  type ParkedGroup,
  type ParkedItem,
  parkedGroupOf,
  parkedGroups,
  type ParkedStatus,
  parkedStatus,
  parkedTime,
  readParked,
  rowFocusAfter,
} from "./threadDecisions.logic";

// Distributes over the union, so an edit keeps its text and a move its kind.
type ParkedChange = ThreadParkedUpdateInput extends infer Input
  ? Input extends unknown
    ? Omit<Input, "threadId">
    : never
  : never;

const KIND_ICON = { agent: BotIcon, me: UserIcon } as const;

/** A row's item, and whether the composer's draft holds its chip (In draft). */
type ParkedRowItem = ParkedItem & { readonly inDraft: boolean };

/** A kind as a row's detail line says it. */
const PARKED_KIND_WORDS = { agent: "for the agent", me: "for me" } as const;

/**
 * Why an item whose chip is in the draft takes no Edit, Done, Drop or Move: the chip holds its words,
 * and nothing rewrites a draft (the lock, Q56).
 */
const PARKED_LOCK_REASON = "remove the chip from your draft first";

/** A status as a row says it. */
const PARKED_STATUS_WORDS: Record<ParkedStatus, string> = {
  draft: "In draft",
  done: msg("Done"),
  dropped: "Dropped",
  sent: "Sent",
};

/**
 * A row's glyph: who acts on an open item (theme roles), else its state. Decorative: the detail line
 * says the same in words, so a name here would be read twice.
 */
function ParkedGlyph(props: { readonly item: ParkedItem }) {
  const { item } = props;
  const glyph = (Icon: (props: LucideProps) => ReactNode, tone: string) => (
    <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", tone)} />
  );
  switch (item.state) {
    case "open":
      return glyph(
        KIND_ICON[item.kind],
        item.kind === "agent" ? "text-update-foreground" : "text-warning-foreground",
      );
    case "done":
      return glyph(CircleCheckIcon, "text-muted-foreground");
    case "dropped":
      return glyph(CircleSlashIcon, "text-muted-foreground");
    case "sent":
      return glyph(SendIcon, "text-muted-foreground");
  }
}

/** The detail line: who it is for and who parked it, where it stands, and its time at the right. */
function ParkedDetail(props: { readonly item: ParkedRowItem }) {
  const { item } = props;
  const resolve = useMessages();
  const key = parkedStatus(item, item.inDraft);
  const status = key === null ? null : resolve(PARKED_STATUS_WORDS[key]);
  const words = PARKED_KIND_WORDS[item.kind];
  const active = item.state === "open";
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
      <span className="min-w-0">
        {active ? (
          <>
            {words} · {item.parkedBy === "agent" ? "by the agent" : "by you"}
            {status === null ? null : (
              <>
                {" · "}
                <span className="font-medium text-tracker-draft">{status}</span>
              </>
            )}
          </>
        ) : (
          `${status} · ${words}`
        )}
      </span>
      <span className="ml-auto shrink-0 tabular-nums">
        <RelativeTime timestamp={parkedTime(item)} />
      </span>
    </div>
  );
}

/**
 * The inline editor. Its text is held by the panel, not here, so a row that moves group while it is
 * open (a send carrying it is recorded) keeps what was typed until Save succeeds.
 */
function ParkedEditor(props: {
  readonly text: string;
  readonly onText: (text: string) => void;
  readonly busy: boolean;
  /** The row's lock reason's id while its chip is in the draft (a Save would change the chip's words). */
  readonly lockedBy: string | null;
  readonly onSave: (text: string) => void;
  readonly onCancel: () => void;
}) {
  const { text } = props;
  const setText = props.onText;
  const gt = useGT();
  const refused = isPlaceholder(text);
  const save = () => {
    if (!refused && !props.busy && props.lockedBy === null) props.onSave(text);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onCancel();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save();
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        size="sm"
        autoFocus
        aria-label="Parked item text"
        // Cmd/Ctrl+Enter saves nothing while locked: a screen reader hears why here too (Opus r4, C5).
        aria-describedby={props.lockedBy ?? undefined}
        maxLength={THREAD_PARKED_TEXT_MAX_LENGTH}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex justify-end gap-0.5">
        <Button size="xs" variant="ghost" onClick={props.onCancel}>
          {gt("Cancel")}
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={refused}
          aria-disabled={props.busy || props.lockedBy !== null || undefined}
          aria-describedby={props.lockedBy ?? undefined}
          onClick={save}
        >
          {gt("Save")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Why a row's action is unavailable: the reason, and the id of its visually hidden copy, which a screen
 * reader hears as the action's description. Null while the action is free.
 */
type ParkedBlocked = { readonly id: string; readonly reason: string } | null;

/**
 * A row's menu action, kept in the menu while blocked: the lock (its chip is in the draft) or a
 * composer that cannot take a chip (Add to draft). Base UI 1.9.0's disabled `MenuItem` stays focusable
 * (`focusableWhenDisabled`, `aria-disabled`) and itself drops the click, Enter and Space
 * (`useButton`), so `onClick` needs no guard. The reason shows under the name, and is its description.
 */
function ParkedMenuAction(props: {
  readonly icon: (props: LucideProps) => ReactNode;
  readonly children: ReactNode;
  readonly blocked: ParkedBlocked;
  readonly onClick: () => void;
}) {
  const { blocked } = props;
  const Icon = props.icon;
  return (
    <MenuItem disabled={blocked !== null} aria-describedby={blocked?.id} onClick={props.onClick}>
      <Icon className="size-3.5" />
      {blocked === null ? (
        props.children
      ) : (
        <span className="flex flex-col">
          <span>{props.children}</span>
          <span aria-hidden className="text-2xs text-muted-foreground">
            {blocked.reason}
          </span>
        </span>
      )}
    </MenuItem>
  );
}

interface ParkedRowActions {
  /** False when this client may not change the thread. */
  readonly canUpdate: boolean;
  /** Why the composer cannot take a chip now (Add to draft); null when it can. */
  readonly draftBlocked: string | null;
  readonly addToDraft: (item: ParkedItem) => void;
  readonly change: (item: ParkedItem, change: ParkedChange) => void;
  /** An action that takes the item out of Open, so focus moves on. */
  readonly leave: (item: ParkedItem, change: ParkedChange) => void;
  readonly save: (item: ParkedItem, text: string) => Promise<boolean>;
}

/**
 * One parked item, built like the pull-request panel's rows: full text, a detail line, and actions
 * that show on hover and keyboard focus (always on a touch screen); right-click opens the same menu.
 */
function ParkedRow(props: {
  readonly item: ParkedRowItem;
  readonly busy: boolean;
  /** What the open editor holds; null while it is closed. */
  readonly editText: string | null;
  readonly onEditText: (text: string) => void;
  readonly onEdit: (editing: boolean) => void;
  readonly actions: ParkedRowActions;
}) {
  const editing = props.editText !== null;
  const { item, actions } = props;
  const label = ariaItemText(item.text);
  const blockedReasonId = useId();
  const lockReasonId = useId();
  const gt = useGT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const menuAnchor = menuPosition
    ? { getBoundingClientRect: () => new DOMRect(menuPosition.x, menuPosition.y, 0, 0) }
    : undefined;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const resolved = item.state !== "open";
  const draftable = !resolved && item.kind === "agent" && !item.inDraft;
  // Locked while its chip is in the draft: Edit, Done, Drop and Move wait until the chip goes.
  const locked: ParkedBlocked =
    !resolved && item.inDraft ? { id: lockReasonId, reason: PARKED_LOCK_REASON } : null;
  const draftBlocked: ParkedBlocked =
    actions.draftBlocked === null ? null : { id: blockedReasonId, reason: actions.draftBlocked };
  const other: ThreadParkedKind = item.kind === "agent" ? "me" : "agent";
  const OtherIcon = KIND_ICON[other];
  const stopEditing = () => {
    flushSync(() => props.onEdit(false));
    triggerRef.current?.focus();
  };
  const ifIdle = (action: () => void) => () => {
    if (!props.busy) action();
  };
  const copyText = () =>
    void writeTextToClipboard(item.text).catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: gt("Failed to copy"),
        description: error instanceof Error ? error.message : gt("An error occurred."),
      });
    });
  return (
    <li
      data-thread-parked={item.id}
      className={cn(
        "group/parked-row relative flex items-start gap-2 rounded-md py-1 pr-1 pl-2 hover:bg-accent/60",
        resolved && "text-muted-foreground",
      )}
      onContextMenu={(event) => {
        if (editing || !actions.canUpdate) return;
        event.preventDefault();
        event.stopPropagation();
        setMenuPosition({ x: event.clientX, y: event.clientY });
        setMenuOpen(true);
      }}
    >
      <ParkedGlyph item={item} />
      {locked === null ? null : (
        <span id={locked.id} className="sr-only">
          {locked.reason}
        </span>
      )}
      {draftable && draftBlocked !== null ? (
        <span id={draftBlocked.id} className="sr-only">
          {draftBlocked.reason}
        </span>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {props.editText !== null ? (
          <ParkedEditor
            text={props.editText}
            onText={props.onEditText}
            busy={props.busy}
            lockedBy={locked?.id ?? null}
            onSave={(text) =>
              void actions.save(item, text).then((saved) => {
                if (saved) stopEditing();
              })
            }
            onCancel={stopEditing}
          />
        ) : (
          <ChatMarkdown
            text={item.text}
            cwd={undefined}
            lineBreaks
            className={cn("text-sm wrap-anywhere", resolved && "text-muted-foreground")}
          />
        )}
        <ParkedDetail item={item} />
      </div>
      {editing || !actions.canUpdate ? null : (
        <span
          className={cn(
            "absolute right-0 bottom-0.5 flex items-center gap-0.5 rounded-r-md bg-background pr-1 pl-5",
            "[mask-image:linear-gradient(to_right,transparent,black_1rem)]",
            // Hidden controls would intercept taps on the row on touch screens.
            "pointer-events-none opacity-0 group-hover/parked-row:pointer-events-auto group-hover/parked-row:opacity-100",
            "has-[[data-popup-open]]:pointer-events-auto has-[[data-popup-open]]:opacity-100",
            "has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100",
            // No hover on touch: the actions stay shown, or the menu would hide behind a long press,
            // and in the row's flow rather than over it, so they never cover the row's time.
            "pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
            "pointer-coarse:static pointer-coarse:self-end pointer-coarse:bg-transparent pointer-coarse:pl-0 pointer-coarse:[mask-image:none]",
          )}
        >
          <span aria-hidden className="absolute inset-0 bg-accent/60 pointer-coarse:hidden" />
          {draftable ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  // Focusable while blocked, so its tooltip can say why (a disabled button shows none);
                  // the tooltip is not its description (Base UI links none), so a hidden one says it
                  // to a screen reader (Opus round 2, O1).
                  <Button
                    variant="ghost"
                    size="icon-micro"
                    className="relative"
                    aria-disabled={props.busy || actions.draftBlocked !== null || undefined}
                    aria-label={`Add to draft: ${label}`}
                    aria-describedby={draftBlocked?.id}
                    onClick={ifIdle(() => {
                      if (draftBlocked === null) actions.addToDraft(item);
                    })}
                  />
                }
              >
                <CornerDownLeftIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {actions.draftBlocked === null
                  ? "Add to draft"
                  : `Add to draft: ${actions.draftBlocked}`}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <Menu
            open={menuOpen}
            onOpenChange={(open) => {
              setMenuOpen(open);
              if (!open) setMenuPosition(null);
            }}
          >
            <MenuTrigger
              render={
                <Button
                  ref={triggerRef}
                  variant="ghost"
                  size="icon-micro"
                  className="relative"
                  aria-disabled={props.busy || undefined}
                  aria-label={`Actions for: ${label}`}
                >
                  <MoreHorizontalIcon className="size-3.5" />
                </Button>
              }
            />
            <MenuPopup
              anchor={menuAnchor}
              align={menuPosition ? "start" : "end"}
              side="bottom"
              sideOffset={menuPosition ? 0 : 4}
            >
              {resolved ? (
                <>
                  <MenuItem
                    onClick={ifIdle(() => actions.change(item, { id: item.id, action: "reopen" }))}
                  >
                    <RotateCcwIcon className="size-3.5" />
                    {gt("Reopen")}
                  </MenuItem>
                  <MenuItem onClick={copyText}>
                    <CopyIcon className="size-3.5" />
                    Copy text
                  </MenuItem>
                </>
              ) : (
                <>
                  {draftable ? (
                    <ParkedMenuAction
                      icon={CornerDownLeftIcon}
                      blocked={draftBlocked}
                      onClick={ifIdle(() => actions.addToDraft(item))}
                    >
                      Add to draft
                    </ParkedMenuAction>
                  ) : null}
                  <ParkedMenuAction
                    icon={PencilIcon}
                    blocked={locked}
                    onClick={ifIdle(() => props.onEdit(true))}
                  >
                    {/* The catalogs hold "Edit" as JSX only, so it is <T>, not gt(). */}
                    <T>Edit</T>
                  </ParkedMenuAction>
                  <ParkedMenuAction
                    icon={CheckIcon}
                    blocked={locked}
                    onClick={ifIdle(() => actions.leave(item, { id: item.id, action: "done" }))}
                  >
                    Mark done
                  </ParkedMenuAction>
                  <ParkedMenuAction
                    icon={OtherIcon}
                    blocked={locked}
                    onClick={ifIdle(() =>
                      actions.change(item, { id: item.id, action: "move", kind: other }),
                    )}
                  >
                    Move to {KIND_LABEL[other]}
                  </ParkedMenuAction>
                  <MenuItem onClick={copyText}>
                    <CopyIcon className="size-3.5" />
                    Copy text
                  </MenuItem>
                  <MenuSeparator />
                  {/* Not styled destructive: Reopen undoes it. */}
                  <ParkedMenuAction
                    icon={XIcon}
                    blocked={locked}
                    onClick={ifIdle(() => actions.leave(item, { id: item.id, action: "drop" }))}
                  >
                    Drop
                  </ParkedMenuAction>
                </>
              )}
            </MenuPopup>
          </Menu>
        </span>
      )}
    </li>
  );
}

function ParkedGroup(props: {
  readonly title: string;
  readonly items: ReadonlyArray<ParkedRowItem>;
  /** Present for a group that collapses: whether it is open, and its toggle. */
  readonly collapse?: { readonly open: boolean; readonly toggle: () => void };
  readonly children: (item: ParkedRowItem) => ReactNode;
  readonly footer?: ReactNode;
}) {
  const id = useId();
  if (props.items.length === 0) return null;
  const heading = (
    <>
      {/* The space keeps the count a word of its own in the heading's accessible name. */}
      {props.title} <span className="font-normal tabular-nums">{props.items.length}</span>
    </>
  );
  const open = props.collapse?.open ?? true;
  return (
    <section aria-labelledby={id}>
      <h3
        id={id}
        className="flex items-center gap-1 px-2 pt-2.5 pb-1 text-2xs font-medium text-muted-foreground"
      >
        {props.collapse === undefined ? (
          heading
        ) : (
          <button
            type="button"
            aria-expanded={open}
            className="-mx-1 flex items-center gap-1 rounded-sm px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onClick={props.collapse.toggle}
          >
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3 transition-transform", !open && "-rotate-90")}
            />
            {heading}
          </button>
        )}
      </h3>
      {open ? (
        <>
          <ul className="flex flex-col">{props.items.map(props.children)}</ul>
          {props.footer}
        </>
      ) : null}
    </section>
  );
}

/** The add field (MAIN-65): Enter parks, Shift+Enter is a new line; the server's refusals show here. */
function ParkField(props: {
  readonly canPark: boolean;
  /** Null once parked; else what to say under the field. */
  readonly onPark: (kind: ThreadParkedKind, text: string) => Promise<string | null>;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [kind, setKind] = useState<ThreadParkedKind>("agent");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async () => {
    if (pending || !props.canPark) return;
    if (text.trim() === "") {
      setProblem("Nothing to park.");
      return;
    }
    setPending(true);
    const parked = text;
    const refused = await props.onPark(kind, parked);
    setPending(false);
    setProblem(refused);
    // Words typed while the park was in flight stay.
    if (refused === null) setText((current) => (current === parked ? "" : current));
  };
  return (
    <div className="shrink-0 border-t border-border/60 p-2">
      <div className="rounded-lg border border-input bg-input/32 px-1 pt-1 pb-1.5 has-focus-visible:border-ring">
        <label htmlFor={`${id}-text`} className="sr-only">
          Park something
        </label>
        <Textarea
          id={`${id}-text`}
          unstyled
          rows={2}
          placeholder="Park something for later…"
          maxLength={THREAD_PARKED_TEXT_MAX_LENGTH}
          value={text}
          disabled={!props.canPark}
          aria-invalid={problem !== null || undefined}
          aria-describedby={problem === null ? undefined : `${id}-problem`}
          onChange={(event) => {
            setText(event.target.value);
            setProblem(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void submit();
          }}
        />
        <div className="mt-1 flex items-center gap-1.5 px-1">
          <RadioGroup
            aria-label="Who acts on it"
            variant="segmented"
            value={kind}
            onValueChange={(value) => {
              if (value === "agent" || value === "me") setKind(value);
            }}
          >
            {(["agent", "me"] as const).map((option) => {
              const Icon = KIND_ICON[option];
              return (
                <SegmentedRadio key={option} value={option}>
                  <Icon aria-hidden className="size-3" />
                  {KIND_LABEL[option]}
                </SegmentedRadio>
              );
            })}
          </RadioGroup>
          <span className="ml-auto text-2xs text-muted-foreground">↵ to park</span>
          <Button
            size="xs"
            disabled={!props.canPark}
            aria-disabled={pending || undefined}
            onClick={() => void submit()}
          >
            Park
          </Button>
        </div>
      </div>
      {problem === null ? null : (
        <p id={`${id}-problem`} role="alert" className="px-1 pt-1 text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}

/** The thread's parked items: its own right-panel surface, beside the Tracker. */
export function ThreadParkedPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly actions: ThreadDecisionActions;
}) {
  const { environmentId, threadId } = props.threadRef;
  const snapshot = useThreadDecisions(props.threadRef);
  const canUpdate = useAtomValue(
    serverEnvironment.updateThreadParkedItem.permissionAtom(environmentId),
  );
  const canPark = useAtomValue(serverEnvironment.parkThreadItems.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateThreadParkedItem, {
    reportFailure: true,
  });
  // Refusals show under the add field, so it reports none itself.
  const park = useAtomCommand(serverEnvironment.parkThreadItems, { reportFailure: false });
  // The row being edited and its editor's text, kept here across a row moving group (Sent).
  const [editing, setEditing] = useState<{
    readonly id: number;
    readonly text: string;
    readonly group: ParkedGroup;
  } | null>(null);
  const [busy, setBusy] = useState<ParkedBusy>(new Map());
  const [resolvedOpen, setResolvedOpen] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Where focus goes once the snapshot drops the item the user just finished or dropped: the open
  // rows as they showed then, so a neighbour another client resolved meanwhile is passed over.
  const focusAfterRef = useRef<{
    readonly leaving: number;
    readonly order: ReadonlyArray<number>;
  } | null>(null);
  // The row focus was last in, kept while its control goes away (a draft lands and Add to draft
  // leaves; a row moves to another group and remounts), dropped once the user moves focus elsewhere.
  const focusedRowRef = useRef<number | null>(null);
  // Each row with whether the composer's draft holds its chip, so a chip added or deleted there
  // re-renders the row and re-runs the focus fix below (Add to draft leaves once In draft).
  const inDraft = new Set(props.actions.parked.inDraft);
  const parked = readParked(snapshot?.parked ?? []).map((item): ParkedRowItem => ({
    ...item,
    inDraft: inDraft.has(item.id),
  }));
  const groups = parkedGroups(parked, editing);
  // Open rows in the order they show, the rows focus can move between.
  const activeIds = groups.open.map((item) => item.id);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus off a control the snapshot or the draft removed
  useLayoutEffect(() => {
    const firstControl = (id: number) =>
      listRef.current?.querySelector<HTMLElement>(
        `[data-thread-parked="${id}"] button:not([disabled])`,
      ) ?? null;
    // Focus fell to the body with the removed control; anywhere else, the user moved it.
    const fell = document.activeElement === null || document.activeElement === document.body;
    const pending = focusAfterRef.current;
    if (pending !== null && !activeIds.includes(pending.leaving)) {
      focusAfterRef.current = null;
      if (!fell) return;
      const next = rowFocusAfter(pending.order, pending.leaving, activeIds);
      // No open item left: the surface itself. Its first control can be the finished item's Reopen,
      // and a second Enter there would undo what was just done.
      (next === null ? panelRef.current : firstControl(next))?.focus();
      return;
    }
    // A row still listed that lost its focused control: its first control (the "…" once in the draft).
    const row = focusedRowRef.current;
    if (fell && row !== null && parked.some((item) => item.id === row)) firstControl(row)?.focus();
  }, [activeIds, parked, focusAfterRef, focusedRowRef, listRef, panelRef]);
  const send = async (input: ParkedChange) =>
    (await update({ environmentId, input: { ...input, threadId } }))._tag === "Success";
  // A change leaves the item busy until the snapshot shows its result (isParkedBusy); a failure frees
  // it at once.
  const run = async (item: ParkedItem, action: () => Promise<boolean>) => {
    if (isParkedBusy(busy, item)) return false;
    setBusy((current) => new Map(current).set(item.id, item.updatedAt));
    const done = await action();
    if (!done) {
      setBusy((current) => {
        const next = new Map(current);
        next.delete(item.id);
        return next;
      });
    }
    return done;
  };
  const actions: ParkedRowActions = {
    canUpdate,
    // Not while the composer edits a queued message or answers T3's own question: the chip would go
    // into that, not the draft.
    draftBlocked: !props.actions.canOperate
      ? "this thread cannot take a message now"
      : props.actions.editingQueuedRun
        ? "finish editing the queued message first"
        : props.actions.answeringPendingInput
          ? "answer the agent's question first"
          : null,
    // A chip in the composer, focus left here, so several items can go in one message; the server
    // marks the item Sent once a message carrying it is recorded. Nothing is stored before then.
    addToDraft: (item) => void props.actions.parked.attach(item),
    change: (item, change) => void run(item, () => send(change)),
    leave: (item, change) => {
      focusAfterRef.current = { leaving: item.id, order: activeIds };
      void run(item, () => send(change)).then((done) => {
        if (!done && focusAfterRef.current?.leaving === item.id) focusAfterRef.current = null;
      });
    },
    // Never an item whose chip is in the draft (the row locks Save), so no chip holds old words.
    save: (item, text) => run(item, () => send({ id: item.id, action: "edit", text })),
  };
  const onPark = async (kind: ThreadParkedKind, text: string) => {
    // In the older word, which a server from before the rename takes too.
    const result = await park({
      environmentId,
      input: { threadId, items: [{ kind: OLDER_KIND_WORD[kind], text }] },
    });
    if (result._tag === "Success") return null;
    return thrownErrorMessage(squashAtomCommandFailure(result), m) ?? "Could not park this.";
  };
  const row = (item: ParkedRowItem) => (
    <ParkedRow
      key={item.id}
      item={item}
      busy={isParkedBusy(busy, item)}
      editText={editing?.id === item.id ? editing.text : null}
      onEditText={(text) =>
        setEditing((current) => (current === null ? null : { ...current, text }))
      }
      onEdit={(open) =>
        setEditing(open ? { id: item.id, text: item.text, group: parkedGroupOf(item) } : null)
      }
      actions={actions}
    />
  );
  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="region"
      aria-label="Parked items"
      className="flex h-full min-h-0 flex-col outline-none"
      data-thread-parked-panel
    >
      {parked.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <ArchiveIcon aria-hidden className="size-6 text-muted-foreground/60" />
          <p className="text-sm font-medium">Nothing parked</p>
          <p className="max-w-60 text-xs text-muted-foreground">
            Park what you or the agent should come back to. Type it below, or use <code>/park</code>{" "}
            in the chat.
          </p>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div
            ref={listRef}
            className="p-1.5"
            onFocus={(event) => {
              // Portalled menus bubble here too; only a control inside a row names it.
              const row = event.target.closest<HTMLElement>("[data-thread-parked]");
              if (row !== null) focusedRowRef.current = Number(row.dataset.threadParked);
            }}
            onBlur={(event) => {
              const left = event.target;
              const to = event.relatedTarget;
              if (to instanceof Element) {
                // A menu opened from a row keeps it; anywhere else outside the list does not.
                if (!listRef.current?.contains(to) && to.closest("[role=menu]") === null) {
                  focusedRowRef.current = null;
                }
                return;
              }
              // Focus went nowhere: the user clicked away, unless the control was removed.
              setTimeout(() => {
                if (left.isConnected) focusedRowRef.current = null;
              });
            }}
          >
            <ParkedGroup title="Open" items={groups.open}>
              {row}
            </ParkedGroup>
            <ParkedGroup
              title="Resolved"
              items={groups.resolved}
              collapse={{ open: resolvedOpen, toggle: () => setResolvedOpen((open) => !open) }}
              footer={
                groups.resolved.length === THREAD_PARKED_RESOLVED_LIMIT ? (
                  <p className="px-2 pt-2 text-xs text-muted-foreground">
                    Older items are not shown.
                  </p>
                ) : null
              }
            >
              {row}
            </ParkedGroup>
          </div>
        </ScrollArea>
      )}
      <ParkField canPark={canPark} onPark={onPark} />
    </div>
  );
}
