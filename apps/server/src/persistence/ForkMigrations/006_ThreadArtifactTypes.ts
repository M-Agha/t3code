import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Fork-only, as 001. What an artifact is (its Artifact type, or a plain page), when a read last found
// it missing, and the type names any thread has learned. Every thread's Artifact calls are read again
// from the start to fill them: the upserts are idempotent, so a re-run only reads them once more.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('fork_thread_artifacts')
  `;
  // type_url: the Artifact type it was made from; page_format: html or markdown for a plain page;
  // both null while no create or publish has named it (a mention, a manual link).
  for (const column of ["type_url", "page_format", "not_found_at"]) {
    if (columns.some((existing) => existing.name === column)) continue;
    yield* sql.unsafe(`ALTER TABLE fork_thread_artifacts ADD COLUMN ${column} TEXT`);
  }
  // Global, not per thread: a name one thread lists names that type in every thread.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_artifact_type_names (
      type_url TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      learned_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  // The replay: messages keep their position, since a link in a reply says nothing new.
  yield* sql`
    UPDATE fork_thread_artifact_sync SET after_item_updated_at = '', after_item_id = ''
  `;
});
