import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Fork-only, as 001. The position of the AskUserQuestion cards (user_input_request turn items) the
// decisions sync has read, beside its message watermark: turn items order by updated_at, not by
// creation. Empty reads every answered card from the start, once.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('fork_thread_decision_sync')
  `;
  for (const column of ["after_item_updated_at", "after_item_id"]) {
    if (columns.some((existing) => existing.name === column)) continue;
    yield* sql.unsafe(
      `ALTER TABLE fork_thread_decision_sync ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`,
    );
  }
});
