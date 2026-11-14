import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Fork-only, as 001: no foreign keys or triggers on upstream tables. Rows are derived from
// projected messages and turn items, so a thread without a watermark rebuilds them from the start.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // link_id is the id in the URL; artifact_id is the tool output's uuid, which `code/artifact/` links use.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_thread_artifacts (
      thread_id TEXT NOT NULL,
      link_id TEXT NOT NULL,
      artifact_id TEXT,
      url TEXT NOT NULL,
      title TEXT,
      description TEXT,
      source TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, link_id)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS fork_thread_artifacts_updated
    ON fork_thread_artifacts (thread_id, updated_at)
  `;
  // Messages and turn items order differently, so each keeps its own position.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_thread_artifact_sync (
      thread_id TEXT PRIMARY KEY,
      after_message_created_at TEXT NOT NULL,
      after_message_id TEXT NOT NULL,
      after_item_updated_at TEXT NOT NULL,
      after_item_id TEXT NOT NULL
    ) WITHOUT ROWID
  `;
});
