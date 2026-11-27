/* oxlint-disable t3code/no-untranslated-copy -- Fork-only English copy: upstream's translation catalogs have no entries for it, so wrapping it would change nothing on screen. Copy they do hold goes through gt() or <T>. FORK.md, "Translation". */
import {
  MessageId,
  type ParkedContextRecord,
  type ScopedThreadRef,
  THREAD_DECIDED_WITHOUT_ASKING_LIMIT,
  type ThreadDecidedWithoutAsking,
  type ThreadDecisionQuestion,
  type ThreadDecisionsSnapshot,
  type ThreadParkedItem,
  type ThreadDecisionsReadBack,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import {
  ArrowUpRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MessageCircleQuestionIcon,
  PanelRightIcon,
  PencilLineIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  createContext,
  Fragment,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { collapseExpandedComposerCursor } from "~/composer-logic";
import { assistantCitationNavigation } from "~/lib/assistantCitationNavigation";
import { parkedContextRecord, parkedContextReference } from "~/lib/composerContextRecords";
import { formatInlineContextReference } from "~/lib/composerContextReferences";
import { readThreadShell } from "~/state/entities";
import { useComposerDraftStore } from "~/composerDraftStore";
import { m } from "~/i18n/messages";
import { useStableCallback } from "~/hooks/useStableCallback";
import ChatMarkdown from "~/components/ChatMarkdown";
import { RelativeTime } from "~/components/RelativeTime";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
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
  DRAFT_PLAIN_TEXT,
  draftSummary,
  endsAtClosingFence,
  groupSelection,
  latestReplyOpenQuestions,
  lineEnd,
  neighbourOf,
  nextUndrafted,
  openQuestions,
  openQuestionsByReply,
  parkedChipRestorable,
  parkedIdsInDraft,
  plural,
  readParked,
  resolvedQuestions,
  unfinishedLabels,
  vetoInDraft,
  withoutLine,
} from "./threadDecisions.logic";

/** How the decision buttons reach the thread: an ordinary message, or a line added to the composer. */
export interface ThreadDecisionActions {
  readonly canOperate: boolean;
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
  /**
   * The composer edits a queued message, so a chip added now would change that message rather than
   * the draft: Parked's Add to draft waits, as `/park` does.
   */
  readonly editingQueuedRun: boolean;
  /** The open questions the composer's draft already closes, and how. */
  readonly inDraft: Readonly<Record<string, DraftChoice>>;
  /** Parked items as chips in the composer's draft (Add to draft): `useParkedDraft`. */
  readonly parked: {
    /** The items whose chips the thread's draft, or a queued message's open edit, holds: In draft. */
    readonly inDraft: ReadonlyArray<number>;
    /** Adds the item's chip at the draft's end without moving focus; true once the composer took it. */
    readonly attach: (item: { readonly id: number; readonly text: string }) => boolean;
  };
  /** Reopen, held for its Undo by ChatView (`useReopenWithUndo`), which outlives the panel. */
  readonly reopen: ReopenWithUndo;
  /** Dismiss, with its Undo toast, held by ChatView (`useDismissWithUndo`) for the same reason. */
  readonly dismiss: DismissWithUndo;
  /**
   * The user's newest message may answer the open questions and is not yet judged, nor its run over
   * (`questionsHeld`): the question card and the Tracker's open questions wait for it.
   */
  readonly questionsHeld: boolean;
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
  const gt = useGT();
  const sendDraft = useStableCallback(async () => {
    const composer = composerRef.current;
    if (composer === null) return false;
    sendingRef.current = null;
    const submitted = composer.submit();
    // Every other refusal already told the user why.
    if (submitted === "blocked") {
      toastManager.add({
        type: "warning",
        title: gt("Not sent"),
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

/**
 * Fork (Parked): the composer's side of Parked: Add to draft, In draft, and the undo gate's item check
 * (ChatComposer's `parkedChipRestorable`). FORK.md, "Parked items".
 */
export function useParkedDraft(input: {
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly threadRef: ScopedThreadRef | null;
  /** The draft the composer shows: a queued message's edit while one is open. */
  readonly draftTarget: ChatComposerProps["composerDraftTarget"];
  /** The thread's own draft. */
  readonly threadDraftTarget: ChatComposerProps["composerDraftTarget"];
  readonly editingQueuedRun: boolean;
  readonly parked: ReadonlyArray<ThreadParkedItem> | undefined;
}): {
  readonly actions: ThreadDecisionActions["parked"];
  readonly chipRestorable: (record: ParkedContextRecord) => boolean;
} {
  const { composerRef, threadRef, draftTarget, threadDraftTarget } = input;
  const gt = useGT();
  // Add to draft puts the item's chip at the draft's end, as a dropped pull request goes in: its
  // record, which a send carries to the agent, then the text. Focus stays put, so several items can go
  // in one message. While the chip is there the item is locked (ThreadParked.tsx), so nothing
  // rewrites it.
  const attach = useStableCallback((item: { readonly id: number; readonly text: string }) => {
    // The Parked tab lists the active thread's items, so it has one.
    if (threadRef === null) return false;
    const record = parkedContextRecord(item, threadRef.threadId);
    const chip = `${formatInlineContextReference(parkedContextReference(record))} `;
    const store = useComposerDraftStore.getState();
    const draft = store.getComposerDraft(draftTarget);
    const held = draft?.parkedContexts ?? [];
    // After a closing code fence, a space would put the chip on the fence line (Sol round 3, S4).
    const ownLine = endsAtClosingFence(draft?.prompt ?? "");
    store.addParkedContexts(draftTarget, [record]);
    const inserted = composerRef.current?.insertTextAtEnd(ownLine ? `\n${chip}` : chip, {
      ensureLeadingBoundary: !ownLine,
      focus: false,
    });
    if (inserted === true) return true;
    store.setParkedContexts(draftTarget, held);
    toastManager.add({
      type: "error",
      title: gt("Unable to add to chat"),
      description: gt("The composer is busy; try again once it is ready."),
    });
    return false;
  });
  // A chip in the thread's draft or in an open queued message's edit locks its item (R3): either
  // would send the words it holds.
  const inDraft = useComposerDraftStore(
    useShallow((store) => [
      ...new Set([
        ...parkedIdsInDraft(store.getComposerDraft(threadDraftTarget)),
        ...parkedIdsInDraft(store.getComposerDraft(draftTarget)),
      ]),
    ]),
  );
  const chipRestorable = useStableCallback((record: ParkedContextRecord) =>
    parkedChipRestorable(record, readParked(input.parked ?? []), input.editingQueuedRun),
  );
  return { actions: { inDraft, attach }, chipRestorable };
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

/** The question card's shown question (by label) and collapse, for the reply that asked it. */
interface QuestionCardView {
  readonly reply: string;
  readonly label: string;
  readonly collapsed: boolean;
}

// By thread, outside the card, which a send's hold unmounts; a new reply starts over. Ceiling: one entry
// per thread opened in a session, never pruned (drop a thread's entry when its view closes if it grows).
const useQuestionCardViews = create<Record<string, QuestionCardView>>()(() => ({}));

/** The composer's open questions, one at a time, built like T3's AskUserQuestion panel. */
function QuestionPanel(props: {
  readonly questions: readonly [ThreadDecisionQuestion, ...ThreadDecisionQuestion[]];
  readonly earlier: number;
  readonly actions: ThreadDecisionActions;
  readonly onOpenPanel: () => void;
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
}) {
  const { questions, actions } = props;
  const gt = useGT();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const reply = questions[0].sourceMessageId;
  const threadKey = scopedThreadKey(props.threadRef);
  const stored = useQuestionCardViews((views) => views[threadKey]);
  const setView = (next: QuestionCardView) => useQuestionCardViews.setState({ [threadKey]: next });
  // By label, never index: answered questions leave the list as the snapshot updates.
  const view =
    stored?.reply === reply ? stored : { reply, label: questions[0].label, collapsed: false };
  const collapsed = view.collapsed;
  const setCurrentLabel = (label: string) => setView({ ...view, label });
  const setCollapsed = (next: boolean) => setView({ ...view, collapsed: next });
  const question = questions.find((q) => q.label === view.label) ?? questions[0];
  const index = questions.indexOf(question);
  const choice = actions.inDraft[question.label];
  const disabled = !actions.canOperate || choice !== undefined;
  // The card moves on to the next question and keeps focus on its row; with none left, the composer.
  const dismiss = () => {
    const next = neighbourOf(
      questions.map((q) => q.label),
      question.label,
    );
    actions.dismiss.start(props.threadRef, question);
    if (next === null) {
      actions.focusLine(null);
      return;
    }
    setCurrentLabel(next);
    toggleRef.current?.focus();
  };
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
  const toggleName = collapsed ? `Show ${question.label}` : `Hide ${question.label}`;
  const dismissName = `Dismiss ${question.label} without answering (tells the agent nothing)`;
  // One collapse control under the whole row: FORK.md, "Questions and decisions", Display.
  return (
    <Collapsible
      open={!collapsed}
      onOpenChange={(open) => setCollapsed(!open)}
      data-thread-decision={question.label}
    >
      <ComposerBanner.Row className="relative rounded-xl px-4 py-1.5 hover:bg-foreground/5">
        <CollapsibleTrigger
          ref={toggleRef}
          aria-label={toggleName}
          title={
            collapsed ? "Show the question and its answers" : "Hide the question and its answers"
          }
          data-thread-decision-toggle={collapsed ? "collapsed" : "expanded"}
          className="absolute inset-0 cursor-pointer rounded-xl outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        />
        <ComposerBanner.Content className="pointer-events-none">
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
        </ComposerBanner.Content>
        <ComposerBanner.Actions className="pointer-events-none relative flex-nowrap gap-0 *:[button]:pointer-events-auto">
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
                aria-label={gt("Previous question")}
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
                aria-label={gt("Next question")}
                disabled={index === questions.length - 1}
                onClick={() => goTo(index + 1)}
              >
                <ChevronRightIcon className="size-3.5" />
              </Button>
            </>
          ) : null}
          <ComposerBanner.ToggleIcon expanded={!collapsed} />
          <SharedTooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={openTracker}
                onClick={props.onOpenPanel}
              />
            }
            label={openTracker}
          >
            <PanelRightIcon className="size-3.5" />
          </SharedTooltipTrigger>
          <ComposerBanner.Dismiss
            aria-label={dismissName}
            title={dismissName}
            disabled={disabled || actions.dismiss.isPending(props.threadRef, question)}
            onClick={dismiss}
          />
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
  if (input.actions.questionsHeld) return null;
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
  answered: "bg-accent text-foreground",
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
      <SharedTooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Show the ${props.title.toLowerCase()} in the chat`}
            onClick={props.onShow}
          />
        }
        label="Show in the chat"
      >
        <ArrowUpRightIcon />
      </SharedTooltipTrigger>
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
  /** The labels of the rows the tab shows, in order. */
  readonly order: ReadonlyArray<string>;
  readonly actions: ThreadDecisionActions;
  readonly threadRef: ScopedThreadRef;
}) {
  const { question, actions } = props;
  const gt = useGT();
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
                  {/* The catalogs hold "Edit", "Remove" and "Review" as JSX only, so <T>, not gt(). */}
                  <T>Edit</T>
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
                  <T>Remove</T>
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
          <Button
            size="xs"
            variant="ghost"
            className="ms-auto"
            disabled={!actions.canOperate || actions.dismiss.isPending(props.threadRef, question)}
            aria-label={`Dismiss ${question.label} without answering (tells the agent nothing)`}
            onClick={() => {
              actions.dismiss.start(props.threadRef, question);
              // The row leaves with the snapshot; its neighbour takes focus, or the composer, as the card.
              const next = neighbourOf(props.order, question.label);
              if (next === null) {
                actions.focusLine(null);
                return;
              }
              focusAfter({ row: next, controls: ["accept", "answer", "edit", "edit-in-composer"] });
            }}
          >
            {gt("Dismiss")}
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
          selected ? "border-s-2 border-s-ring bg-accent ps-3.5" : "ps-4",
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
              <span className="text-tracker-draft">
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

/**
 * The one-time read-back (MAIN-129), on this click only: the judge reads the messages from before it
 * took over, on the server, its progress in the snapshot on every client. `useReadBackOutcome`, which
 * outlives this bar, toasts the end; `heldFocusRef` tells it whether this bar had focus as it went.
 */
function ReadBackBar(props: {
  readonly threadRef: ScopedThreadRef;
  readonly count: number;
  readonly readBack: ThreadDecisionsReadBack | null;
  readonly heldFocusRef: RefObject<boolean>;
}) {
  const { threadRef, readBack, heldFocusRef } = props;
  const countId = useId();
  const barRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads DOM focus as the bar leaves the document (the cleanup runs before the removal), for the panel's end-of-run focus move
  useLayoutEffect(() => {
    const bar = barRef.current;
    heldFocusRef.current = false;
    return () => {
      heldFocusRef.current = bar?.contains(document.activeElement) ?? false;
    };
  }, [heldFocusRef]);
  const [starting, setStarting] = useState(false);
  const canRun = useAtomValue(
    serverEnvironment.readBackThreadDecisions.permissionAtom(threadRef.environmentId),
  );
  const start = useAtomCommand(serverEnvironment.readBackThreadDecisions);
  const running = readBack?.running === true;
  const busy = starting || running;
  const onClick = () => {
    // Kept focusable while busy (`aria-disabled`), so the click is dropped here.
    if (busy) return;
    setStarting(true);
    void start({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }).then((result) => {
      setStarting(false);
      if (result._tag === "Success") return;
      toastManager.add({
        type: "error",
        title: "Could not read your earlier messages",
        description:
          thrownErrorMessage(squashAtomCommandFailure(result), m) ?? "Nothing was changed.",
      });
    });
  };
  return (
    <div
      ref={barRef}
      data-tracker-row="read-back"
      className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 border-b border-border px-4 py-1 text-xs text-muted-foreground"
    >
      <span id={countId} className="min-w-0">
        {plural(props.count, "question")} asked before the judge took over
      </span>
      <Button
        size="xs"
        variant="ghost"
        className="ms-auto shrink-0"
        data-tracker-control="read-back"
        disabled={!canRun}
        aria-disabled={busy || undefined}
        aria-describedby={countId}
        onClick={onClick}
      >
        {busy ? "Checking earlier messages…" : "Check earlier messages"}
      </Button>
      {/* In the accessibility tree while empty, so its first line is announced. */}
      <span role="status" className="w-full min-w-0 empty:sr-only">
        {running
          ? `${readBack.read} of ${plural(readBack.total, "message")} read`
          : readBack?.error == null
            ? null
            : `Last check failed: ${readBack.error}`}
      </span>
    </div>
  );
}

/**
 * Toasts how a read-back ended, on every client that watched it run, and keeps focus in the Tracker
 * when the bar that had this client's focus goes away with it (`barFocusRef`); focus anywhere else,
 * the body included, is the user's. Held by the panel, which a tab switch keeps.
 */
function useReadBackOutcome(
  readBack: ThreadDecisionsReadBack | null,
  panelRef: RefObject<HTMLElement | null>,
  barFocusRef: RefObject<boolean>,
) {
  const wasRunning = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- toasts a server-side run's end, seen as a snapshot change, and moves the focus its bar took with it
  useEffect(() => {
    const running = readBack?.running === true;
    const ended = wasRunning.current && !running;
    wasRunning.current = running;
    if (!ended || readBack === null) return;
    if (readBack.error === null) {
      toastManager.add({
        title: `Read your earlier messages: ${plural(readBack.closed, "question")} closed`,
      });
    } else {
      toastManager.add({
        type: "error",
        title: "Could not read your earlier messages",
        description: readBack.error,
      });
    }
    const panel = panelRef.current;
    const active = document.activeElement;
    const held = barFocusRef.current;
    barFocusRef.current = false;
    if (!held || panel === null || (active !== null && active !== document.body)) return;
    // Select when questions remain, else the Questions tab.
    const next =
      panel.querySelector('[data-tracker-row="status"] [data-tracker-control="select"]') ??
      panel.querySelector('[data-tracker-control="questions"]');
    if (next instanceof HTMLElement) next.focus();
  }, [readBack, panelRef, barFocusRef]);
}

function QuestionsTab(props: {
  readonly threadRef: ScopedThreadRef;
  readonly snapshot: ThreadDecisionsSnapshot | null;
  readonly actions: ThreadDecisionActions;
  readonly selecting: boolean;
  readonly onSelecting: (selecting: boolean) => void;
  readonly readBackFocusRef: RefObject<boolean>;
}) {
  const gt = useGT();
  const { actions, selecting } = props;
  const showReply = useShowReply(props.threadRef);
  const focusAfter = useContext(FocusAfterContext);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const groups = openQuestionsByReply(props.snapshot);
  const shownLabels = groups.flatMap((group) => group.items.map((question) => question.label));
  const open = openQuestions(props.snapshot);
  const readBackCount = props.snapshot?.readBackCount ?? 0;
  const readBack = props.snapshot?.readBack ?? null;
  // Offered outside Select mode, which has its own bar; while it runs, kept whatever else changes. The
  // second child in every branch below (`null` holds the status bar's place), so React keeps the one bar,
  // with its focus and live region, while the run closes the last open question or a send holds them.
  const readBackBar =
    readBack?.running === true || (!selecting && readBackCount > 0) ? (
      <ReadBackBar
        threadRef={props.threadRef}
        count={readBackCount}
        readBack={readBack}
        heldFocusRef={props.readBackFocusRef}
      />
    ) : null;
  // A selection ends with Select mode, however it ends.
  if (!selecting && selected.size > 0) setSelected(new Set());
  if (actions.questionsHeld) {
    return (
      <>
        {null}
        {readBackBar}
        <EmptyState
          title="Reading your message"
          description="Open questions come back once your message is checked against them, or once the reply is done."
        />
      </>
    );
  }
  if (groups.length === 0) {
    return (
      <>
        {null}
        {readBackBar}
        <EmptyState
          title="No open questions"
          description="Questions an agent asks at the end of a reply, as Q-labelled lines, appear here until you answer them."
        />
      </>
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
            <span className="font-medium text-foreground">Selecting</span>
            <Dot />
            <span className="min-w-0 truncate">questions in your draft can't be selected</span>
            <Button size="xs" variant="ghost" className="ms-auto" onClick={stopSelecting}>
              {gt("Done")}
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
              {gt("Select")}
            </Button>
          </>
        )}
      </StatusBar>
      {readBackBar}
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
                      order={shownLabels}
                      actions={actions}
                      threadRef={props.threadRef}
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

/** How long Reopen's toast waits for an Undo; Base UI pauses it on hover, focus and window blur. */
const REOPEN_UNDO_MS = 8_000;

/**
 * Reopen, held back while its toast offers Undo; the only Tracker action that skips the draft. Held
 * by ChatView rather than the panel, so a switch to another tab or surface (Parked, Artifacts), which
 * unmounts the panel, keeps the toast's Undo working; when the chat view goes, what is still held
 * goes ahead, since the user asked for it.
 */
export function useReopenWithUndo() {
  const gt = useGT();
  const reopen = useAtomCommand(serverEnvironment.reopenThreadDecision, { reportFailure: true });
  const held = useRef(new Map<string, { readonly toastId: string; readonly run: () => void }>());
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
    toastManager.close(entry.toastId);
    return entry;
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sends the reopens still held when the chat view unmounts or the page goes
  useEffect(() => {
    const entries = held.current;
    // A paused toast can wait indefinitely, so a reload or quit sends what it holds (best effort).
    const flush = () => {
      for (const entry of entries.values()) {
        toastManager.close(entry.toastId);
        entry.run();
      }
      entries.clear();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
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
        input: {
          threadId: threadRef.threadId,
          label: question.label,
          sourceMessageId: question.sourceMessageId,
        },
      }).then((result) => {
        // A failed reopen was reported; its row may be tried again.
        if (result._tag !== "Success") unpend(key);
      });
    let toastId = "";
    // Each toast acts on its own hold only: one still fading after Undo must not send a newer Reopen.
    const own = () => held.current.get(key)?.toastId === toastId;
    const goAhead = () => {
      if (own()) release(key)?.run();
    };
    const undo = () => {
      if (own() && release(key) !== undefined) unpend(key);
    };
    // Base UI's timer (hover pauses it); the reopen goes out once the toast is gone, so an Undo during
    // the fade counts; ✕ cancels like Undo (2026-11-17: a late Undo and the ✕ both reopened a question).
    // No `type`: the info icon is a fixed blue no theme sets (FORK.md, Colours).
    toastId = toastManager.add({
      title: `Reopening ${question.label}`,
      description: "It goes back to Questions.",
      timeout: REOPEN_UNDO_MS,
      onRemove: goAhead,
      actionProps: { children: gt("Undo"), onClick: undo },
      data: { onClose: undo },
    });
    held.current.set(key, { toastId, run });
    setPending((current) => new Set(current).add(key));
  };
  return {
    isPending: (threadRef: ScopedThreadRef, question: ThreadDecisionQuestion) =>
      pending.has(keyOf(threadRef, question)),
    start,
  };
}

export type ReopenWithUndo = ReturnType<typeof useReopenWithUndo>;

/**
 * Dismiss: closes an open question at once, sending nothing to the agent (unlike Not a decision, a
 * draft line it reads), then offers Undo, which reopens it. Held by ChatView, so the toast's Undo
 * outlives the card and the panel. A dismiss in flight disables its button.
 */
export function useDismissWithUndo() {
  const gt = useGT();
  const dismiss = useAtomCommand(serverEnvironment.dismissThreadDecision, { reportFailure: true });
  const reopen = useAtomCommand(serverEnvironment.reopenThreadDecision, { reportFailure: true });
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const keyOf = (threadRef: ScopedThreadRef, question: ThreadDecisionQuestion) =>
    `${threadRef.threadId}:${question.label}`;
  const start = (threadRef: ScopedThreadRef, question: ThreadDecisionQuestion) => {
    const key = keyOf(threadRef, question);
    setPending((current) => new Set(current).add(key));
    const target = {
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        label: question.label,
        sourceMessageId: question.sourceMessageId,
      },
    };
    void dismiss(target).then((result) => {
      setPending((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      // A failed dismiss was reported.
      if (result._tag !== "Success") return;
      // Undo's reopen waits on the thread's lock, held through a judge call (up to 20 s), so the toast
      // stays, saying so, until it is done. A question asked again meanwhile is already open: the
      // server counts that as reopened.
      const undo = () => {
        toastManager.update(toastId, {
          title: `Reopening ${question.label}…`,
          description: "It goes back to Questions.",
          timeout: 0,
          actionProps: { children: gt("Undo"), disabled: true },
        });
        void reopen(target).then(() => toastManager.close(toastId));
      };
      // No `type`: the info icon is a fixed blue no theme sets (FORK.md, Colours).
      const toastId = toastManager.add({
        title: `Dismissed ${question.label}`,
        description: "Nothing was sent. It is under Decisions, where Reopen brings it back.",
        timeout: REOPEN_UNDO_MS,
        actionProps: { children: gt("Undo"), onClick: undo },
      });
    });
  };
  return {
    isPending: (threadRef: ScopedThreadRef, question: ThreadDecisionQuestion) =>
      pending.has(keyOf(threadRef, question)),
    start,
  };
}

export type DismissWithUndo = ReturnType<typeof useDismissWithUndo>;

function ResolvedRow(props: {
  readonly question: ThreadDecisionQuestion;
  readonly canReopen: boolean;
  readonly reopening: boolean;
  readonly onReopen: () => void;
}) {
  const { question } = props;
  const gt = useGT();
  const answered = question.state === "answered";
  // Settled through t3_question: its Undo is Reopen (MAIN-127).
  const byAgent = question.settledByAgent;
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
          aria-label={
            byAgent
              ? `Undo the agent's settling of ${question.label} (reopens it)`
              : `Reopen ${question.label}`
          }
          onClick={props.onReopen}
        >
          {props.reopening ? "Reopening…" : byAgent ? gt("Undo") : gt("Reopen")}
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
          <span className="me-1.5 text-xs font-semibold text-foreground">
            {byAgent ? "Settled by the agent" : "You"}
          </span>
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
              <T>Remove</T>
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
        description="Answered, dropped and dismissed questions, and the choices agents list under Decided without asking, appear here."
      />
    );
  }
  const answered = resolved.filter((question) => question.state === "answered");
  const dropped = resolved.filter((question) => question.state === "dropped");
  const dismissed = resolved.filter((question) => question.state === "dismissed");
  const toReview = choicesToReview(snapshot, actions.draft);
  const vetoesInDraft = (snapshot?.decidedWithoutAsking ?? []).filter(
    (item) => !item.vetoed && vetoInDraft(actions.draft, item),
  ).length;
  const counts = [
    ...(vetoesInDraft > 0 ? [`${plural(vetoesInDraft, "veto", "vetoes")} in draft`] : []),
    ...(answered.length > 0 ? [`${answered.length} answered`] : []),
    ...(dropped.length > 0 ? [`${dropped.length} not a decision`] : []),
    ...(dismissed.length > 0 ? [`${dismissed.length} dismissed`] : []),
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
        {resolvedSection("Dismissed", dismissed)}
      </ScrollArea>
    </>
  );
}

/**
 * The draft's summary and the composer's own send, shown while the draft holds Tracker lines
 * (answers, vetoes or an unfinished `Qn:`); a draft of plain text is the composer's alone.
 */
function DraftBar(props: {
  readonly snapshot: ThreadDecisionsSnapshot | null;
  readonly actions: ThreadDecisionActions;
}) {
  const { actions } = props;
  // One send at a time: a second click while the first is in flight would send twice.
  const [sending, setSending] = useState(false);
  const open = openQuestions(props.snapshot);
  const summary = draftSummary(actions.draft, open, actions.inDraft);
  if (summary === DRAFT_PLAIN_TEXT) return null;
  // A bare `Qn: ` from Answer… is a place to type, not an answer, so it is not sent as one.
  const unfinished = unfinishedLabels(actions.draft, open);
  const send = () => {
    setSending(true);
    void actions.sendDraft().finally(() => setSending(false));
  };
  return (
    <section
      aria-label="Your draft"
      className="flex shrink-0 items-center gap-1.5 border-t border-border/60 px-2 py-1.5 text-2xs text-muted-foreground"
    >
      <PencilLineIcon aria-hidden className="size-3.5 shrink-0 text-tracker-draft" />
      <span className="font-medium text-foreground">Draft</span>
      <Dot />
      <span className="min-w-0 truncate">{summary}</span>
      <Button size="xs" variant="ghost" className="ms-auto" onClick={() => actions.focusLine(null)}>
        <T>Review</T>
      </Button>
      <Button
        size="xs"
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
  const { reopen } = actions;
  const panelRef = useRef<HTMLDivElement>(null);
  const focusAfter = useFocusAfter(panelRef);
  // Whether the read-back bar had this client's focus when it went: set by the bar, read at a run's end.
  const readBackFocusRef = useRef(false);
  useReadBackOutcome(snapshot?.readBack ?? null, panelRef, readBackFocusRef);
  const counts = {
    questions: actions.questionsHeld ? 0 : (snapshot?.openCount ?? 0),
    decisions: choicesToReview(snapshot, actions.draft),
  };
  // Select mode ends once the draft or the snapshot leaves nothing to select, or the questions are held.
  if (
    selecting &&
    (actions.questionsHeld ||
      !openQuestions(snapshot).some((question) => actions.inDraft[question.label] === undefined))
  ) {
    setSelecting(false);
  }
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
              if (next === "questions" || next === "decisions") {
                setTab(next);
                setSelecting(false);
              }
            }}
          >
            <Toggle
              variant="segmented-bordered"
              value="questions"
              data-tracker-control="questions"
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
          </ToggleGroup>
        </div>
        {tab === "questions" ? (
          <QuestionsTab
            threadRef={props.threadRef}
            snapshot={snapshot}
            actions={actions}
            selecting={selecting}
            onSelecting={setSelecting}
            readBackFocusRef={readBackFocusRef}
          />
        ) : (
          <DecisionsTab
            threadRef={props.threadRef}
            snapshot={snapshot}
            actions={actions}
            reopen={reopen}
          />
        )}
        {tab === "questions" && selecting ? null : (
          <DraftBar snapshot={snapshot} actions={actions} />
        )}
      </div>
    </FocusAfterContext>
  );
}
