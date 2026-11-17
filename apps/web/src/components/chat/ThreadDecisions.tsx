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
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MessageCircleQuestionIcon,
  PanelRightIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import { useOpenLink } from "~/browser/useOpenLink";
import ChatMarkdown from "~/components/ChatMarkdown";
import { RelativeTime } from "~/components/RelativeTime";
import { readLocalApi } from "~/localApi";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { ScrollArea } from "../ui/scroll-area";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { OptionRadio } from "./ComposerPendingUserInputPanel";
import { useDecisionsPanelTab } from "./decisionsPanelTabStore";
import {
  answerLines,
  ariaItemText,
  decidedWithoutAskingByReply,
  decisionMessages,
  type DraftChoice,
  isParkedBusy,
  latestReplyOpenQuestions,
  nextUndrafted,
  openQuestionsByReply,
  type ParkedBusy,
  parkedFocusAfter,
  resolvedQuestions,
} from "./threadDecisions.logic";

/** How the decision buttons reach the thread: an ordinary message, or a line added to the composer. */
export interface ThreadDecisionActions {
  readonly canOperate: boolean;
  /** Resolves true once the message was sent or queued; failures are reported to the user. */
  readonly send: (text: string) => Promise<boolean>;
  /** True once the composer took the text; failures are reported to the user. */
  readonly insert: (text: string) => boolean;
  /** The open questions the composer's draft already closes, and how. */
  readonly inDraft: Readonly<Record<string, DraftChoice>>;
}

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
  const drafted = actions.inDraft[question.label] !== undefined;
  const disabled = !actions.canOperate || drafted;
  return (
    <span className="ms-auto flex shrink-0 items-center gap-0.5">
      {drafted ? (
        <Badge size="sm" variant="outline">
          in draft
        </Badge>
      ) : null}
      <Button
        size="xs"
        variant="outline"
        disabled={disabled || question.pick === ""}
        aria-label={`Accept ${question.label}: ${question.pick} (adds to your message)`}
        onClick={() => actions.insert(decisionMessages.accept(question))}
      >
        Accept
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={disabled}
        aria-label={`Answer ${question.label} in the composer`}
        onClick={() => actions.insert(decisionMessages.answer(question))}
      >
        Answer
      </Button>
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={disabled}
        aria-label={`Drop ${question.label} as not a decision (adds to your message)`}
        onClick={() => actions.insert(decisionMessages.drop(question))}
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

const OPTION_ROW =
  "group flex w-full items-start gap-2.5 rounded-md bg-transparent py-1.5 ps-2 text-start outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/25 sm:ps-1.5";

/** One answer of the composer panel, drawn like T3's own question panel's option rows. */
function OptionRow(props: {
  readonly label: string;
  readonly ariaLabel: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onChoose: () => void;
  readonly preview?: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        aria-pressed={props.selected}
        aria-label={props.ariaLabel}
        disabled={props.disabled}
        onClick={props.onChoose}
        className={cn(
          OPTION_ROW,
          "min-w-0 flex-1",
          props.selected ? "text-foreground" : "text-foreground/70",
          props.disabled
            ? cn("cursor-not-allowed", !props.selected && "opacity-50")
            : "cursor-pointer hover:bg-muted/30",
        )}
      >
        <span className="pointer-events-none flex h-5 shrink-0 items-center">
          <OptionRadio checked={props.selected} />
        </span>
        <span className="min-w-0 flex-1 text-sm font-medium wrap-anywhere">{props.label}</span>
      </button>
      {props.preview}
    </div>
  );
}

/**
 * The composer's open questions, one at a time, built like T3's AskUserQuestion panel. Mounted per
 * reply (keyed by its message), so the shown question and the collapse start over with a new one.
 */
function QuestionPanel(props: {
  readonly questions: readonly [ThreadDecisionQuestion, ...ThreadDecisionQuestion[]];
  readonly earlier: number;
  readonly actions: ThreadDecisionActions;
  readonly onOpenPanel: () => void;
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
}) {
  const { questions, actions } = props;
  // By label, never index: answered questions leave the list as the snapshot updates.
  const [currentLabel, setCurrentLabel] = useState(props.questions[0].label);
  const [collapsed, setCollapsed] = useState(false);
  const question = questions.find((q) => q.label === currentLabel) ?? questions[0];
  const index = questions.indexOf(question);
  const choice = actions.inDraft[question.label];
  const disabled = !actions.canOperate || choice !== undefined;
  const choose = (text: string, advance: boolean) => {
    if (!actions.insert(text) || !advance) return;
    const next = nextUndrafted(
      questions.map((q) => q.label),
      question.label,
      actions.inDraft,
    );
    if (next !== undefined) setCurrentLabel(next);
  };
  // From two questions up, as the transcript mod draws its "yes to all": one Accept line per question
  // the draft leaves open, so it is disabled with nothing to add.
  const yesToAllShown = questions.length > 1;
  const yesToAll = answerLines(questions, "accept", actions.inDraft);
  const yesToAllInsert =
    yesToAll.length === 0 || !actions.canOperate
      ? undefined
      : () => actions.insert(yesToAll.join("\n"));
  const goTo = (at: number) => {
    const target = questions[at];
    if (target !== undefined) setCurrentLabel(target.label);
  };
  const openTracker =
    props.earlier > 0 ? `Open Tracker (+${props.earlier} earlier)` : "Open Tracker";
  return (
    <Collapsible
      open={!collapsed}
      onOpenChange={(open) => setCollapsed(!open)}
      data-thread-decision={question.label}
    >
      <ComposerBanner.Row>
        <CollapsibleTrigger
          title={
            collapsed ? "Show the question and its answers" : "Hide the question and its answers"
          }
          className="col-[1/3] row-start-1 flex min-h-7 min-w-0 items-center gap-1 self-stretch rounded-xl ps-4 pe-2 text-start hover:bg-foreground/5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:min-h-6"
        >
          <span className="shrink-0 font-medium text-foreground">{question.label}</span>
          {question.keyWords === "" ? null : (
            <>
              <ComposerBanner.Separator />
              <span className="min-w-0 truncate text-muted-foreground">{question.keyWords}</span>
            </>
          )}
          {collapsed ? (
            <>
              <ComposerBanner.Separator />
              {/* One plain line, so the markdown's code ticks are dropped rather than shown raw. */}
              <span className="min-w-0 flex-1 truncate text-secondary-label">
                {question.question.replaceAll("`", "")}
              </span>
            </>
          ) : null}
        </CollapsibleTrigger>
        <ComposerBanner.Actions className="flex-nowrap gap-0">
          {choice === undefined ? null : (
            <span className="px-1.5 text-muted-foreground">In draft</span>
          )}
          {yesToAllShown ? (
            <Button
              size="xs"
              variant="ghost-muted"
              className="me-1"
              disabled={yesToAllInsert === undefined}
              aria-label="Yes to all (adds to your message)"
              onClick={yesToAllInsert}
            >
              Yes to all
            </Button>
          ) : null}
          {questions.length > 1 ? (
            <>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Previous question"
                disabled={index === 0}
                onClick={() => goTo(index - 1)}
              >
                <ChevronLeftIcon className="size-3.5" />
              </Button>
              <ComposerBanner.Count>
                {index + 1}/{questions.length}
              </ComposerBanner.Count>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Next question"
                disabled={index === questions.length - 1}
                onClick={() => goTo(index + 1)}
              >
                <ChevronRightIcon className="size-3.5" />
              </Button>
            </>
          ) : null}
          <CollapsibleTrigger
            render={<Button size="icon-xs" variant="ghost" />}
            aria-label={collapsed ? `Show ${question.label}` : `Hide ${question.label}`}
          >
            <ChevronDownIcon className={cn("size-3.5", collapsed && "rotate-180")} />
          </CollapsibleTrigger>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={openTracker}
                  onClick={props.onOpenPanel}
                />
              }
            >
              <PanelRightIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">{openTracker}</TooltipPopup>
          </Tooltip>
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      <CollapsiblePanel>
        <ComposerBanner.Scroll>
          <ComposerBanner.Body className="ps-6 pe-4 pb-1 wrap-anywhere sm:ps-5.5">
            <ChatMarkdown
              text={question.question}
              cwd={props.cwd}
              threadRef={props.threadRef}
              lineBreaks
              className="pt-0.5 text-foreground/85"
            />
            <div className="-ms-2 mt-1.5 sm:-ms-1.5">
              {question.pick === "" ? null : (
                <OptionRow
                  label={`Accept: ${question.pick}`}
                  ariaLabel={`Accept ${question.label}: ${question.pick} (adds to your message)`}
                  selected={choice === "accept"}
                  disabled={disabled}
                  onChoose={() => choose(decisionMessages.accept(question), true)}
                  preview={
                    question.reason === "" ? undefined : (
                      <ChatMarkdown
                        text={question.reason}
                        cwd={props.cwd}
                        threadRef={props.threadRef}
                        lineBreaks
                        className="ps-9 pe-2 pb-1.5 text-xs text-foreground/70 sm:ps-8"
                      />
                    )
                  }
                />
              )}
              <OptionRow
                label="Answer…"
                ariaLabel={`Answer ${question.label} in the composer`}
                selected={choice === "answer"}
                disabled={disabled}
                onChoose={() => choose(decisionMessages.answer(question), false)}
              />
              <OptionRow
                label="Not a decision"
                ariaLabel={`Drop ${question.label} as not a decision (adds to your message)`}
                selected={choice === "drop"}
                disabled={disabled}
                onChoose={() => choose(decisionMessages.drop(question), true)}
              />
            </div>
          </ComposerBanner.Body>
        </ComposerBanner.Scroll>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** The composer panel: the latest reply's open questions, or nothing. */
export function threadDecisionsBannerItem(input: {
  readonly snapshot: ThreadDecisionsSnapshot | null;
  readonly actions: ThreadDecisionActions;
  readonly onOpenPanel: () => void;
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
}): ComposerBannerStackItem | null {
  const [first, ...rest] = latestReplyOpenQuestions(input.snapshot);
  if (first === undefined) return null;
  return {
    id: "thread-decisions",
    variant: "info",
    // The panel draws its own header, so the notice row's icon and title are not used.
    icon: null,
    title: null,
    content: (
      <QuestionPanel
        key={first.sourceMessageId}
        questions={[first, ...rest]}
        earlier={(input.snapshot?.openCount ?? 0) - rest.length - 1}
        actions={input.actions}
        onOpenPanel={input.onOpenPanel}
        threadRef={input.threadRef}
        cwd={input.cwd}
      />
    ),
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
          aria-label="Tracker view"
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
