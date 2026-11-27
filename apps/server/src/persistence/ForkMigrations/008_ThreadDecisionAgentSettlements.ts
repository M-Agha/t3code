import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Fork-only, as 001 (MAIN-127, MAIN-129). `settled_by`: 'agent' on a question its thread's agent closed
// through t3_question, else NULL; a column, not a state, so a client from before still lists the row
// (an unknown state is dropped). `read_back_at`: when the Tracker's one-time read-back of the messages
// from before the judge's cutoff ran; NULL until then.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [table, column] of [
    ["fork_thread_decision_questions", "settled_by"],
    ["fork_thread_decision_sync", "read_back_at"],
  ] as const) {
    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info(${table})
    `;
    if (columns.some((existing) => existing.name === column)) continue;
    yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  }
});
