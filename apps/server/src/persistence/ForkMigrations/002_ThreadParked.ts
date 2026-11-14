import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Fork-only, as 001: no foreign keys or triggers on upstream tables.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_thread_parked_items (
      id INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      state TEXT NOT NULL,
      parked_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS fork_thread_parked_items_thread
    ON fork_thread_parked_items (thread_id, state)
  `;
});
