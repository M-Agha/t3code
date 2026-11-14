import {
  type ScopedThreadRef,
  THREAD_DECIDED_WITHOUT_ASKING_LIMIT,
  type ThreadDecidedWithoutAsking,
  type ThreadDecisionQuestion,
  type ThreadDecisionsSnapshot,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { MessageCircleQuestionIcon } from "lucide-react";
import { useState } from "react";

import { RelativeTime } from "~/components/RelativeTime";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import {
  decidedWithoutAskingByReply,
  decisionMessages,
  latestReplyOpenQuestions,
  openQuestionsByReply,
  resolvedQuestions,
} from "./threadDecisions.logic";

/** How the decision buttons reach the thread: an ordinary message, or text left in the composer. */
export interface ThreadDecisionActions {
  readonly canOperate: boolean;
  readonly send: (text: string) => void;
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
        onClick={() => actions.send(decisionMessages.accept(question))}
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
        onClick={() => actions.send(decisionMessages.drop(question))}
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
        aria-label={`Veto: ${props.item.text}`}
        onClick={() => props.actions.insert(decisionMessages.veto(props.item))}
      >
        Veto
      </Button>
    </li>
  );
}

type DecisionsPanelTab = "questions" | "decisions";

export function ThreadDecisionsPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly actions: ThreadDecisionActions;
}) {
  const snapshot = useThreadDecisions(props.threadRef);
  const [tab, setTab] = useState<DecisionsPanelTab>("questions");
  const openCount = snapshot?.openCount ?? 0;
  return (
    <div className="flex h-full min-h-0 flex-col" data-thread-decisions-panel>
      <div className="flex shrink-0 items-center px-3 pt-3">
        <ToggleGroup
          aria-label="Decisions view"
          variant="segmented"
          value={[tab]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "questions" || next === "decisions") setTab(next);
          }}
        >
          <Toggle value="questions">Questions{openCount > 0 ? ` (${openCount})` : ""}</Toggle>
          <Toggle value="decisions">Decisions</Toggle>
        </ToggleGroup>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-3 pb-3">
          {tab === "questions" ? (
            <QuestionsTab snapshot={snapshot} actions={props.actions} />
          ) : (
            <DecisionsTab threadRef={props.threadRef} snapshot={snapshot} actions={props.actions} />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
