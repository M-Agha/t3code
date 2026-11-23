import {
  MessageId,
  ParkedContextRecord,
  type ThreadArtifact,
  type ThreadArtifactLinkInput,
  type ThreadArtifactUnlinkInput,
  type ThreadDecisionQuestion,
  type ThreadDecisionQuestionInput,
  ENDED_RUN_STATUSES,
  ThreadDecisionsError,
  type ThreadDecisionsSnapshot,
  type ThreadId,
  type ThreadParkedItem,
  type ThreadParkedKindWord,
  type ThreadParkedUpdateInput,
  THREAD_ARTIFACTS_LIMIT,
  THREAD_DECIDED_WITHOUT_ASKING_LIMIT,
  THREAD_PARKED_RESOLVED_LIMIT,
} from "@t3tools/contracts";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { artifactLinksIn, parseArtifactLink } from "@t3tools/shared/sessionKit/artifacts";
import {
  answerPart,
  type Closing,
  closingFor,
  type JudgedQuestion,
  Q_LINE,
  readReplyDecisions,
  splitQuestion,
} from "@t3tools/shared/sessionKit/decisions";
import {
  isPlaceholder,
  OLDER_KIND_WORD,
  PARK_KIND_OF_WORD,
  parkKind,
} from "@t3tools/shared/sessionKit/parks";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import { CORE_ARTIFACT_TYPE_NAMES, readArtifactCall } from "./artifactCalls.ts";
import * as DecisionJudge from "./DecisionJudge.ts";

// Fork-only. Questions are derived from projected messages; only resolutions are irreplaceable.

// The line the Tracker's Veto adds for a choice made without asking (`decisionMessages.veto`).
const VETO_PREFIX = "Veto: ";
const VETO_LINE = /^\s*Veto: /m;

// The full answer stays in the database; the snapshot carries a preview of the question's own part.
const ANSWER_TEXT_LIMIT = 300;

/** A question's own part of the message that answered it (answerPart), cut to a preview. */
const answerPreview = (message: string, label: string) => {
  const part = answerPart(message, label);
  return part.length > ANSWER_TEXT_LIMIT ? `${part.slice(0, ANSWER_TEXT_LIMIT - 1)}…` : part;
};

interface MessageRow {
  readonly messageId: string;
  readonly role: string;
  readonly createdAt: string;
  readonly runId: string | null;
  readonly runStatus: string | null;
  /** The run's place in its thread (`orchestration_v2_projection_runs.ordinal`); null without a run. */
  readonly runOrdinal: number | null;
  /** 1 when its run ended before it started (`neverStarted`), so the agent never received the message. */
  readonly neverStarted: number | null;
  readonly streaming: number;
  readonly text: string | null;
  readonly userAuthored: number;
  /** 1 when sent at or after the judge took over (fork migration 005); else the rules alone read it. */
  readonly judged: number | null;
}

interface QuestionRow {
  readonly label: string;
  readonly text: string;
  readonly sourceMessageId: string;
  readonly askedAt: string;
  readonly state: ThreadDecisionQuestion["state"];
  readonly answerText: string | null;
  readonly answerMessageId: string | null;
  readonly resolvedAt: string | null;
}

const ARTIFACT_TITLE_LIMIT = 200;
const ARTIFACT_DESCRIPTION_LIMIT = 1000;

// A Claude Artifact call's turn item is provider data: any field may be missing or of another type.
const decodeArtifactItem = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.optional(Schema.Unknown),
      input: Schema.optional(Schema.Unknown),
      output: Schema.optional(Schema.Unknown),
    }),
  ),
);

interface ArtifactItemRow {
  readonly itemId: string;
  readonly updatedAt: string;
  /** Only for Claude's Artifact calls; null for every other tool item. */
  readonly payload: string | null;
}

interface ArtifactRow {
  readonly id: string;
  readonly url: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly mentionedOnly: number;
  readonly linkedByUser: number;
  readonly updatedAt: string;
  readonly typeUrl: string | null;
  readonly typeName: string | null;
  readonly pageFormat: string | null;
  readonly notFoundAt: string | null;
}

/** A row's type: a learned name first, then a core type's, else none (the panel says "Typed artifact"). */
const artifactType = (row: ArtifactRow): ThreadArtifact["type"] => {
  if (row.typeUrl !== null) {
    return {
      kind: "typed",
      url: row.typeUrl,
      name: row.typeName ?? CORE_ARTIFACT_TYPE_NAMES.get(row.typeUrl) ?? null,
    };
  }
  return row.pageFormat === "html" || row.pageFormat === "markdown"
    ? { kind: "page", format: row.pageFormat }
    : null;
};

export const NOT_AN_ARTIFACT_LINK =
  "Not a claude.ai artifact link. Paste one like https://claude.ai/artifact/… or https://claude.ai/code/artifact/….";

// An answered AskUserQuestion card (a `user_input_request` turn item) is provider data: its questions
// in the card's order, and answers keyed by question id, or by the question's text in older cards.
const decodeCard = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      questions: Schema.Array(Schema.Struct({ id: Schema.String, question: Schema.String })),
      questionAnswer: Schema.Struct({ answers: Schema.Record(Schema.String, Schema.Unknown) }),
    }),
  ),
);

/** One card question's selections as reply text: a string or an array of strings, else unusable. */
const cardSelections = (answer: unknown): string | null => {
  const chosen: ReadonlyArray<unknown> = Array.isArray(answer) ? answer : [answer];
  if (!chosen.every((value): value is string => typeof value === "string")) return null;
  const text = chosen
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .join(", ");
  return text === "" ? null : text;
};

/**
 * What a card answers, as the reply a person would type, by the label its question text starts with
 * (session-kit's Q_LINE, as the terminal reads it). A label asked in parts ("Q28 (1 of 3)") gathers
 * them in the card's order; one missing or unusable part leaves the label unanswered.
 */
const cardReplies = (
  questions: ReadonlyArray<{ readonly id: string; readonly question: string }>,
  answers: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, string> => {
  const parts = new Map<string, Array<string | null>>();
  for (const question of questions) {
    const label = Q_LINE.exec(question.question)?.[1];
    if (label === undefined) continue;
    const answer = answers[question.id] ?? answers[question.question];
    parts.set(label, [...(parts.get(label) ?? []), cardSelections(answer)]);
  }
  const replies = new Map<string, string>();
  for (const [label, selections] of parts) {
    if (selections.every((part) => part !== null)) {
      replies.set(label, `${label}: ${selections.join("; ")}`);
    }
  }
  return replies;
};

// A user message as the parked pass reads it: its text and the context records riding on it. Records are
// provider-shaped data any build may have written, so each is decoded alone and an odd one is skipped.
const decodeSentMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      text: Schema.String,
      context: Schema.optional(Schema.Struct({ records: Schema.Array(Schema.Unknown) })),
    }),
  ),
);
const decodeParkedRecord = Schema.decodeUnknownOption(ParkedContextRecord);

/**
 * The parked items a message of `threadId` carries: its parked chips' records that its text also
 * references, as `projectComposerContextForProvider` sends them, and that name this thread. A record
 * whose chip was deleted from the text before the send never reached the agent; one naming another
 * thread (a chip pasted across threads or machines, where the same id is another item) marks nothing.
 */
const parkedItemsCarried = (threadId: ThreadId, payload: string): ReadonlyArray<number> => {
  const message = Option.getOrUndefined(decodeSentMessage(payload));
  if (message?.context === undefined) return [];
  const referenced = new Set(
    collectComposerContextReferences(message.text).map((reference) => reference.contextId),
  );
  return message.context.records.flatMap((candidate) => {
    const record = Option.getOrUndefined(decodeParkedRecord(candidate));
    return record !== undefined &&
      record.payload.threadId === threadId &&
      referenced.has(record.contextId)
      ? [record.payload.itemId]
      : [];
  });
};

export interface ThreadParkRequest {
  readonly threadId: ThreadId;
  readonly items: ReadonlyArray<{ readonly kind: ThreadParkedKindWord; readonly text: string }>;
  readonly parkedBy: ThreadParkedItem["parkedBy"];
}

export const PLACEHOLDER_PARK_MESSAGE =
  "not parked: the text is empty or a placeholder. Park only what the user asked to set aside, or a real follow-up.";

/** A side chat never holds parks; in its pane, the Parked tab shown is its parent's. */
export const SIDE_CHAT_PARK_MESSAGE =
  "not parked: a side chat has no Parked tab; park it in the main thread.";

/** Nor does a thread another agent drives (`isDelegatedAppThread`): a subagent or a delegated task. */
export const SUBAGENT_PARK_MESSAGE =
  "not parked: a subagent has no Parked tab; park it in the main thread.";

/**
 * Nor does a workflow run's agent step (MAIN-114): its thread is read through the run. For the
 * step's agent calling t3_park; the composer's refusal (composerParkDecision) is for the owner.
 */
export const WORKFLOW_STEP_PARK_MESSAGE =
  "not parked: a workflow step's thread has no Parked tab; put follow-ups in the step's result.";

const RESOLVED_PARKED_STATE = { done: "done", drop: "dropped" } as const;

export class ThreadDecisions extends Context.Service<
  ThreadDecisions,
  {
    /**
     * Reads the thread's messages, answered question cards and Artifact tool calls after their
     * watermarks, and which parked items its messages carried; true when a row changed.
     */
    readonly sync: (threadId: ThreadId) => Effect.Effect<boolean, ThreadDecisionsError>;
    readonly snapshot: (
      threadId: ThreadId,
    ) => Effect.Effect<ThreadDecisionsSnapshot, ThreadDecisionsError>;
    readonly subscribe: (
      threadId: ThreadId,
    ) => Stream.Stream<ThreadDecisionsSnapshot, ThreadDecisionsError>;
    readonly reopen: (
      input: ThreadDecisionQuestionInput,
    ) => Effect.Effect<void, ThreadDecisionsError>;
    /** Closes an open question as `dismissed`; nothing reaches the agent. */
    readonly dismiss: (
      input: ThreadDecisionQuestionInput,
    ) => Effect.Effect<void, ThreadDecisionsError>;
    /** Parks every item or none. */
    readonly park: (input: ThreadParkRequest) => Effect.Effect<void, ThreadDecisionsError>;
    readonly updateParked: (
      input: ThreadParkedUpdateInput,
    ) => Effect.Effect<void, ThreadDecisionsError>;
    /** Adds an artifact by its link; one the thread already lists keeps its row. */
    readonly linkArtifact: (
      input: ThreadArtifactLinkInput,
    ) => Effect.Effect<void, ThreadDecisionsError>;
    /** Removes an artifact the user linked; other rows come from the thread itself. */
    readonly unlinkArtifact: (
      input: ThreadArtifactUnlinkInput,
    ) => Effect.Effect<void, ThreadDecisionsError>;
  }
>()("t3/decisions/ThreadDecisions") {}

export const layer = Layer.effect(
  ThreadDecisions,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const scope = yield* Effect.scope;
    const judge = yield* DecisionJudge.DecisionJudge;
    const locks = yield* KeyedLock.make<ThreadId>();
    // Subscribers re-read their thread on a signal, so a slow one only needs recent thread ids.
    const changes = yield* PubSub.sliding<ThreadId>(256);
    const fail = (message: string) => (cause: unknown) =>
      new ThreadDecisionsError({ message, cause });

    // Rows of deleted threads; their messages are gone from every view, so nothing can resolve them.
    // Parked items and artifacts hold what the user made (items, links, titles), so only a
    // soft-deleted thread drops them; one merely absent from the projection keeps them. Ceiling: rows
    // of a thread removed outright stay (FORK.md, Artifacts).
    yield* Effect.forEach(
      [
        ...[
          "fork_thread_parked_items",
          "fork_thread_parked_set_aside",
          "fork_thread_artifacts",
          "fork_thread_artifact_sync",
        ].map(
          (table) => `DELETE FROM ${table} WHERE thread_id IN (
            SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL
          )`,
        ),
        ...[
          "fork_thread_decision_questions",
          "fork_thread_decided_without_asking",
          "fork_thread_decision_sync",
        ].map(
          (table) => `DELETE FROM ${table} WHERE thread_id NOT IN (
            SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL
          )`,
        ),
      ],
      (statement) => sql.unsafe(statement),
      { discard: true },
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to sweep orphaned decisions", { cause }),
      ),
    );

    // Fork migration 005 writes the one row; without it no message counts as judged.
    const cutoff = yield* sql`SELECT 1 FROM fork_decision_judge_cutoff`;
    if (cutoff.length === 0) {
      yield* Effect.logWarning(
        "Decision judge cutoff is missing, so the rules alone close questions",
      );
    }

    // Upstream's user-authored test (ProjectionStore), plus the payloads that mark automation, over a
    // messages row named `message`.
    const userAuthored = () => sql`(
      json_extract(message.payload_json, '$.createdBy') = 'user'
      AND json_type(message.payload_json, '$.idleCompaction') IS NULL
      AND json_type(message.payload_json, '$.senderThreadId') IS NULL
      AND json_type(message.payload_json, '$.scheduledTaskId') IS NULL
      AND json_type(message.payload_json, '$.linkedSender') IS NULL
      AND json_type(message.payload_json, '$.delegatedCompletion') IS NULL
      AND json_type(message.payload_json, '$.notification') IS NULL
    )`;

    // A runs row named `run` that ended before it started: a queued run cancelled, or one that failed to start
    // (the Orchestrator's failQueuedRunStart marks it `failed`). The agent never received its messages. NULL
    // without a run.
    const neverStarted = () => sql`(
      run.status IN ('cancelled', 'failed') AND json_extract(run.payload_json, '$.startedAt') IS NULL
    )`;

    // Rows in order, in one transaction: the questions a run's reply asks, the closing found for each user
    // message among them, then the watermark past the last row.
    const applyRows = Effect.fn("ThreadDecisions.applyRows")(function* (
      threadId: ThreadId,
      rows: ReadonlyArray<MessageRow>,
      replies: ReadonlySet<string>,
      closings: ReadonlyMap<string, Closing>,
    ) {
      const last = rows.at(-1);
      if (last === undefined) return false;
      let changed = false;
      for (const row of rows) {
        if (row.text === null) continue;
        if (replies.has(row.messageId)) {
          const read = readReplyDecisions(row.text);
          // A re-ask never reopens a question answered by a message the reply could not have seen: one of a later
          // run (Q46, 2026-11-19), or of a run still queued (its ordinal changes only when it starts). A steer shares
          // the reply's run. Either run unknown (imported, a card's answer): time order; the reply's case needs this
          // branch, as `ordinal > NULL OR status = 'queued'` holds for a queued answer.
          const unlessAnsweredLater =
            row.runOrdinal === null
              ? sql``
              : sql`AND NOT EXISTS (
                  SELECT 1
                  FROM orchestration_v2_projection_messages AS answer
                  JOIN orchestration_v2_projection_runs AS answer_run
                    ON answer_run.run_id = answer.run_id
                  WHERE answer.message_id = fork_thread_decision_questions.answer_message_id
                    AND (answer_run.ordinal > ${row.runOrdinal} OR answer_run.status = 'queued')
                )`;
          for (const question of read.questions) {
            // Only a shaped re-ask ("My pick is") reopens or rewords a known label. An unshaped line about it
            // ("Q4 remains open", or an agent echoing "Q7: nothing to change." after the user answered) changes
            // nothing: echoes reopened answered questions (2026-11-17). A label never seen before is still recorded.
            const shaped = splitQuestion(question.text).pick !== "";
            const asked = yield* sql`
              INSERT INTO fork_thread_decision_questions (
                thread_id, label, label_number, text, source_message_id, asked_at, state
              ) VALUES (
                ${threadId}, ${question.label}, ${Number(question.label.slice(1))},
                ${question.text}, ${row.messageId}, ${row.createdAt}, 'open'
              )
              ON CONFLICT (thread_id, label) DO UPDATE SET
                ${shaped ? sql`text = excluded.text, source_message_id = excluded.source_message_id, asked_at = excluded.asked_at,` : sql``}
                state = 'open',
                answer_text = NULL,
                answer_message_id = NULL,
                resolved_at = NULL
              WHERE ${shaped ? sql`source_message_id <> excluded.source_message_id` : sql`0`}
                ${unlessAnsweredLater}
              RETURNING label
            `;
            changed ||= asked.length > 0;
          }
          yield* sql`
            DELETE FROM fork_thread_decided_without_asking
            WHERE thread_id = ${threadId} AND message_id = ${row.messageId}
          `;
          for (const [ordinal, text] of read.decidedWithoutAsking.entries()) {
            yield* sql`
              INSERT INTO fork_thread_decided_without_asking (
                thread_id, message_id, ordinal, text, created_at
              ) VALUES (${threadId}, ${row.messageId}, ${ordinal}, ${text}, ${row.createdAt})
            `;
            changed = true;
          }
          continue;
        }
        // The snapshot reads vetoes from the user's messages that reached (or wait to reach) the agent, so one with a veto line
        // changes it.
        changed ||=
          row.role === "user" &&
          row.userAuthored === 1 &&
          row.neverStarted !== 1 &&
          VETO_LINE.test(row.text);
        const closing = closings.get(row.messageId);
        if (closing === undefined) continue;
        for (const [state, labels] of [
          ["answered", closing.answered],
          ["dropped", closing.dropped],
        ] as const) {
          if (labels.length === 0) continue;
          yield* sql`
            UPDATE fork_thread_decision_questions
            SET state = ${state}, answer_text = ${row.text},
              answer_message_id = ${row.messageId}, resolved_at = ${row.createdAt}
            WHERE thread_id = ${threadId} AND state = 'open' AND ${sql.in("label", labels)}
          `;
          changed = true;
        }
      }
      yield* sql`
        INSERT INTO fork_thread_decision_sync (thread_id, after_created_at, after_message_id)
        VALUES (${threadId}, ${last.createdAt}, ${last.messageId})
        ON CONFLICT (thread_id) DO UPDATE SET
          after_created_at = excluded.after_created_at,
          after_message_id = excluded.after_message_id
      `;
      return changed;
    }, sql.withTransaction);

    // What a user's message closes while questions are open: the judge's verdict when `useJudge`, as in the
    // terminal, the rules (`closingFor`) when it gives none; else the rules alone, with no model call (owner's
    // Q38). Outside any transaction: it may wait on a model for seconds.
    const closingOf = Effect.fn("ThreadDecisions.closingOf")(function* (
      threadId: ThreadId,
      row: MessageRow & { readonly text: string },
      useJudge: boolean,
    ) {
      const open = yield* sql<JudgedQuestion>`
        SELECT label, text, source_message_id AS "sourceMessageId", asked_at AS "askedAt"
        FROM fork_thread_decision_questions
        WHERE thread_id = ${threadId} AND state = 'open'
        ORDER BY asked_at, label_number
      `;
      if (open.length === 0) return undefined;
      if (!useJudge) return closingFor(row.text, open);
      // The reply the message follows: whether a bare "yes" assents to the question block depends on it.
      const [reply] = yield* sql<{ readonly text: string }>`
        SELECT json_extract(payload_json, '$.text') AS text
        FROM orchestration_v2_projection_messages
        WHERE thread_id = ${threadId} AND role = 'assistant'
          AND json_extract(payload_json, '$.text') IS NOT NULL
          AND (created_at, message_id) < (${row.createdAt}, ${row.messageId})
        ORDER BY created_at DESC, message_id DESC
        LIMIT 1
      `;
      const judged = yield* judge.judge({
        threadId,
        messageId: row.messageId,
        open,
        reply: reply?.text,
        message: row.text,
      });
      return judged ?? closingFor(row.text, open);
    });

    // Under the thread's lock, but in several transactions, so no model call runs inside one: the rows before
    // each user message are applied first, so the questions it may close include those they asked; then its
    // closing is found, then applied with the watermark past it. Each step commits its own watermark, so a
    // failure part way keeps what was read and resumes after it.
    const syncMessages = Effect.fn("ThreadDecisions.syncMessages")(function* (threadId: ThreadId) {
      const [watermark] = yield* sql<{
        readonly afterCreatedAt: string;
        readonly afterMessageId: string;
      }>`
        SELECT after_created_at AS "afterCreatedAt", after_message_id AS "afterMessageId"
        FROM fork_thread_decision_sync WHERE thread_id = ${threadId}
      `;
      // The judge reads only what a person sent since it took over, in a thread the fork has read before:
      // older history was answered under the rules, and a thread opened for the first time (an imported
      // session, or one an official build ran) shows its questions at once at no model cost. A new thread's
      // first pass runs on its first message, before any question, so its answers are judged.
      const judgedThread = watermark !== undefined;
      const rows = yield* sql<MessageRow>`
        SELECT
          message.message_id AS "messageId",
          message.role,
          message.created_at AS "createdAt",
          message.run_id AS "runId",
          run.status AS "runStatus",
          run.ordinal AS "runOrdinal",
          ${neverStarted()} AS "neverStarted",
          message.streaming,
          json_extract(message.payload_json, '$.text') AS text,
          ${userAuthored()} AS "userAuthored",
          message.created_at >= (SELECT judged_from FROM fork_decision_judge_cutoff) AS judged
        FROM orchestration_v2_projection_messages AS message
        LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = message.run_id
        WHERE message.thread_id = ${threadId}
          AND (message.created_at, message.message_id) >
            (${watermark?.afterCreatedAt ?? ""}, ${watermark?.afterMessageId ?? ""})
        ORDER BY message.created_at, message.message_id
      `;
      // A streaming message or a running run's reply may still grow, so stop before it; a steer
      // sent during the run is read once the run ends.
      const blocked = rows.findIndex(
        (row) =>
          row.streaming === 1 ||
          (row.role === "assistant" &&
            row.runStatus !== null &&
            !ENDED_RUN_STATUSES.has(row.runStatus)),
      );
      const ready = blocked === -1 ? rows : rows.slice(0, blocked);

      // A run's reply is its last assistant message; earlier ones narrate tool calls.
      const replyByRun = new Map<string, string>();
      for (const row of ready) {
        if (row.role === "assistant") replyByRun.set(row.runId ?? row.messageId, row.messageId);
      }
      const replies = new Set(replyByRun.values());

      let changed = false;
      let start = 0;
      for (const [index, row] of ready.entries()) {
        // A message whose run never started never reached the agent, so it answers nothing.
        if (
          row.role !== "user" ||
          row.userAuthored !== 1 ||
          row.text === null ||
          row.neverStarted === 1
        )
          continue;
        changed =
          (yield* applyRows(threadId, ready.slice(start, index), replies, new Map())) || changed;
        const closing = yield* closingOf(
          threadId,
          { ...row, text: row.text },
          judgedThread && row.judged === 1,
        );
        // A message read while questions were open publishes even when it closes none: the composer hides
        // them from the send until the snapshot's `lastTypedMessageRead` names it (FORK.md, "Hidden while a send is judged").
        changed =
          (yield* applyRows(
            threadId,
            [row],
            replies,
            new Map(closing === undefined ? [] : [[row.messageId, closing]]),
          )) ||
          closing !== undefined ||
          changed;
        start = index + 1;
      }
      changed = (yield* applyRows(threadId, ready.slice(start), replies, new Map())) || changed;
      return changed;
    });

    // Answers given on AskUserQuestion cards. A card is read once, in (updated_at, turn_item_id) order,
    // so a question reopened by hand stays open. Its own watermark: it runs whether or not new messages
    // arrived, since a card is answered mid-run and the run's end is what syncs.
    const syncCards = Effect.fn("ThreadDecisions.syncCards")(function* (threadId: ThreadId) {
      const [watermark] = yield* sql<{
        readonly afterCreatedAt: string;
        readonly afterMessageId: string;
        readonly afterItemUpdatedAt: string;
        readonly afterItemId: string;
      }>`
        SELECT
          after_created_at AS "afterCreatedAt",
          after_message_id AS "afterMessageId",
          after_item_updated_at AS "afterItemUpdatedAt",
          after_item_id AS "afterItemId"
        FROM fork_thread_decision_sync WHERE thread_id = ${threadId}
      `;
      // The message pass stops before a message that may still change. A card answered after it waits,
      // so it never closes a question before the questions asked up to then are recorded.
      const [unread] = yield* sql<{ readonly createdAt: string }>`
        SELECT created_at AS "createdAt"
        FROM orchestration_v2_projection_messages
        WHERE thread_id = ${threadId}
          AND (created_at, message_id) >
            (${watermark?.afterCreatedAt ?? ""}, ${watermark?.afterMessageId ?? ""})
        ORDER BY created_at, message_id
        LIMIT 1
      `;
      const cards = yield* sql<{
        readonly itemId: string;
        readonly updatedAt: string;
        readonly payload: string;
      }>`
        SELECT turn_item_id AS "itemId", updated_at AS "updatedAt", payload_json AS payload
        FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} AND type = 'user_input_request' AND status = 'completed'
          AND (updated_at, turn_item_id) >
            (${watermark?.afterItemUpdatedAt ?? ""}, ${watermark?.afterItemId ?? ""})
          ${unread === undefined ? sql`` : sql`AND updated_at < ${unread.createdAt}`}
        ORDER BY updated_at, turn_item_id
      `;
      const last = cards.at(-1);
      if (last === undefined) return false;

      let changed = false;
      for (const card of cards) {
        const read = Option.getOrNull(decodeCard(card.payload));
        if (read === null) continue;
        for (const [label, text] of cardReplies(read.questions, read.questionAnswer.answers)) {
          // Only this label's row: option text naming another label, or "go with your picks",
          // answers nothing else. A question asked again after the card stays open.
          const open = yield* sql<{
            readonly label: string;
            readonly sourceMessageId: string;
            readonly askedAt: string;
          }>`
            SELECT label, source_message_id AS "sourceMessageId", asked_at AS "askedAt"
            FROM fork_thread_decision_questions
            WHERE thread_id = ${threadId} AND label = ${label} AND state = 'open'
              AND asked_at < ${card.updatedAt}
          `;
          if (open.length === 0) continue;
          const closing = closingFor(text, open);
          for (const [state, labels] of [
            ["answered", closing.answered],
            ["dropped", closing.dropped],
          ] as const) {
            if (labels.length === 0) continue;
            yield* sql`
              UPDATE fork_thread_decision_questions
              SET state = ${state}, answer_text = ${text}, answer_message_id = NULL,
                resolved_at = ${card.updatedAt}
              WHERE thread_id = ${threadId} AND state = 'open' AND ${sql.in("label", labels)}
            `;
            changed = true;
          }
        }
      }
      yield* sql`
        INSERT INTO fork_thread_decision_sync (
          thread_id, after_created_at, after_message_id, after_item_updated_at, after_item_id
        ) VALUES (${threadId}, '', '', ${last.updatedAt}, ${last.itemId})
        ON CONFLICT (thread_id) DO UPDATE SET
          after_item_updated_at = excluded.after_item_updated_at,
          after_item_id = excluded.after_item_id
      `;
      return changed;
    }, sql.withTransaction);

    const syncArtifacts = Effect.fn("ThreadDecisions.syncArtifacts")(function* (
      threadId: ThreadId,
    ) {
      const [watermark] = yield* sql<{
        readonly afterMessageCreatedAt: string;
        readonly afterMessageId: string;
        readonly afterItemUpdatedAt: string;
        readonly afterItemId: string;
      }>`
        SELECT
          after_message_created_at AS "afterMessageCreatedAt",
          after_message_id AS "afterMessageId",
          after_item_updated_at AS "afterItemUpdatedAt",
          after_item_id AS "afterItemId"
        FROM fork_thread_artifact_sync WHERE thread_id = ${threadId}
      `;
      // A tool item is re-read whenever it changes, so one still running is read again once done.
      // Every tool item moves the watermark; only Claude's Artifact calls pay for their payload.
      const items = yield* sql<ArtifactItemRow>`
        SELECT
          turn_item_id AS "itemId",
          updated_at AS "updatedAt",
          CASE WHEN json_extract(payload_json, '$.toolName') = 'Artifact'
            AND json_extract(payload_json, '$.nativeItemRef.driver') = 'claudeAgent'
          THEN payload_json END AS payload
        FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} AND type = 'dynamic_tool'
          AND (updated_at, turn_item_id) >
            (${watermark?.afterItemUpdatedAt ?? ""}, ${watermark?.afterItemId ?? ""})
        ORDER BY updated_at, turn_item_id
      `;
      const messages = yield* sql<{
        readonly messageId: string;
        readonly createdAt: string;
        readonly streaming: number;
        readonly text: string | null;
      }>`
        SELECT
          message_id AS "messageId",
          created_at AS "createdAt",
          streaming,
          CASE WHEN role = 'assistant'
            AND json_extract(payload_json, '$.text') LIKE '%claude.ai/%artifact/%'
          THEN json_extract(payload_json, '$.text') END AS text
        FROM orchestration_v2_projection_messages
        WHERE thread_id = ${threadId}
          AND (created_at, message_id) >
            (${watermark?.afterMessageCreatedAt ?? ""}, ${watermark?.afterMessageId ?? ""})
        ORDER BY created_at, message_id
      `;
      // A message still streaming holds what came after it, calls too, so a catch-up sync reads the
      // same order an incremental one does.
      const blocked = messages.findIndex((row) => row.streaming === 1);
      const ready = blocked === -1 ? messages : messages.slice(0, blocked);
      const heldFrom = blocked === -1 ? undefined : messages[blocked]?.createdAt;
      const readyItems =
        heldFrom === undefined ? items : items.filter((item) => item.updatedAt < heldFrom);
      const lastItem = readyItems.at(-1);
      const lastMessage = ready.at(-1);
      if (lastItem === undefined && lastMessage === undefined) return false;

      let changed = false;
      const readItem = function* (item: ArtifactItemRow) {
        if (item.payload === null) return;
        const payload = Option.getOrNull(decodeArtifactItem(item.payload));
        if (payload === null) return;
        const { call, typeNames } = readArtifactCall(payload);
        // Global: a name one thread learns names the type wherever it shows, read when a snapshot is.
        for (const name of typeNames) {
          const learned = yield* sql`
            INSERT INTO fork_artifact_type_names (type_url, title, learned_at)
            VALUES (${name.url}, ${name.title}, ${item.updatedAt})
            ON CONFLICT (type_url) DO UPDATE SET
              title = excluded.title, learned_at = excluded.learned_at
            WHERE excluded.learned_at >= learned_at AND excluded.title <> title
            RETURNING type_url
          `;
          changed ||= learned.length > 0;
          // The same name again is news too: an older thread read later must not revert it.
          if (learned.length === 0) {
            yield* sql`
              UPDATE fork_artifact_type_names SET learned_at = ${item.updatedAt}
              WHERE type_url = ${name.url} AND title = ${name.title}
                AND learned_at < ${item.updatedAt}
            `;
          }
        }
        if (call === null) return;
        if (call.kind !== "published") {
          // Either link form names the row: its own id, or the publish's uuid. A missing artifact
          // never adds a row, nor marks one first seen at or after it: an incremental sync read it
          // before that row existed, and 006's replay must agree. A read only clears what an
          // earlier not-found set.
          const marked =
            call.kind === "notFound"
              ? yield* sql`
                  UPDATE fork_thread_artifacts SET not_found_at = ${item.updatedAt}
                  WHERE thread_id = ${threadId}
                    AND (link_id = ${call.link.id} OR artifact_id = ${call.link.id})
                    AND (not_found_at IS NULL OR not_found_at < ${item.updatedAt})
                    AND first_seen_at < ${item.updatedAt}
                  RETURNING link_id
                `
              : yield* sql`
                  UPDATE fork_thread_artifacts SET not_found_at = NULL
                  WHERE thread_id = ${threadId}
                    AND (link_id = ${call.link.id} OR artifact_id = ${call.link.id})
                    AND not_found_at <= ${item.updatedAt}
                  RETURNING link_id
                `;
          changed ||= marked.length > 0;
          return;
        }
        const id = call.link.id;
        const description = call.description;
        const artifactId = call.artifactId;
        const typeUrl = call.type.kind === "typed" ? call.type.url : null;
        const pageFormat = call.type.kind === "page" ? call.type.format : null;
        // A `code/artifact/{uuid}` link read, or linked, before this publish named the same artifact.
        const [linked] =
          artifactId === null || artifactId === id
            ? []
            : yield* sql<{ readonly firstSeenAt: string; readonly title: string | null }>`
                DELETE FROM fork_thread_artifacts
                WHERE thread_id = ${threadId} AND link_id = ${artifactId}
                  AND source IN ('mention', 'manual')
                RETURNING first_seen_at AS "firstSeenAt", title
              `;
        // A title the user gave the link folded in here stands when the publish names none.
        const title = call.title ?? linked?.title ?? null;
        const firstSeenAt =
          linked !== undefined && linked.firstSeenAt < item.updatedAt
            ? linked.firstSeenAt
            : item.updatedAt;
        const upserted = yield* sql`
          INSERT INTO fork_thread_artifacts (
            thread_id, link_id, artifact_id, url, title, description, source, first_seen_at,
            updated_at, type_url, page_format, not_found_at
          ) VALUES (
            ${threadId}, ${id}, ${artifactId}, ${call.link.url},
            substr(${title}, 1, ${ARTIFACT_TITLE_LIMIT}),
            substr(${description}, 1, ${ARTIFACT_DESCRIPTION_LIMIT}), 'tool',
            ${firstSeenAt}, ${item.updatedAt}, ${typeUrl}, ${pageFormat}, NULL
          )
          ON CONFLICT (thread_id, link_id) DO UPDATE SET
            artifact_id = COALESCE(excluded.artifact_id, artifact_id),
            url = excluded.url,
            title = COALESCE(excluded.title, title),
            description = COALESCE(excluded.description, description),
            source = 'tool',
            first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
            updated_at = excluded.updated_at,
            type_url = COALESCE(excluded.type_url, type_url),
            page_format = CASE WHEN COALESCE(excluded.type_url, type_url) IS NULL
              THEN excluded.page_format ELSE NULL END,
            not_found_at = CASE WHEN not_found_at <= excluded.updated_at THEN NULL
              ELSE not_found_at END
          WHERE source <> 'tool' OR excluded.updated_at >= updated_at
          RETURNING link_id
        `;
        changed ||= upserted.length > 0 || linked !== undefined;
        // An Artifact type is for good (the upsert's COALESCE), so an older call naming it still
        // types the row the upsert skipped: migration 006's replay meets a row a later untyped
        // publish already wrote.
        if (typeUrl !== null && upserted.length === 0) {
          const typed = yield* sql`
            UPDATE fork_thread_artifacts SET type_url = ${typeUrl}, page_format = NULL
            WHERE thread_id = ${threadId} AND link_id = ${id} AND type_url IS NULL
            RETURNING link_id
          `;
          changed ||= typed.length > 0;
        }
      };
      const readMessage = function* (row: (typeof ready)[number]) {
        if (row.text === null) return;
        for (const { id, url } of artifactLinksIn(row.text)) {
          const [published] = yield* sql<{ readonly linkId: string }>`
            SELECT link_id AS "linkId" FROM fork_thread_artifacts
            WHERE thread_id = ${threadId} AND artifact_id = ${id}
          `;
          const upserted = yield* sql`
            INSERT INTO fork_thread_artifacts (
              thread_id, link_id, artifact_id, url, title, description, source, first_seen_at,
              updated_at
            ) VALUES (
              ${threadId}, ${published?.linkId ?? id}, NULL, ${url}, NULL, NULL, 'mention',
              ${row.createdAt}, ${row.createdAt}
            )
            ON CONFLICT (thread_id, link_id) DO UPDATE SET
              first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
              updated_at = CASE WHEN source = 'mention'
                THEN MAX(updated_at, excluded.updated_at) ELSE updated_at END
            WHERE excluded.first_seen_at < first_seen_at
              OR (source = 'mention' AND excluded.updated_at > updated_at)
            RETURNING link_id
          `;
          changed ||= upserted.length > 0;
        }
      };
      // In time order, so a not-found and a later read or publish of the same artifact end as the
      // later, and a not-found after a reply links it marks that row however many syncs it takes.
      // A call before a message at the same time, so a reply linking what it published keeps the title.
      const inOrder = [
        ...readyItems.map((item) => ({ at: item.updatedAt, item })),
        ...ready.map((row) => ({ at: row.createdAt, row })),
      ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      for (const entry of inOrder) {
        yield* "item" in entry ? readItem(entry.item) : readMessage(entry.row);
      }
      yield* sql`
        INSERT INTO fork_thread_artifact_sync (
          thread_id, after_message_created_at, after_message_id, after_item_updated_at,
          after_item_id
        ) VALUES (
          ${threadId},
          ${lastMessage?.createdAt ?? watermark?.afterMessageCreatedAt ?? ""},
          ${lastMessage?.messageId ?? watermark?.afterMessageId ?? ""},
          ${lastItem?.updatedAt ?? watermark?.afterItemUpdatedAt ?? ""},
          ${lastItem?.itemId ?? watermark?.afterItemId ?? ""}
        )
        ON CONFLICT (thread_id) DO UPDATE SET
          after_message_created_at = excluded.after_message_created_at,
          after_message_id = excluded.after_message_id,
          after_item_updated_at = excluded.after_item_updated_at,
          after_item_id = excluded.after_item_id
      `;
      return changed;
    }, sql.withTransaction);

    // Every (item, message) pair of the thread's user messages carrying an item's chip, oldest message
    // first. `reached`: the message's run did not end before it started (`neverStarted`).
    // Ceiling: it reads every user message of the thread naming a parked record, each sync; thousands
    // would want a watermark over the messages already read.
    const carriedPairs = Effect.fn("ThreadDecisions.carriedPairs")(function* (threadId: ThreadId) {
      const messages = yield* sql<{
        readonly messageId: string;
        readonly createdAt: string;
        readonly payload: string;
        readonly neverStarted: number | null;
      }>`
        SELECT message.message_id AS "messageId", message.created_at AS "createdAt",
          message.payload_json AS payload,
          ${neverStarted()} AS "neverStarted"
        FROM orchestration_v2_projection_messages AS message
        LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = message.run_id
        WHERE message.thread_id = ${threadId} AND message.role = 'user'
          AND instr(message.payload_json, '"parked"') > 0
        ORDER BY message.created_at, message.message_id
      `;
      return messages.flatMap((message) =>
        parkedItemsCarried(threadId, message.payload).map((itemId) => ({
          itemId,
          messageId: message.messageId,
          createdAt: message.createdAt,
          reached: message.neverStarted !== 1,
        })),
      );
    });

    // Sent and back to Open, from the records; FORK.md, "Parked items", has the rules (MAIN-75). An item
    // is Sent while a message carrying it reached (or waits to reach) the agent and no Reopen set that
    // message aside, so each sync re-reads every pair: a chip removed from a queued message and put
    // back marks the item again.
    const syncParkedSends = Effect.fn("ThreadDecisions.syncParkedSends")(function* (
      threadId: ThreadId,
    ) {
      const pairKey = (itemId: number, messageId: string) => `${itemId}:${messageId}`;
      const setAside = new Set(
        (yield* sql<{ readonly itemId: number; readonly messageId: string }>`
          SELECT item_id AS "itemId", message_id AS "messageId"
          FROM fork_thread_parked_set_aside WHERE thread_id = ${threadId}
        `).map((row) => pairKey(row.itemId, row.messageId)),
      );
      const live = (yield* carriedPairs(threadId)).filter(
        (pair) => pair.reached && !setAside.has(pairKey(pair.itemId, pair.messageId)),
      );
      const items = yield* sql<{
        readonly id: number;
        readonly state: string;
        readonly sentMessageId: string | null;
      }>`
        SELECT id, state, sent_message_id AS "sentMessageId"
        FROM fork_thread_parked_items WHERE thread_id = ${threadId} AND state IN ('open', 'sent')
      `;
      const now = DateTime.formatIso(yield* DateTime.now);
      let changed = false;
      for (const item of items) {
        // A null message is a row the old Send button marked: nothing reads it back.
        if (item.state === "sent" && item.sentMessageId === null) continue;
        const carriers = live.filter((pair) => pair.itemId === item.id);
        if (
          item.state === "sent" &&
          carriers.some((pair) => pair.messageId === item.sentMessageId)
        ) {
          continue;
        }
        const carrier = carriers[0];
        if (carrier === undefined && item.state === "open") continue;
        yield* carrier === undefined
          ? sql`
              UPDATE fork_thread_parked_items
              SET state = 'open', sent_message_id = NULL, resolved_at = NULL, updated_at = ${now}
              WHERE id = ${item.id}
            `
          : sql`
              UPDATE fork_thread_parked_items
              SET state = 'sent', sent_message_id = ${carrier.messageId},
                resolved_at = ${carrier.createdAt}, updated_at = ${now}
              WHERE id = ${item.id}
            `;
        changed = true;
      }
      return changed;
    }, sql.withTransaction);

    const sync = Effect.fn("ThreadDecisions.sync")(function* (threadId: ThreadId) {
      const parkedChanged = yield* syncParkedSends(threadId).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read the parked items a thread's messages carried", {
            threadId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      // Published as soon as its own transaction commits: the rest of the sync can wait seconds on the
      // decision judge, or fail, and neither may hold back a Sent (Sol round 3, S6).
      if (parkedChanged) yield* PubSub.publish(changes, threadId);
      const changed = yield* locks
        .withLock(
          threadId,
          Effect.all([
            syncMessages(threadId),
            // After the messages, so a card never closes a question before its reply is read. Each in its
            // own transaction: a failure here must not hide decisions already committed.
            syncCards(threadId).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed to read answers on question cards", {
                  threadId,
                  cause,
                }).pipe(Effect.as(false)),
              ),
            ),
            syncArtifacts(threadId).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed to sync thread artifacts", { threadId, cause }).pipe(
                  Effect.as(false),
                ),
              ),
            ),
          ]).pipe(Effect.map((changes) => changes.some(Boolean))),
        )
        .pipe(Effect.mapError(fail("Could not read this thread's decisions.")));
      if (changed) yield* PubSub.publish(changes, threadId);
      return changed || parkedChanged;
    });

    const snapshot = Effect.fn("ThreadDecisions.snapshot")(
      function* (threadId: ThreadId) {
        const questions = yield* sql<QuestionRow>`
          SELECT
            label, text, source_message_id AS "sourceMessageId", asked_at AS "askedAt", state,
            answer_text AS "answerText",
            answer_message_id AS "answerMessageId",
            resolved_at AS "resolvedAt"
          FROM fork_thread_decision_questions
          WHERE thread_id = ${threadId}
          ORDER BY asked_at DESC, label_number ASC
        `;
        const decided = yield* sql<{
          readonly messageId: string;
          readonly ordinal: number;
          readonly text: string;
          readonly createdAt: string;
        }>`
          SELECT message_id AS "messageId", ordinal, text, created_at AS "createdAt"
          FROM fork_thread_decided_without_asking
          WHERE thread_id = ${threadId}
          ORDER BY created_at DESC, ordinal ASC
          LIMIT ${THREAD_DECIDED_WITHOUT_ASKING_LIMIT}
        `;
        // A choice is vetoed once a message the user sent after its reply, and that reached (or waits to reach) the agent,
        // holds the panel's line `Veto: <text>`, trimmed as the panel reads its draft. One read for the
        // thread's messages with a veto line; the lines are matched here.
        const oldest = decided.at(-1)?.createdAt;
        const vetoes =
          oldest === undefined
            ? []
            : yield* sql<{ readonly createdAt: string; readonly text: string }>`
                SELECT message.created_at AS "createdAt",
                  json_extract(message.payload_json, '$.text') AS text
                FROM orchestration_v2_projection_messages AS message
                LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = message.run_id
                WHERE message.thread_id = ${threadId} AND message.role = 'user'
                  AND message.created_at > ${oldest}
                  AND ${userAuthored()}
                  AND ${neverStarted()} IS NOT 1
                  AND instr(json_extract(message.payload_json, '$.text'), ${VETO_PREFIX}) > 0
              `;
        const vetoLines = vetoes.map((message) => ({
          createdAt: message.createdAt,
          lines: new Set(message.text.split("\n").map((line) => line.trim())),
        }));
        const parkedRows = yield* sql<ThreadParkedItem>`
          SELECT * FROM (
            SELECT id, kind, text, state, parked_by AS "parkedBy", created_at AS "createdAt",
              updated_at AS "updatedAt", resolved_at AS "resolvedAt"
            FROM fork_thread_parked_items
            WHERE thread_id = ${threadId} AND state = 'open'
            ORDER BY created_at ASC, id ASC
          )
          UNION ALL
          SELECT * FROM (
            SELECT id, kind, text, state, parked_by AS "parkedBy", created_at AS "createdAt",
              updated_at AS "updatedAt", resolved_at AS "resolvedAt"
            FROM fork_thread_parked_items
            WHERE thread_id = ${threadId} AND state <> 'open'
            ORDER BY resolved_at DESC, id DESC
            LIMIT ${THREAD_PARKED_RESOLVED_LIMIT}
          )
        `;
        const parked = parkedRows.map((row) => ({
          ...row,
          // Stored in the new words (an older build may still write the old ones); said in the older
          // word, which every client reads (ThreadParkedItem's `kind`). No build writes any other; one
          // would show as the person's rather than vanish.
          kind: OLDER_KIND_WORD[parkKind(row.kind) ?? "me"],
        }));
        // Type names join here, so a name learned after a row was written still names it.
        const artifacts = yield* sql<ArtifactRow>`
          SELECT artifact.link_id AS id, artifact.url, artifact.title, artifact.description,
            artifact.source <> 'tool' AS "mentionedOnly",
            artifact.source = 'manual' AS "linkedByUser",
            artifact.updated_at AS "updatedAt",
            artifact.type_url AS "typeUrl", names.title AS "typeName",
            artifact.page_format AS "pageFormat", artifact.not_found_at AS "notFoundAt"
          FROM fork_thread_artifacts AS artifact
          LEFT JOIN fork_artifact_type_names AS names ON names.type_url = artifact.type_url
          WHERE artifact.thread_id = ${threadId}
            AND NOT (artifact.source = 'mention' AND (artifact.url IN ${sql.in([...CORE_ARTIFACT_TYPE_NAMES.keys()])}
              OR EXISTS (SELECT 1 FROM fork_artifact_type_names AS known
                WHERE known.type_url = artifact.url)))
          ORDER BY artifact.updated_at DESC, artifact.link_id ASC
          LIMIT ${THREAD_ARTIFACTS_LIMIT}
        `;
        const [artifactCount] = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM fork_thread_artifacts AS artifact
          WHERE artifact.thread_id = ${threadId}
            AND NOT (artifact.source = 'mention' AND (artifact.url IN ${sql.in([...CORE_ARTIFACT_TYPE_NAMES.keys()])}
              OR EXISTS (SELECT 1 FROM fork_artifact_type_names AS known
                WHERE known.type_url = artifact.url)))
        `;
        // The newest person-typed message at or before the watermark; a card read before any message
        // leaves the watermark at ('', ''), which passes none.
        const [lastTypedRead] = yield* sql<{ readonly messageId: string }>`
          SELECT message.message_id AS "messageId"
          FROM orchestration_v2_projection_messages AS message
          JOIN fork_thread_decision_sync AS sync ON sync.thread_id = message.thread_id
          WHERE message.thread_id = ${threadId} AND message.role = 'user' AND ${userAuthored()}
            AND (message.created_at, message.message_id) <= (sync.after_created_at, sync.after_message_id)
          ORDER BY message.created_at DESC, message.message_id DESC
          LIMIT 1
        `;
        return {
          threadId,
          questions: questions.map((row): ThreadDecisionQuestion => ({
            label: row.label,
            ...splitQuestion(row.text),
            sourceMessageId: MessageId.make(row.sourceMessageId),
            askedAt: row.askedAt,
            state: row.state,
            answerText: row.answerText === null ? null : answerPreview(row.answerText, row.label),
            answerMessageId:
              row.answerMessageId === null ? null : MessageId.make(row.answerMessageId),
            resolvedAt: row.resolvedAt,
          })),
          decidedWithoutAsking: decided.map((row) => ({
            ...row,
            messageId: MessageId.make(row.messageId),
            vetoed: vetoLines.some(
              (message) =>
                message.createdAt > row.createdAt && message.lines.has(`${VETO_PREFIX}${row.text}`),
            ),
          })),
          openCount: questions.filter((row) => row.state === "open").length,
          parked,
          parkedOpenCount: parked.filter((item) => item.state === "open").length,
          artifacts: artifacts.map((row): ThreadArtifact => ({
            id: row.id,
            url: row.url,
            title: row.title,
            description: row.description,
            mentionedOnly: row.mentionedOnly === 1,
            updatedAt: row.updatedAt,
            linkedByUser: row.linkedByUser === 1,
            type: artifactType(row),
            notFoundAt: row.notFoundAt,
          })),
          artifactCount: artifactCount?.count ?? 0,
          lastTypedMessageRead:
            lastTypedRead === undefined ? null : MessageId.make(lastTypedRead.messageId),
        };
      },
      NodeSqliteClient.readOnly,
      Effect.mapError(fail("Could not read this thread's decisions.")),
    );

    const subscribe = (threadId: ThreadId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribes before reading, then backfills replies written while another build ran, in the
          // background: messages sent since the judge took over are each judged, which can take seconds,
          // and the panel shows the current rows meanwhile. It runs in the service's scope, so a client
          // leaving does not cut the backlog short; what it changes publishes as usual.
          const subscription = yield* PubSub.subscribe(changes);
          yield* sync(threadId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to sync thread decisions", { threadId, cause }),
            ),
            Effect.forkIn(scope),
          );
          return Stream.concat(
            Stream.fromEffect(snapshot(threadId)),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((changed) => changed === threadId),
              Stream.mapEffect(() => snapshot(threadId)),
            ),
          );
        }),
      );

    // A question asked again since the user saw it (a new source message) is not the one they reopen.
    // One already open, asked again or reopened elsewhere, is what Reopen asks for, so it succeeds.
    const reopen = Effect.fn("ThreadDecisions.reopen")(function* (
      input: ThreadDecisionQuestionInput,
    ) {
      const state = yield* locks
        .withLock(
          input.threadId,
          Effect.gen(function* () {
            const reopened = yield* sql`
              UPDATE fork_thread_decision_questions
              SET state = 'open', answer_text = NULL, answer_message_id = NULL, resolved_at = NULL
              WHERE thread_id = ${input.threadId} AND label = ${input.label}
                AND source_message_id = ${input.sourceMessageId} AND state <> 'open'
              RETURNING label
            `;
            if (reopened.length > 0) return "reopened";
            const [current] = yield* sql<{ readonly state: string }>`
              SELECT state FROM fork_thread_decision_questions
              WHERE thread_id = ${input.threadId} AND label = ${input.label}
            `;
            if (current === undefined) return "unknown";
            return current.state === "open" ? "alreadyOpen" : "askedAgain";
          }),
        )
        .pipe(Effect.mapError(fail(`Could not reopen ${input.label}.`)));
      if (state === "unknown") {
        return yield* new ThreadDecisionsError({
          message: `${input.label} is not a question in this thread.`,
        });
      }
      if (state === "askedAgain") {
        return yield* new ThreadDecisionsError({
          message: `${input.label} was asked again since; nothing was reopened.`,
        });
      }
      if (state === "reopened") yield* PubSub.publish(changes, input.threadId);
    });

    // Not under the thread's lock, unlike Reopen: it would wait out a judge call (up to 20 s). A sync's
    // closings write only open questions, so none lands on a dismissed one; its re-ask upsert does reopen
    // one, by design, as it reopens any closed question. A question asked again since the user saw it
    // (a new source message) is refused, so a re-ask racing the click is not dismissed unseen.
    const dismiss = Effect.fn("ThreadDecisions.dismiss")(function* (
      input: ThreadDecisionQuestionInput,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const dismissed = yield* sql`
        UPDATE fork_thread_decision_questions
        SET state = 'dismissed', answer_text = NULL, answer_message_id = NULL, resolved_at = ${now}
        WHERE thread_id = ${input.threadId} AND label = ${input.label}
          AND source_message_id = ${input.sourceMessageId} AND state = 'open'
        RETURNING label
      `.pipe(Effect.mapError(fail(`Could not dismiss ${input.label}.`)));
      if (dismissed.length === 0) {
        return yield* new ThreadDecisionsError({
          message: `${input.label} is no longer open as shown (closed, or asked again); nothing was dismissed.`,
        });
      }
      yield* PubSub.publish(changes, input.threadId);
    });

    const refusePlaceholder = (text: string) =>
      isPlaceholder(text)
        ? Effect.fail(new ThreadDecisionsError({ message: PLACEHOLDER_PARK_MESSAGE }))
        : Effect.void;

    const park = Effect.fn("ThreadDecisions.park")(function* (input: ThreadParkRequest) {
      if (input.items.length === 0) {
        return yield* new ThreadDecisionsError({ message: "Nothing to park." });
      }
      yield* Effect.forEach(input.items, (item) => refusePlaceholder(item.text), {
        discard: true,
      });
      const now = DateTime.formatIso(yield* DateTime.now);
      const parked = yield* Effect.gen(function* () {
        // `delegated` is isDelegatedAppThread in SQL: a JSON null delegatedFrom reads as NULL too.
        const [thread] = yield* sql<{
          readonly side_chat: number | null;
          readonly delegated: number;
          readonly workflow_step: number | null;
        }>`
          SELECT json_extract(payload_json, '$.lineage.sideChat') AS side_chat,
            (json_extract(payload_json, '$.lineage.relationshipToParent') IS 'subagent'
              OR json_extract(payload_json, '$.delegatedFrom') IS NOT NULL) AS delegated,
            json_extract(payload_json, '$.lineage.workflowStep') AS workflow_step
          FROM orchestration_v2_projection_threads
          WHERE thread_id = ${input.threadId} AND deleted_at IS NULL
        `;
        if (thread === undefined) return "missing";
        // Every park passes here (the Parked tab's field, t3_park, any client), not only `/park`'s.
        if (thread.side_chat === 1) return "sideChat";
        if (thread.delegated === 1) return "subagent";
        if (thread.workflow_step === 1) return "workflowStep";
        for (const item of input.items) {
          yield* sql`
            INSERT INTO fork_thread_parked_items (
              thread_id, kind, text, state, parked_by, created_at, updated_at
            ) VALUES (
              ${input.threadId}, ${PARK_KIND_OF_WORD[item.kind]}, ${item.text.trim()}, 'open',
              ${input.parkedBy},
              ${now}, ${now}
            )
          `;
        }
        return "parked";
      }).pipe(sql.withTransaction, Effect.mapError(fail("Could not park this.")));
      if (parked === "missing") {
        return yield* new ThreadDecisionsError({ message: "This thread was not found." });
      }
      if (parked === "sideChat") {
        return yield* new ThreadDecisionsError({ message: SIDE_CHAT_PARK_MESSAGE });
      }
      if (parked === "subagent") {
        return yield* new ThreadDecisionsError({ message: SUBAGENT_PARK_MESSAGE });
      }
      if (parked === "workflowStep") {
        return yield* new ThreadDecisionsError({ message: WORKFLOW_STEP_PARK_MESSAGE });
      }
      yield* PubSub.publish(changes, input.threadId);
    });

    const updateParked = Effect.fn("ThreadDecisions.updateParked")(function* (
      input: ThreadParkedUpdateInput,
    ) {
      if (input.action === "edit") yield* refusePlaceholder(input.text);
      const now = DateTime.formatIso(yield* DateTime.now);
      const reopening = input.action === "reopen";
      const set = (() => {
        switch (input.action) {
          case "edit":
            return sql`text = ${input.text.trim()}`;
          case "move":
            return sql`kind = ${PARK_KIND_OF_WORD[input.kind]}`;
          case "reopen":
            return sql`state = 'open', resolved_at = NULL, sent_message_id = NULL`;
          case "done":
          case "drop":
            return sql`state = ${RESOLVED_PARKED_STATE[input.action]}, resolved_at = ${now}`;
        }
      })();
      const updated = yield* Effect.gen(function* () {
        const rows = yield* sql`
          UPDATE fork_thread_parked_items SET ${set}, updated_at = ${now}
          WHERE thread_id = ${input.threadId} AND id = ${input.id}
            AND ${reopening ? sql`state <> 'open'` : sql`state = 'open'`}
          RETURNING id
        `;
        // Every message recorded carrying it so far no longer marks it Sent, read now rather than from
        // what a sync has seen: one recorded just before this but not yet synced would undo the Reopen.
        // Only a message recorded after this marks it again.
        if (reopening && rows.length > 0) {
          for (const pair of yield* carriedPairs(input.threadId)) {
            if (pair.itemId !== input.id) continue;
            yield* sql`
              INSERT INTO fork_thread_parked_set_aside (thread_id, item_id, message_id)
              VALUES (${input.threadId}, ${input.id}, ${pair.messageId})
              ON CONFLICT DO NOTHING
            `;
          }
        }
        return rows;
      }).pipe(sql.withTransaction, Effect.mapError(fail("Could not update this item.")));
      if (updated.length === 0) {
        return yield* new ThreadDecisionsError({
          message: reopening
            ? "This item is not resolved."
            : "This item is no longer open in this thread.",
        });
      }
      yield* PubSub.publish(changes, input.threadId);
    });

    const linkArtifact = Effect.fn("ThreadDecisions.linkArtifact")(function* (
      input: ThreadArtifactLinkInput,
    ) {
      const link = parseArtifactLink(input.url);
      if (link === null) {
        return yield* new ThreadDecisionsError({ message: NOT_AN_ARTIFACT_LINK });
      }
      const title = input.title ?? null;
      const now = DateTime.formatIso(yield* DateTime.now);
      const linked = yield* locks
        .withLock(
          input.threadId,
          Effect.gen(function* () {
            const [thread] = yield* sql`
              SELECT 1 FROM orchestration_v2_projection_threads
              WHERE thread_id = ${input.threadId} AND deleted_at IS NULL
            `;
            if (thread === undefined) return false;
            // Either link form finds a listed artifact: its own id, or its publish's uuid.
            const [listed] = yield* sql<{ readonly linkId: string; readonly source: string }>`
              SELECT link_id AS "linkId", source FROM fork_thread_artifacts
              WHERE thread_id = ${input.threadId}
                AND (link_id = ${link.id} OR artifact_id = ${link.id})
            `;
            if (listed !== undefined) {
              // A mention becomes the user's link (their title, and Unlink), dated now so it lists
              // among the newest rows; a published row keeps its own, and a title the user gives
              // fills one it lacks. The message watermark is not reset, so an unlinked mention stays
              // gone.
              yield* listed.source === "mention"
                ? sql`
                    UPDATE fork_thread_artifacts
                    SET source = 'manual', title = COALESCE(${title}, title), updated_at = ${now}
                    WHERE thread_id = ${input.threadId} AND link_id = ${listed.linkId}
                  `
                : sql`
                    UPDATE fork_thread_artifacts SET title = ${title}
                    WHERE thread_id = ${input.threadId} AND link_id = ${listed.linkId}
                      AND title IS NULL
                  `;
              return true;
            }
            yield* sql`
              INSERT INTO fork_thread_artifacts (
                thread_id, link_id, artifact_id, url, title, description, source, first_seen_at,
                updated_at
              ) VALUES (
                ${input.threadId}, ${link.id}, NULL, ${link.url}, ${title}, NULL, 'manual', ${now},
                ${now}
              )
            `;
            return true;
          }).pipe(sql.withTransaction),
        )
        .pipe(Effect.mapError(fail("Could not link this artifact.")));
      if (!linked) {
        return yield* new ThreadDecisionsError({ message: "This thread was not found." });
      }
      yield* PubSub.publish(changes, input.threadId);
    });

    const unlinkArtifact = Effect.fn("ThreadDecisions.unlinkArtifact")(function* (
      input: ThreadArtifactUnlinkInput,
    ) {
      const removed = yield* locks
        .withLock(
          input.threadId,
          sql`
            DELETE FROM fork_thread_artifacts
            WHERE thread_id = ${input.threadId} AND link_id = ${input.id} AND source = 'manual'
            RETURNING link_id
          `,
        )
        .pipe(Effect.mapError(fail("Could not unlink this artifact.")));
      if (removed.length === 0) {
        return yield* new ThreadDecisionsError({
          message: "Only an artifact you linked can be unlinked from this thread.",
        });
      }
      yield* PubSub.publish(changes, input.threadId);
    });

    return ThreadDecisions.of({
      sync,
      snapshot,
      subscribe,
      reopen,
      dismiss,
      park,
      updateParked,
      linkArtifact,
      unlinkArtifact,
    });
  }),
);

const LISTENER_CONCURRENCY = 4;

/** Keeps decisions current as replies finish and the user answers, whether or not a client watches. */
export const layerListener = Layer.effectDiscard(
  Effect.gen(function* () {
    const decisions = yield* ThreadDecisions;
    const eventSink = yield* EventSink.EventSinkV2;
    const afterSequence = yield* eventSink.latestSequence().pipe(Effect.orDie);
    yield* Stream.merge(
      eventSink.stream({ afterSequence, eventType: "message.updated" }).pipe(
        // The user's message closes questions; an assistant message finishing covers a reply that
        // stops streaming after its run already reads as ended, which no run event would follow.
        Stream.filter(
          (stored) =>
            stored.event.type === "message.updated" &&
            (stored.event.payload.role === "user" || stored.event.payload.role === "assistant") &&
            !stored.event.payload.streaming,
        ),
      ),
      eventSink
        .stream({ afterSequence, eventType: "run.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              ENDED_RUN_STATUSES.has(stored.event.payload.status),
          ),
        ),
    ).pipe(
      // A few at once: a sync may wait seconds on the decision judge, and must not hold up other threads.
      // The per-thread lock keeps one thread's syncs in order; a sync after a slow one finds little left.
      // Ceiling: 4 threads judged at once; a fifth waits for a slot.
      Stream.mapEffect(
        (stored) =>
          decisions.sync(stored.event.threadId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to sync thread decisions", {
                threadId: stored.event.threadId,
                cause,
              }),
            ),
          ),
        { concurrency: LISTENER_CONCURRENCY, unordered: true },
      ),
      Stream.runDrain,
      Effect.catchCause((cause) =>
        Effect.logError("Thread decisions listener stopped; decisions sync only on subscribe", {
          cause,
        }),
      ),
      Effect.forkScoped,
    );
  }),
);
