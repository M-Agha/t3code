import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  MessageId,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

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

export const ThreadParkedKind = Schema.Literals(["todo", "later", "prompt"]);
export type ThreadParkedKind = typeof ThreadParkedKind.Type;

export const ThreadParkedState = Schema.Literals(["open", "done", "dropped", "sent"]);
export type ThreadParkedState = typeof ThreadParkedState.Type;

export const THREAD_PARKED_TEXT_MAX_LENGTH = 4_000;

export const ThreadParkedText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(THREAD_PARKED_TEXT_MAX_LENGTH),
);

/** Something set aside in a thread for later, by the user (`/park`) or its agent (`t3_park`). */
export const ThreadParkedItem = Schema.Struct({
  id: PositiveInt,
  kind: ThreadParkedKind,
  text: Schema.String,
  state: ThreadParkedState,
  parkedBy: Schema.Literals(["user", "agent"]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type ThreadParkedItem = typeof ThreadParkedItem.Type;

/** The snapshot carries every open parked item and at most this many resolved ones, newest first. */
export const THREAD_PARKED_RESOLVED_LIMIT = 50;

/** A claude.ai artifact the thread published (Claude's Artifact tool) or an agent's reply linked. */
export const ThreadArtifact = Schema.Struct({
  /** The id in the artifact's URL. */
  id: Schema.String,
  url: Schema.String,
  /** Null when the artifact is only mentioned. */
  title: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  /** True when only a reply's link names it, so title and updatedAt come from no publish. */
  mentionedOnly: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type ThreadArtifact = typeof ThreadArtifact.Type;

/** The snapshot carries at most this many artifacts, most recently updated first. */
export const THREAD_ARTIFACTS_LIMIT = 50;

export const ThreadDecisionsSnapshot = Schema.Struct({
  threadId: ThreadId,
  /** Newest asking reply first; labels ascending within a reply. */
  questions: ForwardCompatibleArray(ThreadDecisionQuestion),
  decidedWithoutAsking: ForwardCompatibleArray(ThreadDecidedWithoutAsking),
  openCount: Schema.Int,
  /** Open items oldest first, then resolved ones newest first. */
  parked: ForwardCompatibleArray(ThreadParkedItem),
  parkedOpenCount: Schema.Int,
  artifacts: ForwardCompatibleArray(ThreadArtifact),
  /** Every artifact of the thread, including those past the snapshot's limit. */
  artifactCount: Schema.Int,
});
export type ThreadDecisionsSnapshot = typeof ThreadDecisionsSnapshot.Type;

export const ThreadDecisionReopenInput = Schema.Struct({
  threadId: ThreadId,
  label: ThreadDecisionLabel,
});
export type ThreadDecisionReopenInput = typeof ThreadDecisionReopenInput.Type;

export const ThreadParkInput = Schema.Struct({
  threadId: ThreadId,
  items: Schema.Array(Schema.Struct({ kind: ThreadParkedKind, text: ThreadParkedText })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
});
export type ThreadParkInput = typeof ThreadParkInput.Type;

export const ThreadParkedUpdateInput = Schema.Union([
  Schema.Struct({
    threadId: ThreadId,
    id: PositiveInt,
    action: Schema.Literal("edit"),
    text: ThreadParkedText,
  }),
  Schema.Struct({
    threadId: ThreadId,
    id: PositiveInt,
    action: Schema.Literals(["done", "drop", "sent", "reopen"]),
  }),
]);
export type ThreadParkedUpdateInput = typeof ThreadParkedUpdateInput.Type;

export class ThreadDecisionsError extends Schema.TaggedError<ThreadDecisionsError>()(
  "ThreadDecisionsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
