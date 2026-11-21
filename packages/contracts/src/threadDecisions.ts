import * as Effect from "effect/Effect";
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

/**
 * `dropped`: a message said it is not a decision; `dismissed`: the user closed it on the card or the
 * Tracker, and nothing told the agent.
 */
export const ThreadDecisionState = Schema.Literals(["open", "answered", "dropped", "dismissed"]);
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
  /**
   * A message the user sent after the reply holds the line `Veto: <text>`. Defaults to false for a
   * server that predates it.
   */
  vetoed: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
});
export type ThreadDecidedWithoutAsking = typeof ThreadDecidedWithoutAsking.Type;

export const ThreadDecisionsSubscribeInput = Schema.Struct({ threadId: ThreadId });
export type ThreadDecisionsSubscribeInput = typeof ThreadDecisionsSubscribeInput.Type;

/** The snapshot carries at most this many decided-without-asking items, newest first. */
export const THREAD_DECIDED_WITHOUT_ASKING_LIMIT = 50;

/** Who acts on a parked item: the agent (words to send it) or the person. */
export const ThreadParkedKind = Schema.Literals(["agent", "me"]);
export type ThreadParkedKind = typeof ThreadParkedKind.Type;

/**
 * The words a kind is said in: the kinds, and the older names for them (`prompt` the agent's, `todo`
 * and `later` the person's). Inputs take any; a reader maps them through session-kit's `parkKind`.
 */
export const ThreadParkedKindWord = Schema.Literals(["agent", "me", "prompt", "todo", "later"]);
export type ThreadParkedKindWord = typeof ThreadParkedKindWord.Type;

/**
 * `sent`: a message carrying the item's composer chip was recorded (`ParkedContextRecord`), or, on rows
 * from before the chip, the old Send button sent it.
 */
export const ThreadParkedState = Schema.Literals(["open", "done", "dropped", "sent"]);
export type ThreadParkedState = typeof ThreadParkedState.Type;

export const THREAD_PARKED_TEXT_MAX_LENGTH = 4_000;

export const ThreadParkedText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(THREAD_PARKED_TEXT_MAX_LENGTH),
);

/** Something set aside in a thread for later, by the user (`/park`) or its agent (`t3_park`). */
export const ThreadParkedItem = Schema.Struct({
  id: PositiveInt,
  /**
   * A kind word, read through `parkKind`. The server says it in the older words (`prompt`, `todo`)
   * so a client from before the rename, whose decoder knows only those, still lists every row; a
   * client takes any string, so a newer word drops no row either.
   */
  kind: Schema.String,
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

/** What an artifact is: made from an Artifact type (named when any thread learned it), or a plain page. */
export const ThreadArtifactType = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("typed"),
    url: Schema.String,
    /** Null when no thread has named the type and it is not a core one. */
    name: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("page"), format: Schema.Literals(["html", "markdown"]) }),
]);
export type ThreadArtifactType = typeof ThreadArtifactType.Type;

/**
 * A claude.ai artifact the thread published (Claude's Artifact tool), an agent's reply linked, or the
 * user linked by hand. The fields after `updatedAt` default for a server that predates them.
 */
export const ThreadArtifact = Schema.Struct({
  /** The id in the artifact's URL. */
  id: Schema.String,
  url: Schema.String,
  /** Null when the artifact is only mentioned. */
  title: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  /** True when no publish names it (a reply's link, or the user's), so title and updatedAt come from none. */
  mentionedOnly: Schema.Boolean,
  updatedAt: IsoDateTime,
  /** The user linked it (threadDecisions.linkArtifact); only such a row can be unlinked. */
  linkedByUser: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  /** Null until a create or publish of it is read. */
  type: Schema.NullOr(ThreadArtifactType).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** When the last call that reached it was answered "artifact not found"; null once one finds it. */
  notFoundAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
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
  /**
   * The newest message a person typed that the message watermark has passed, so the judge (or the
   * rules) has read it; null before one. The composer holds questions back until it names the
   * message just sent (FORK.md, "Hidden while a send is judged").
   */
  lastTypedMessageRead: Schema.NullOr(MessageId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
});
export type ThreadDecisionsSnapshot = typeof ThreadDecisionsSnapshot.Type;

/**
 * Dismiss's and Reopen's target: the question as the user saw it, so one asked again in the
 * meantime (a new `sourceMessageId`) is not the one acted on.
 */
export const ThreadDecisionQuestionInput = Schema.Struct({
  threadId: ThreadId,
  label: ThreadDecisionLabel,
  sourceMessageId: MessageId,
});
export type ThreadDecisionQuestionInput = typeof ThreadDecisionQuestionInput.Type;

/** Run statuses that end a run. A completed turn is first persisted as `waiting` (RunExecutionService). */
export const ENDED_RUN_STATUSES: ReadonlySet<string> = new Set([
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

export const ThreadParkInput = Schema.Struct({
  threadId: ThreadId,
  items: Schema.Array(Schema.Struct({ kind: ThreadParkedKindWord, text: ThreadParkedText })).check(
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
    action: Schema.Literal("move"),
    kind: ThreadParkedKindWord,
  }),
  Schema.Struct({
    threadId: ThreadId,
    id: PositiveInt,
    action: Schema.Literals(["done", "drop", "reopen"]),
  }),
]);
export type ThreadParkedUpdateInput = typeof ThreadParkedUpdateInput.Type;

const THREAD_ARTIFACT_TITLE_MAX_LENGTH = 200;

/** A claude.ai artifact link the user adds to the thread's Artifacts; the server reads the URL. */
export const ThreadArtifactLinkInput = Schema.Struct({
  threadId: ThreadId,
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  title: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(THREAD_ARTIFACT_TITLE_MAX_LENGTH)),
  ),
});
export type ThreadArtifactLinkInput = typeof ThreadArtifactLinkInput.Type;

export const ThreadArtifactUnlinkInput = Schema.Struct({
  threadId: ThreadId,
  /** The row's `id`. */
  id: TrimmedNonEmptyString,
});
export type ThreadArtifactUnlinkInput = typeof ThreadArtifactUnlinkInput.Type;

export class ThreadDecisionsError extends Schema.TaggedError<ThreadDecisionsError>()(
  "ThreadDecisionsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
