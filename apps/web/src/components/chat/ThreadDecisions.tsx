/* oxlint-disable t3code/no-untranslated-copy -- Fork-only English copy: upstream's translation catalogs have no entries for it, so wrapping it would change nothing on screen. FORK.md, "Translation". */
import {
  MessageId,
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
  PencilLineIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import {
  createContext,
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import { useOpenLink } from "~/browser/useOpenLink";
import { collapseExpandedComposerCursor } from "~/composer-logic";
import { assistantCitationNavigation } from "~/lib/assistantCitationNavigation";
import { readThreadShell } from "~/state/entities";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useStableCallback } from "~/hooks/useStableCallback";
import ChatMarkdown from "~/components/ChatMarkdown";
import { RelativeTime } from "~/components/RelativeTime";
import { readLocalApi } from "~/localApi";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { ScrollArea } from "../ui/scroll-area";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import type { ChatComposerHandle, ChatComposerProps } from "./ChatComposer";
import { OptionRadio } from "./ComposerPendingUserInputPanel";
import { useDecisionsPanelTab } from "./decisionsPanelTabStore";
import {
  acceptsPick,
  answerLines,
  ariaItemText,
  choicesToReview,
  decidedWithoutAskingByReply,
  decisionMessages,
  type DraftChoice,
  draftLineOf,
  draftSummary,
  groupSelection,
  isParkedBusy,
  latestReplyOpenQuestions,
  lineEnd,
  nextUndrafted,
  openQuestions,
  openQuestionsByReply,
  type ParkedBusy,
  parkedFocusAfter,
  plural,
  resolvedQuestions,
  unfinishedLabels,
  vetoInDraft,
  withoutLine,
} from "./threadDecisions.logic";

/** How the decision buttons reach the thread: an ordinary message, or a line added to the composer. */
export interface ThreadDecisionActions {
  readonly canOperate: boolean;
  /** Resolves true once the message was sent or queued; failures are reported to the user. */
  readonly send: (text: string) => Promise<boolean>;
  /**
   * True once the composer took the text; failures are reported to the user. The composer takes
   * focus unless `focus` is false (the Tracker keeps it, so rows can be answered one after another).
   */
  readonly insert: (text: string, options?: { readonly focus?: boolean }) => boolean;
  /**
   * Sends the draft as the composer's send button does, so a busy run queues or steers as the user
   * set. Resolves true once sent or queued.
   */
  readonly sendDraft: () => Promise<boolean>;
  /** Puts the caret at the end of the draft's line in the composer; at the draft's end for null. */
  readonly focusLine: (line: string | null) => void;
  /** Takes the draft's line out of the composer. */
  readonly removeLine: (line: string) => void;
  /** The composer's draft text. */
  readonly draft: string;
  /**
   * The composer is answering T3's own pending question, so what it shows is that answer, not the
   * draft: the Tracker's line edits and Send draft wait.
   */
  readonly answeringPendingInput: boolean;
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

/**
 * The draft actions the Tracker needs from the composer. Kept out of ChatView's body so the callbacks
 * hold these inputs, never a render's thread state.
 */
export function useDraftActions(input: {
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly promptRef: RefObject<string>;
  /** The composer's send in flight, which `submit` starts. */
  readonly sendingRef: RefObject<Promise<void> | null>;
  readonly draftTarget: ChatComposerProps["composerDraftTarget"];
}): Pick<ThreadDecisionActions, "sendDraft" | "focusLine" | "removeLine"> {
  const { composerRef, promptRef, sendingRef, draftTarget } = input;
  const sendDraft = useStableCallback(async () => {
    const composer = composerRef.current;
    if (composer === null) return false;
    sendingRef.current = null;
    const submitted = composer.submit();
    // Every other refusal already told the user why.
    if (submitted === "blocked") {
      toastManager.add({
        type: "warning",
        title: "Not sent",
        description: "The composer cannot send right now, so your draft is as it was.",
      });
    }
    if (submitted !== "sent") return false;
    try {
      await sendingRef.current;
      return true;
    } catch {
      // A failed send is T3's to report, and T3 puts the draft back.
      return false;
    }
  });
  // The draft from the store: while T3's own question is answered, the composer's prompt is that answer.
  const readDraft = () =>
    useComposerDraftStore.getState().getComposerDraft(draftTarget)?.prompt ?? "";
  const focusLine = useStableCallback((line: string | null) => {
    const composer = composerRef.current;
    const prompt = readDraft();
    const end = line === null ? null : lineEnd(prompt, line);
    if (end === null) composer?.focusAtEnd();
    else composer?.focusAt(collapseExpandedComposerCursor(prompt, end));
  });
  const removeLine = useStableCallback((line: string) => {
    const prompt = readDraft();
    const next = withoutLine(prompt, line);
    if (next === prompt) return;
    promptRef.current = next;
    useComposerDraftStore.getState().setPrompt(draftTarget, next);
    composerRef.current?.resetCursorState({ prompt: next, cursor: next.length });
  });
  return { sendDraft, focusLine, removeLine };
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

const CHIP_TONES = {
  open: "bg-warning-surface text-warning-foreground",
  draft: "bg-tracker-draft/12 text-tracker-draft",
  answered: "bg-success/8 text-success-foreground dark:bg-success/16",
  dropped: "bg-muted text-secondary-foreground",
} as const;

/** A question's label, coloured by its state; the state is also said in words beside it or above it. */
function StateChip(props: { readonly label: string; readonly tone: keyof typeof CHIP_TONES }) {
  return (
    <span
      className={cn(
        "inline-flex h-4.5 shrink-0 items-center rounded-sm px-1 font-mono text-xs font-medium",
        CHIP_TONES[props.tone],
      )}
    >
      {props.label}
    </span>
  );
}

/** A line as it stands in the draft, in the draft colour. */
function DraftLineCode(props: { readonly line: string }) {
  return (
    <code className="min-w-0 truncate rounded-sm bg-tracker-draft/10 px-1 font-mono text-xs text-tracker-draft">
      {props.line}
    </code>
  );
}

/** Where focus goes once an action re-renders the panel: a row, and its controls in order of preference. */
interface FocusTarget {
  readonly row: string;
  readonly controls: ReadonlyArray<string>;
}

/**
 * Moves focus after a Tracker action that replaces the clicked control (Accept becomes Edit, Remove
 * brings Accept back), so a keyboard user can go on to the next row. Rows carry `data-tracker-row`,
 * controls `data-tracker-control`.
 */
const FocusAfterContext = createContext<(target: FocusTarget) => void>(() => {});

function useFocusAfter(panelRef: RefObject<HTMLElement | null>) {
  const pending = useRef<FocusTarget | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus to a control the last action's re-render brought in
  useLayoutEffect(() => {
    const target = pending.current;
    const panel = panelRef.current;
    if (target === null || panel === null) return;
    // Focus that fell to the body with the clicked control is the panel's to move; anywhere else,
    // the user moved it.
    const active = document.activeElement;
    if (active !== null && active !== document.body && !panel.contains(active)) {
      pending.current = null;
      return;
    }
    const row = panel.querySelector(`[data-tracker-row="${CSS.escape(target.row)}"]`);
    for (const control of target.controls) {
      const element = row?.querySelector(`[data-tracker-control="${control}"]`);
      if (element instanceof HTMLElement) {
        pending.current = null;
        element.focus();
        return;
      }
    }
  });
  return (target: FocusTarget) => {
    pending.current = target;
  };
}

/** The bar under the tabs: a tab's counts, and its mode's control. */
function StatusBar(props: { readonly children: ReactNode }) {
  return (
    <div
      data-tracker-row="status"
      className="flex min-h-9 shrink-0 items-center gap-1.5 border-b border-border px-4 py-1 text-xs text-muted-foreground"
    >
      {props.children}
    </div>
  );
}

function Dot() {
  return <span aria-hidden>·</span>;
}

/**
 * A reply's text to cite so the chat shows it: T3's citation reveal scrolls to the message and
 * highlights the quote. Markdown marks are dropped, as the rendered reply drops them.
 */
const replyQuote = (text: string) => text.replaceAll("`", "").replaceAll("**", "").slice(0, 80);

/** Shows a reply in the chat, through the same reveal a quote's citation uses. */
function useShowReply(threadRef: ScopedThreadRef) {
  const navigate = useNavigate();
  return (messageId: MessageId, quote: string) => {
    const text = replyQuote(quote);
    void navigate(
      assistantCitationNavigation(
        {
          version: 1,
          environmentId: threadRef.environmentId,
          threadId: threadRef.threadId,
          messageId,
          text,
          // No real offsets or context: the reveal then finds a quote that occurs once in the reply.
          start: 0,
          end: text.length,
          prefix: "",
          suffix: "",
        },
        readThreadShell(threadRef),
      ),
    );
  };
}

/** A reply group's heading: which reply, its age, and a button that shows it in the chat. */
function ReplyHeading(props: {
  readonly title: string;
  readonly at: string;
  readonly onShow: () => void;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex min-h-8 items-center gap-1.5 ps-4 pe-3 pt-3 text-xs text-muted-foreground">
      <span className="font-medium text-foreground/80">{props.title}</span>
      <Dot />
      <RelativeTime timestamp={props.at} />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Show the ${props.title.toLowerCase()} in the chat`}
              onClick={props.onShow}
            />
          }
        >
          <ArrowUpRightIcon />
        </TooltipTrigger>
        <TooltipPopup side="top">Show in the chat</TooltipPopup>
      </Tooltip>
      {props.children === undefined ? null : <span className="ms-auto">{props.children}</span>}
    </div>
  );
}

/** "Pick: <pick>." and the reason, in the pick colour; nothing for a question without a pick. */
function PickLine(props: { readonly question: ThreadDecisionQuestion }) {
  const { question } = props;
  if (question.pick === "") return null;
  return (
    <div className="mt-1 text-xs text-muted-foreground wrap-anywhere">
      <span className="font-medium text-tracker-pick">Pick: {question.pick}.</span>{" "}
      {/* Inline, so the reason runs on after the pick as one paragraph. */}
      <ChatMarkdown
        text={question.reason}
        cwd={undefined}
        className="inline text-xs [&_p]:inline"
      />
    </div>
  );
}

function QuestionBody(props: { readonly question: ThreadDecisionQuestion }) {
  const { question } = props;
  return (
    <>
      <ChatMarkdown text={question.question} cwd={undefined} lineBreaks className="mt-1 text-sm" />
      <PickLine question={question} />
    </>
  );
}

/** An open question in the Questions tab: its answers, or its line once the draft holds one. */
function QuestionRow(props: {
  readonly question: ThreadDecisionQuestion;
  readonly open: ReadonlyArray<ThreadDecisionQuestion>;
  readonly actions: ThreadDecisionActions;
}) {
  const { question, actions } = props;
  const focusAfter = useContext(FocusAfterContext);
  const drafted = actions.inDraft[question.label] !== undefined;
  const line = drafted ? draftLineOf(actions.draft, question, props.open) : null;
  // Accept and Not a decision keep focus in the panel, on the row's Edit once it is drafted.
  const answer = (text: string) => {
    if (actions.insert(text, { focus: false })) {
      focusAfter({ row: question.label, controls: ["edit", "edit-in-composer"] });
    }
  };
  return (
    <li
      className="border-b border-border px-4 py-2.5"
      data-thread-decision={question.label}
      data-tracker-row={question.label}
    >
      <div className="flex min-h-5 items-center gap-2">
        <StateChip label={question.label} tone={drafted ? "draft" : "open"} />
        <span className="min-w-0 truncate text-xs text-muted-foreground">{question.keyWords}</span>
        {drafted ? (
          <span className="ms-auto shrink-0 text-xs font-medium text-tracker-draft">In draft</span>
        ) : null}
      </div>
      <QuestionBody question={question} />
      {drafted ? (
        <div className="mt-1.5 flex min-w-0 items-center gap-1">
          {line === null ? null : <DraftLineCode line={line.line} />}
          <span className="ms-auto flex shrink-0 items-center">
            {line?.own ? (
              <>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={actions.answeringPendingInput}
                  data-tracker-control="edit"
                  aria-label={`Edit ${question.label}'s line in the composer`}
                  onClick={() => actions.focusLine(line.line)}
                >
                  Edit
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={actions.answeringPendingInput}
                  aria-label={`Remove ${question.label}'s line from your draft`}
                  onClick={() => {
                    actions.removeLine(line.line);
                    focusAfter({ row: question.label, controls: ["accept", "answer"] });
                  }}
                >
                  Remove
                </Button>
              </>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                disabled={actions.answeringPendingInput}
                data-tracker-control="edit-in-composer"
                aria-label={`Edit the line that answers ${question.label} in the composer`}
                onClick={() => actions.focusLine(line?.line ?? null)}
              >
                Edit in composer
              </Button>
            )}
          </span>
        </div>
      ) : (
        <div className="-ms-2 mt-1 flex flex-wrap items-center">
          {question.pick === "" ? null : (
            <Button
              size="xs"
              variant="ghost"
              disabled={!actions.canOperate}
              data-tracker-control="accept"
              aria-label={`Accept ${question.label}: ${question.pick} (adds to your draft)`}
              onClick={() => answer(decisionMessages.accept(question))}
            >
              <span className="font-medium text-tracker-pick">Accept: {question.pick}</span>
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            disabled={!actions.canOperate}
            data-tracker-control="answer"
            aria-label={`Answer ${question.label} in your draft`}
            onClick={() => actions.insert(decisionMessages.answer(question))}
          >
            Answer…
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={!actions.canOperate}
            aria-label={`${question.label} is not a decision (adds to your draft)`}
            onClick={() => answer(decisionMessages.drop(question))}
          >
            Not a decision
          </Button>
        </div>
      )}
    </li>
  );
}

/** A question in Select mode: the whole row toggles it; one the draft holds cannot be selected. */
function SelectableRow(props: {
  readonly question: ThreadDecisionQuestion;
  readonly drafted: boolean;
  readonly selected: boolean;
  readonly onToggle: () => void;
}) {
  const { question, drafted, selected } = props;
  return (
    <li data-thread-decision={question.label}>
      <label
        className={cn(
          "grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 border-b border-border py-2.5 pe-4",
          drafted ? "cursor-default" : "cursor-pointer",
          selected ? "border-s-2 border-s-ring bg-info/8 ps-3.5" : "ps-4",
        )}
      >
        <Checkbox
          className="mt-0.5"
          checked={selected}
          disabled={drafted}
          aria-label={
            drafted ? `${question.label} is already in your draft` : `Select ${question.label}`
          }
          onCheckedChange={props.onToggle}
        />
        <div className="min-w-0">
          <div className="flex min-h-5 items-center gap-2">
            <StateChip label={question.label} tone={drafted ? "draft" : "open"} />
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {question.keyWords}
            </span>
            {drafted ? (
              <span className="ms-auto shrink-0 text-xs font-medium text-tracker-draft">
                In draft
              </span>
            ) : null}
          </div>
          <QuestionBody question={question} />
        </div>
      </label>
    </li>
  );
}

type BulkChoice = "accept" | "drop";

/** Select mode's dock: what the selection adds, shown against the whole draft, and one Add. */
function SelectDock(props: {
  readonly selected: ReadonlyArray<ThreadDecisionQuestion>;
  readonly actions: ThreadDecisionActions;
  readonly onClear: () => void;
  readonly onAdded: () => void;
}) {
  const { selected, actions } = props;
  const [choice, setChoice] = useState<BulkChoice>("accept");
  const added = answerLines(selected, choice, actions.inDraft);
  const skipped = choice === "accept" ? selected.filter((question) => question.pick === "") : [];
  const existing = actions.draft.split("\n").filter((line) => line.trim() !== "");
  const replies = new Set(selected.map((question) => question.sourceMessageId)).size;
  const previewRef = useRef<HTMLDivElement>(null);
  const addedKey = added.join("\n");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the capped preview to the lines this action adds, which come last
  useLayoutEffect(() => {
    const preview = previewRef.current;
    // Nothing to add, nothing to show.
    if (preview !== null && addedKey !== "") preview.scrollTop = preview.scrollHeight;
  }, [addedKey, previewRef]);
  const add = () => {
    if (actions.insert(added.join("\n"), { focus: false })) props.onAdded();
  };
  return (
    <section
      aria-label={`Answer ${plural(selected.length, "selected question")}`}
      className="shrink-0 border-t border-border bg-muted px-4 pt-2.5 pb-3"
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{selected.length} selected</span>
        <Dot />
        <span>from {plural(replies, "reply", "replies")}</span>
        <Button
          size="xs"
          variant="ghost"
          className="ms-auto"
          disabled={selected.length === 0}
          onClick={props.onClear}
        >
          Clear
        </Button>
      </div>
      <RadioGroup
        aria-label="Answer the selected questions with"
        value={choice}
        onValueChange={(value) => setChoice(value === "drop" ? "drop" : "accept")}
        className="mt-2 flex-row"
      >
        <Label className="cursor-pointer">
          <Radio value="accept" />
          Accept picks
        </Label>
        <Label className="cursor-pointer">
          <Radio value="drop" />
          Not a decision
        </Label>
      </RadioGroup>
      {existing.length + added.length === 0 ? null : (
        <div
          ref={previewRef}
          role="group"
          // Focusable, so the capped preview scrolls from the keyboard too.
          tabIndex={0}
          aria-label="Your draft after this action"
          className="mt-2.5 max-h-24 overflow-y-auto rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs leading-relaxed text-muted-foreground wrap-anywhere"
        >
          {existing.map((line, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- draft lines can repeat; their order is their identity
            <div key={`existing-${index}`} className="grid grid-cols-[1rem_minmax(0,1fr)]">
              <span />
              <span>{line}</span>
            </div>
          ))}
          {added.map((line) => (
            <div key={line} className="grid grid-cols-[1rem_minmax(0,1fr)] text-foreground">
              <span className="text-info-foreground">
                <span aria-hidden>+</span>
                <span className="sr-only">Adds </span>
              </span>
              <span>{line}</span>
            </div>
          ))}
        </div>
      )}
      {skipped.length === 0 ? null : (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Skipped, no pick: {skipped.map((question) => question.label).join(", ")}
        </p>
      )}
      <div className="mt-2.5 flex items-center gap-2">
        <Button size="sm" disabled={added.length === 0 || !actions.canOperate} onClick={add}>
          Add {added.length} to draft
        </Button>
        <span className="ms-auto text-xs text-muted-foreground">Send from the draft bar</span>
      </div>
    </section>
  );
}

const replyTitle = (index: number) => (index === 0 ? "Latest reply" : "Earlier reply");

function QuestionsTab(props: {
  readonly threadRef: ScopedThreadRef;
  readonly snapshot: ThreadDecisionsSnapshot | null;
  readonly actions: ThreadDecisionActions;
  readonly selecting: boolean;
  readonly onSelecting: (selecting: boolean) => void;
}) {
  const { actions, selecting } = props;
  const showReply = useShowReply(props.threadRef);
  const focusAfter = useContext(FocusAfterContext);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const groups = openQuestionsByReply(props.snapshot);
  const open = openQuestions(props.snapshot);
  // A selection ends with Select mode, however it ends.
  if (!selecting && selected.size > 0) setSelected(new Set());
  if (groups.length === 0) {
    return (
      <EmptyState
        title="No open questions"
        description="Questions an agent asks at the end of a reply, as Q-labelled lines, appear here until you answer them."
      />
    );
  }
  const drafted = (question: ThreadDecisionQuestion) =>
    actions.inDraft[question.label] !== undefined;
  const inDraftCount = open.filter(drafted).length;
  // What the draft now holds cannot stay selected.
  const selectedQuestions = open.filter(
    (question) => selected.has(question.label) && !drafted(question),
  );
  const toggle = (labels: ReadonlyArray<string>, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const label of labels) {
        if (on) next.add(label);
        else next.delete(label);
      }
      return next;
    });
  const stopSelecting = () => {
    setSelected(new Set());
    props.onSelecting(false);
  };
  return (
    <>
      <StatusBar>
        {selecting ? (
          <>
            <span className="font-medium text-info-foreground">Selecting</span>
            <Dot />
            <span className="min-w-0 truncate">questions in your draft can't be selected</span>
            <Button size="xs" variant="ghost" className="ms-auto" onClick={stopSelecting}>
              Done
            </Button>
          </>
        ) : (
          <>
            <span>{open.length - inDraftCount} to answer</span>
            {inDraftCount > 0 ? (
              <>
                <Dot />
                <span className="text-tracker-draft">{inDraftCount} in draft</span>
              </>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              className="ms-auto"
              disabled={!actions.canOperate}
              data-tracker-control="select"
              onClick={() => props.onSelecting(true)}
            >
              Select
            </Button>
          </>
        )}
      </StatusBar>
      <ScrollArea className="min-h-0 flex-1">
        {groups.map((group, index) => {
          const title = replyTitle(index);
          const [first] = group.items;
          const show = () =>
            showReply(
              MessageId.make(group.messageId),
              first === undefined || first.keyWords === ""
                ? (first?.label ?? "")
                : `${first.label}, ${first.keyWords}`,
            );
          const selectable = group.items.filter((question) => !drafted(question));
          const picks = answerLines(group.items, "accept", actions.inDraft);
          return (
            <section key={group.messageId} aria-label={title}>
              {selecting ? (
                <label className="flex min-h-8 cursor-pointer items-center gap-2.5 ps-4 pe-3 pt-3 text-xs text-muted-foreground">
                  <GroupCheckbox
                    title={title}
                    selectable={selectable.map((question) => question.label)}
                    selected={selected}
                    onChange={(on) =>
                      toggle(
                        selectable.map((question) => question.label),
                        on,
                      )
                    }
                  />
                  <span className="font-medium text-foreground/80">{title}</span>
                  <Dot />
                  <RelativeTime timestamp={group.at} />
                </label>
              ) : (
                <ReplyHeading title={title} at={group.at} onShow={show}>
                  {picks.length === 0 ? null : (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!actions.canOperate}
                      aria-label={`Accept ${plural(picks.length, "pick")} (adds ${picks.join(", ")} to your draft)`}
                      onClick={() => {
                        if (!actions.insert(picks.join("\n"), { focus: false })) return;
                        // The button leaves at zero; the first row it answered takes focus.
                        const label = group.items.find(
                          (question) => !drafted(question) && question.pick !== "",
                        )?.label;
                        if (label !== undefined) {
                          focusAfter({ row: label, controls: ["edit", "edit-in-composer"] });
                        }
                      }}
                    >
                      <span className="font-medium text-tracker-pick">
                        Accept {plural(picks.length, "pick")}
                      </span>
                    </Button>
                  )}
                </ReplyHeading>
              )}
              <ul>
                {group.items.map((question) =>
                  selecting ? (
                    <SelectableRow
                      key={question.label}
                      question={question}
                      drafted={drafted(question)}
                      selected={selected.has(question.label) && !drafted(question)}
                      onToggle={() => toggle([question.label], !selected.has(question.label))}
                    />
                  ) : (
                    <QuestionRow
                      key={question.label}
                      question={question}
                      open={open}
                      actions={actions}
                    />
                  ),
                )}
              </ul>
            </section>
          );
        })}
      </ScrollArea>
      {selecting ? (
        <SelectDock
          selected={selectedQuestions}
          actions={actions}
          onClear={() => setSelected(new Set())}
          onAdded={() => {
            stopSelecting();
            focusAfter({ row: "status", controls: ["select"] });
          }}
        />
      ) : null}
    </>
  );
}

function GroupCheckbox(props: {
  readonly title: string;
  readonly selectable: ReadonlyArray<string>;
  readonly selected: ReadonlySet<string>;
  readonly onChange: (on: boolean) => void;
}) {
  const state = groupSelection(props.selectable, props.selected);
  return (
    <Checkbox
      checked={state === true}
      indeterminate={state === "mixed"}
      disabled={props.selectable.length === 0}
      aria-label={`Select every question of the ${props.title.toLowerCase()} you can select`}
      onCheckedChange={() => props.onChange(state !== true)}
    />
  );
}

/** How long Reopen waits for an Undo before it reopens the question. */
const REOPEN_UNDO_MS = 5_000;

/**
 * Reopen, held back while its toast offers Undo; the only Tracker action that skips the draft. Held
 * by the panel, so a tab switch keeps the toast's Undo working; when the panel goes, what is still
 * held goes ahead, since the user asked for it.
 */
function useReopenWithUndo() {
  const reopen = useAtomCommand(serverEnvironment.reopenThreadDecision, { reportFailure: true });
  const held = useRef(
    new Map<
      string,
      { readonly timer: number; readonly toastId: string; readonly run: () => void }
    >(),
  );
  // Held, or sent and not yet failed. A sent reopen leaves its row once the snapshot shows the
  // question open; the key carries resolvedAt, so a question answered again starts afresh.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const unpend = (key: string) =>
    setPending((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  const release = (key: string) => {
    const entry = held.current.get(key);
    if (entry === undefined) return undefined;
    held.current.delete(key);
    window.clearTimeout(entry.timer);
    toastManager.close(entry.toastId);
    return entry;
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs the reopens still held back when the panel unmounts
  useEffect(() => {
    const entries = held.current;
    return () => {
      for (const entry of entries.values()) {
        window.clearTimeout(entry.timer);
        toastManager.close(entry.toastId);
        entry.run();
      }
      entries.clear();
    };
  }, [held]);
  const keyOf = (threadRef: ScopedThreadRef, question: ThreadDecisionQuestion) =>
    `${threadRef.threadId}:${question.label}:${question.resolvedAt ?? ""}`;
  const start = (threadRef: ScopedThreadRef, question: ThreadDecisionQuestion) => {
    const key = keyOf(threadRef, question);
    if (pending.has(key)) return;
    // The thread is fixed now, so a panel that moves to another thread still reopens this one.
    const run = () =>
      void reopen({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, label: question.label },
      }).then((result) => {
        // A failed reopen was reported; its row may be tried again.
        if (result._tag !== "Success") unpend(key);
      });
    const goAhead = () => release(key)?.run();
    const toastId = toastManager.add({
      type: "info",
      title: `Reopening ${question.label}`,
      description: "It goes back to Questions.",
      timeout: 0,
      actionProps: {
        children: "Undo",
        onClick: () => {
          if (release(key) !== undefined) unpend(key);
        },
      },
      data: { onClose: goAhead },
    });
    held.current.set(key, { timer: window.setTimeout(goAhead, REOPEN_UNDO_MS), toastId, run });
    setPending((current) => new Set(current).add(key));
  };
  return {
    isPending: (threadRef: ScopedThreadRef, question: ThreadDecisionQuestion) =>
      pending.has(keyOf(threadRef, question)),
    start,
  };
}

type ReopenWithUndo = ReturnType<typeof useReopenWithUndo>;

function ResolvedRow(props: {
  readonly question: ThreadDecisionQuestion;
  readonly canReopen: boolean;
  readonly reopening: boolean;
  readonly onReopen: () => void;
}) {
  const { question } = props;
  const answered = question.state === "answered";
  const departed =
    answered &&
    question.pick !== "" &&
    question.answerText !== null &&
    !acceptsPick(question.answerText, question);
  return (
    <li className="border-b border-border ps-4 pe-3 py-2.5" data-thread-decision={question.label}>
      <div className="flex min-h-6 items-center gap-2">
        <StateChip label={question.label} tone={answered ? "answered" : "dropped"} />
        <span className="min-w-0 truncate text-xs text-muted-foreground">{question.keyWords}</span>
        <span className="ms-auto shrink-0 text-xs text-muted-foreground">
          {question.resolvedAt === null ? null : <RelativeTime timestamp={question.resolvedAt} />}
        </span>
        <Button
          size="xs"
          variant="ghost"
          disabled={!props.canReopen || props.reopening}
          aria-label={`Reopen ${question.label}`}
          onClick={props.onReopen}
        >
          {props.reopening ? "Reopening…" : "Reopen"}
        </Button>
      </div>
      <ChatMarkdown
        text={question.question}
        cwd={undefined}
        lineBreaks
        className="mt-1 text-sm text-muted-foreground"
      />
      {question.answerText === null ? null : (
        <p className="mt-0.5 text-sm whitespace-pre-wrap wrap-anywhere">
          <span className="me-1.5 text-xs font-semibold text-success-foreground">You</span>
          {question.answerText}
        </p>
      )}
      {departed ? (
        <p className="mt-0.5 text-xs text-tracker-pick wrap-anywhere">Pick was: {question.pick}</p>
      ) : null}
    </li>
  );
}

function UnaskedRow(props: {
  readonly item: ThreadDecidedWithoutAsking;
  readonly actions: ThreadDecisionActions;
}) {
  const { item, actions } = props;
  const focusAfter = useContext(FocusAfterContext);
  const row = `veto:${item.messageId}:${item.ordinal}`;
  const line = decisionMessages.veto(item);
  const drafted = !item.vetoed && vetoInDraft(actions.draft, item);
  return (
    <li
      className="flex items-start gap-2.5 border-b border-border py-2 ps-4 pe-3"
      data-tracker-row={row}
    >
      <span
        aria-hidden
        className={cn(
          "w-0.75 self-stretch rounded-full",
          item.vetoed ? "bg-border" : drafted ? "bg-tracker-draft" : "bg-tracker-agent",
        )}
      />
      <div className="min-w-0 flex-1">
        <ChatMarkdown text={item.text} cwd={undefined} lineBreaks className="text-sm" />
        {drafted ? (
          <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs">
            <span className="shrink-0 font-medium text-tracker-draft">In draft</span>
            <DraftLineCode line={line} />
            <Button
              size="xs"
              variant="ghost"
              className="ms-auto"
              disabled={actions.answeringPendingInput}
              data-tracker-control="remove"
              aria-label={`Remove the veto from your draft: ${ariaItemText(item.text)}`}
              onClick={() => {
                actions.removeLine(line);
                focusAfter({ row, controls: ["veto"] });
              }}
            >
              Remove
            </Button>
          </div>
        ) : null}
      </div>
      {item.vetoed ? (
        <span className="shrink-0 py-0.5 text-xs font-medium text-muted-foreground">Vetoed</span>
      ) : drafted ? null : (
        <Button
          size="xs"
          variant="ghost"
          disabled={!actions.canOperate}
          data-tracker-control="veto"
          aria-label={`Veto: ${ariaItemText(item.text)} (adds to your draft)`}
          onClick={() => {
            if (actions.insert(line, { focus: false })) focusAfter({ row, controls: ["remove"] });
          }}
        >
          <span className="font-medium text-tracker-agent">Veto</span>
        </Button>
      )}
    </li>
  );
}

function DecisionsTab(props: {
  readonly threadRef: ScopedThreadRef;
  readonly snapshot: ThreadDecisionsSnapshot | null;
  readonly actions: ThreadDecisionActions;
  readonly reopen: ReopenWithUndo;
}) {
  const { threadRef, snapshot, actions, reopen } = props;
  const canReopen = useAtomValue(
    serverEnvironment.reopenThreadDecision.permissionAtom(threadRef.environmentId),
  );
  const showReply = useShowReply(threadRef);
  const resolved = resolvedQuestions(snapshot);
  const unasked = decidedWithoutAskingByReply(snapshot);
  if (resolved.length === 0 && unasked.length === 0) {
    return (
      <EmptyState
        title="No decisions yet"
        description="Answered and dropped questions, and the choices agents list under Decided without asking, appear here."
      />
    );
  }
  const answered = resolved.filter((question) => question.state === "answered");
  const dropped = resolved.filter((question) => question.state !== "answered");
  const toReview = choicesToReview(snapshot, actions.draft);
  const vetoesInDraft = (snapshot?.decidedWithoutAsking ?? []).filter(
    (item) => !item.vetoed && vetoInDraft(actions.draft, item),
  ).length;
  const counts = [
    ...(vetoesInDraft > 0 ? [`${plural(vetoesInDraft, "veto", "vetoes")} in draft`] : []),
    ...(answered.length > 0 ? [`${answered.length} answered`] : []),
    ...(dropped.length > 0 ? [`${dropped.length} not a decision`] : []),
  ];
  const resolvedSection = (title: string, questions: ReadonlyArray<ThreadDecisionQuestion>) =>
    questions.length === 0 ? null : (
      <section aria-label={title}>
        <h3 className="ps-4 pe-3 pt-5 pb-1 text-xs font-medium text-foreground/80">{title}</h3>
        <ul>
          {questions.map((question) => (
            <ResolvedRow
              key={question.label}
              question={question}
              canReopen={canReopen}
              reopening={reopen.isPending(threadRef, question)}
              onReopen={() => reopen.start(threadRef, question)}
            />
          ))}
        </ul>
      </section>
    );
  return (
    <>
      <StatusBar>
        <span className={cn(toReview > 0 && "text-tracker-agent")}>
          {plural(toReview, "choice")} to review
        </span>
        {counts.map((count) => (
          <Fragment key={count}>
            <Dot />
            <span>{count}</span>
          </Fragment>
        ))}
      </StatusBar>
      <ScrollArea className="min-h-0 flex-1">
        {unasked.map((group, index) => {
          const [first] = group.items;
          return (
            <section key={group.messageId} aria-label="Decided without asking">
              <ReplyHeading
                title={`Decided without asking · ${replyTitle(index).toLowerCase()}`}
                at={group.at}
                onShow={() => showReply(MessageId.make(group.messageId), first?.text ?? "")}
              />
              <ul>
                {group.items.map((item) => (
                  <UnaskedRow key={item.ordinal} item={item} actions={actions} />
                ))}
              </ul>
            </section>
          );
        })}
        {snapshot?.decidedWithoutAsking.length === THREAD_DECIDED_WITHOUT_ASKING_LIMIT ? (
          <p className="px-4 pt-2 text-xs text-muted-foreground">
            Older choices are in the thread.
          </p>
        ) : null}
        {resolvedSection("Answered", answered)}
        {resolvedSection("Not a decision", dropped)}
      </ScrollArea>
    </>
  );
}

/** The draft's summary on every tab while it has content, and the composer's own send. */
function DraftBar(props: {
  readonly snapshot: ThreadDecisionsSnapshot | null;
  readonly actions: ThreadDecisionActions;
}) {
  const { actions } = props;
  // One send at a time: a second click while the first is in flight would send twice.
  const [sending, setSending] = useState(false);
  const open = openQuestions(props.snapshot);
  const summary = draftSummary(actions.draft, open, actions.inDraft);
  // A bare `Qn: ` from Answer… is a place to type, not an answer, so it is not sent as one.
  const unfinished = unfinishedLabels(actions.draft, open);
  const send = () => {
    setSending(true);
    void actions.sendDraft().finally(() => setSending(false));
  };
  return (
    <section
      aria-label="Your draft"
      className="flex shrink-0 items-center gap-2 border-t border-border bg-muted px-4 py-2 text-xs text-muted-foreground"
    >
      <PencilLineIcon aria-hidden className="size-3.5 shrink-0 text-tracker-draft" />
      <span className="font-medium text-foreground">Draft</span>
      <Dot />
      <span className="min-w-0 truncate">{summary}</span>
      <Button size="xs" variant="ghost" className="ms-auto" onClick={() => actions.focusLine(null)}>
        Review
      </Button>
      <Button
        size="sm"
        disabled={
          !actions.canOperate || sending || unfinished.length > 0 || actions.answeringPendingInput
        }
        onClick={send}
      >
        Send draft
      </Button>
    </section>
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

function TabLabel(props: { readonly name: string; readonly count: number }) {
  return (
    <>
      {props.name}
      {props.count > 0 ? (
        <span className="font-normal text-muted-foreground">{props.count}</span>
      ) : null}
    </>
  );
}

const tabName = (name: string, count: number) => (count > 0 ? `${name}, ${count}` : name);

export function ThreadDecisionsPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly actions: ThreadDecisionActions;
}) {
  const { actions } = props;
  const snapshot = useThreadDecisions(props.threadRef);
  const { tab, setTab } = useDecisionsPanelTab();
  const [selecting, setSelecting] = useState(false);
  const reopen = useReopenWithUndo();
  const panelRef = useRef<HTMLDivElement>(null);
  const focusAfter = useFocusAfter(panelRef);
  const parkedTabRef = useRef<HTMLButtonElement>(null);
  const focusParkedTab = () => parkedTabRef.current?.focus();
  const counts = {
    questions: snapshot?.openCount ?? 0,
    decisions: choicesToReview(snapshot, actions.draft),
    parked: snapshot?.parkedOpenCount ?? 0,
    artifacts: snapshot?.artifactCount ?? 0,
  };
  // Select mode ends once the draft or the snapshot leaves nothing to select.
  if (
    selecting &&
    !openQuestions(snapshot).some((question) => actions.inDraft[question.label] === undefined)
  ) {
    setSelecting(false);
  }
  const draftShown = actions.draft.trim() !== "" && !(tab === "questions" && selecting);
  return (
    <FocusAfterContext value={focusAfter}>
      <div ref={panelRef} className="flex h-full min-h-0 flex-col" data-thread-decisions-panel>
        <div className="flex shrink-0 items-center px-3 pt-3 pb-2">
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
                setSelecting(false);
              }
            }}
          >
            <Toggle
              variant="segmented-bordered"
              value="questions"
              aria-label={tabName("Questions", counts.questions)}
            >
              <TabLabel name="Questions" count={counts.questions} />
            </Toggle>
            <Toggle
              variant="segmented-bordered"
              value="decisions"
              aria-label={
                counts.decisions > 0
                  ? `Decisions, ${plural(counts.decisions, "choice")} to review`
                  : "Decisions"
              }
            >
              <TabLabel name="Decisions" count={counts.decisions} />
            </Toggle>
            <Toggle
              ref={parkedTabRef}
              variant="segmented-bordered"
              value="parked"
              aria-label={tabName("Parked", counts.parked)}
            >
              <TabLabel name="Parked" count={counts.parked} />
            </Toggle>
            <Toggle
              variant="segmented-bordered"
              value="artifacts"
              aria-label={tabName("Artifacts", counts.artifacts)}
            >
              <TabLabel name="Artifacts" count={counts.artifacts} />
            </Toggle>
          </ToggleGroup>
        </div>
        {tab === "questions" ? (
          <QuestionsTab
            threadRef={props.threadRef}
            snapshot={snapshot}
            actions={actions}
            selecting={selecting}
            onSelecting={setSelecting}
          />
        ) : tab === "decisions" ? (
          <DecisionsTab
            threadRef={props.threadRef}
            snapshot={snapshot}
            actions={actions}
            reopen={reopen}
          />
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="px-3 pb-3">
              {tab === "artifacts" ? (
                <ArtifactsTab threadRef={props.threadRef} snapshot={snapshot} />
              ) : (
                <ParkedTab
                  threadRef={props.threadRef}
                  snapshot={snapshot}
                  actions={actions}
                  focusTab={focusParkedTab}
                />
              )}
            </div>
          </ScrollArea>
        )}
        {draftShown ? <DraftBar snapshot={snapshot} actions={actions} /> : null}
      </div>
    </FocusAfterContext>
  );
}
