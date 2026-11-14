import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, IsoDateTime, MessageId, ThreadId } from "./baseSchemas.ts";

/** A decision label as agents write it: `Q` and a number. */
export const ThreadDecisionLabel = Schema.String.check(Schema.isPattern(/^Q\d+$/));
export type ThreadDecisionLabel = typeof ThreadDecisionLabel.Type;

export const ThreadDecisionState = Schema.Literals(["open", "answered", "dropped"]);
export type ThreadDecisionState = typeof ThreadDecisionState.Type;

export const ThreadDecisionQuestion = Schema.Struct({
  label: ThreadDecisionLabel,
  /** Empty when the reply did not use the `Q<n>, <key words>: … My pick is …: …` shape. */
  keyWords: Schema.String,
  question: Schema.String,
  pick: Schema.String,
  reason: Schema.String,
  sourceMessageId: MessageId,
  askedAt: IsoDateTime,
  state: ThreadDecisionState,
  /** A preview of the user's answer; the full message is in the thread. */
  answerText: Schema.NullOr(Schema.String),
  answerMessageId: Schema.NullOr(MessageId),
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type ThreadDecisionQuestion = typeof ThreadDecisionQuestion.Type;

/** A choice the agent made itself, from a reply's "Decided without asking" section. */
export const ThreadDecidedWithoutAsking = Schema.Struct({
  messageId: MessageId,
  ordinal: Schema.Int,
  text: Schema.String,
  createdAt: IsoDateTime,
});
export type ThreadDecidedWithoutAsking = typeof ThreadDecidedWithoutAsking.Type;

export const ThreadDecisionsSubscribeInput = Schema.Struct({ threadId: ThreadId });
export type ThreadDecisionsSubscribeInput = typeof ThreadDecisionsSubscribeInput.Type;

/** The snapshot carries at most this many decided-without-asking items, newest first. */
export const THREAD_DECIDED_WITHOUT_ASKING_LIMIT = 50;

export const ThreadDecisionsSnapshot = Schema.Struct({
  threadId: ThreadId,
  /** Newest asking reply first; labels ascending within a reply. */
  questions: ForwardCompatibleArray(ThreadDecisionQuestion),
  decidedWithoutAsking: ForwardCompatibleArray(ThreadDecidedWithoutAsking),
  openCount: Schema.Int,
});
export type ThreadDecisionsSnapshot = typeof ThreadDecisionsSnapshot.Type;

export const ThreadDecisionReopenInput = Schema.Struct({
  threadId: ThreadId,
  label: ThreadDecisionLabel,
});
export type ThreadDecisionReopenInput = typeof ThreadDecisionReopenInput.Type;

export class ThreadDecisionsError extends Schema.TaggedError<ThreadDecisionsError>()(
  "ThreadDecisionsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
