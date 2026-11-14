// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ForkMigration0001 from "./ForkMigrations/001_ThreadDecisions.ts";
import ForkMigration0002 from "./ForkMigrations/002_ThreadParked.ts";
import { FORK_MIGRATIONS_TABLE, runForkMigrations } from "./ForkMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const upstreamHead = Math.max(...migrationManifest.map(([id]) => id));

it.effect("runs fork migrations from their own ledger after upstream's", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    // Upstream already records ids 1..head; a shared ledger would skip fork id 1.
    assert.deepEqual(yield* runForkMigrations(), [
      [1, "ThreadDecisions"],
      [2, "ThreadParked"],
      [3, "ThreadArtifacts"],
    ]);
    assert.deepEqual(yield* runForkMigrations(), []);

    const forkLedger = yield* sql.unsafe<{ readonly migration_id: number }>(
      `SELECT migration_id FROM ${FORK_MIGRATIONS_TABLE}`,
    );
    assert.deepEqual(
      forkLedger.map((row) => row.migration_id),
      [1, 2, 3],
    );
    const upstream = yield* sql<{ readonly latest: number; readonly forkRows: number }>`
      SELECT MAX(migration_id) AS latest, SUM(name = 'ThreadDecisions') AS forkRows
      FROM effect_sql_migrations
    `;
    assert.deepEqual(upstream[0], { latest: upstreamHead, forkRows: 0 });
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fork_thread_decision%'
      ORDER BY name
    `;
    assert.deepEqual(
      tables.map((row) => row.name),
      ["fork_thread_decision_questions", "fork_thread_decision_sync"],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("runs only the artifacts migration on a database that already has 001 and 002", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* Migrator.make({})({
      table: FORK_MIGRATIONS_TABLE,
      loader: Migrator.fromRecord({
        "1_ThreadDecisions": ForkMigration0001,
        "2_ThreadParked": ForkMigration0002,
      }),
    });
    yield* sql`
      INSERT INTO fork_thread_decision_questions (
        thread_id, label, label_number, text, source_message_id, asked_at, state
      ) VALUES ('t', 'Q1', 1, 'Q1: x', 'm', '2026-01-01T00:00:00.000Z', 'open')
    `;
    yield* sql`
      INSERT INTO fork_thread_parked_items (
        thread_id, kind, text, state, parked_by, created_at, updated_at
      ) VALUES ('t', 'todo', 'x', 'open', 'user', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z')
    `;
    assert.deepEqual(yield* runForkMigrations(), [[3, "ThreadArtifacts"]]);
    const kept = yield* sql<{
      readonly questions: number;
      readonly parked: number;
      readonly artifacts: number;
    }>`
      SELECT
        (SELECT COUNT(*) FROM fork_thread_decision_questions) AS questions,
        (SELECT COUNT(*) FROM fork_thread_parked_items) AS parked,
        (SELECT COUNT(*) FROM fork_thread_artifacts) AS artifacts
    `;
    assert.deepEqual(kept[0], { questions: 1, parked: 1, artifacts: 0 });
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("refuses to start on a database a newer official build migrated", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-guard-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const open = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES (${upstreamHead + 1}, 'NewerOfficial', CURRENT_TIMESTAMP)
      `;
    }).pipe(Effect.provide(open()));

    const error = yield* Effect.flip(Effect.provide(Effect.void, open()));
    assert.include(String(error), `${upstreamHead + 1}_NewerOfficial`);
    assert.include(String(error), "newer official T3 Code build");
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
