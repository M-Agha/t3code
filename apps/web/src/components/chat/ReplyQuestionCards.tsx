// Fork-only: the questions a reply ends with (replyQuestions.ts) as cards. Every button answers by sending
// or drafting an ordinary message, so whatever reads the conversation (the owner's session-kit mod) records
// the answer the same way it records a typed one.
import { memo, useState } from "react";
import { Button } from "../ui/button";
import { MessageCopyButton } from "./MessageCopyButton";
import type { ReplyQuestion } from "./replyQuestions";

type Sent = "accepted" | "dropped";

const ReplyQuestionCard = memo(function ReplyQuestionCard({
  question,
  onSend,
  onDraft,
}: {
  question: ReplyQuestion;
  onSend: ((text: string) => Promise<void>) | undefined;
  onDraft: ((text: string) => void) | undefined;
}) {
  const [sent, setSent] = useState<Sent | null>(null);
  const [sending, setSending] = useState(false);

  const send = (text: string, outcome: Sent) => {
    if (!onSend) return;
    setSending(true);
    onSend(text).then(
      () => setSent(outcome),
      () => setSending(false),
    );
  };

  return (
    <div className="rounded-lg border border-border bg-card/40 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-semibold text-primary">{question.label}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
          {question.keyWords}
        </span>
        {sent ? <span className="text-muted-foreground text-xs">{sent}</span> : null}
      </div>
      <p className="mt-1 text-foreground">{question.question}</p>
      <p className="mt-1">
        <span className="mr-1.5 rounded bg-primary px-1.5 py-0.5 font-semibold text-primary-foreground text-xs">
          pick
        </span>
        <span className="text-foreground">{question.pick}:</span>{" "}
        <span className="text-muted-foreground">{question.reason}</span>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {onSend ? (
          <Button
            size="xs"
            disabled={sending || sent !== null}
            onClick={() => send(`${question.label}: ${question.pick}`, "accepted")}
          >
            Accept pick
          </Button>
        ) : null}
        {onDraft ? (
          <Button size="xs" variant="outline" onClick={() => onDraft(`${question.label}: `)}>
            Answer
          </Button>
        ) : null}
        {onSend ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={sending || sent !== null}
            onClick={() => send(`${question.label}: not a decision`, "dropped")}
          >
            Drop
          </Button>
        ) : null}
        <MessageCopyButton
          text={question.line}
          label="Copy question"
          size="icon-xs"
          variant="ghost"
        />
      </div>
    </div>
  );
});

export const ReplyQuestionCards = memo(function ReplyQuestionCards({
  questions,
  onSend,
  onDraft,
}: {
  questions: ReadonlyArray<ReplyQuestion>;
  onSend: ((text: string) => Promise<void>) | undefined;
  onDraft: ((text: string) => void) | undefined;
}) {
  return (
    <div className="mt-3 flex flex-col gap-2">
      {questions.map((question) => (
        <ReplyQuestionCard
          key={question.label}
          question={question}
          onSend={onSend}
          onDraft={onDraft}
        />
      ))}
    </div>
  );
});
