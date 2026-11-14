import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Fork-only: no foreign keys or triggers on upstream tables, so official builds can keep using this database.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_thread_decision_questions (
      thread_id TEXT NOT NULL,
      label TEXT NOT NULL,
      label_number INTEGER NOT NULL,
      text TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      asked_at TEXT NOT NULL,
      state TEXT NOT NULL,
      answer_text TEXT,
      answer_message_id TEXT,
      resolved_at TEXT,
      PRIMARY KEY (thread_id, label)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_thread_decided_without_asking (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, message_id, ordinal)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_thread_decision_sync (
      thread_id TEXT PRIMARY KEY,
      after_created_at TEXT NOT NULL,
      after_message_id TEXT NOT NULL
    ) WITHOUT ROWID
  `;
});
