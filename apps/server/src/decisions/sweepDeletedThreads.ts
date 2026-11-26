import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Deletes the fork's rows of deleted threads. Parked items and artifacts hold what the user made,
 * so only a soft-deleted thread drops them (FORK.md, Artifacts). Runs when ThreadDecisions starts
 * and on each compaction pass (DatabaseStorage), so a deleted thread's text goes by the next pass.
 */
export const sweepDeletedThreads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
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
  );
}).pipe(
  Effect.catchCause((cause) => Effect.logWarning("Failed to sweep orphaned decisions", { cause })),
);
