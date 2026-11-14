import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest } from "./Migrations.ts";
import ForkMigration0001 from "./ForkMigrations/001_ThreadDecisions.ts";

// Fork-only schema, kept out of effect_sql_migrations: the Migrator skips every id up to the highest
// recorded, so a fork id there would make an official build skip its own migration with that id.
export const FORK_MIGRATIONS_TABLE = "fork_sql_migrations";

const forkMigrationEntries = [[1, "ThreadDecisions", ForkMigration0001]] as const;

const UPSTREAM_MIGRATION_HEAD = Math.max(...migrationManifest.map(([id]) => id));

const FORK_MIGRATION_HEAD = Math.max(...forkMigrationEntries.map(([id]) => id));

export const hasPendingForkMigrations = Effect.fn("hasPendingForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* sql`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${FORK_MIGRATIONS_TABLE}
  `;
  if (ledger.length === 0) return true;
  const [latest] = yield* sql<{ readonly id: number | null }>`
    SELECT MAX(migration_id) AS id FROM ${sql(FORK_MIGRATIONS_TABLE)}
  `;
  return (latest?.id ?? 0) < FORK_MIGRATION_HEAD;
});

export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  return yield* Migrator.make({})({
    table: FORK_MIGRATIONS_TABLE,
    loader: Migrator.fromRecord(
      Object.fromEntries(
        forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
});

/** Refuses a database an official build newer than this fork has migrated; its schema is unknown here. */
export const assertDatabaseNotAheadOfFork = Effect.fn("assertDatabaseNotAheadOfFork")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* sql`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (ledger.length === 0) return;
  const ahead = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations
    WHERE migration_id > ${UPSTREAM_MIGRATION_HEAD}
    ORDER BY migration_id
  `;
  if (ahead.length === 0) return;
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message: `This database was migrated by a newer official T3 Code build (${ahead.map((row) => `${row.migration_id}_${row.name}`).join(", ")}), past this fork's last known migration ${UPSTREAM_MIGRATION_HEAD}. The fork will not run on a schema it does not know. Rebase the fork onto that release, or keep using the official build on this database.`,
  });
});
