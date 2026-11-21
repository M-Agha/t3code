// @effect-diagnostics nodeBuiltinImport:off - The test checks refs with git, as the script under test does.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  DIFF,
  WIDE,
  baselineAt,
  baselineText,
  changedPatches,
  createdTables,
  diffBodies,
  forkTablesIn,
  grepHits,
  headOf,
  importsOf,
  isProduction,
  ledgerAfter,
  ledgerFacts,
  ledgerRows,
  lintFlags,
  liveDbOf,
  lost,
  manifestChanges,
  manifestEntries,
  otherMigrationChanges,
  overlapsFork,
  parseNameStatus,
  plan,
  readArgs,
  rebaseRefusal,
  rebaseStopped,
  releaseNote,
  readReport,
  resolveSpec,
  seamLines,
  suiteOwed,
  suiteRun,
  suiteWidth,
  tablesIn,
  targetProblem,
  testPackages,
  touches,
  undiscovered,
  upstreamFileFates,
  verifyRefusal,
  writingRefusal,
  type Repo,
  type Suite,
} from "./upstream-sync.ts";

const fakeRepo = (refs: Record<string, Record<string, string>>): Repo => ({
  files: (ref) => new Set(Object.keys(refs[ref] ?? {})),
  read: (ref, path) => refs[ref]?.[path] ?? null,
});
const sorted = (values: Iterable<string>) => [...values].toSorted();
/** A throwaway repo for checks that must hold against git's own output under a user's config. */
const scratchGit = (body: (run: (...args: string[]) => string, dir: string) => void) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "upstream-sync-git-"));
  const run = (...args: string[]) =>
    NodeChildProcess.execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...args],
      { cwd: dir, encoding: "utf8" },
    );
  try {
    run("init", "-q");
    body(run, dir);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

describe("target and Node", () => {
  const base = "v0.1.11-nightly.20261118.4864";
  const ok = { fetched: true, sameCommit: false, descends: true, upstream: true };
  it("takes only a fetched Nightly tag newer than the base, on its line and upstream's", () => {
    expect(targetProblem("v0.1.11-nightly.20261120.4969", base, ok)).toBeNull();
    expect(targetProblem("upstream/main", base, ok)).toContain("not an upstream Nightly tag");
    expect(
      targetProblem("v0.1.11-nightly.20261120.4969", base, { ...ok, fetched: false }),
    ).toContain("git fetch upstream tag v0.1.11-nightly.20261120.4969");
    expect(targetProblem("v0.1.11-nightly.20261117.4825", base, ok)).toContain("not newer");
    expect(
      targetProblem("v0.1.11-nightly.20261120.4969", base, { ...ok, descends: false }),
    ).toContain("does not descend");
    expect(
      targetProblem("v0.1.11-nightly.20261120.4969", base, { ...ok, upstream: false }),
    ).toContain("not on upstream/main's history");
    // Twin tags: 4865 on 4864's commit is the same build under another number.
    expect(
      targetProblem("v0.1.11-nightly.20261118.4865", base, { ...ok, sameCommit: true }),
    ).toContain("tags the same commit as the fork's base");
  });
  it("reads every word of a command line, and refuses one it does not know", () => {
    expect(readArgs(["plan", "--target", "t", "--notes", "--nightly", "none"])).toMatchObject({
      command: "plan",
      target: "t",
      notes: true,
      nightly: "none",
      head: "HEAD",
    });
    expect(
      readArgs([
        "verify",
        "--target",
        "t",
        "--dropped",
        "a",
        "--dropped",
        "b",
        "--dropped-commit",
        "c",
      ]),
    ).toMatchObject({ dropped: ["a", "b"], droppedCommits: ["c"], baseline: null });
    expect(readArgs(["verify", "--target", "t", "--baseline", "b.txt"])).toMatchObject({
      baseline: "b.txt",
    });
    expect(readArgs(["suite"])).toMatchObject({ command: "suite" });
    expect(readArgs(["suite", "--out", "o.txt"])).toBe("suite does not take --out");
    expect(readArgs([])).toMatchObject({ command: "plan" });
    expect(readArgs(["plan", "--tagret", "t"])).toBe("plan does not take --tagret");
    expect(readArgs(["rebase", "--target", "t", "--notes"])).toBe("rebase does not take --notes");
    expect(readArgs(["verify", "--target"])).toBe("--target needs a value");
    expect(readArgs(["merge"])).toBe("unknown command merge");
  });
});

describe("migrations and ~/.t3's ledger", () => {
  const manifest = (rows: string) =>
    manifestEntries(
      `import Migration0001 from "./Migrations/001_A.ts";\nimport Migration0002 from "./Migrations/002_B.ts";\nimport Migration0003 from "./Migrations/003_C.ts";\n\nconst migrationEntries = [\n${rows}\n] as const;\n`,
    );
  it("lists the manifest's added, removed and changed entries by file path", () => {
    const base = manifest(
      '  [1, "A", Migration0001],\n  [2, "B", Migration0002],\n  [3, "C", Migration0003],',
    );
    // Id 1 renamed, id 2 gone, id 3 pointed at another file, id 4 new.
    const target = manifest(
      '  [1, "A2", Migration0001],\n  // a note\n  [3, "C", Migration0002],\n  [4, "D", Migration0003],',
    );
    expect(manifestChanges(base, target)).toEqual({
      added: ["4 D (`apps/server/src/persistence/Migrations/003_C.ts`)"],
      removed: ["2 B (`apps/server/src/persistence/Migrations/002_B.ts`)"],
      changed: [
        "1 A (`apps/server/src/persistence/Migrations/001_A.ts`) → 1 A2 (`apps/server/src/persistence/Migrations/001_A.ts`)",
        "3 C (`apps/server/src/persistence/Migrations/003_C.ts`) → 3 C (`apps/server/src/persistence/Migrations/002_B.ts`)",
      ],
    });
    expect(headOf(target)).toBe(4);
  });
  it("lists every other change under the migrations folder, once and without tests", () => {
    const base = manifest('  [1, "A", Migration0001],');
    const target = manifest('  [1, "A", Migration0001],\n  [2, "B", Migration0002],');
    const changes = parseNameStatus(
      [
        "A\tapps/server/src/persistence/Migrations/002_B.ts",
        "A\tapps/server/src/persistence/Migrations/002_B.test.ts",
        "M\tapps/server/src/persistence/Migrations/001_A.ts",
        "A\tapps/server/src/persistence/Migrations/helpers/sql.ts",
        "R100\tapps/server/src/x.ts\tapps/server/src/persistence/Migrations/moved.ts",
        "M\tapps/server/src/persistence/Sqlite.ts",
      ].join("\n"),
    );
    expect(otherMigrationChanges(changes, base, target).map((c) => c.to ?? c.path)).toEqual([
      "apps/server/src/persistence/Migrations/001_A.ts",
      "apps/server/src/persistence/Migrations/helpers/sql.ts",
      "apps/server/src/persistence/Migrations/moved.ts",
    ]);
  });
  it("says a manifest line it cannot read plainly, and then knows no head", () => {
    const odd = manifest(
      '  [1, "A", Migration0001],\n  [102, "B", Migration0002],\n  [103, "NewShape", () => import("./103.ts")],\n  [102, "Twice", Migration0003],\n  [104, "Options", Migration0003, { transaction: false }],\n  [105, "Unimported", Migration0105],',
    );
    expect(headOf(odd)).toBeNull();
    expect(odd.unreadable).toEqual([
      'apps/server/src/persistence/Migrations.ts:8 `[103, "NewShape", () => import("./103.ts")],`',
      'apps/server/src/persistence/Migrations.ts:9 `[102, "Twice", Migration0003],`',
      'apps/server/src/persistence/Migrations.ts:10 `[104, "Options", Migration0003, { transaction: false }],`',
      'apps/server/src/persistence/Migrations.ts:11 `[105, "Unimported", Migration0105],`',
    ]);
    expect(manifestEntries("const other = [];").unreadable).toEqual([
      "no `migrationEntries = [` … `]` list",
    ]);
  });
  it("states where a build's manifest and the ledger disagree, and nothing when they agree", () => {
    const upTo3 = manifest(
      '  [1, "A", Migration0001],\n  [2, "B", Migration0002],\n  [3, "C", Migration0003],',
    );
    // `rows("1:A 2:B")`: a ledger holding ids 1 and 2.
    const rows = (spec: string) =>
      spec
        .split(" ")
        .map((pair) => ({ id: Number(pair.split(":")[0]), name: pair.split(":")[1] ?? "" }));
    expect(ledgerFacts(upTo3, rows("1:A 2:B"))).toEqual([]);
    // Nightly 4825 against a ledger at 98: one id it does not know.
    expect(ledgerFacts(upTo3, rows("1:A 2:B 3:C 4:D"))).toEqual([
      "4 D is recorded and not in its manifest",
    ]);
    expect(ledgerFacts(upTo3, rows("1:A 2:Z 3:C"))).toEqual([
      "2 is recorded as Z and named B in its manifest",
    ]);
    expect(ledgerFacts(upTo3, rows("1:A 3:C"))).toEqual([
      "2 B is in its manifest, below 3, and not recorded",
    ]);
    expect(ledgerFacts(manifestEntries(""), rows("1:A"))).toEqual([
      "1 A is recorded and not in its manifest",
      "its manifest has lines this tool cannot read (no `migrationEntries = [` … `]` list)",
    ]);
    // Opus r5's case: the Nightly knows today's ledger, not the one the fork at the target leaves.
    const upTo4 = manifest(
      '  [1, "A", Migration0001],\n  [2, "B", Migration0002],\n  [3, "C", Migration0003],\n  [4, "D", Migration0003],',
    );
    const nightly = manifest('  [1, "A", Migration0001],\n  [2, "B", Migration0002],');
    expect(ledgerAfter(rows("1:A 2:B"), upTo4)).toEqual(rows("1:A 2:B 3:C 4:D"));
    expect(ledgerAfter(rows("1:A 3:C"), upTo4)).toEqual(rows("1:A 3:C 4:D"));
    expect(ledgerFacts(nightly, ledgerAfter(rows("1:A 2:B"), upTo4))).toEqual([
      "3 C is recorded and not in its manifest",
      "4 D is recorded and not in its manifest",
    ]);
  });
  it("finds the live database's folder and file in upstream's config.ts", () => {
    const config = (dir: string, file: string) =>
      `  const stateDir = join(\n    baseDir,\n    devUrl !== undefined ? "dev" : "${dir}",\n  );\n  const dbPath = join(stateDir, "${file}");`;
    expect(liveDbOf(config("userdata", "statev2.sqlite"))).toEqual({
      dirs: ["dev", "userdata"],
      file: "statev2.sqlite",
    });
    expect(liveDbOf(config("state", "statev3.sqlite"))).toEqual({
      dirs: ["dev", "state"],
      file: "statev3.sqlite",
    });
    expect(
      liveDbOf("  const stateDir = resolveState(baseDir);\n  const dbPath = resolveDb(stateDir);"),
    ).toEqual({
      dirs: null,
      file: null,
    });
  });
  it("reads a ledger's rows without writing, and says why one cannot be read", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "upstream-sync-"));
    try {
      const path = NodePath.join(dir, "state.sqlite");
      const db = new NodeSqlite.DatabaseSync(path);
      db.exec("CREATE TABLE effect_sql_migrations (migration_id INTEGER, name TEXT)");
      expect(ledgerRows(path)).toBe("its effect_sql_migrations is empty");
      db.exec("INSERT INTO effect_sql_migrations VALUES (98, 'b'), (97, 'a')");
      expect(ledgerRows(path)).toEqual([
        { id: 97, name: "a" },
        { id: 98, name: "b" },
      ]);
      db.exec("INSERT INTO effect_sql_migrations VALUES (99, NULL)");
      db.close();
      expect(ledgerRows(path)).toContain("without a numeric id and a name");
      const missing = NodePath.join(dir, "missing.sqlite");
      expect(typeof ledgerRows(missing)).toBe("string");
      expect(NodeFS.existsSync(missing)).toBe(false);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the fork's tables", () => {
  const known = new Set(["projection_threads", "projection_runs", "projection_turns"]);
  it("reads quoted, bracketed and schema-qualified tables after a SQL keyword", () => {
    expect(
      sorted(
        tablesIn(
          'UPDATE `projection_runs` SET x = 1; CREATE INDEX i ON [projection_turns](a); DROP TABLE "main"."projection_threads"; const projection_other = 1',
          known,
        ),
      ),
    ).toEqual(["projection_runs", "projection_threads", "projection_turns"]);
    expect(tablesIn("const projection_threads = 1; // projection_runs", known).size).toBe(0);
  });
  it("knows a table only from SQL that creates or renames one, not from prose", () => {
    expect(
      createdTables(
        'CREATE TABLE IF NOT EXISTS "foo_bar" (a); ALTER TABLE x RENAME TO y; // a rename to the repository; create table ts',
      ),
    ).toEqual(["foo_bar", "y"]);
  });
  it("widens an edited query line to the statement that names its table", () => {
    scratchGit((run, dir) => {
      const write = (value: string) =>
        NodeFS.writeFileSync(
          NodePath.join(dir, "store.ts"),
          `const other = 1;\nexport const touch = (id: string) =>\n  sql\`\n    UPDATE projection_threads\n    SET a = 1,\n      b = 2,\n      c = 3,\n      d = 4,\n      updated_at = \${${value}}\n    WHERE id = \${id}\n  \`;\nconst after = 2;\n`,
        );
      write("now");
      run("add", ".");
      run("commit", "-q", "-m", "one");
      write("batchTime");
      run("commit", "-q", "-am", "two");
      const body = diffBodies(run(...WIDE, "HEAD~1", "HEAD")).get("store.ts") ?? [];
      expect([...tablesIn(body.join("\n"), known)]).toEqual(["projection_threads"]);
      expect(body.some((line) => line.includes("const other"))).toBe(false);
    });
  });
  it("says when the fork's SQL names no known table, and leaves out the fork's own", () => {
    expect(
      forkTablesIn("sql`SELECT * FROM projection_runs JOIN fork_x`", new Set([...known, "fork_x"])),
    ).toEqual(new Set(["projection_runs"]));
    expect(forkTablesIn("sql`SELECT * FROM fork_x`", new Set(["fork_x"]))).toContain(
      "read the fork's queries by hand",
    );
    expect(forkTablesIn("sql`SELECT * FROM renamed_table`", known)).toContain(
      "read the fork's queries by hand",
    );
    expect(forkTablesIn("const x = 1;", known)).toEqual(new Set());
  });
  it("tells git grep's no-match from its failure", () => {
    expect(grepHits({ status: 0, stdout: "HEAD:a.ts\n", stderr: "" })).toEqual(["HEAD:a.ts"]);
    expect(grepHits({ status: 1, stdout: "", stderr: "" })).toEqual([]);
    expect(grepHits({ status: 128, stdout: "", stderr: "fatal: bad ref\n" })).toBe(
      "git grep failed: fatal: bad ref",
    );
  });
  it("reads production code only", () => {
    expect(isProduction("scripts/fork/upstream-sync.ts")).toBe(false);
    expect(isProduction("apps/server/src/persistence/Sqlite.test.ts")).toBe(false);
    expect(isProduction("apps/server/src/decisions/ThreadDecisions.ts")).toBe(true);
  });
});

describe("imports", () => {
  it("lists every module a source names, by regex, erring toward more", () => {
    const text = [
      'import Default, { type A, b as c } from "./x.ts";',
      'import * as NS from "./ns.ts";',
      'import "./side.css";',
      "import type {",
      "  T,",
      '} from "./t.ts";',
      'export { e as f } from "./e.ts";',
      'export * from "./star.ts";',
      'const lazy = import("./lazy.ts");',
      'type M = typeof import("./typed.ts");',
      "const m = await import(path);",
      'const r = require("./req.cjs");',
    ].join("\n");
    expect(importsOf(text).map((imp) => [imp.spec, imp.names])).toEqual([
      ["./x.ts", ["Default", "A", "b", "c"]],
      ["./ns.ts", ["NS"]],
      ["./t.ts", ["T"]],
      ["./e.ts", ["e", "f"]],
      ["./star.ts", []],
      ["./side.css", []],
      ["./lazy.ts", []],
      ["./typed.ts", []],
      ["./req.cjs", []],
      [null, []],
    ]);
  });
  it("takes an upstream file's import when the fork's added lines use its name or specifier", () => {
    const [lib, ns] = importsOf(
      'import { kept, forkAdded } from "./lib.ts";\nimport * as NS from "./ns.ts";',
    );
    if (lib === undefined || ns === undefined) throw new Error("parse");
    expect(touches(lib, ["  forkAdded,"])).toBe(true);
    expect(touches(lib, ["const x = forkAdded();"])).toBe(true);
    expect(touches(lib, ['} from "./lib.ts";'])).toBe(true);
    expect(touches(ns, ["NS.member();"])).toBe(true);
    // A name inside a longer word is not a use.
    expect(touches(lib, ["const keptAlive = 1;"])).toBe(false);
    expect(touches(ns, ["unrelated();"])).toBe(false);
  });
  it("resolves relative, tsconfig-path and workspace specifiers to files, and tells packages from misses", () => {
    const repo = fakeRepo({
      t: {
        "apps/web/tsconfig.json":
          '{\n  // comment\n  "compilerOptions": { "paths": { "~/*": ["./src/*"] } }\n}',
        "apps/web/src/lib.ts": "",
        "apps/web/src/dir/index.tsx": "",
        "apps/web/src/side.css": "",
        "apps/web/src/a/fork.ts": "",
        "packages/shared/package.json": JSON.stringify({
          name: "@t3tools/shared",
          exports: { "./*": { types: "./lib/*.ts", import: "./lib/*.ts" } },
        }),
        "packages/shared/lib/x/y.ts": "",
        "packages/contracts/package.json": JSON.stringify({
          name: "@t3tools/contracts",
          exports: {
            ".": { types: "./src/main.ts" },
            "./settings": { types: "./src/settingsSchema.ts" },
          },
        }),
        "packages/contracts/src/main.ts": "",
        "packages/contracts/src/settingsSchema.ts": "",
        "packages/plain/package.json": JSON.stringify({ name: "@t3tools/plain" }),
        "packages/plain/src/index.ts": "",
      },
    });
    const at = (spec: string) => resolveSpec(repo, "t", "apps/web/src/a/fork.ts", spec);
    expect(at("../lib")).toEqual({ path: "apps/web/src/lib.ts" });
    expect(at("../lib.js")).toEqual({ path: "apps/web/src/lib.ts" });
    expect(at("../dir")).toEqual({ path: "apps/web/src/dir/index.tsx" });
    expect(at("~/side.css?inline")).toEqual({ path: "apps/web/src/side.css" });
    expect(at("~/lib")).toEqual({ path: "apps/web/src/lib.ts" });
    expect(at("@t3tools/shared/x/y")).toEqual({ path: "packages/shared/lib/x/y.ts" });
    expect(at("@t3tools/contracts")).toEqual({ path: "packages/contracts/src/main.ts" });
    expect(at("@t3tools/contracts/settings")).toEqual({
      path: "packages/contracts/src/settingsSchema.ts",
    });
    // A workspace package with no `exports`: its src/index.ts.
    expect(at("@t3tools/plain")).toEqual({ path: "packages/plain/src/index.ts" });
    expect(at("../gone")).toBe("unresolved");
    expect(at("~/gone")).toBe("unresolved");
    expect(at("#internal")).toBe("unresolved");
    expect(at("@t3tools/shared/nope")).toBe("unresolved");
    expect(at("effect/Effect")).toBe("package");
    expect(at("node:fs")).toBe("package");
  });
  it("stops on a malformed package.json rather than reading it as empty", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const repo = fakeRepo({ t: { "packages/bad/package.json": "{ name: " } });
      expect(() => resolveSpec(repo, "t", "apps/web/src/a.ts", "@t3tools/bad")).toThrow("exit 2");
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("packages/bad/package.json at t is not JSON"),
      );
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});

describe("the full suite", () => {
  it("names each workspace package with a test script", () => {
    const repo = fakeRepo({
      t: {
        "pnpm-workspace.yaml":
          'packages:\n  - apps/*\n\n# the scripts package\n  - "scripts" # its own\ncatalog:\n  - infra/*\n',
        "package.json": JSON.stringify({ name: "root", scripts: { test: "vp run -r test" } }),
        "apps/web/package.json": JSON.stringify({ name: "web", scripts: { test: "vp test run" } }),
        "apps/server/package.json": JSON.stringify({
          name: "t3",
          scripts: { test: "vp test run" },
        }),
        "apps/types/package.json": JSON.stringify({ name: "types", scripts: {} }),
        "apps/web/fixture/package.json": JSON.stringify({ name: "nested", scripts: { test: "x" } }),
        "scripts/package.json": JSON.stringify({ name: "scripts", scripts: { test: "vp test" } }),
        "infra/x/package.json": JSON.stringify({ name: "infra", scripts: { test: "vp test" } }),
      },
    });
    expect(testPackages(repo, "t")).toEqual(["scripts", "t3", "web"]);
  });
  it("reads each failed test, each file that failed with none, and the tests each file ran, from Vitest's JSON report", () => {
    // `vp run --filter @t3tools/tailscale test --reporter=json` with zz-probe (failing, passing,
    // skipped, todo) and zz-unhandled (passes, then throws outside it) added; kept to the fields
    // read, 12 passing tests and the checkout path cut; zz-broken (throws on import) from an earlier
    // run, a message line added. The uncaught error is in no field: only the exit status shows it.
    const report = String.raw`{"testResults":[{"assertionResults":[{"ancestorTitles":["tailscale"],"status":"passed","title":"does not treat a non-T3 response on the HTTPS probe path as reachable"}],"status":"passed","message":"","name":"/home/dev/t3code/packages/tailscale/src/tailscale.test.ts"},{"assertionResults":[{"ancestorTitles":["probe group"],"status":"failed","title":"fails on purpose"},{"ancestorTitles":["probe group"],"status":"passed","title":"passes"},{"ancestorTitles":["probe group"],"status":"skipped","title":"is skipped"},{"ancestorTitles":["probe group"],"status":"todo","title":"is todo"}],"status":"failed","message":"","name":"/home/dev/t3code/packages/tailscale/src/zz-probe.test.ts"},{"assertionResults":[],"status":"failed","message":"boom at import\nat line 2","name":"/home/dev/t3code/packages/tailscale/src/zz-broken.test.ts"},{"assertionResults":[{"ancestorTitles":[],"status":"passed","title":"passes, then throws outside any test"}],"status":"passed","message":"","name":"/home/dev/t3code/packages/tailscale/src/zz-unhandled.test.ts"}]}`;
    const file = (name: string) => `packages/tailscale/src/${name}.test.ts`;
    expect(readReport(report, "/home/dev/t3code")).toEqual({
      failures: [
        `${file("zz-probe")} > probe group > fails on purpose`,
        `${file("zz-broken")}: boom at import`,
      ],
      files: new Map([
        [file("tailscale"), 1],
        [file("zz-probe"), 2],
        [file("zz-broken"), 0],
        [file("zz-unhandled"), 1],
      ]),
    });
    for (const text of ["JSON report written to x", "", "{}"])
      expect(readReport(text, "/")).toEqual({ failures: [], files: null });
  });
  it("writes and reads back a baseline: each package's exit, its files' tests run, every failure", () => {
    const sha = "a".repeat(40);
    const recorded: Suite = {
      failures: ["web: a.test.ts > x"],
      packages: new Map([
        ["t3", { exit: 1, files: null }],
        [
          "web",
          {
            exit: 1,
            files: new Map([
              ["a.test.ts", 3],
              ["gone.test.ts", 2],
            ]),
          },
        ],
        ["scripts", { exit: null, files: new Map() }],
      ]),
    };
    const text = baselineText(sha, recorded);
    expect(text).toBe(
      `# upstream-sync suite at ${sha}\n# t3 exited 1 with no report\n# web exited 1\n# web: a.test.ts ran 3 tests\n# web: gone.test.ts ran 2 tests\n# scripts exited on a signal\nweb: a.test.ts > x`,
    );
    expect(baselineAt(`${text}\n`, sha)).toEqual(recorded);
    expect(baselineAt(`# upstream-sync suite at ${sha}\n`, sha)).toContain("has no package lines");
    expect(baselineAt(`${text}\n# web ran 5 tests\n`, sha)).toBe(
      "has a line suite does not write: # web ran 5 tests",
    );
    expect(baselineAt(`# upstream-sync suite at ${"b".repeat(40)}\n`, sha)).toContain(
      `not at the target's commit ${sha}`,
    );
    expect(baselineAt("web: a.test.ts > x\n", sha)).toContain("is not a file `suite` wrote");
  });
  it("marks each failure against the baseline, names each package to read for unhandled errors, and each upstream test file that ran less", () => {
    const files = (entries: Record<string, number>) => new Map(Object.entries(entries));
    const baseline: Suite = {
      failures: ["web: a.test.ts > x", "shared: s.test.ts > q"],
      packages: new Map([
        ["t3", { exit: 1, files: null }],
        ["web", { exit: 1, files: files({ "a.test.ts": 3, "gone.test.ts": 2 }) }],
        ["shared", { exit: 1, files: files({ "x.test.ts": 5, "y.test.ts": 5, "s.test.ts": 1 }) }],
        ["desktop", { exit: 0, files: files({ "d.test.ts": 4 }) }],
        ["old", { exit: 0, files: files({ "o.test.ts": 1 }) }],
        ["tail", { exit: 0, files: files({ "t.test.ts": 2 }) }],
      ]),
    };
    const run: Suite = {
      failures: [
        "t3: b.test.ts > y",
        "web: a.test.ts > x",
        "web: c.test.ts > z",
        "shared: s.test.ts > q",
        "tail: t.test.ts > n",
      ],
      packages: new Map([
        // No report at the target: nothing to compare its failure with.
        ["t3", { exit: 1, files: files({ "b.test.ts": 6 }) }],
        // The fork's 40 tests do not hide the upstream file the rebase dropped.
        ["web", { exit: 1, files: files({ "a.test.ts": 3, "c.test.ts": 1, "fork.test.ts": 40 }) }],
        // Only a known failure: its exit may hide an unhandled error. x.test.ts is the fork's to change.
        ["shared", { exit: 1, files: files({ "x.test.ts": 4, "y.test.ts": 4, "s.test.ts": 1 }) }],
        // Its files are not listed one by one: its exit line says it wrote no report.
        ["desktop", { exit: 1, files: null }],
        // A new failure explains its exit, but it exited 0 at the target.
        ["tail", { exit: 1, files: files({ "t.test.ts": 2 }) }],
      ]),
    };
    const read = (name: string, note = "") =>
      `\n  - [ ] ${name}: its test script exited 1${note}; read its output above for unhandled errors`;
    expect(suiteOwed(run, baseline, "v1", new Set(["x.test.ts"]))).toEqual([
      "- The full suite: 2 new, 2 also failing at v1, 1 cannot be compared (no report or no such package at v1); read each, new ones first." +
        "\n  - [ ] new: web: c.test.ts > z\n  - [ ] new: tail: t.test.ts > n" +
        "\n  - [ ] cannot be compared: t3: b.test.ts > y" +
        "\n  - [ ] also fails at v1: web: a.test.ts > x\n  - [ ] also fails at v1: shared: s.test.ts > q",
      "- 4 packages exited non-zero with no new failure, or exited 0 at v1:" +
        read("t3") +
        read("shared") +
        read("desktop", " (0 at v1) and wrote no report") +
        read("tail", " (0 at v1)"),
      "- 3 of v1's test files did not run, or ran fewer tests where the fork does not modify them: find what the rebase dropped (a Vite project, a test file, a test)." +
        "\n  - [ ] web: gone.test.ts: did not run, 2 tests at v1\n  - [ ] shared: y.test.ts: 4 tests ran, 5 at v1\n  - [ ] old: o.test.ts: did not run, 1 tests at v1",
      // R22: the fork's own file is listed too, apart: a rebase can drop upstream's new tests in it.
      "- 1 of v1's test files ran fewer tests; the fork changes these files: check the rebase kept upstream's new tests." +
        "\n  - [ ] shared: x.test.ts: 4 tests ran, 5 at v1",
    ]);
    const clean: Suite = {
      failures: [],
      packages: new Map([["tail", { exit: 0, files: files({ "t.test.ts": 2 }) }]]),
    };
    expect(suiteOwed(clean, clean, "v1", new Set())).toEqual([]);
    const noBaseline = (count: number) =>
      `- No baseline was given (--baseline <file>) or kept by suite for v1 (FORK.md step 5): ${count} full-suite failures, none marked new or also failing at v1, and no test file compared; read each.`;
    expect(suiteOwed(run, null, "v1", new Set())).toEqual([
      noBaseline(6) +
        "\n  - [ ] t3: b.test.ts > y\n  - [ ] web: a.test.ts > x\n  - [ ] web: c.test.ts > z" +
        "\n  - [ ] shared: s.test.ts > q\n  - [ ] tail: t.test.ts > n" +
        read("desktop", " and wrote no report"),
    ]);
    expect(suiteOwed(clean, null, "v1", new Set())).toEqual([noBaseline(0)]);
  });
  it("records no baseline outside a worktree of this checkout, from a dirty one, under another Node, or without a vp that starts", () => {
    scratchGit((run, dir) => {
      // A copy of this script makes the scratch repo its own checkout, as a worktree of the fork is.
      const script = NodePath.join(dir, "scripts/fork/upstream-sync.ts");
      NodeFS.mkdirSync(NodePath.dirname(script), { recursive: true });
      NodeFS.copyFileSync(NodePath.join(import.meta.dirname, "upstream-sync.ts"), script);
      NodeFS.mkdirSync(NodePath.join(dir, "pkgs/a"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, "pnpm-workspace.yaml"), "packages:\n  - pkgs/*\n");
      NodeFS.writeFileSync(
        NodePath.join(dir, "pkgs/a/package.json"),
        JSON.stringify({ name: "a", scripts: { test: "vp test run" } }),
      );
      const suiteIn = (cwd: string) =>
        NodeChildProcess.spawnSync(process.execPath, [script, "suite"], {
          cwd,
          encoding: "utf8",
        });
      const suiteUnder = (node: string) => {
        NodeFS.writeFileSync(
          NodePath.join(dir, "package.json"),
          JSON.stringify({ engines: { node } }),
        );
        run("add", "-A");
        run("commit", "-qm", node);
        return suiteIn(dir);
      };
      const otherNode = suiteUnder("0.0.1");
      expect(otherNode.status).toBe(2);
      expect(otherNode.stderr).toContain(
        `mise exec node@0.0.1 -- node ${NodeFS.realpathSync(script)} …`,
      );
      const noVp = suiteUnder(process.version.slice(1));
      expect(noVp.status).toBe(2);
      expect(noVp.stderr).toContain("node_modules/.bin/vp does not start");
      // The baseline names a commit; an untracked file would run tests that commit does not have.
      NodeFS.writeFileSync(NodePath.join(dir, "pkgs/a/stray.test.ts"), "");
      const dirty = suiteIn(dir);
      expect(dirty.status).toBe(2);
      expect(dirty.stderr).toContain("has changes; the baseline names only its commit");
      NodeFS.rmSync(NodePath.join(dir, "pkgs/a/stray.test.ts"));
      // A clone of its own, not a worktree: this checkout cannot read its commit.
      run("init", "-q", "clone");
      run("-C", "clone", "commit", "-q", "--allow-empty", "-m", "elsewhere");
      const clone = suiteIn(NodePath.join(dir, "clone"));
      expect(clone.status).toBe(2);
      expect(clone.stderr).toMatch(
        /clone's HEAD [0-9a-f]{40} is not in .*: run suite in a worktree of it/,
      );
      // Nothing kept, nor begun.
      expect(NodeFS.existsSync(NodePath.join(dir, ".git", "upstream-sync"))).toBe(false);
    });
  });
  it("refuses while a suite still writes the baseline, naming its file, and passes over one that crashed", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "upstream-sync-writing-"));
    try {
      const kept = NodePath.join(dir, "baseline-abc.txt");
      expect(writingRefusal(kept)).toBeNull();
      NodeFS.writeFileSync(`${kept}.99999999`, "");
      NodeFS.writeFileSync(NodePath.join(dir, `baseline-other.txt.${process.pid}`), "");
      expect(writingRefusal(kept)).toBeNull();
      NodeFS.writeFileSync(`${kept}.${process.pid}`, "");
      expect(writingRefusal(kept)).toBe(
        `suite (pid ${process.pid}) is still writing the baseline to ${kept}.${process.pid}; run verify once it ends, or pass --baseline <file> (if pid ${process.pid} is no suite, remove that file)`,
      );
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("runs as many test scripts at once as its width", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "upstream-sync-width-"));
    const quiet = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const vp = NodePath.join(dir, "vp");
      NodeFS.mkdirSync(NodePath.join(dir, "running"));
      NodeFS.writeFileSync(
        vp,
        [
          "#!/bin/bash",
          `cd "${dir}" && touch "running/$3" && ls running | wc -l >>widths`,
          'sleep 1; rm "running/$3"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const run = await suiteRun(dir, vp, ["a", "b", "c"], { width: 2 });
      expect([...run.packages.values()].map(({ exit }) => exit)).toEqual([0, 0, 0]);
      const widths = NodeFS.readFileSync(NodePath.join(dir, "widths"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map(Number);
      expect(Math.max(...widths)).toBe(2);
    } finally {
      quiet.mockRestore();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
  /** A checkout suite runs in: this script, `names` packages, and a vp whose run is `vpRun`. */
  const suiteRepo = (dir: string, names: ReadonlyArray<string>, vpRun: ReadonlyArray<string>) => {
    const script = NodePath.join(dir, "scripts/fork/upstream-sync.ts");
    NodeFS.mkdirSync(NodePath.dirname(script), { recursive: true });
    NodeFS.copyFileSync(NodePath.join(import.meta.dirname, "upstream-sync.ts"), script);
    for (const name of names) {
      NodeFS.mkdirSync(NodePath.join(dir, "pkgs", name), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(dir, "pkgs", name, "package.json"),
        JSON.stringify({ name, scripts: { test: "vp test run" } }),
      );
    }
    NodeFS.writeFileSync(NodePath.join(dir, "pnpm-workspace.yaml"), "packages:\n  - pkgs/*\n");
    NodeFS.writeFileSync(
      NodePath.join(dir, "package.json"),
      JSON.stringify({ engines: { node: process.version.slice(1) } }),
    );
    NodeFS.writeFileSync(NodePath.join(dir, ".gitignore"), "node_modules/\nmarks/\n");
    const marks = NodePath.join(dir, "marks");
    const vp = NodePath.join(dir, "node_modules/.bin/vp");
    NodeFS.mkdirSync(NodePath.dirname(vp), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(marks, "running"), { recursive: true });
    NodeFS.writeFileSync(
      vp,
      ["#!/bin/bash", '[ "$1" = --version ] && exit 0', `marks="${marks}"`, ...vpRun, ""].join(
        "\n",
      ),
      { mode: 0o755 },
    );
    return { script, marks };
  };
  it("runs the packages' test scripts no wider than one per four CPUs, without the T3 service's address, and keeps the baseline by commit", () => {
    scratchGit((run, dir) => {
      const width = suiteWidth(NodeOS.availableParallelism());
      // One more package than the bound, so an unbounded run would show one more at once.
      const names = Array.from({ length: width + 1 }, (_, at) => `p${String(at).padStart(2, "0")}`);
      // A vp that notes what the T3 service's variables were, how many scripts ran with it, and
      // writes a report: p00 fails its test and exits 1, the others pass.
      const { script, marks } = suiteRepo(dir, names, [
        'name="$3" report="${7#--outputFile.json=}"',
        'echo "${T3CODE_PORT-unset} ${T3CODE_HOST-unset}" >"$marks/env-$name"',
        'touch "$marks/running/$name" && ls "$marks/running" | wc -l >>"$marks/widths"',
        'ls "$(git rev-parse --git-common-dir)/upstream-sync" >"$marks/kept-$name"',
        'echo "start $name"; sleep 1; echo "end $name"',
        'rm "$marks/running/$name"',
        'status=passed; [ "$name" != p00 ] || status=failed',
        'printf \'{"testResults":[{"name":"%s","status":"%s","message":"","assertionResults":[{"ancestorTitles":[],"title":"t","status":"%s"}]}]}\' "$PWD/pkgs/$name/a.test.ts" "$status" "$status" >"$report"',
        '[ "$status" = passed ]',
      ]);
      run("add", "-A");
      run("commit", "-qm", "packages");
      const head = run("rev-parse", "HEAD").trim();

      const suite = NodeChildProcess.spawnSync(process.execPath, [script, "suite"], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, T3CODE_PORT: "3773", T3CODE_HOST: "127.0.0.1" },
      });
      expect(suite.status, suite.stderr).toBe(0);
      for (const name of names)
        expect(NodeFS.readFileSync(NodePath.join(marks, `env-${name}`), "utf8")).toBe(
          "unset unset\n",
        );
      const widths = NodeFS.readFileSync(NodePath.join(marks, "widths"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map(Number);
      expect(Math.max(...widths)).toBeLessThanOrEqual(width);
      // Each package says when it starts, before its output.
      for (const name of names) expect(suite.stdout).toContain(`== ${name} started\n`);
      // While it runs, verify can see that it writes the baseline.
      expect(NodeFS.readFileSync(NodePath.join(marks, "kept-p00"), "utf8")).toMatch(
        new RegExp(`^baseline-${head}\\.txt\\.\\d+\\n$`),
      );
      // Each script's output whole, under its exit.
      for (const name of names)
        expect(suite.stdout).toContain(
          `== ${name}: its test script exited ${name === "p00" ? 1 : 0}\nstart ${name}\nend ${name}\n`,
        );
      // In the packages' order, whatever order they finished in.
      const kept = NodePath.join(dir, ".git", "upstream-sync", `baseline-${head}.txt`);
      expect(NodeFS.readFileSync(kept, "utf8")).toBe(
        [
          `# upstream-sync suite at ${head}`,
          ...names.flatMap((name) => [
            `# ${name} exited ${name === "p00" ? 1 : 0}`,
            `# ${name}: pkgs/${name}/a.test.ts ran 1 tests`,
          ]),
          "p00: pkgs/p00/a.test.ts > t",
          "",
        ].join("\n"),
      );
    });
  });
  it("on a signal, stops its test scripts, removes its reports and its <kept>.<pid> file, and ends by that signal", () => {
    scratchGit((run, dir) => {
      // The script's own pid, then sleep in its place, so the pid is what the suite must stop.
      const { script, marks } = suiteRepo(
        dir,
        ["p00"],
        ['echo $$ >"$marks/started"', "exec sleep 30"],
      );
      run("add", "-A");
      run("commit", "-qm", "packages");
      const tmp = NodePath.join(dir, "marks", "tmp");
      NodeFS.mkdirSync(tmp);
      // A SIGTERM to the suite alone, as `kill` sends it, once its one package runs.
      const stop = `
        const child = require("node:child_process").spawn(process.execPath, [process.argv[1], "suite"], { stdio: "ignore" });
        const started = ${JSON.stringify(NodePath.join(marks, "started"))};
        const wait = setInterval(() => {
          if (!require("node:fs").existsSync(started) || require("node:fs").readFileSync(started, "utf8") === "") return;
          clearInterval(wait);
          child.kill("SIGTERM");
        }, 50);
        child.on("close", (code, signal) => console.log(JSON.stringify({ code, signal })));`;
      const stopped = NodeChildProcess.spawnSync(process.execPath, ["-e", stop, script], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, TMPDIR: tmp },
        timeout: 20_000,
      });
      expect(JSON.parse(stopped.stdout), stopped.stderr).toEqual({ code: null, signal: "SIGTERM" });
      expect(NodeFS.readdirSync(NodePath.join(dir, ".git", "upstream-sync"))).toEqual([]);
      expect(NodeFS.readdirSync(tmp)).toEqual([]);
      // Signalled before the suite ended; a killed process can take a moment to go.
      const pid = Number(NodeFS.readFileSync(NodePath.join(marks, "started"), "utf8"));
      const gone = () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      };
      for (let tries = 0; !gone() && tries < 50; tries++)
        NodeChildProcess.spawnSync("sleep", ["0.1"]);
      expect(gone(), `pid ${pid} still runs`).toBe(true);
    });
  });
});

describe("upstream files the fork changes", () => {
  it("flags moves, deletions and files both sides add, and keeps edits on both as hot", () => {
    const fork = parseNameStatus(
      "M\ta.ts\nM\tb.ts\nD\tc.ts\nR090\td.ts\te.ts\nA\tf.ts\nA\tboth.ts\nA\tmoved-here.ts",
    );
    const upstream = parseNameStatus(
      "R100\ta.ts\ta2.ts\nM\tb.ts\nM\tc.ts\nM\td.ts\nA\tg.ts\nA\tboth.ts\nR100\tz.ts\tmoved-here.ts",
    );
    const fates = upstreamFileFates(fork, upstream);
    expect(fates.hot).toEqual(["b.ts"]);
    expect(fates.flags).toHaveLength(5);
    expect(fates.flags[0]).toContain(
      "`a.ts`, which the fork has changed, moved upstream to `a2.ts`",
    );
    expect(fates.flags[1]).toContain("the fork deletes `c.ts`");
    expect(fates.flags[2]).toContain("the fork moves `d.ts` to `e.ts`");
    expect(fates.flags[3]).toContain("both add `both.ts`");
    expect(fates.flags[4]).toContain("both add `moved-here.ts`");
  });
  it("reads each file's hunk lines, and never a header", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "index 1..2 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -3,0 +4,2 @@ const f = () => {",
      '+import { a } from "./a.ts";',
      " context",
      "--- a/not-a-header",
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    ].join("\n");
    expect([...diffBodies(diff)]).toEqual([
      ["x.ts", ['+import { a } from "./a.ts";', " context", "--- a/not-a-header"]],
      ["gone.ts", ["-bye"]],
    ]);
  });
  it("parses git's own diff whatever the user's prefix, driver or hunk-merging config", () => {
    scratchGit((run, dir) => {
      const text = (changed: ReadonlyArray<number>) =>
        Array.from({ length: 30 }, (_, i) => (changed.includes(i) ? `new ${i}` : `line ${i}`)).join(
          "\n",
        );
      NodeFS.writeFileSync(NodePath.join(dir, "x.ts"), text([]));
      run("add", ".");
      run("commit", "-q", "-m", "one");
      NodeFS.writeFileSync(NodePath.join(dir, "x.ts"), text([2, 12]));
      NodeFS.writeFileSync(NodePath.join(dir, "new.ts"), "added\n");
      run("add", ".");
      run("commit", "-q", "-m", "two");
      for (const config of [
        "diff.noprefix=true",
        "diff.mnemonicPrefix=true",
        "diff.external=false",
        "diff.interHunkContext=10",
      ]) {
        const bodies = diffBodies(run("-c", config, ...DIFF, "-U0", "HEAD~1", "HEAD"));
        // Two one-line hunks, never one merged across the ten lines between them; an added
        // file is named by its new side alone.
        expect([...bodies]).toEqual([
          ["new.ts", ["+added"]],
          ["x.ts", ["-line 2", "+new 2", "-line 12", "+new 12"]],
        ]);
      }
    });
  });
  it("finds a seam note by full path only, and says where", () => {
    const doc =
      "intro\n- `ws.ts`, and `apps/server/src/server.ts`.\n- again apps/server/src/server.ts";
    expect(seamLines(doc, "apps/server/src/server.ts")).toEqual([2, 3]);
    expect(seamLines(doc, "apps/server/src/ws.ts")).toEqual([]);
    expect(seamLines(doc, "packages/x/src/state/server.ts")).toEqual([]);
  });
});

describe("lint", () => {
  it("flags any new, changed or removed rule source and any lint tool's version change", () => {
    const changes = parseNameStatus(
      "A\toxlint-plugin-t3code/rules/new-rule.ts\nM\toxlint-plugin-t3code/rules/old-rule.ts\nD\toxlint-plugin-t3code/rules/gone-rule.ts\nM\toxlint-plugin-t3code/rules/old-rule.test.ts\nM\tapps/web/x.ts",
    );
    const workspace = (vitePlus: string) =>
      `packages:\n  - apps/*\n\ncatalog:\n  "@alchemy.run/axiom": 2.0.0\n  vite-plus: ${vitePlus}\n\noverrides:\n  vite-plus: "catalog:"\n`;
    const at = (shadcn = "0.1.5", vitePlus = "1.4.0") => ({
      pkg: { devDependencies: { "@shadcn/lint": shadcn, "vite-plus": "catalog:" } },
      workspace: workspace(vitePlus),
    });
    const flags = lintFlags(changes, at(), at());
    expect(flags).toHaveLength(3);
    expect(flags[0]).toContain("`oxlint-plugin-t3code/rules/new-rule.ts` is new");
    expect(flags[1]).toContain("`oxlint-plugin-t3code/rules/old-rule.ts` changed");
    expect(flags[2]).toContain("`oxlint-plugin-t3code/rules/gone-rule.ts` deleted");
    // A lint tool's version can bring rules no file in this repo shows.
    expect(lintFlags([], at(), at("0.2.0", "1.5.0"))).toEqual([
      "package.json @shadcn/lint 0.1.5 → 0.2.0 upstream: new lint rules possible; verify's check:changed lints the fork's files against it.",
      "pnpm-workspace.yaml catalog vite-plus 1.4.0 → 1.5.0 upstream: new lint rules possible; verify's check:changed lints the fork's files against it.",
    ]);
    // A version this cannot find at the target is said, never read as unchanged.
    const unfound = (tool: string) =>
      `${tool}'s version at the target is not in package.json or pnpm-workspace.yaml's \`catalog:\` as this reads them, so a change to it is not listed: read where upstream pins it now; verify's check:changed lints the fork's files against it.`;
    const catalogOnly = { pkg: at().pkg, workspace: "catalog:\n  other: 1.0.0\n" };
    expect(lintFlags([], catalogOnly, catalogOnly)).toEqual([unfound("vite-plus")]);
    expect(lintFlags([], { pkg: null, workspace: "" }, { pkg: null, workspace: "" })).toEqual([
      unfound("@shadcn/lint"),
      unfound("vite-plus"),
    ]);
    // Found at the base, not at the target: one item, not also a `1.4.0 → absent` line.
    expect(lintFlags([], at(), catalogOnly)).toEqual([unfound("vite-plus")]);
  });
});

describe("overlap with fork features", () => {
  it("needs a fork file or a feature path, and skips upstream's issue tracker", () => {
    const fork = new Set(["apps/web/src/rightPanelStore.ts"]);
    expect(
      overlapsFork("feat: issue tracker sync", ["apps/server/src/IssueTrackerBindings.ts"], fork),
    ).toBe(false);
    expect(overlapsFork("feat: parked threads", ["apps/web/src/sparkline.ts"], fork)).toBe(false);
    expect(overlapsFork("feat: parked threads", ["apps/web/src/ThreadParked.tsx"], fork)).toBe(
      true,
    );
    expect(overlapsFork("feat: a tracker panel", ["apps/web/src/rightPanelStore.ts"], fork)).toBe(
      true,
    );
  });
});

describe("release notes", () => {
  it("shows a body whole and a gh failure as a failure", () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    expect(releaseNote("v1", { status: 0, stdout: body, stderr: "" })).toEqual({
      say: `### v1\n\n${body}`,
    });
    expect(
      releaseNote("v1", { status: 1, stdout: "", stderr: "HTTP 401: Bad credentials\n" }),
    ).toEqual({
      flag: "`gh release view v1` failed: HTTP 401: Bad credentials",
    });
  });
});

describe("rebase and verify guards", () => {
  const state = {
    rebasing: false,
    dirty: false,
    branch: "fork/main",
    keep: "fork/main-pre-4969",
    keepSha: null,
    headSha: "abc",
    hasOrigin: true,
    merges: false,
  };
  it("reruns after an aborted rebase and refuses a finished, running or stale one, or one with merge commits", () => {
    expect(rebaseRefusal(state)).toBeNull();
    expect(rebaseRefusal({ ...state, keepSha: "abc" })).toBeNull();
    expect(rebaseRefusal({ ...state, keepSha: "old" })).toContain("already ran");
    expect(rebaseRefusal({ ...state, rebasing: true, branch: "(detached)" })).toContain(
      "in progress",
    );
    expect(rebaseRefusal({ ...state, dirty: true })).toContain("working tree");
    expect(rebaseRefusal({ ...state, branch: "main" })).toContain("check out fork/main");
    expect(rebaseRefusal({ ...state, hasOrigin: false })).toContain("another machine");
    expect(rebaseRefusal({ ...state, merges: true })).toContain("merge commits");
  });
  it("says a rebase that never began rewrote nothing, and lists a conflict stop's files", () => {
    const stop = { rebasing: true, conflicted: ["a.ts"], before: "abc", after: "abc", keep: "k" };
    expect(rebaseStopped(stop)).toEqual([
      "The rebase stopped on 1 conflicted file(s):",
      "  a.ts",
      "Re-apply the fork's intent, not the old hunk (FORK.md step 4), `git rebase --continue`, then run verify.",
    ]);
    // An empty commit or a failed hook stops it with nothing conflicted.
    expect(rebaseStopped({ ...stop, conflicted: [] })).toEqual([
      "The rebase stopped without a conflict: read git's message above (an empty commit, a failed hook) and act on it, `git rebase --continue`, then run verify.",
    ]);
    const early = rebaseStopped({ ...stop, rebasing: false, conflicted: [] });
    expect(early).toHaveLength(1);
    expect(early[0]).toContain("nothing was rewritten, fork/main is still abc");
    expect(rebaseStopped({ ...stop, rebasing: false, after: "def" })[0]).toContain(
      "moved from abc to def",
    );
  });
  it("verifies only a finished, committed rebase checked out as fork/main on the target", () => {
    const ready = {
      rebasing: false,
      dirty: false,
      branch: "fork/main",
      onto: "v0.1.11-nightly.20261118.4864",
      ontoCommit: "abc",
      targetCommit: "abc",
    };
    // Twin tags: describe names 4864 and the target is 4865 on the same commit.
    expect(verifyRefusal(ready)).toBeNull();
    expect(verifyRefusal({ ...ready, rebasing: true })).toContain("in progress");
    expect(verifyRefusal({ ...ready, dirty: true })).toContain("untracked files");
    expect(verifyRefusal({ ...ready, branch: "(detached)" })).toContain(
      "HEAD is (detached), not fork/main",
    );
    expect(verifyRefusal({ ...ready, targetCommit: "def" })).toContain(
      "HEAD sits on v0.1.11-nightly.20261118.4864",
    );
  });
  it("names a fork test file or commit the rebase lost unless it is named as dropped", () => {
    // Opus's case: a commit skipped while resolving a conflict, its subject gone from HEAD.
    const commits = ["(fork) tracker: x", "(fork) park: y", "(fork) park: y"];
    expect(lost(commits, ["(fork) tracker: x", "(fork) park: y"], [])).toEqual(["(fork) park: y"]);
    expect(lost(commits, ["(fork) tracker: x", "(fork) park: y"], ["(fork) park: y"])).toEqual([]);
  });
  it("lists each fork commit the rebase changed or dropped, and each new in HEAD, with its files", () => {
    scratchGit((run, dir) => {
      const write = (file: string, text: string) =>
        NodeFS.writeFileSync(NodePath.join(dir, file), text);
      const commit = (subject: string) => {
        run("add", ".");
        run("commit", "-q", "-m", subject);
      };
      const numbers = (from: number, to: number) =>
        Array.from({ length: to - from + 1 }, (_, i) => `${from + i}\n`).join("");
      write("x.ts", numbers(1, 20));
      write("y.css", "1\n");
      commit("base");
      run("checkout", "-q", "-b", "old");
      write("x.ts", `${numbers(1, 20)}fork\n`);
      commit("f1");
      write("x.ts", `${numbers(1, 20)}fork\n${numbers(30, 40)}`);
      write("y.css", "1\nred\n");
      commit("f2 colours");
      write("z.ts", "gone\n");
      commit("f3 gone");
      run("checkout", "-q", "-b", "new", "HEAD~3");
      write("u.ts", "upstream\n");
      commit("upstream");
      run("tag", "target");
      write("x.ts", `${numbers(1, 20)}fork\n`);
      commit("f1");
      // The rebase kept f2's subject and x.ts hunk, dropped its y.css hunk and all of f3; a commit
      // made while resolving a conflict then took f1's line back out.
      write("x.ts", `${numbers(1, 20)}fork\n${numbers(30, 40)}`);
      commit("f2 colours");
      write("x.ts", `${numbers(1, 20)}${numbers(30, 40)}`);
      commit("fix");
      for (const config of ["color.ui=always", "diff.noprefix=true"]) {
        const { patches, refusal } = changedPatches(
          run("-c", config, "range-diff", "--no-color", "old~3..old", "target..new"),
          (sha) => run("-c", config, "show", "--format=", "--numstat", "--no-renames", sha),
          3,
        );
        expect(refusal).toBeNull();
        expect(patches).toEqual([
          expect.stringMatching(/^2: {2}\w+ ! 2: {2}\w+ f2 colours \(y\.css ±3\)$/),
          expect.stringMatching(
            /^3: {2}\w+ < -: {2}-+ f3 gone: no match in HEAD, read it \(z\.ts \+1 −0\)$/,
          ),
          expect.stringMatching(
            /^-: {2}-+ > 3: {2}\w+ fix: new in HEAD, read it \(x\.ts \+0 −1\)$/,
          ),
        ]);
      }
    });
  });
  it("refuses range-diff output in a form it does not read", () => {
    // color.ui=always's escapes before each mark: no line reads as a commit.
    const coloured = [
      "1:  aaaaaaa = 1:  bbbbbbb f1",
      "2:  ccccccc ! 2:  ddddddd f2",
      "3:  eeeeeee < -:  ------- f3",
    ]
      .map((line) => `\x1b[33m${line}\x1b[m`)
      .join("\n");
    expect(changedPatches(coloured, () => "1\t0\tz.ts", 3)).toEqual({
      patches: [],
      refusal: expect.stringContaining("read 0 commit lines for 3 fork commits"),
    });
  });
  it("names a test file no Vite project discovers", () => {
    const listing =
      "[root] a.test.ts\n[@t3tools/web (browser) (chromium)] apps/web/b.browser.test.tsx\n";
    expect(
      undiscovered(listing, ["a.test.ts", "apps/web/b.browser.test.tsx", "c.test.ts"]),
    ).toEqual(["c.test.ts"]);
  });
});

// The proof: the 4825 -> 4864 rebase was done by hand (2026-11-18) and broke on a removed settings
// export and a new translation lint rule. The plan must list both to read. A checkout without the
// refs (CI's) skips it with the reason shown; verify sets UPSTREAM_SYNC_PROOF=required, where a skip
// would look green, so there the missing refs fail it.
const hasRef = (ref: string) =>
  NodeChildProcess.spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: import.meta.dirname,
    stdio: "ignore",
  }).status === 0;
const target = "v0.1.11-nightly.20261118.4864";
const nightly = "v0.1.11-nightly.20261117.4825";
describe("plan on the 4864 rebase", () => {
  it("lists what broke when it was done by hand", (context) => {
    const before = ["fork/main-pre-4864", "origin/fork/main-pre-4864"].find(hasRef);
    if (before === undefined || ![target, nightly, "upstream/main"].every(hasRef)) {
      const why = `the proof needs fork/main-pre-4864, ${nightly}, ${target} and upstream/main: git fetch origin fork/main-pre-4864 && git fetch upstream main && git fetch upstream tag ${target} --no-tags && git fetch upstream tag ${nightly} --no-tags`;
      if (process.env.UPSTREAM_SYNC_PROOF === "required") throw new Error(why);
      context.skip(why);
      return;
    }
    // A ledger 4825 wrote: every id in its own manifest, so only the fork's migration to 4864's
    // head leaves it one it does not know.
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "upstream-sync-proof-"));
    try {
      const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "statev2.sqlite"));
      db.exec("CREATE TABLE effect_sql_migrations (migration_id INTEGER, name TEXT)");
      const insert = db.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)");
      const manifest = NodeChildProcess.execFileSync(
        "git",
        ["show", `${nightly}:apps/server/src/persistence/Migrations.ts`],
        { cwd: import.meta.dirname, encoding: "utf8" },
      );
      for (const [id, entry] of manifestEntries(manifest).entries) insert.run(id, entry.name);
      db.close();
      const args = {
        command: "plan",
        target,
        base: null,
        head: before,
        notes: false,
        nightly,
        dropped: [],
        droppedCommits: [],
        baseline: null,
        out: null,
        db: NodePath.join(dir, "statev2.sqlite"),
      };
      const report = plan(args);
      expect(report).toContain(
        "- [ ] `apps/web/src/components/settings/settingsSearch.ts` changed upstream; fork code imports it in `apps/web/src/components/settings/DecisionJudgeModelRow.tsx`",
      );
      expect(report).toContain(
        "- [ ] lint rule source `oxlint-plugin-t3code/rules/no-untranslated-copy.ts` is new",
      );
      expect(report).toContain(`${nightly} → ${target}`);
      expect(report).toContain(
        `- [ ] the target ${target} is not the installed Nightly ${nightly}`,
      );
      const nightlyLine = `- [ ] once the fork runs ${target}'s migrations, the installed Nightly ${nightly}: 98 ActiveShellIndexIndexes is recorded and not in its manifest.`;
      expect(report).toContain(nightlyLine);
      // The Nightly is one item, never also a build of its own beside the target and the base.
      expect(report).not.toMatch(/^- (?:\[ \] )?the installed Nightly v/m);
      // A ledger the fork at 4864 already migrated: the target adds nothing above it, and the
      // Nightly's line still says what it does not know.
      const migrated = new NodeSqlite.DatabaseSync(args.db);
      migrated.exec("INSERT INTO effect_sql_migrations VALUES (98, 'ActiveShellIndexIndexes')");
      migrated.close();
      expect(plan(args)).toContain(nightlyLine);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
