import {
  type ScopedThreadRef,
  type ThreadArtifact,
  THREAD_DECIDED_WITHOUT_ASKING_LIMIT,
  THREAD_PARKED_RESOLVED_LIMIT,
  THREAD_PARKED_TEXT_MAX_LENGTH,
  type ThreadDecidedWithoutAsking,
  type ThreadDecisionQuestion,
  type ThreadDecisionsSnapshot,
  type ThreadParkedItem,
  type ThreadParkedUpdateInput,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { isPlaceholder } from "@t3tools/shared/sessionKit/parks";
import { ArrowUpRightIcon, MessageCircleQuestionIcon } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { useOpenLink } from "~/browser/useOpenLink";
import { RelativeTime } from "~/components/RelativeTime";
import { readLocalApi } from "~/localApi";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { useDecisionsPanelTab } from "./decisionsPanelTabStore";
import {
  ariaItemText,
  decidedWithoutAskingByReply,
  decisionMessages,
  isParkedBusy,
  latestReplyOpenQuestions,
  openQuestionsByReply,
  type ParkedBusy,
  parkedFocusAfter,
  resolvedQuestions,
} from "./threadDecisions.logic";

/** How the decision buttons reach the thread: an ordinary message, or text left in the composer. */
export interface ThreadDecisionActions {
  readonly canOperate: boolean;
  /** Resolves true once the message was sent or queued; failures are reported to the user. */
  readonly send: (text: string) => Promise<boolean>;
  readonly insert: (text: string) => void;
}

const STRIP_VISIBLE_ROWS = 3;

export function useThreadDecisions(
  threadRef: ScopedThreadRef | null,
): ThreadDecisionsSnapshot | null {
  return (
    useEnvironmentQuery(
      threadRef === null
        ? null
        : serverEnvironment.threadDecisionsLive({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId },
          }),
    ).data ?? null
  );
}

function QuestionActions(props: {
  readonly question: ThreadDecisionQuestion;
  readonly actions: ThreadDecisionActions;
}) {
  const { question, actions } = props;
  return (
    <span className="ms-auto flex shrink-0 items-center gap-0.5">
      <Button
        size="xs"
        variant="outline"
        disabled={!actions.canOperate || question.pick === ""}
        aria-label={`Accept ${question.label}: ${question.pick}`}
        onClick={() => void actions.send(decisionMessages.accept(question))}
      >
        Accept
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={!actions.canOperate}
        aria-label={`Answer ${question.label} in the composer`}
        onClick={() => actions.insert(decisionMessages.answer(question))}
      >
        Answer
      </Button>
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={!actions.canOperate}
        aria-label={`Drop ${question.label} as not a decision`}
        onClick={() => void actions.send(decisionMessages.drop(question))}
      >
        Drop
      </Button>
    </span>
  );
}

function QuestionLabel({ question }: { readonly question: ThreadDecisionQuestion }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 font-mono text-xs font-medium text-foreground">
        {question.label}
      </span>
      {question.keyWords === "" ? null : (
        <Badge size="sm" variant="outline" className="max-w-40">
          <span className="truncate">{question.keyWords}</span>
        </Badge>
      )}
    </span>
  );
}

function PickBadge({ question }: { readonly question: ThreadDecisionQuestion }) {
  if (question.pick === "") return null;
  return (
    <Badge size="sm" variant="info" className="max-w-48">
      <span className="truncate">pick: {question.pick}</span>
    </Badge>
  );
}

function StripRow(props: {
  readonly question: ThreadDecisionQuestion;
  readonly actions: ThreadDecisionActions;
}) {
  const { question } = props;
  return (
    <li
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 py-0.5"
      data-thread-decision={question.label}
    >
      <QuestionLabel question={question} />
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              aria-label={question.question}
              className="min-w-24 flex-1 basis-40 truncate rounded-sm text-sm text-foreground/80 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            />
          }
        >
          {question.question}
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-96">
          <p>{question.question}</p>
          {question.reason === "" ? null : (
            <p className="mt-1 text-muted-foreground">
              {question.pick}: {question.reason}
            </p>
          )}
        </TooltipPopup>
      </Tooltip>
      <PickBadge question={question} />
      <QuestionActions question={question} actions={props.actions} />
    </li>
  );
}

function StripRows(props: {
  readonly questions: ReadonlyArray<ThreadDecisionQuestion>;
  readonly actions: ThreadDecisionActions;
}) {
  const [expanded, setExpanded] = useState(false);
  const hidden = props.questions.length - STRIP_VISIBLE_ROWS;
  const shown =
    expanded || hidden <= 0 ? props.questions : props.questions.slice(0, STRIP_VISIBLE_ROWS);
  return (
    <div className="pb-1.5">
      <ul aria-label="Open questions from the latest reply">
        {shown.map((question) => (
          <StripRow key={question.label} question={question} actions={props.actions} />
        ))}
      </ul>
      {hidden > 0 ? (
        <Button size="xs" variant="ghost-muted" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show fewer" : `Show ${hidden} more`}
        </Button>
      ) : null}
    </div>
  );
}

/** The composer strip: the latest reply's open questions, or nothing. */
export function threadDecisionsBannerItem(input: {
  readonly snapshot: ThreadDecisionsSnapshot | null;
  readonly actions: ThreadDecisionActions;
  readonly onOpenPanel: () => void;
}): ComposerBannerStackItem | null {
  const questions = latestReplyOpenQuestions(input.snapshot);
  if (questions.length === 0) return null;
  const earlier = (input.snapshot?.openCount ?? 0) - questions.length;
  return {
    id: "thread-decisions",
    variant: "info",
    icon: <MessageCircleQuestionIcon />,
    title: questions.length === 1 ? "1 open question" : `${questions.length} open questions`,
    ...(earlier > 0 ? { description: `${earlier} more from earlier replies` } : {}),
    actions: (
      <Button size="xs" variant="ghost" onClick={input.onOpenPanel}>
        All decisions
      </Button>
    ),
    children: <StripRows questions={questions} actions={input.actions} />,
  };
}

function SectionHeading(props: { readonly children: React.ReactNode; readonly at?: string }) {
  return (
    <h3 className="flex items-baseline justify-between gap-2 px-1 pt-3 pb-1 text-xs font-medium text-muted-foreground">
      <span>{props.children}</span>
      {props.at === undefined ? null : (
        <span className="text-2xs font-normal">
          <RelativeTime timestamp={props.at} />
        </span>
      )}
    </h3>
  );
}

function EmptyState(props: { readonly title: string; readonly description: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
      <MessageCircleQuestionIcon aria-hidden className="size-6 text-muted-foreground/60" />
      <p className="text-sm font-medium">{props.title}</p>
      <p className="max-w-64 text-xs text-muted-foreground">{props.description}</p>
    </div>
  );
}

function OpenQuestionCard(props: {
  readonly question: ThreadDecisionQuestion;
  readonly actions: ThreadDecisionActions;
}) {
  const { question } = props;
  return (
    <li className="rounded-lg border border-border/70 p-2.5" data-thread-decision={question.label}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <QuestionLabel question={question} />
        <PickBadge question={question} />
      </div>
      <p className="mt-1.5 text-sm text-foreground wrap-anywhere">{question.question}</p>
      {question.reason === "" ? null : (
        <p className="mt-1 text-xs text-muted-foreground wrap-anywhere">{question.reason}</p>
      )}
      <div className="mt-2 flex justify-end">
        <QuestionActions question={question} actions={props.actions} />
      </div>
    </li>
  );
}

function QuestionsTab(props: {
  readonly snapshot: ThreadDecisionsSnapshot | null;
  readonly actions: ThreadDecisionActions;
}) {
  const groups = openQuestionsByReply(props.snapshot);
  if (groups.length === 0) {
    return (
      <EmptyState
        title="No open questions"
        description="Questions an agent asks at the end of a reply, as Q-labelled lines, appear here until you answer them."
      />
    );
  }
  return groups.map((group, index) => (
    <section key={group.messageId} aria-label={index === 0 ? "Latest reply" : "Earlier reply"}>
      <SectionHeading at={group.at}>
        {index === 0 ? "Latest reply" : "Earlier reply"}
      </SectionHeading>
      <ul className="flex flex-col gap-1.5">
        {group.items.map((question) => (
          <OpenQuestionCard key={question.label} question={question} actions={props.actions} />
        ))}
      </ul>
    </section>
  ));
}

function ResolvedRow(props: {
  readonly question: ThreadDecisionQuestion;
  readonly canReopen: boolean;
  readonly onReopen: (question: ThreadDecisionQuestion) => void;
}) {
  const { question } = props;
  return (
    <li className="rounded-lg border border-border/70 p-2.5" data-thread-decision={question.label}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <QuestionLabel question={question} />
        <span className="flex shrink-0 items-center gap-1.5">
          <Badge size="sm" variant={question.state === "answered" ? "success" : "secondary"}>
            {question.state}
          </Badge>
          {question.resolvedAt === null ? null : (
            <span className="text-2xs text-muted-foreground">
              <RelativeTime timestamp={question.resolvedAt} />
            </span>
          )}
        </span>
      </div>
      <p className="mt-1.5 text-sm text-foreground/80 wrap-anywhere">{question.question}</p>
      {question.answerText === null ? null : (
        <p className="mt-1 text-xs text-muted-foreground wrap-anywhere">
          <span className="font-medium text-foreground/70">You: </span>
          {question.answerText}
        </p>
      )}
      <div className="mt-2 flex justify-end">
        <Button
          size="xs"
          variant="ghost"
          disabled={!props.canReopen}
          aria-label={`Reopen ${question.label}`}
          onClick={() => props.onReopen(question)}
        >
          Reopen
        </Button>
      </div>
    </li>
  );
}

function DecisionsTab(props: {
  readonly threadRef: ScopedThreadRef;
  readonly snapshot: ThreadDecisionsSnapshot | null;
  readonly actions: ThreadDecisionActions;
}) {
  const canReopen = useAtomValue(
    serverEnvironment.reopenThreadDecision.permissionAtom(props.threadRef.environmentId),
  );
  const reopen = useAtomCommand(serverEnvironment.reopenThreadDecision, { reportFailure: true });
  const resolved = resolvedQuestions(props.snapshot);
  const unasked = decidedWithoutAskingByReply(props.snapshot);
  if (resolved.length === 0 && unasked.length === 0) {
    return (
      <EmptyState
        title="No decisions yet"
        description="Answered and dropped questions, and the choices agents list under Decided without asking, appear here."
      />
    );
  }
  const onReopen = (question: ThreadDecisionQuestion) => {
    void reopen({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId, label: question.label },
    });
  };
  return (
    <>
      {resolved.length === 0 ? null : (
        <section aria-label="Resolved questions">
          <SectionHeading>Resolved</SectionHeading>
          <ul className="flex flex-col gap-1.5">
            {resolved.map((question) => (
              <ResolvedRow
                key={question.label}
                question={question}
                canReopen={canReopen}
                onReopen={onReopen}
              />
            ))}
          </ul>
        </section>
      )}
      {unasked.map((group) => (
        <section key={group.messageId} aria-label="Decided without asking">
          <SectionHeading at={group.at}>Decided without asking</SectionHeading>
          <ul className="flex flex-col gap-1">
            {group.items.map((item) => (
              <UnaskedRow key={item.ordinal} item={item} actions={props.actions} />
            ))}
          </ul>
        </section>
      ))}
      {props.snapshot?.decidedWithoutAsking.length === THREAD_DECIDED_WITHOUT_ASKING_LIMIT ? (
        <p className="px-1 pt-2 text-xs text-muted-foreground">Older choices are in the thread.</p>
      ) : null}
    </>
  );
}

function UnaskedRow(props: {
  readonly item: ThreadDecidedWithoutAsking;
  readonly actions: ThreadDecisionActions;
}) {
  return (
    <li className="flex items-start gap-2 rounded-md px-1 py-1">
      <p className="min-w-0 flex-1 text-sm text-foreground/80 wrap-anywhere">{props.item.text}</p>
      <Button
        size="xs"
        variant="ghost"
        disabled={!props.actions.canOperate}
        aria-label={`Veto: ${ariaItemText(props.item.text)}`}
        onClick={() => props.actions.insert(decisionMessages.veto(props.item))}
      >
        Veto
      </Button>
    </li>
  );
}

const PARKED_KIND_BADGE = { todo: "outline", later: "secondary", prompt: "info" } as const;

const PARKED_STATE_BADGE = { done: "success", dropped: "secondary", sent: "info" } as const;

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

function ParkedTab(props: {
  readonly threadRef: ScopedThreadRef;
  readonly snapshot: ThreadDecisionsSnapshot | null;
  readonly actions: ThreadDecisionActions;
  readonly focusTab: () => void;
}) {
  const { environmentId, threadId } = props.threadRef;
  const { focusTab } = props;
  const canUpdate = useAtomValue(
    serverEnvironment.updateThreadParkedItem.permissionAtom(environmentId),
  );
  const update = useAtomCommand(serverEnvironment.updateThreadParkedItem, {
    reportFailure: true,
  });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [busy, setBusy] = useState<ParkedBusy>(new Map());
  const openListRef = useRef<HTMLUListElement>(null);
  // Where focus goes once the snapshot drops the item the user just sent, finished or dropped.
  const focusAfterRef = useRef<{ readonly leaving: number; readonly next: number | null } | null>(
    null,
  );
  const parked = props.snapshot?.parked ?? [];
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
            `[data-thread-parked="${pending.next}"] button`,
          );
    if (next) next.focus();
    else focusTab();
  }, [openKey, focusTab, focusAfterRef, openListRef]);
  if (parked.length === 0) {
    return (
      <EmptyState
        title="Nothing parked"
        description="Type /park and some text in the composer to set it aside for later. Agents can park follow-ups here too."
      />
    );
  }
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
    <>
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
                onSave={(text) => run(item, () => change({ id: item.id, action: "edit", text }))}
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
                    onClick={() => void run(item, () => change({ id: item.id, action: "reopen" }))}
                  >
                    Reopen
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {resolved.length === THREAD_PARKED_RESOLVED_LIMIT ? (
            <p className="px-1 pt-2 text-xs text-muted-foreground">Older items are not shown.</p>
          ) : null}
        </section>
      )}
    </>
  );
}

function ArtifactRow(props: {
  readonly artifact: ThreadArtifact;
  readonly onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly onOpenInBrowser: () => void;
}) {
  const { artifact } = props;
  const title = artifact.title ?? artifact.id;
  return (
    <li className="flex items-start gap-1 rounded-md hover:bg-accent/50">
      <button
        type="button"
        className="min-w-0 flex-1 rounded-md px-1.5 py-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={props.onOpen}
        onAuxClick={props.onOpen}
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{title}</span>
          {artifact.mentionedOnly ? (
            <span className="shrink-0 text-2xs text-muted-foreground">mentioned</span>
          ) : null}
          <span className="ms-auto shrink-0 text-2xs text-muted-foreground">
            <RelativeTime timestamp={artifact.updatedAt} />
          </span>
        </span>
        {artifact.description === null ? null : (
          <span className="block truncate text-xs text-muted-foreground">
            {artifact.description}
          </span>
        )}
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              className="mt-1"
              aria-label={`Open in browser: ${title}`}
              onClick={props.onOpenInBrowser}
            />
          }
        >
          <ArrowUpRightIcon />
        </TooltipTrigger>
        <TooltipPopup side="top">Open in browser</TooltipPopup>
      </Tooltip>
    </li>
  );
}

function ArtifactsTab(props: {
  readonly threadRef: ScopedThreadRef;
  readonly snapshot: ThreadDecisionsSnapshot | null;
}) {
  const openLink = useOpenLink(props.threadRef);
  const artifacts = props.snapshot?.artifacts ?? [];
  if (artifacts.length === 0) {
    return (
      <EmptyState
        title="No artifacts"
        description="Pages an agent publishes to claude.ai, or links to in a reply, appear here."
      />
    );
  }
  const report = (error: unknown) => {
    console.error(error);
    toastManager.add({ type: "error", title: "Unable to open artifact" });
  };
  const open = (artifact: ThreadArtifact, event: MouseEvent<HTMLButtonElement>) => {
    if (event.button > 1) return;
    void openLink(artifact.url, {
      event: { metaKey: event.metaKey, ctrlKey: event.ctrlKey, button: event.button },
    }).catch(report);
  };
  const openInBrowser = (artifact: ThreadArtifact) => {
    const api = readLocalApi();
    if (!api) return report(new Error("Link opening is unavailable."));
    void api.shell.openExternal(artifact.url).catch(report);
  };
  return (
    <>
      <ul className="flex flex-col gap-0.5 pt-3">
        {artifacts.map((artifact) => (
          <ArtifactRow
            key={artifact.id}
            artifact={artifact}
            onOpen={(event) => open(artifact, event)}
            onOpenInBrowser={() => openInBrowser(artifact)}
          />
        ))}
      </ul>
      {(props.snapshot?.artifactCount ?? 0) > artifacts.length ? (
        <p className="px-1 pt-2 text-xs text-muted-foreground">Older artifacts are not shown.</p>
      ) : null}
    </>
  );
}

export function ThreadDecisionsPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly actions: ThreadDecisionActions;
}) {
  const snapshot = useThreadDecisions(props.threadRef);
  const { tab, setTab } = useDecisionsPanelTab();
  const parkedTabRef = useRef<HTMLButtonElement>(null);
  const focusParkedTab = () => parkedTabRef.current?.focus();
  const openCount = snapshot?.openCount ?? 0;
  const parkedOpenCount = snapshot?.parkedOpenCount ?? 0;
  const artifactCount = snapshot?.artifactCount ?? 0;
  return (
    <div className="flex h-full min-h-0 flex-col" data-thread-decisions-panel>
      <div className="flex shrink-0 items-center px-3 pt-3">
        <ToggleGroup
          aria-label="Decisions view"
          variant="segmented"
          value={[tab]}
          onValueChange={(value) => {
            const next = value[0];
            if (
              next === "questions" ||
              next === "decisions" ||
              next === "parked" ||
              next === "artifacts"
            ) {
              setTab(next);
            }
          }}
        >
          <Toggle value="questions">Questions{openCount > 0 ? ` (${openCount})` : ""}</Toggle>
          <Toggle value="decisions">Decisions</Toggle>
          <Toggle ref={parkedTabRef} value="parked">
            Parked{parkedOpenCount > 0 ? ` (${parkedOpenCount})` : ""}
          </Toggle>
          <Toggle value="artifacts">
            Artifacts{artifactCount > 0 ? ` (${artifactCount})` : ""}
          </Toggle>
        </ToggleGroup>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-3 pb-3">
          {tab === "questions" ? (
            <QuestionsTab snapshot={snapshot} actions={props.actions} />
          ) : tab === "decisions" ? (
            <DecisionsTab threadRef={props.threadRef} snapshot={snapshot} actions={props.actions} />
          ) : tab === "artifacts" ? (
            <ArtifactsTab threadRef={props.threadRef} snapshot={snapshot} />
          ) : (
            <ParkedTab
              threadRef={props.threadRef}
              snapshot={snapshot}
              actions={props.actions}
              focusTab={focusParkedTab}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
