import {
  MessageId,
  type ThreadDecisionQuestion,
  type ThreadDecisionReopenInput,
  ThreadDecisionsError,
  type ThreadDecisionsSnapshot,
  type ThreadId,
  type ThreadParkedItem,
  type ThreadParkedKind,
  type ThreadParkedUpdateInput,
  THREAD_ARTIFACTS_LIMIT,
  THREAD_DECIDED_WITHOUT_ASKING_LIMIT,
  THREAD_PARKED_RESOLVED_LIMIT,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  closingFor,
  readReplyDecisions,
  splitQuestion,
} from "@t3tools/shared/sessionKit/decisions";
import { isPlaceholder } from "@t3tools/shared/sessionKit/parks";
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

// Fork-only. Questions are derived from projected messages; only resolutions are irreplaceable.

// A completed turn is first persisted as `waiting` (RunExecutionService), so it counts as ended.
const ENDED_RUN_STATUSES: ReadonlySet<string> = new Set([
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

// The full answer stays in the database; the snapshot carries a preview.
const ANSWER_TEXT_LIMIT = 300;

interface MessageRow {
  readonly messageId: string;
  readonly role: string;
  readonly createdAt: string;
  readonly runId: string | null;
  readonly runStatus: string | null;
  readonly streaming: number;
  readonly text: string | null;
  readonly userAuthored: number;
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

// Both forms the Artifact tool documents: `artifact/{id}` and `code/artifact/{uuid}`.
const ARTIFACT_URL_SOURCE =
  "https://claude\\.ai/(?:artifact/([A-Za-z0-9]+)|code/artifact/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))";
const ARTIFACT_URL = new RegExp(ARTIFACT_URL_SOURCE, "g");
const ARTIFACT_URL_EXACT = new RegExp(`^${ARTIFACT_URL_SOURCE}$`);
const ARTIFACT_TITLE_LIMIT = 200;
const ARTIFACT_DESCRIPTION_LIMIT = 1000;

// The Artifact tool's output is provider data: an object, or JSON text, from any action or failure.
const decodeArtifactPublish = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      url: Schema.String,
      title: Schema.optional(Schema.Unknown),
      artifact_id: Schema.optional(Schema.Unknown),
    }),
  ),
);

interface ArtifactItemRow {
  readonly itemId: string;
  readonly updatedAt: string;
  readonly output: unknown;
  readonly description: unknown;
}

export interface ThreadParkRequest {
  readonly threadId: ThreadId;
  readonly items: ReadonlyArray<{ readonly kind: ThreadParkedKind; readonly text: string }>;
  readonly parkedBy: ThreadParkedItem["parkedBy"];
}

export const PLACEHOLDER_PARK_MESSAGE =
  "not parked: the text is empty or a placeholder. Park only what the user asked to set aside, or a real follow-up.";

const RESOLVED_PARKED_STATE = { done: "done", drop: "dropped", sent: "sent" } as const;

export class ThreadDecisions extends Context.Service<
  ThreadDecisions,
  {
    /** Reads the thread's messages and Artifact tool calls after its watermarks; true when a row changed. */
    readonly sync: (threadId: ThreadId) => Effect.Effect<boolean, ThreadDecisionsError>;
    readonly snapshot: (
      threadId: ThreadId,
    ) => Effect.Effect<ThreadDecisionsSnapshot, ThreadDecisionsError>;
    readonly subscribe: (
      threadId: ThreadId,
    ) => Stream.Stream<ThreadDecisionsSnapshot, ThreadDecisionsError>;
    readonly reopen: (
      input: ThreadDecisionReopenInput,
    ) => Effect.Effect<void, ThreadDecisionsError>;
    /** Parks every item or none. */
    readonly park: (input: ThreadParkRequest) => Effect.Effect<void, ThreadDecisionsError>;
    readonly updateParked: (
      input: ThreadParkedUpdateInput,
    ) => Effect.Effect<void, ThreadDecisionsError>;
  }
>()("t3/decisions/ThreadDecisions") {}

export const layer = Layer.effect(
  ThreadDecisions,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const locks = yield* KeyedLock.make<ThreadId>();
    // Subscribers re-read their thread on a signal, so a slow one only needs recent thread ids.
    const changes = yield* PubSub.sliding<ThreadId>(256);
    const fail = (message: string) => (cause: unknown) =>
      new ThreadDecisionsError({ message, cause });

    // Rows of deleted threads; their messages are gone from every view, so nothing can resolve them.
    // Parked items are user-authored and cannot be rebuilt, so only a soft-deleted thread drops them.
    yield* Effect.forEach(
      [
        `DELETE FROM fork_thread_parked_items WHERE thread_id IN (
          SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL
        )`,
        ...[
          "fork_thread_decision_questions",
          "fork_thread_decided_without_asking",
          "fork_thread_decision_sync",
          "fork_thread_artifacts",
          "fork_thread_artifact_sync",
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

    const syncUnlocked = Effect.fn("ThreadDecisions.syncUnlocked")(function* (threadId: ThreadId) {
      const [watermark] = yield* sql<{
        readonly afterCreatedAt: string;
        readonly afterMessageId: string;
      }>`
        SELECT after_created_at AS "afterCreatedAt", after_message_id AS "afterMessageId"
        FROM fork_thread_decision_sync WHERE thread_id = ${threadId}
      `;
      const rows = yield* sql<MessageRow>`
        SELECT
          message.message_id AS "messageId",
          message.role,
          message.created_at AS "createdAt",
          message.run_id AS "runId",
          run.status AS "runStatus",
          message.streaming,
          json_extract(message.payload_json, '$.text') AS text,
          -- Upstream's user-authored test (ProjectionStore), plus the payloads that mark automation.
          (
            json_extract(message.payload_json, '$.createdBy') = 'user'
            AND json_type(message.payload_json, '$.idleCompaction') IS NULL
            AND json_type(message.payload_json, '$.senderThreadId') IS NULL
            AND json_type(message.payload_json, '$.scheduledTaskId') IS NULL
            AND json_type(message.payload_json, '$.linkedSender') IS NULL
            AND json_type(message.payload_json, '$.delegatedCompletion') IS NULL
            AND json_type(message.payload_json, '$.notification') IS NULL
          ) AS "userAuthored"
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
      const last = ready.at(-1);
      if (last === undefined) return false;

      // A run's reply is its last assistant message; earlier ones narrate tool calls.
      const replyByRun = new Map<string, string>();
      for (const row of ready) {
        if (row.role === "assistant") replyByRun.set(row.runId ?? row.messageId, row.messageId);
      }

      let changed = false;
      for (const row of ready) {
        if (row.text === null) continue;
        if (
          row.role === "assistant" &&
          replyByRun.get(row.runId ?? row.messageId) === row.messageId
        ) {
          const read = readReplyDecisions(row.text);
          for (const question of read.questions) {
            // An unshaped line about a label ("Q4 is still open") may reopen it, never reword it.
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
              WHERE ${shaped ? sql`source_message_id <> excluded.source_message_id` : sql`state <> 'open'`}
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
        } else if (row.role === "user" && row.userAuthored === 1) {
          const open = yield* sql<{
            readonly label: string;
            readonly sourceMessageId: string;
            readonly askedAt: string;
          }>`
            SELECT label, source_message_id AS "sourceMessageId", asked_at AS "askedAt"
            FROM fork_thread_decision_questions
            WHERE thread_id = ${threadId} AND state = 'open'
          `;
          if (open.length === 0) continue;
          const closing = closingFor(row.text, open);
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
      // Every tool item moves the watermark; only Claude's Artifact calls pay for their output.
      const items = yield* sql<ArtifactItemRow>`
        SELECT
          turn_item_id AS "itemId",
          updated_at AS "updatedAt",
          CASE WHEN json_extract(payload_json, '$.toolName') = 'Artifact'
            AND json_extract(payload_json, '$.nativeItemRef.driver') = 'claudeAgent'
          THEN json_extract(payload_json, '$.output') END AS output,
          CASE WHEN json_extract(payload_json, '$.toolName') = 'Artifact'
            AND json_extract(payload_json, '$.nativeItemRef.driver') = 'claudeAgent'
          THEN json_extract(payload_json, '$.input.description') END AS description
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
      const blocked = messages.findIndex((row) => row.streaming === 1);
      const ready = blocked === -1 ? messages : messages.slice(0, blocked);
      const lastItem = items.at(-1);
      const lastMessage = ready.at(-1);
      if (lastItem === undefined && lastMessage === undefined) return false;

      let changed = false;
      // Publishes first, so a reply linking an artifact this thread published keeps its title.
      for (const item of items) {
        if (item.output === null) continue;
        const publish = Option.getOrNull(decodeArtifactPublish(item.output));
        const match = publish === null ? null : ARTIFACT_URL_EXACT.exec(publish.url);
        const id = match?.[1] ?? match?.[2];
        if (publish === null || id === undefined) continue;
        const title =
          typeof publish.title === "string" && publish.title !== "" ? publish.title : null;
        const description =
          typeof item.description === "string" && item.description !== "" ? item.description : null;
        const artifactId =
          typeof publish.artifact_id === "string" && publish.artifact_id !== ""
            ? publish.artifact_id
            : null;
        // A `code/artifact/{uuid}` link read before this publish named the same artifact.
        const [linked] =
          artifactId === null || artifactId === id
            ? []
            : yield* sql<{ readonly firstSeenAt: string }>`
                DELETE FROM fork_thread_artifacts
                WHERE thread_id = ${threadId} AND link_id = ${artifactId} AND source = 'mention'
                RETURNING first_seen_at AS "firstSeenAt"
              `;
        const firstSeenAt =
          linked !== undefined && linked.firstSeenAt < item.updatedAt
            ? linked.firstSeenAt
            : item.updatedAt;
        const upserted = yield* sql`
          INSERT INTO fork_thread_artifacts (
            thread_id, link_id, artifact_id, url, title, description, source, first_seen_at,
            updated_at
          ) VALUES (
            ${threadId}, ${id}, ${artifactId}, ${publish.url},
            substr(${title}, 1, ${ARTIFACT_TITLE_LIMIT}),
            substr(${description}, 1, ${ARTIFACT_DESCRIPTION_LIMIT}), 'tool',
            ${firstSeenAt}, ${item.updatedAt}
          )
          ON CONFLICT (thread_id, link_id) DO UPDATE SET
            artifact_id = COALESCE(excluded.artifact_id, artifact_id),
            url = excluded.url,
            title = COALESCE(excluded.title, title),
            description = COALESCE(excluded.description, description),
            source = 'tool',
            first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
            updated_at = excluded.updated_at
          WHERE source = 'mention' OR excluded.updated_at >= updated_at
          RETURNING link_id
        `;
        changed ||= upserted.length > 0 || linked !== undefined;
      }
      for (const row of ready) {
        if (row.text === null) continue;
        const links = new Map<string, string>();
        for (const match of row.text.matchAll(ARTIFACT_URL)) {
          const id = match[1] ?? match[2];
          if (id !== undefined && !links.has(id)) links.set(id, match[0]);
        }
        for (const [id, url] of links) {
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

    const sync = Effect.fn("ThreadDecisions.sync")(function* (threadId: ThreadId) {
      const changed = yield* locks
        .withLock(
          threadId,
          Effect.all([
            syncUnlocked(threadId),
            // Its own transaction: a failure here must not hide decisions already committed.
            syncArtifacts(threadId).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed to sync thread artifacts", { threadId, cause }).pipe(
                  Effect.as(false),
                ),
              ),
            ),
          ]).pipe(Effect.map(([decisions, artifacts]) => decisions || artifacts)),
        )
        .pipe(Effect.mapError(fail("Could not read this thread's decisions.")));
      if (changed) yield* PubSub.publish(changes, threadId);
      return changed;
    });

    const snapshot = Effect.fn("ThreadDecisions.snapshot")(
      function* (threadId: ThreadId) {
        const questions = yield* sql<QuestionRow>`
          SELECT
            label, text, source_message_id AS "sourceMessageId", asked_at AS "askedAt", state,
            substr(answer_text, 1, ${ANSWER_TEXT_LIMIT + 1}) AS "answerText",
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
        const parked = yield* sql<ThreadParkedItem>`
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
        const artifacts = yield* sql<{
          readonly id: string;
          readonly url: string;
          readonly title: string | null;
          readonly description: string | null;
          readonly mentionedOnly: number;
          readonly updatedAt: string;
        }>`
          SELECT link_id AS id, url, title, description,
            source = 'mention' AS "mentionedOnly", updated_at AS "updatedAt"
          FROM fork_thread_artifacts
          WHERE thread_id = ${threadId}
          ORDER BY updated_at DESC, link_id ASC
          LIMIT ${THREAD_ARTIFACTS_LIMIT}
        `;
        const [artifactCount] = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM fork_thread_artifacts WHERE thread_id = ${threadId}
        `;
        return {
          threadId,
          questions: questions.map((row): ThreadDecisionQuestion => ({
            label: row.label,
            ...splitQuestion(row.text),
            sourceMessageId: MessageId.make(row.sourceMessageId),
            askedAt: row.askedAt,
            state: row.state,
            answerText:
              row.answerText !== null && row.answerText.length > ANSWER_TEXT_LIMIT
                ? `${row.answerText.slice(0, ANSWER_TEXT_LIMIT - 1)}…`
                : row.answerText,
            answerMessageId:
              row.answerMessageId === null ? null : MessageId.make(row.answerMessageId),
            resolvedAt: row.resolvedAt,
          })),
          decidedWithoutAsking: decided.map((row) => ({
            ...row,
            messageId: MessageId.make(row.messageId),
          })),
          openCount: questions.filter((row) => row.state === "open").length,
          parked,
          parkedOpenCount: parked.filter((item) => item.state === "open").length,
          artifacts: artifacts.map((row) => ({ ...row, mentionedOnly: row.mentionedOnly === 1 })),
          artifactCount: artifactCount?.count ?? 0,
        };
      },
      NodeSqliteClient.readOnly,
      Effect.mapError(fail("Could not read this thread's decisions.")),
    );

    const subscribe = (threadId: ThreadId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Backfills replies written while another build ran, then subscribes before reading.
          yield* sync(threadId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to sync thread decisions", { threadId, cause }),
            ),
          );
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(snapshot(threadId)),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((changed) => changed === threadId),
              Stream.mapEffect(() => snapshot(threadId)),
            ),
          );
        }),
      );

    const reopen = Effect.fn("ThreadDecisions.reopen")(function* (
      input: ThreadDecisionReopenInput,
    ) {
      const reopened = yield* locks
        .withLock(
          input.threadId,
          sql`
            UPDATE fork_thread_decision_questions
            SET state = 'open', answer_text = NULL, answer_message_id = NULL, resolved_at = NULL
            WHERE thread_id = ${input.threadId} AND label = ${input.label} AND state <> 'open'
            RETURNING label
          `,
        )
        .pipe(Effect.mapError(fail(`Could not reopen ${input.label}.`)));
      if (reopened.length === 0) {
        return yield* new ThreadDecisionsError({
          message: `${input.label} is not a resolved question in this thread.`,
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
        const [thread] = yield* sql`
          SELECT 1 FROM orchestration_v2_projection_threads
          WHERE thread_id = ${input.threadId} AND deleted_at IS NULL
        `;
        if (thread === undefined) return false;
        for (const item of input.items) {
          yield* sql`
            INSERT INTO fork_thread_parked_items (
              thread_id, kind, text, state, parked_by, created_at, updated_at
            ) VALUES (
              ${input.threadId}, ${item.kind}, ${item.text.trim()}, 'open', ${input.parkedBy},
              ${now}, ${now}
            )
          `;
        }
        return true;
      }).pipe(sql.withTransaction, Effect.mapError(fail("Could not park this.")));
      if (!parked) {
        return yield* new ThreadDecisionsError({ message: "This thread was not found." });
      }
      yield* PubSub.publish(changes, input.threadId);
    });

    const updateParked = Effect.fn("ThreadDecisions.updateParked")(function* (
      input: ThreadParkedUpdateInput,
    ) {
      if (input.action === "edit") yield* refusePlaceholder(input.text);
      const now = DateTime.formatIso(yield* DateTime.now);
      const reopening = input.action === "reopen";
      const set =
        input.action === "edit"
          ? sql`text = ${input.text.trim()}`
          : reopening
            ? sql`state = 'open', resolved_at = NULL`
            : sql`state = ${RESOLVED_PARKED_STATE[input.action]}, resolved_at = ${now}`;
      const updated = yield* sql`
        UPDATE fork_thread_parked_items SET ${set}, updated_at = ${now}
        WHERE thread_id = ${input.threadId} AND id = ${input.id}
          AND ${reopening ? sql`state <> 'open'` : sql`state = 'open'`}
        RETURNING id
      `.pipe(Effect.mapError(fail("Could not update this item.")));
      if (updated.length === 0) {
        return yield* new ThreadDecisionsError({
          message: reopening
            ? "This item is not resolved."
            : "This item is no longer open in this thread.",
        });
      }
      yield* PubSub.publish(changes, input.threadId);
    });

    return ThreadDecisions.of({ sync, snapshot, subscribe, reopen, park, updateParked });
  }),
);

/** Keeps decisions current as replies finish and the user answers, whether or not a client watches. */
export const layerListener = Layer.effectDiscard(
  Effect.gen(function* () {
    const decisions = yield* ThreadDecisions;
    const eventSink = yield* EventSink.EventSinkV2;
    const afterSequence = yield* eventSink.latestSequence().pipe(Effect.orDie);
    yield* Stream.merge(
      eventSink
        .stream({ afterSequence, eventType: "message.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "message.updated" &&
              stored.event.payload.role === "user" &&
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
      Stream.runForEach((stored) =>
        decisions.sync(stored.event.threadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to sync thread decisions", {
              threadId: stored.event.threadId,
              cause,
            }),
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("Thread decisions listener stopped; decisions sync only on subscribe", {
          cause,
        }),
      ),
      Effect.forkScoped,
    );
  }),
);
