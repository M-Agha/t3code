/* oxlint-disable t3code/no-untranslated-copy -- Fork-only English copy: upstream's translation catalogs have no entries for it, so wrapping it would change nothing on screen. FORK.md, "Translation". */
import {
  type ScopedThreadRef,
  THREAD_PARKED_RESOLVED_LIMIT,
  THREAD_PARKED_TEXT_MAX_LENGTH,
  type ThreadParkedItem,
  type ThreadParkedUpdateInput,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { isPlaceholder } from "@t3tools/shared/sessionKit/parks";
import { ArchiveIcon } from "lucide-react";
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { RelativeTime } from "~/components/RelativeTime";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Textarea } from "../ui/textarea";
import {
  EmptyState,
  SectionHeading,
  type ThreadDecisionActions,
  useThreadDecisions,
} from "./ThreadDecisions";
import {
  ariaItemText,
  isParkedBusy,
  type ParkedBusy,
  parkedFocusAfter,
} from "./threadDecisions.logic";

// Badge variants whose colours a T3 theme sets; each badge says its kind or state in words.
const PARKED_KIND_BADGE = { todo: "outline", later: "secondary", prompt: "warning" } as const;

const PARKED_STATE_BADGE = { done: "outline", dropped: "secondary", sent: "outline" } as const;

// Distributes over the union, so an edit keeps its text.
type ParkedChange = ThreadParkedUpdateInput extends infer Input
  ? Input extends unknown
    ? Omit<Input, "threadId">
    : never
  : never;

function ParkedEditor(props: {
  readonly item: ThreadParkedItem;
  readonly busy: boolean;
  readonly onSave: (text: string) => void;
  readonly onCancel: () => void;
}) {
  const [text, setText] = useState(props.item.text);
  const refused = isPlaceholder(text);
  const save = () => {
    if (!refused && !props.busy) props.onSave(text);
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
    <div className="mt-1.5 flex flex-col gap-1.5">
      <Textarea
        size="sm"
        autoFocus
        aria-label="Parked item text"
        maxLength={THREAD_PARKED_TEXT_MAX_LENGTH}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex justify-end gap-0.5">
        <Button size="xs" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={refused}
          aria-disabled={props.busy || undefined}
          onClick={save}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function ParkedHeader(props: { readonly item: ThreadParkedItem; readonly at: string }) {
  const { item } = props;
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <span className="flex items-center gap-1.5">
        <Badge size="sm" variant={PARKED_KIND_BADGE[item.kind]}>
          {item.kind}
        </Badge>
        {item.parkedBy === "agent" ? (
          <span className="text-2xs text-muted-foreground">parked by the agent</span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {item.state === "open" ? null : (
          <Badge size="sm" variant={PARKED_STATE_BADGE[item.state]}>
            {item.state}
          </Badge>
        )}
        <span className="text-2xs text-muted-foreground">
          <RelativeTime timestamp={props.at} />
        </span>
      </span>
    </div>
  );
}

function OpenParkedCard(props: {
  readonly item: ThreadParkedItem;
  readonly canUpdate: boolean;
  readonly canSend: boolean;
  /** An action on this item is in flight; its buttons stay focusable but do nothing. */
  readonly busy: boolean;
  readonly editing: boolean;
  readonly onEdit: (editing: boolean) => void;
  readonly onSend: () => void;
  readonly onResolve: (action: "done" | "drop") => void;
  readonly onSave: (text: string) => Promise<boolean>;
}) {
  const { item } = props;
  const label = ariaItemText(item.text);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const stopEditing = () => {
    flushSync(() => props.onEdit(false));
    editButtonRef.current?.focus();
  };
  const save = (text: string) => {
    void props.onSave(text).then((saved) => {
      if (saved) stopEditing();
    });
  };
  const ifIdle = (action: () => void) => () => {
    if (!props.busy) action();
  };
  return (
    <li className="rounded-lg border border-border/70 p-2.5" data-thread-parked={item.id}>
      <ParkedHeader item={item} at={item.createdAt} />
      {props.editing ? (
        <ParkedEditor item={item} busy={props.busy} onSave={save} onCancel={stopEditing} />
      ) : (
        <>
          <p className="mt-1.5 text-sm whitespace-pre-wrap text-foreground wrap-anywhere">
            {item.text}
          </p>
          <div className="mt-2 flex justify-end gap-0.5">
            <Button
              size="xs"
              variant="outline"
              disabled={!props.canSend}
              aria-disabled={props.busy || undefined}
              aria-label={`Send as a message: ${label}`}
              onClick={ifIdle(props.onSend)}
            >
              Send
            </Button>
            <Button
              ref={editButtonRef}
              size="xs"
              variant="ghost"
              disabled={!props.canUpdate}
              aria-disabled={props.busy || undefined}
              aria-label={`Edit: ${label}`}
              onClick={ifIdle(() => props.onEdit(true))}
            >
              Edit
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={!props.canUpdate}
              aria-disabled={props.busy || undefined}
              aria-label={`Mark done: ${label}`}
              onClick={ifIdle(() => props.onResolve("done"))}
            >
              Done
            </Button>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={!props.canUpdate}
              aria-disabled={props.busy || undefined}
              aria-label={`Drop: ${label}`}
              onClick={ifIdle(() => props.onResolve("drop"))}
            >
              Drop
            </Button>
          </div>
        </>
      )}
    </li>
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
  const update = useAtomCommand(serverEnvironment.updateThreadParkedItem, {
    reportFailure: true,
  });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [busy, setBusy] = useState<ParkedBusy>(new Map());
  const panelRef = useRef<HTMLDivElement>(null);
  const openListRef = useRef<HTMLUListElement>(null);
  // Where focus goes once the snapshot drops the item the user just sent, finished or dropped.
  const focusAfterRef = useRef<{ readonly leaving: number; readonly next: number | null } | null>(
    null,
  );
  const parked = snapshot?.parked ?? [];
  const open = parked.filter((item) => item.state === "open");
  const resolved = parked.filter((item) => item.state !== "open");
  const openIds = open.map((item) => item.id);
  const openKey = openIds.join(",");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus off a card the snapshot removed
  useLayoutEffect(() => {
    const pending = focusAfterRef.current;
    if (pending === null || openKey.split(",").includes(String(pending.leaving))) return;
    focusAfterRef.current = null;
    // Focus fell to the body with the removed button; anywhere else, the user moved it.
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    const next =
      pending.next === null
        ? null
        : openListRef.current?.querySelector<HTMLElement>(
            `[data-thread-parked="${pending.next}"] button:not([disabled])`,
          );
    // No open item left: the surface itself. Its first control can be the finished item's Reopen,
    // and a second Enter there would undo what was just done.
    (next ?? panelRef.current)?.focus();
  }, [openKey, focusAfterRef, openListRef, panelRef]);
  const change = async (input: ParkedChange) => {
    const result = await update({ environmentId, input: { ...input, threadId } });
    return result._tag === "Success";
  };
  // A finished action leaves the item busy until the snapshot shows its result (isParkedBusy).
  const run = async (item: ThreadParkedItem, action: () => Promise<boolean>) => {
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
  const leave = (item: ThreadParkedItem, action: () => Promise<boolean>) => {
    focusAfterRef.current = { leaving: item.id, next: parkedFocusAfter(openIds, item.id) };
    void run(item, action).then((done) => {
      if (!done && focusAfterRef.current?.leaving === item.id) focusAfterRef.current = null;
    });
  };
  const send = (item: ThreadParkedItem) =>
    leave(
      item,
      async () =>
        (await props.actions.send(item.text)) && (await change({ id: item.id, action: "sent" })),
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
        <EmptyState
          icon={ArchiveIcon}
          title="Nothing parked"
          description="Type /park and some text in the composer to set it aside for later. Agents can park follow-ups here too."
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-3 pb-3">
            {open.length === 0 ? null : (
              <section aria-label="Parked">
                <SectionHeading>Parked</SectionHeading>
                <ul ref={openListRef} className="flex flex-col gap-1.5">
                  {open.map((item) => (
                    <OpenParkedCard
                      key={item.id}
                      item={item}
                      canUpdate={canUpdate}
                      canSend={canUpdate && props.actions.canOperate}
                      busy={isParkedBusy(busy, item)}
                      editing={editingId === item.id}
                      onEdit={(editing) => setEditingId(editing ? item.id : null)}
                      onSend={() => send(item)}
                      onResolve={(action) => leave(item, () => change({ id: item.id, action }))}
                      onSave={(text) =>
                        run(item, () => change({ id: item.id, action: "edit", text }))
                      }
                    />
                  ))}
                </ul>
              </section>
            )}
            {resolved.length === 0 ? null : (
              <section aria-label="Resolved parked items">
                <SectionHeading>Resolved</SectionHeading>
                <ul className="flex flex-col gap-1.5">
                  {resolved.map((item) => (
                    <li
                      key={item.id}
                      className="rounded-lg border border-border/70 p-2.5"
                      data-thread-parked={item.id}
                    >
                      <ParkedHeader item={item} at={item.resolvedAt ?? item.updatedAt} />
                      <p className="mt-1.5 text-sm whitespace-pre-wrap text-foreground/80 wrap-anywhere">
                        {item.text}
                      </p>
                      <div className="mt-2 flex justify-end">
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={!canUpdate}
                          aria-disabled={isParkedBusy(busy, item) || undefined}
                          aria-label={`Reopen: ${ariaItemText(item.text)}`}
                          onClick={() =>
                            void run(item, () => change({ id: item.id, action: "reopen" }))
                          }
                        >
                          Reopen
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
                {resolved.length === THREAD_PARKED_RESOLVED_LIMIT ? (
                  <p className="px-1 pt-2 text-xs text-muted-foreground">
                    Older items are not shown.
                  </p>
                ) : null}
              </section>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
