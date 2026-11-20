import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Fork-only, as 001. Parked kinds become who acts on an item (MAIN-67, MAIN-68): `prompt` was words for
// the agent, `todo` and `later` the person's. Then what marks an item Sent (MAIN-75): the message that
// carried its composer chip, and the messages a Reopen set aside. Idempotent, as every fork migration.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE fork_thread_parked_items SET kind = 'agent' WHERE kind = 'prompt'`;
  yield* sql`UPDATE fork_thread_parked_items SET kind = 'me' WHERE kind IN ('todo', 'later')`;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('fork_thread_parked_items')
  `;
  // The message that keeps a Sent item Sent; null on rows the old Send button marked.
  if (!columns.some((column) => column.name === "sent_message_id")) {
    yield* sql`ALTER TABLE fork_thread_parked_items ADD COLUMN sent_message_id TEXT`;
  }
  // The messages carrying an item's chip when it was reopened: they no longer mark it Sent. Keyed by
  // thread first, since every sync reads one thread's rows.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_thread_parked_set_aside (
      thread_id TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      message_id TEXT NOT NULL,
      PRIMARY KEY (thread_id, item_id, message_id)
    ) WITHOUT ROWID
  `;
});
