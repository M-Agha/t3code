#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A one-shot fork tool; synchronous Node APIs keep it small.
// The fork's upstream sync, as FORK.md "Rebasing onto upstream" describes it, made rerunnable:
//   plan    read-only: what a person must read before moving the fork from its base tag to a target tag
//   rebase  pushes the old head as a branch, then rebases the fork's commits onto the target tag
//   verify  after the rebase, before the push: what it runs and reaches is FORK.md step 5
//   suite   the full suite wherever it runs (failures, exits, tests run per file): verify's baseline, from a worktree at the target, kept per commit
// `plan` judges nothing safe: it lists files and facts to read.
// Exit codes: 0 done, 1 a step failed or the rebase stopped on a conflict, 2 refused before acting.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

const UPSTREAM_REPO = "pingdotgg/t3code";
const MIGRATIONS_FILE = "apps/server/src/persistence/Migrations.ts";
const MIGRATIONS_DIR = "apps/server/src/persistence/Migrations/";
// Where upstream names the live database: `stateDir = join(baseDir, … "userdata")`, then
// `dbPath = join(stateDir, "statev2.sqlite")`.
const CONFIG_FILE = "apps/server/src/config.ts";
const LIVE_DB_DIR = "userdata";
const LIVE_DB_FILE = "statev2.sqlite";
const LINT_PLUGIN_DIR = "oxlint-plugin-t3code/";
const NIGHTLY_TAG = /^v\d+\.\d+\.\d+-nightly\.\d{8}\.(\d+)$/;
const NIGHTLY_APP = "T3 Code (Nightly).app";
// Every git call and child runs at the repo root: CI runs this package's tests from scripts/, where
// `git ls-tree` would list paths relative to it.
const ROOT_DIR = NodePath.resolve(import.meta.dirname, "..", "..");
// Words in an upstream commit subject that may mean upstream shipped its own version of a fork
// feature (FORK.md: "stop and ask the owner"). A subject alone is not enough: the commit must also
// touch a file the fork changes or a path named for a fork feature.
const FEATURE_WORDS =
  /\b(park(ed|ing)?|tracker|artifacts?|decisions?|judge|session board|questions? panel)\b/i;
// A path segment or camelCase word, so `sparkline` is not `park`.
const FEATURE_PATH =
  /(?:^|[^A-Za-z])(?:[Pp]ark|[Tt]racker|[Aa]rtifact|[Dd]ecision|[Jj]udge)|[a-z](?:Park|Tracker|Artifact|Decision|Judge)/;
// Upstream's own issue tracker (Linear, GitHub, Jira issues) is not the fork's Tracker panel.
const ISSUE_TRACKER = /issue[-_ ]?trackers?/gi;

const git = (...args: string[]): string =>
  NodeChildProcess.execFileSync("git", args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).trimEnd();
const gitRun = (...args: string[]) =>
  NodeChildProcess.spawnSync("git", args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
const gitTry = (...args: string[]): string | null => {
  const result = gitRun(...args);
  return result.status === 0 ? result.stdout.trimEnd() : null;
};
const lines = (text: string): string[] => (text === "" ? [] : text.split("\n"));
// Every `git log` and `git show` of commits this parses passes it: log.showSignature=true writes
// "No signature" or a key's check above each commit's output.
const NO_SIGNATURE = "--no-show-signature";
const gitLog = (...args: string[]): string => git("log", NO_SIGNATURE, ...args);

const fail = (message: string): never => {
  console.error(`upstream-sync: ${message}`);
  process.exit(2);
};

/** What the checks read from a ref: git when the tool runs, a plain map in the unit tests. */
export interface Repo {
  readonly files: (ref: string) => ReadonlySet<string>;
  readonly read: (ref: string, path: string) => string | null;
}
// One tree listing per ref and one read per file: plan reads hundreds of files at three refs.
const gitRepo = (): Repo => {
  const trees = new Map<string, Set<string>>();
  const blobs = new Map<string, string | null>();
  const files = (ref: string): Set<string> => {
    let set = trees.get(ref);
    if (set === undefined) {
      set = new Set(lines(git("ls-tree", "-r", "--name-only", ref)));
      trees.set(ref, set);
    }
    return set;
  };
  return {
    files,
    read: (ref, path) => {
      const key = `${ref}:${path}`;
      if (!blobs.has(key)) blobs.set(key, files(ref).has(path) ? git("show", key) : null);
      return blobs.get(key) ?? null;
    },
  };
};
const repo = gitRepo();

interface Args {
  readonly command: string;
  readonly target: string | null;
  readonly base: string | null;
  readonly head: string;
  readonly notes: boolean;
  /** `--nightly <tag|none>`: the Nightly this machine falls back to; null reads the installed app. */
  readonly nightly: string | null;
  /** `--dropped <path>`, repeatable: a fork test file verify no longer expects after the rebase. */
  readonly dropped: ReadonlyArray<string>;
  /** `--dropped-commit <subject>`, repeatable: a fork commit verify no longer expects after the rebase. */
  readonly droppedCommits: ReadonlyArray<string>;
  /** verify's `--baseline <file>`: what `suite` wrote at the target; null reads the one it kept. */
  readonly baseline: string | null;
  /** The live database plan reads read-only; null takes it from upstream's config.ts at the target. */
  readonly db: string | null;
}
// Each command's flags: a value flag is followed by its value; a misspelt one is refused, never ignored.
const FLAGS: Readonly<Record<string, ReadonlyArray<string>>> = {
  plan: ["--target", "--base", "--head", "--nightly", "--notes"],
  rebase: ["--target"],
  verify: ["--target", "--dropped", "--dropped-commit", "--baseline"],
  suite: [],
};
const USAGE =
  "usage: upstream-sync.ts plan [--target <tag>] [--base <tag>] [--head <ref>] [--nightly <tag|none>] [--notes] | rebase --target <tag> | verify --target <tag> [--dropped <path>]… [--dropped-commit <subject>]… [--baseline <file>] | suite";
/** The command line read, or what is wrong with it: every word must be understood. */
export const readArgs = (argv: ReadonlyArray<string>): Args | string => {
  const [command = "plan", ...rest] = argv;
  const flags = FLAGS[command];
  if (flags === undefined) return `unknown command ${command}`;
  const values = new Map<string, string[]>();
  for (let at = 0; at < rest.length; at += 1) {
    const flag = rest[at] ?? "";
    if (!flags.includes(flag)) return `${command} does not take ${flag}`;
    const value = flag === "--notes" ? "" : rest[(at += 1)];
    if (value === undefined) return `${flag} needs a value`;
    values.set(flag, [...(values.get(flag) ?? []), value]);
  }
  return {
    command,
    target: values.get("--target")?.[0] ?? null,
    base: values.get("--base")?.[0] ?? null,
    head: values.get("--head")?.[0] ?? "HEAD",
    notes: values.has("--notes"),
    nightly: values.get("--nightly")?.[0] ?? null,
    dropped: values.get("--dropped") ?? [],
    droppedCommits: values.get("--dropped-commit") ?? [],
    baseline: values.get("--baseline")?.[0] ?? null,
    db: null,
  };
};
const parseArgs = (argv: ReadonlyArray<string>): Args => {
  const args = readArgs(argv);
  return typeof args === "string" ? fail(`${args}\n${USAGE}`) : args;
};

const buildNumber = (tag: string): number => Number(NIGHTLY_TAG.exec(tag)?.[1] ?? Number.NaN);
const baseTagOf = (ref: string): string =>
  gitTry("describe", "--tags", "--abbrev=0", "--match", "v*-nightly.*", ref) ??
  fail(`no upstream Nightly tag below ${ref}; run git fetch upstream --tags`);
/** A tag's commit: two tags on one commit are one build, whatever their numbers say. */
const commitOf = (tag: string): string => git("rev-parse", `refs/tags/${tag}^{commit}`);
const isFetchedTag = (tag: string): boolean =>
  gitTry("rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`) !== null;

/** Why `target` cannot be the tag the fork moves to from `base`, or null when it can. */
export const targetProblem = (
  target: string,
  base: string,
  facts: {
    readonly fetched: boolean;
    /** Upstream tags some builds twice (857 and 858 on one commit): a twin of the base moves nothing. */
    readonly sameCommit: boolean;
    readonly descends: boolean;
    readonly upstream: boolean;
  },
): string | null => {
  if (!NIGHTLY_TAG.test(target))
    return `${target} is not an upstream Nightly tag (v<version>-nightly.<date>.<n>): FORK.md step 1 targets the Nightly the owner runs, never a branch`;
  if (!facts.fetched)
    return `tag ${target} is not fetched here: git fetch upstream tag ${target} --no-tags`;
  if (facts.sameCommit) return `${target} tags the same commit as the fork's base ${base}`;
  if (buildNumber(target) <= buildNumber(base))
    return `${target} is not newer than the fork's base ${base}`;
  if (!facts.descends) return `${target} does not descend from the fork's base ${base}`;
  // A Nightly-shaped tag on a fork commit passes every check above.
  if (!facts.upstream)
    return `${target} is not on upstream/main's history: it may tag a fork commit, or upstream/main is behind it (git fetch upstream main)`;
  return null;
};
/** The target tag's commit, once it passes `targetProblem`: what git is handed, never the tag name. */
const requireTarget = (target: string, base: string): string => {
  const fetched = isFetchedTag(target);
  const problem = targetProblem(target, base, {
    fetched,
    sameCommit: fetched && commitOf(target) === commitOf(base),
    descends: fetched && gitTry("merge-base", "--is-ancestor", base, target) !== null,
    upstream:
      fetched &&
      gitTry("merge-base", "--is-ancestor", target, "refs/remotes/upstream/main") !== null,
  });
  return problem === null ? commitOf(target) : fail(problem);
};

export interface MigrationEntry {
  readonly name: string;
  readonly file: string;
}
/** Upstream's migration manifest: each id's name and file, and every line of it this cannot read. */
export interface MigrationManifest {
  readonly entries: ReadonlyMap<number, MigrationEntry>;
  /** A line not `[<id>, "<name>", <imported migration>],`: while one exists, the manifest is not fully read. */
  readonly unreadable: ReadonlyArray<string>;
}
const TUPLE = /^\[\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*([A-Za-z_$][\w$]*)\s*\],?$/;
/** `migrationEntries` read line by line: anything but one plain tuple per line is unreadable, never guessed. */
export const manifestEntries = (text: string): MigrationManifest => {
  const files = new Map(
    [...text.matchAll(/^import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/gm)].map(
      (m) => [m[1] ?? "", m[2] ?? ""] as const,
    ),
  );
  const list = /^(?:export\s+)?const\s+migrationEntries\b[^=]*=\s*\[\n([^]*?)^\]/m.exec(text);
  if (list === null || list[1] === undefined)
    return { entries: new Map(), unreadable: ["no `migrationEntries = [` … `]` list"] };
  const first = text.slice(0, list.index).split("\n").length + 1;
  const entries = new Map<number, MigrationEntry>();
  const unreadable: string[] = [];
  lines(list[1].trimEnd()).forEach((raw, at) => {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (line === "") return;
    const [, id = "", name = "", migration = ""] = TUPLE.exec(line) ?? [];
    const file = files.get(migration);
    if (id !== "" && file !== undefined && !entries.has(Number(id)))
      entries.set(Number(id), { name, file });
    else unreadable.push(`${MIGRATIONS_FILE}:${first + at} \`${line.slice(0, 80)}\``);
  });
  return { entries, unreadable };
};
const manifestAt = (ref: string): MigrationManifest =>
  manifestEntries(repo.read(ref, MIGRATIONS_FILE) ?? fail(`${MIGRATIONS_FILE} missing at ${ref}`));
/** The highest id, or null while a line is unreadable: it may hold a higher one. */
export const headOf = (manifest: MigrationManifest): number | null =>
  manifest.unreadable.length > 0 || manifest.entries.size === 0
    ? null
    : Math.max(...manifest.entries.keys());
const migrationPath = (entry: MigrationEntry): string =>
  NodePath.posix.join(NodePath.posix.dirname(MIGRATIONS_FILE), entry.file);
const entryText = (id: number, entry: MigrationEntry) =>
  `${id} ${entry.name} (\`${migrationPath(entry)}\`)`;
const same = (entry: MigrationEntry, old: MigrationEntry | undefined): boolean =>
  entry.name === old?.name && entry.file === old.file;
/** Manifest entries the target adds, removes, or keeps under an id with another name or file. */
export const manifestChanges = (
  base: MigrationManifest,
  target: MigrationManifest,
): { added: string[]; removed: string[]; changed: string[] } => ({
  added: [...target.entries]
    .filter(([id]) => !base.entries.has(id))
    .map(([id, entry]) => entryText(id, entry)),
  removed: [...base.entries]
    .filter(([id]) => !target.entries.has(id))
    .map(([id, entry]) => entryText(id, entry)),
  changed: [...target.entries].flatMap(([id, entry]) => {
    const old = base.entries.get(id);
    return old === undefined || same(entry, old)
      ? []
      : [`${entryText(id, old)} → ${entryText(id, entry)}`];
  }),
});

export interface Recorded {
  readonly id: number;
  readonly name: string;
}
/** The upstream migrations a database has run, read without writing; a string says why it could not be read. */
export const ledgerRows = (path: string): Recorded[] | string => {
  try {
    const db = new NodeSqlite.DatabaseSync(path, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
        .all();
      const read = rows.flatMap((row) =>
        typeof row.migration_id === "number" && typeof row.name === "string"
          ? [{ id: row.migration_id, name: row.name }]
          : [],
      );
      return rows.length === 0
        ? "its effect_sql_migrations is empty"
        : read.length < rows.length
          ? "its effect_sql_migrations has a row without a numeric id and a name"
          : read;
    } finally {
      db.close();
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};
/**
 * Where upstream's config.ts puts the live database: the folders its `stateDir` joins (null when
 * this cannot find it) and the file its `dbPath` names (null likewise).
 */
export const liveDbOf = (
  config: string,
): { readonly dirs: string[] | null; readonly file: string | null } => {
  const join = /\bstateDir\s*=\s*join\(([^;]*?)\);/.exec(config)?.[1];
  return {
    dirs:
      join === undefined ? null : [...join.matchAll(/["']([^"']+)["']/g)].map((m) => m[1] ?? ""),
    file: /\bdbPath\s*=\s*join\(\s*stateDir\s*,\s*["']([^"']+)["']\s*\)/.exec(config)?.[1] ?? null,
  };
};
/**
 * Where a build's manifest and a ledger disagree, as facts: recorded ids it does not know, ids
 * recorded under another name, and ids it has below the ledger's last that were never recorded.
 * What the build does about each is in its own Migrations.ts; plan does not say.
 */
export const ledgerFacts = (
  manifest: MigrationManifest,
  ledger: ReadonlyArray<Recorded>,
): string[] => {
  const top = Math.max(...ledger.map((row) => row.id));
  const recorded = new Map(ledger.map((row) => [row.id, row.name]));
  return [
    ...ledger
      .filter((row) => !manifest.entries.has(row.id))
      .map((row) => `${row.id} ${row.name} is recorded and not in its manifest`),
    ...ledger.flatMap((row) => {
      const entry = manifest.entries.get(row.id);
      return entry !== undefined && entry.name !== row.name
        ? [`${row.id} is recorded as ${row.name} and named ${entry.name} in its manifest`]
        : [];
    }),
    ...[...manifest.entries]
      .filter(([id]) => id < top && !recorded.has(id))
      .map(
        ([id, entry]) => `${id} ${entry.name} is in its manifest, below ${top}, and not recorded`,
      ),
    ...(manifest.unreadable.length > 0
      ? [`its manifest has lines this tool cannot read (${manifest.unreadable.join("; ")})`]
      : []),
  ];
};
/**
 * The ledger once a build has run on it: upstream's migrator runs only ids above the highest
 * recorded one (`pending` in Migrations.ts at 4969), so those are the ids it adds.
 */
export const ledgerAfter = (
  ledger: ReadonlyArray<Recorded>,
  manifest: MigrationManifest,
): Recorded[] => {
  const top = Math.max(...ledger.map((row) => row.id));
  return [
    ...ledger,
    ...[...manifest.entries]
      .filter(([id]) => id > top)
      .map(([id, entry]) => ({ id, name: entry.name })),
  ];
};

/** The installed official Nightly's tag, from its app bundle; null when there is none (or off macOS). */
const installedNightlyTag = (): string | null => {
  for (const dir of ["/Applications", NodePath.join(NodeOS.homedir(), "Applications")]) {
    const plist = NodePath.join(dir, NIGHTLY_APP, "Contents", "Info.plist");
    if (!NodeFS.existsSync(plist)) continue;
    const result = NodeChildProcess.spawnSync(
      "defaults",
      ["read", plist.replace(/\.plist$/, ""), "CFBundleShortVersionString"],
      { encoding: "utf8" },
    );
    if (result.status === 0) return `v${result.stdout.trim()}`;
  }
  return null;
};

// SQL identifiers, quoted any of SQLite's ways (a backtick may arrive escaped inside a TS template),
// optionally schema-qualified (`main.x`); the table is the last part, never one followed by a dot.
const IDENT = String.raw`(?:"[^"]+"|\\?\x60[^\x60\\]+\\?\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
const QUALIFIED = String.raw`(?:${IDENT}\s*\.\s*)?(${IDENT})(?![\w$]|\s*\.)`;
const unquote = (name: string): string =>
  name
    .replace(/^(?:"|\\?\x60|\[)/, "")
    .replace(/(?:"|\\?\x60|\])$/, "")
    .toLowerCase();
const CREATE_TABLE = String.raw`CREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:VIRTUAL\s+)?TABLE(?:\s+IF\s+NOT\s+EXISTS)?`;
const READS = String.raw`TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?|INTO|FROM|UPDATE|JOIN|ON|REFERENCES|TO`;

/** The tables a source creates or renames to, in SQL only (`CREATE TABLE t (`): the names `tablesIn` accepts. */
export const createdTables = (text: string): string[] => [
  ...[
    ...text.matchAll(
      new RegExp(String.raw`\b${CREATE_TABLE}\s+${QUALIFIED}\s*(?:\(|AS\b|USING\b)`, "gi"),
    ),
  ].map((m) => unquote(m[1] ?? "")),
  ...[
    ...text.matchAll(
      new RegExp(String.raw`\bALTER\s+TABLE\s+${QUALIFIED}\s+RENAME\s+TO\s+${QUALIFIED}`, "gi"),
    ),
  ].map((m) => unquote(m[2] ?? "")),
];
/** The known tables a text names after a SQL keyword: what it creates, alters, indexes, reads or writes. */
export const tablesIn = (text: string, known: ReadonlySet<string>): Set<string> =>
  new Set(
    [...text.matchAll(new RegExp(String.raw`\b(?:${READS})\s+${QUALIFIED}`, "gi"))]
      .map((m) => unquote(m[1] ?? ""))
      .filter((name) => known.has(name)),
  );

/**
 * The fork's tables: the `known` ones (some production `CREATE TABLE` or `RENAME TO` makes them)
 * named after a SQL keyword in `forkSql` (the fork's added production files, and the top-level
 * statements its edits to upstream files sit in), its own `fork_` tables left out. Or why that
 * came out empty: fork code holding a `sql` template that names no known table is read by hand.
 */
export const forkTablesIn = (forkSql: string, known: ReadonlySet<string>): Set<string> | string => {
  const named = [...tablesIn(forkSql, known)].filter((table) => !table.startsWith("fork_"));
  return named.length === 0 && /\bsql\s*(?:`|\.unsafe\s*\()/.test(forkSql)
    ? "the fork's production code holds SQL, yet names no upstream table a production `CREATE TABLE` makes: read the fork's queries by hand against upstream's changes"
    : new Set(named);
};
/** `git grep`'s matching lines: exit 1 is no match; anything else is an error, never an empty answer. */
export const grepHits = (result: {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}): string[] | string =>
  result.status === 0
    ? lines(result.stdout.trimEnd())
    : result.status === 1
      ? []
      : `git grep failed: ${result.stderr.trim() || `exit ${result.status}`}`;

const isTest = (path: string) => /\.test\.tsx?$/.test(path);
/** Code that ships: not a test, and not a script (this one's comments hold SQL-shaped text). */
export const isProduction = (path: string): boolean =>
  /\.tsx?$/.test(path) &&
  !/(?:^|\/)scripts\/|\.test\.tsx?$|(?:^|\/)(?:tests?|__tests__)\//.test(path);

const nodeVersionAt = (ref: string): string =>
  (readJson(repo, ref, "package.json") ?? fail(`package.json missing at ${ref}`)).engines?.node ??
  "unknown";
/** engines.node when it pins one version; null for a range, which this tool does not compare. */
const exactVersion = (engines: string): string | null =>
  /^\d+\.\d+\.\d+$/.test(engines) ? engines : null;

export interface Import {
  /** The module as written; null for a computed `import(x)`. */
  readonly spec: string | null;
  /** The local names an `import … from` / `export … from` clause binds (more than it binds, never fewer). */
  readonly names: ReadonlyArray<string>;
}
/**
 * Every module a source names, by regex: `import`/`export … from`, side-effect imports, `import()`
 * (and `import()` types) and `require()`. Text in comments or strings that looks like one is
 * listed too: this lists more, never fewer.
 */
export const importsOf = (text: string): Import[] => [
  ...[
    ...text.matchAll(
      /\b(?:import|export)\s+(?:type\s+)?([^;"'`]*?)\s*\bfrom\s*["']([^"'\n]+)["']/g,
    ),
  ].map((m) => ({
    spec: m[2] ?? "",
    names: [...(m[1] ?? "").matchAll(/[A-Za-z_$][\w$]*/g)]
      .map((n) => n[0])
      .filter((n) => n !== "type" && n !== "as"),
  })),
  ...[...text.matchAll(/\b(?:import|require)\s*\(?\s*["'`]([^"'`\n]+)["'`]/g)].map((m) => ({
    spec: m[1] ?? "",
    names: [],
  })),
  ...[...text.matchAll(/\bimport\s*\(\s*(?!["'`])/g)].map(() => ({ spec: null, names: [] })),
];
/** Whether the fork's added lines in an upstream file touch an import: its specifier or a name it binds. */
export const touches = (imp: Import, added: ReadonlyArray<string>): boolean => {
  const name =
    imp.names.length === 0
      ? null
      : new RegExp(String.raw`(?<![\w$])(?:${imp.names.map(escapeRegExp).join("|")})(?![\w$])`);
  return added.some(
    (line) => (imp.spec !== null && line.includes(imp.spec)) || (name?.test(line) ?? false),
  );
};

interface PackageJson {
  readonly name?: string;
  readonly exports?: unknown;
  readonly engines?: { readonly node?: string };
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}
/** A package.json at a ref, or null when there is none; a malformed one stops the tool, never reads as empty. */
const readJson = (from: Repo, ref: string, path: string): PackageJson | null => {
  const text = from.read(ref, path);
  if (text === null) return null;
  try {
    const json: PackageJson = JSON.parse(text);
    return json;
  } catch (error) {
    return fail(`${path} at ${ref} is not JSON: ${error instanceof Error ? error.message : error}`);
  }
};
/** Each workspace package (pnpm-workspace.yaml's `packages:` globs) that has a `test` script, by name. */
export const testPackages = (from: Repo, ref: string): string[] => {
  // The list's `- <glob>` lines run to the next unindented line; blank and comment lines sit between.
  const yaml = lines(from.read(ref, "pnpm-workspace.yaml") ?? "");
  const globs: string[] = [];
  const start = yaml.findIndex((line) => /^packages:\s*$/.test(line));
  for (const line of start < 0 ? [] : yaml.slice(start + 1)) {
    if (/^\s*(?:#|$)/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const glob = /^\s+-\s*["']?([^"'\s#]+)/.exec(line)?.[1];
    if (glob !== undefined) globs.push(glob);
  }
  return [...from.files(ref)]
    .filter((path) =>
      globs.some((glob) => NodePath.posix.matchesGlob(path, `${glob}/package.json`)),
    )
    .flatMap((path) => {
      const pkg = readJson(from, ref, path);
      return pkg?.name !== undefined && pkg.scripts?.test !== undefined ? [pkg.name] : [];
    })
    .toSorted();
};
interface VitestReport {
  readonly testResults?: ReadonlyArray<{
    readonly name: string;
    readonly status: string;
    readonly message: string;
    readonly assertionResults: ReadonlyArray<{
      readonly ancestorTitles: ReadonlyArray<string>;
      readonly title: string;
      readonly status: string;
    }>;
  }>;
}
// Vitest's JSON reporter maps a test that ran to these; skipped, todo and never-run ones to others.
const RAN = new Set(["passed", "failed"]);
/** One package's test script: its exit status (null: a signal), and each test file its report names with the tests that ran there (null: no report). */
export interface PackageRun {
  readonly exit: number | null;
  readonly files: Map<string, number> | null;
}
/**
 * A Vitest JSON report (`--reporter=json`): each failed test as `file > describe > test`, the file
 * relative to `root`, and a file that failed with no failed test (it threw on import) as `file: its
 * message`; and each file with how many of its tests ran. No failures and null files when the text
 * is no such report: the exit status speaks then.
 */
export const readReport = (
  report: string,
  root: string,
): { readonly failures: string[]; readonly files: Map<string, number> | null } => {
  let json: VitestReport | null;
  try {
    json = JSON.parse(report);
  } catch {
    return { failures: [], files: null };
  }
  const results = json?.testResults;
  if (results === undefined) return { failures: [], files: null };
  const files = new Map<string, number>();
  const failures = results.flatMap((file) => {
    const path = NodePath.relative(root, file.name);
    files.set(path, file.assertionResults.filter((test) => RAN.has(test.status)).length);
    const tests = file.assertionResults
      .filter((test) => test.status === "failed")
      .map((test) => [path, ...test.ancestorTitles, test.title].join(" > "));
    return tests.length > 0 || file.status !== "failed"
      ? tests
      : [`${path}: ${file.message.split("\n")[0] || "failed with no failed test"}`];
  });
  return { failures, files };
};
/** The full suite: each failure as `<package>: <failure>`, and each package's run. */
export interface Suite {
  readonly failures: ReadonlyArray<string>;
  readonly packages: ReadonlyMap<string, PackageRun>;
}
const BASELINE_HEADER = "# upstream-sync suite at ";
const BASELINE_EXIT = /^# (\S+) exited (\d+|on a signal)( with no report)?$/;
const BASELINE_FILE = /^# (\S+): (.+) ran (\d+) tests$/;
const exitText = (exit: number | null): string => (exit === null ? "on a signal" : String(exit));
/** What `suite` keeps: the commit, each package's exit and its files' ran counts, then every failure line. */
export const baselineText = (commit: string, run: Suite): string =>
  [
    `${BASELINE_HEADER}${commit}`,
    ...[...run.packages].flatMap(([name, { exit, files }]) => [
      `# ${name} exited ${exitText(exit)}${files === null ? " with no report" : ""}`,
      ...[...(files ?? [])].map(([file, ran]) => `# ${name}: ${file} ran ${ran} tests`),
    ]),
    ...run.failures,
  ].join("\n");
/** A file `suite` kept, read back, or why it is not one recorded at `commit`. */
export const baselineAt = (text: string, commit: string): Suite | string => {
  const [header = "", ...rest] = lines(text.trimEnd());
  if (!header.startsWith(BASELINE_HEADER)) return "is not a file `suite` wrote";
  const at = header.slice(BASELINE_HEADER.length);
  if (at !== commit) return `was recorded at ${at}, not at the target's commit ${commit}`;
  const failures: string[] = [];
  const packages = new Map<string, PackageRun>();
  for (const line of rest) {
    const exit = BASELINE_EXIT.exec(line);
    const file = BASELINE_FILE.exec(line);
    if (exit !== null)
      packages.set(exit[1] ?? "", {
        exit: exit[2] === "on a signal" ? null : Number(exit[2]),
        files: exit[3] === undefined ? new Map() : null,
      });
    // baselineText writes a package's exit line before its files.
    else if (file !== null) packages.get(file[1] ?? "")?.files?.set(file[2] ?? "", Number(file[3]));
    // An older format's lines would read as failures, and its packages as absent.
    else if (line.startsWith("# ")) return `has a line suite does not write: ${line}`;
    else failures.push(line);
  }
  if (packages.size === 0) return "has no package lines: record it again with this script's suite";
  return { failures, packages };
};
/**
 * verify's owed lines for the full suite: each failure new, also failing at the target, or not
 * comparable; each package to read for unhandled errors, which Vitest's JSON report leaves out;
 * each target test file that did not run or ran fewer tests, those `forkChanged` holds listed apart.
 */
export const suiteOwed = (
  run: Suite,
  baseline: Suite | null,
  target: string,
  forkChanged: ReadonlySet<string>,
): string[] => {
  const list = (items: ReadonlyArray<string>, mark = "") =>
    items.map((line) => `\n  - [ ] ${mark}${line}`).join("");
  const packageOf = (failure: string) => failure.slice(0, failure.indexOf(": "));
  const exitLine = (name: string, { exit, files }: PackageRun, note = "") =>
    `${name}: its test script exited ${exitText(exit)}${note}${files === null ? " and wrote no report" : ""}; read its output above for unhandled errors`;
  const exited = [...run.packages].filter(([, { exit }]) => exit !== 0);
  if (baseline === null) {
    const silent = exited
      .filter(([name]) => !run.failures.some((line) => packageOf(line) === name))
      .map(([name, ran]) => exitLine(name, ran));
    return [
      `- No baseline was given (--baseline <file>) or kept by suite for ${target} (FORK.md step 5): ${run.failures.length + silent.length} full-suite failures, none marked new or also failing at ${target}, and no test file compared; read each.${list([...run.failures, ...silent])}`,
    ];
  }
  // undefined (no such package at the target) and null (no report) alike leave nothing to compare.
  const reported = (name: string) => (baseline.packages.get(name)?.files ?? null) !== null;
  const uncomparable = run.failures.filter((line) => !reported(packageOf(line)));
  const compared = run.failures.filter((line) => reported(packageOf(line)));
  const fresh = compared.filter((line) => !baseline.failures.includes(line));
  const known = compared.filter((line) => baseline.failures.includes(line));
  const unexplained = exited.flatMap(([name, ran]) => {
    const wasZero = baseline.packages.get(name)?.exit === 0;
    return wasZero || !fresh.some((line) => packageOf(line) === name)
      ? [exitLine(name, ran, wasZero ? ` (0 at ${target})` : "")]
      : [];
  });
  const dropped: string[] = [];
  const forkFewer: string[] = [];
  for (const [name, { files }] of baseline.packages) {
    const now = run.packages.get(name);
    // Its exit line above already says it wrote no report.
    if (now !== undefined && now.files === null && now.exit !== 0) continue;
    for (const [file, was] of files ?? []) {
      const ran = now?.files?.get(file);
      if (ran === undefined)
        dropped.push(`${name}: ${file}: did not run, ${was} tests at ${target}`);
      else if (ran < was)
        (forkChanged.has(file) ? forkFewer : dropped).push(
          `${name}: ${file}: ${ran} tests ran, ${was} at ${target}`,
        );
    }
  }
  return [
    ...(run.failures.length > 0
      ? [
          `- The full suite: ${fresh.length} new, ${known.length} also failing at ${target}, ${uncomparable.length} cannot be compared (no report or no such package at ${target}); read each, new ones first.${list(fresh, "new: ")}${list(uncomparable, "cannot be compared: ")}${list(known, `also fails at ${target}: `)}`,
        ]
      : []),
    ...(unexplained.length > 0
      ? [
          `- ${unexplained.length} packages exited non-zero with no new failure, or exited 0 at ${target}:${list(unexplained)}`,
        ]
      : []),
    ...(dropped.length > 0
      ? [
          `- ${dropped.length} of ${target}'s test files did not run, or ran fewer tests where the fork does not modify them: find what the rebase dropped (a Vite project, a test file, a test).${list(dropped)}`,
        ]
      : []),
    ...(forkFewer.length > 0
      ? [
          `- ${forkFewer.length} of ${target}'s test files ran fewer tests; the fork changes these files: check the rebase kept upstream's new tests.${list(forkFewer)}`,
        ]
      : []),
  ];
};
/** The first file path an `exports` entry names, through any conditions (`types` first, as written). */
const exportTarget = (value: unknown): string | null =>
  typeof value === "string"
    ? value
    : typeof value === "object" && value !== null
      ? (Object.values(value)
          .map(exportTarget)
          .find((target) => target !== null) ?? null)
      : null;
/** The repo file a specifier lands on, or why not: a package (not the repo's code), or a local specifier that names no file. */
export type Resolved = { readonly path: string } | "package" | "unresolved";
/**
 * File-level resolution against one ref's tree: relative paths, the nearest tsconfig.json's `paths`
 * (`~/*`), and workspace packages through their package.json `exports`. Anything starting `.`, `~`,
 * `#` or `@/` that names no file is unresolved; any other bare name is a package.
 */
export const resolveSpec = (from: Repo, ref: string, file: string, spec: string): Resolved => {
  const files = from.files(ref);
  const bare = spec.replace(/\?.*$/, "");
  const found = (stem: string): Resolved => {
    const plain = NodePath.posix.normalize(stem).replace(/^\.\//, "");
    const noJs = plain.replace(/\.[cm]?js$/, "");
    const path = [
      plain,
      ...["", "/index"].flatMap((dir) => [".ts", ".tsx"].map((ext) => `${noJs}${dir}${ext}`)),
    ].find((candidate) => files.has(candidate));
    return path === undefined ? "unresolved" : { path };
  };
  if (bare.startsWith(".")) return found(NodePath.posix.join(NodePath.posix.dirname(file), bare));
  const [scope = "", name = ""] = bare.split("/");
  const pkgName = scope.startsWith("@") ? `${scope}/${name}` : scope;
  for (const manifest of files) {
    if (
      NodePath.posix.basename(manifest) !== "package.json" ||
      !manifest.includes("/") ||
      manifest.startsWith(".repos/")
    )
      continue;
    const pkg = readJson(from, ref, manifest);
    if (pkg?.name !== pkgName) continue;
    const dir = NodePath.posix.dirname(manifest);
    const sub = `.${bare.slice(pkgName.length)}`;
    const exports = typeof pkg.exports === "object" && pkg.exports !== null ? pkg.exports : {};
    const exact = exportTarget(Object.entries(exports).find(([key]) => key === sub)?.[1]);
    const star = Object.entries(exports)
      .filter(([key]) => key.endsWith("*") && sub.startsWith(key.slice(0, -1)))
      .toSorted(([a], [b]) => b.length - a.length)[0];
    const target =
      exact ??
      (star === undefined
        ? null
        : (exportTarget(star[1])?.replace("*", sub.slice(star[0].length - 1)) ?? null)) ??
      (typeof pkg.exports === "string" && sub === "." ? pkg.exports : null);
    return found(
      NodePath.posix.join(dir, target ?? NodePath.posix.join("src", sub === "." ? "index" : sub)),
    );
  }
  for (let dir = NodePath.posix.dirname(file); ; dir = NodePath.posix.dirname(dir)) {
    const config = from.read(ref, dir === "." ? "tsconfig.json" : `${dir}/tsconfig.json`);
    const paths = /"paths"\s*:\s*\{([^}]*)\}/.exec(config ?? "")?.[1] ?? "";
    for (const [, key = "", value = ""] of paths.matchAll(/"([^"]+)"\s*:\s*\[\s*"([^"]+)"/g)) {
      const prefix = key.replace(/\*$/, "");
      if (key.endsWith("*") ? bare.startsWith(prefix) : bare === key)
        return found(NodePath.posix.join(dir, value.replace("*", bare.slice(prefix.length))));
    }
    if (config !== null || dir === ".") break;
  }
  return /^(?:[~#]|@\/)/.test(bare) ? "unresolved" : "package";
};

export interface Change {
  /** A, M, D, R or T: `git diff --name-status`'s first letter. */
  readonly status: string;
  readonly path: string;
  /** The new path of a rename. */
  readonly to: string | null;
}
export const parseNameStatus = (text: string): Change[] =>
  lines(text).map((line) => {
    const [status = "", path = "", to = null] = line.split("\t");
    return { status: status.charAt(0), path, to };
  });
/** What upstream did to a file, in words. */
const changeText = (change: Change): string =>
  change.status === "D"
    ? "deleted"
    : change.status === "R"
      ? `moved to \`${change.to}\``
      : change.status === "A"
        ? "added"
        : "changed";
/**
 * The upstream files the fork changes that upstream also changed: `hot` ones both sides edited
 * (a conflict to resolve by seam), and `flags` for a file one side moved or deleted, or both added.
 */
export const upstreamFileFates = (
  fork: ReadonlyArray<Change>,
  upstream: ReadonlyArray<Change>,
): { hot: string[]; flags: string[] } => {
  const byPath = new Map(upstream.map((change) => [change.path, change]));
  const upstreamAdds = new Set(
    upstream.filter((c) => c.status === "A" || c.status === "R").map((c) => c.to ?? c.path),
  );
  const hot: string[] = [];
  const flags: string[] = [];
  for (const mine of fork) {
    const added = mine.status === "A" || mine.status === "R" ? (mine.to ?? mine.path) : null;
    if (added !== null && upstreamAdds.has(added))
      flags.push(
        `the fork and upstream both add \`${added}\`: the rebase stops on an add/add conflict there; merge the two or move the fork's file (FORK.md step 4).`,
      );
    if (mine.status === "A") continue;
    const theirs = byPath.get(mine.path);
    if (theirs === undefined || theirs.status === "A") continue;
    const what = `has ${changeText(mine)}`;
    if (theirs.status === "R")
      flags.push(
        `\`${mine.path}\`, which the fork ${what}, moved upstream to \`${theirs.to}\`: re-apply the fork's change there (FORK.md step 4).`,
      );
    else if (theirs.status === "D")
      flags.push(
        `\`${mine.path}\`, which the fork ${what}, was deleted upstream: re-apply the fork's change where upstream moved that code (FORK.md step 4).`,
      );
    else if (mine.status === "D")
      flags.push(
        `the fork deletes \`${mine.path}\`, which upstream changed: confirm the deletion still holds.`,
      );
    else if (mine.status === "R")
      flags.push(
        `the fork moves \`${mine.path}\` to \`${mine.to}\`, and upstream changed it: check that the rebase carried upstream's change into the moved file.`,
      );
    else hot.push(mine.path);
  }
  return { hot, flags };
};

// Every patch this parses: prefixes, colour, external drivers and hunk merging pinned, whatever the
// user's git config (diff.noprefix, diff.external, diff.interHunkContext).
export const DIFF = [
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--inter-hunk-context=0",
];
/**
 * `DIFF` with each hunk widened to its enclosing top-level statement (git's function context: up to
 * the previous line that starts in column 0), so an edited line inside a query brings the query's
 * table names with it.
 */
export const WIDE = [...DIFF, "-W"];
/** Each file's hunk lines (with their `+`, `-` or ` ` mark), from `git diff` output run with `DIFF`'s flags. */
export const diffBodies = (diff: string): Map<string, string[]> => {
  const byFile = new Map<string, string[]>();
  let current: string[] | null = null;
  let header = false;
  let oldPath = "";
  for (const line of lines(diff)) {
    if (line.startsWith("diff --git ")) {
      header = true;
      current = null;
    } else if (header && line.startsWith("@@ ")) header = false;
    else if (header && line.startsWith("--- ")) oldPath = /^--- a\/(.+)$/.exec(line)?.[1] ?? "";
    else if (header && line.startsWith("+++ ")) {
      current = [];
      byFile.set(/^\+\+\+ b\/(.+)$/.exec(line)?.[1] ?? oldPath, current);
    } else if (current !== null && !header && /^[-+ ]/.test(line)) current.push(line);
  }
  return byFile;
};
const added = (body: ReadonlyArray<string>): string[] =>
  body.filter((line) => line.startsWith("+")).map((line) => line.slice(1));

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The FORK.md lines that name `path` in full: a basename alone names no file once two share it. */
export const seamLines = (doc: string, path: string): number[] => {
  const pattern = new RegExp(String.raw`(?<![\w./-])${escapeRegExp(path)}(?![\w-])`);
  return lines(doc).flatMap((line, at) => (pattern.test(line) ? [at + 1] : []));
};

// Lint tools whose own rules can change under a version bump: shadcn's (a jsPlugin) and vite-plus's
// built-in oxlint rules.
const LINT_TOOLS = ["@shadcn/lint", "vite-plus"];
/** Where upstream pins each lint tool: root package.json's own entry and pnpm-workspace.yaml's catalog. */
const lintToolVersions = (pkg: PackageJson | null, workspace: string): Map<string, string> => {
  const versions = new Map<string, string>();
  for (const tool of LINT_TOOLS) {
    const declared = pkg?.devDependencies?.[tool] ?? pkg?.dependencies?.[tool];
    if (declared !== undefined) versions.set(`package.json ${tool}`, declared);
  }
  const catalog = /^catalog:\n((?:[ \t].*\n?|\n)*)/m.exec(workspace)?.[1] ?? "";
  for (const m of catalog.matchAll(/^[ \t]+"?([^"\s:]+)"?:[ \t]*"?([^"\s#]+)"?/gm))
    if (LINT_TOOLS.includes(m[1] ?? ""))
      versions.set(`pnpm-workspace.yaml catalog ${m[1]}`, m[2] ?? "");
  return versions;
};
export interface LintInputs {
  readonly pkg: PackageJson | null;
  readonly workspace: string;
}
const RECHECK = "verify's check:changed lints the fork's files against it";
/**
 * Lint changes that can fail fork code the old rules let through: a rule source or a lint tool's
 * version; and a lint tool whose version at the target this cannot find, or finds only as `catalog:`.
 */
export const lintFlags = (
  upstream: ReadonlyArray<Change>,
  base: LintInputs,
  target: LintInputs,
): string[] => {
  const before = lintToolVersions(base.pkg, base.workspace);
  const after = lintToolVersions(target.pkg, target.workspace);
  // A tool this cannot find at the target gets one item, not also an `→ absent` line that reads as
  // upstream having dropped it.
  const unfound = LINT_TOOLS.filter((tool) =>
    [...after]
      .filter(([key]) => key.endsWith(` ${tool}`))
      .every(([, version]) => version.startsWith("catalog:")),
  );
  return [
    ...upstream
      .filter((c) => (c.to ?? c.path).startsWith(LINT_PLUGIN_DIR) && !isTest(c.path))
      .map(
        (c) =>
          `lint rule source \`${c.path}\` ${c.status === "A" ? "is new" : changeText(c)} upstream: ${RECHECK}; FORK.md "Translation" says how the fork answers rules it cannot follow.`,
      ),
    ...[...new Set([...before.keys(), ...after.keys()])]
      .filter(
        (key) =>
          before.get(key) !== after.get(key) && !unfound.some((tool) => key.endsWith(` ${tool}`)),
      )
      .map(
        (key) =>
          `${key} ${before.get(key) ?? "absent"} → ${after.get(key) ?? "absent"} upstream: new lint rules possible; ${RECHECK}.`,
      ),
    ...unfound.map(
      (tool) =>
        `${tool}'s version at the target is not in package.json or pnpm-workspace.yaml's \`catalog:\` as this reads them, so a change to it is not listed: read where upstream pins it now; ${RECHECK}.`,
    ),
  ];
};

/** Whether an upstream commit may be upstream's own version of a fork feature: its subject and a path agree. */
export const overlapsFork = (
  subject: string,
  paths: ReadonlyArray<string>,
  forkPaths: ReadonlySet<string>,
): boolean =>
  FEATURE_WORDS.test(subject.replace(ISSUE_TRACKER, "")) &&
  paths.some((path) => forkPaths.has(path) || FEATURE_PATH.test(path.replace(ISSUE_TRACKER, "")));

/** One tag's release notes in full, or the gh error as a flag: a failed call is not a missing release. */
export const releaseNote = (
  tag: string,
  result: { readonly status: number | null; readonly stdout: string; readonly stderr: string },
): { say: string } | { flag: string } => {
  if (result.status !== 0)
    return { flag: `\`gh release view ${tag}\` failed: ${result.stderr.trim() || "no output"}` };
  const body = result.stdout.trim();
  return { say: `### ${tag}\n\n${body === "" ? "(no notes)" : body}` };
};

/** Test files `vp test list --filesOnly` did not place in any project: `vp test run` skips them silently. */
export const undiscovered = (listing: string, wanted: ReadonlyArray<string>): string[] => {
  const found = new Set([...listing.matchAll(/^\[.+\] (\S+)$/gm)].map((m) => m[1]));
  return wanted.filter((path) => !found.has(path));
};
/**
 * What the rebase lost: each item before it that is neither after it nor named as dropped, counted
 * as a multiset, so two fork commits with one subject need two matches.
 */
export const lost = (
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
  named: ReadonlyArray<string>,
): string[] => {
  const left = [...after, ...named];
  return before.filter((item) => {
    const at = left.indexOf(item);
    if (at >= 0) left.splice(at, 1);
    return at < 0;
  });
};

/**
 * From `git range-diff --no-color` output: each fork commit whose patch the rebase changed (`!`),
 * with the files whose hunks differ; each unpaired one, only in the kept head (`<`) or new in HEAD
 * (`>`), with its files from `numstat(<its sha>)`, as range-diff prints no body for either.
 */
type Patch = { readonly head: string; readonly files: Map<string, number> };
export const changedPatches = (
  rangeDiff: string,
  numstat: (sha: string) => string,
  /** The fork commits in the kept head: each names one line (`=`, `!`, `<`) in the form read. */
  commits: number,
): {
  readonly patches: string[];
  /** Why the list cannot be trusted (fewer commit lines read than commits); null when it can. */
  readonly refusal: string | null;
} => {
  const out: Patch[] = [];
  let kept = 0;
  let current: Patch | null = null;
  let file = "";
  for (const line of lines(rangeDiff)) {
    // `<old n>:  <sha> <mark> <new n>:  <sha> <subject>`, a missing side written `-:  -------`.
    const [, oldSha = "", mark = "", newSha = ""] =
      /^\s*[\d-]+:\s+(\S+) ([=!<>])\s+[\d-]+:\s+(\S+) /.exec(line) ?? [];
    if (mark !== "") {
      if (mark !== ">") kept += 1;
      current = mark === "!" ? { head: line.trim(), files: new Map() } : null;
      if (current !== null) out.push(current);
      else if (mark !== "=") {
        const files = lines(numstat(mark === "<" ? oldSha : newSha).trimEnd()).map((stat) => {
          const [plus, minus, path] = stat.split("\t");
          return `${path} +${plus} −${minus}`;
        });
        out.push({
          head: `${line.trim()}: ${mark === "<" ? "no match in HEAD" : "new in HEAD"}, read it (${files.join(", ")})`,
          files: new Map(),
        });
      }
      file = "";
    } else if (current !== null && line.startsWith("    ")) {
      const body = line.slice(4);
      // A file's section opens ` ## <path> ##` (behind the outer diff's mark); a hunk `@@ <path>`.
      const header = /^(?:[-+ ] ## (.+) ##|@@ ([^:]+?)(?::.*)?)$/.exec(body);
      if (header !== null) file = header[1] ?? header[2] ?? "";
      // A changed line carries the outer mark and an inner one; a bare `-`/`+` is a blank separator.
      else if (/^[-+][-+ @]/.test(body) && file !== "")
        current.files.set(file, (current.files.get(file) ?? 0) + 1);
    }
  }
  return {
    patches: out.map(
      ({ head, files }) =>
        `${head}${files.size === 0 ? "" : ` (${[...files].map(([path, n]) => `${path} ±${n}`).join(", ")})`}`,
    ),
    refusal:
      kept < commits
        ? `read ${kept} commit lines for ${commits} fork commits: its output is not in the form this reads, so a changed or dropped patch could go unlisted; read it by hand, and update changedPatches`
        : null,
  };
};

/** Upstream's changes under the migrations folder no manifest line names: edited migrations, helpers, unwired files. */
export const otherMigrationChanges = (
  upstream: ReadonlyArray<Change>,
  base: MigrationManifest,
  target: MigrationManifest,
): Change[] => {
  const named = new Set(
    [...target.entries]
      .filter(([id, entry]) => !same(entry, base.entries.get(id)))
      .map(([, entry]) => migrationPath(entry)),
  );
  return upstream.filter(
    (c) =>
      (c.to ?? c.path).startsWith(MIGRATIONS_DIR) && !isTest(c.path) && !named.has(c.to ?? c.path),
  );
};

export const plan = (args: Args): string => {
  const head = args.head;
  const base = args.base ?? baseTagOf(head);
  if (!NIGHTLY_TAG.test(base) || gitTry("merge-base", "--is-ancestor", base, head) === null)
    fail(`--base ${base} is not an upstream Nightly tag below ${head}`);
  const installed = args.nightly === null ? installedNightlyTag() : args.nightly;
  const nightly = installed === "none" ? null : installed;
  const target =
    args.target ??
    nightly ??
    fail("no installed Nightly to target; pass --target <tag> (FORK.md step 1)");
  if (args.target === null)
    console.error(`upstream-sync: targeting the installed Nightly, ${target}`);
  const targetSha = requireTarget(target, base);

  const report: string[] = [];
  let items = 0;
  const say = (line = "") => report.push(line);
  // A thing to read or do; everything else is context for it.
  const item = (line: string) => {
    items += 1;
    say(`- [ ] ${line}`);
  };

  const commits = lines(gitLog("--format=%h %s", `${base}..${target}`));
  say(`# Upstream sync plan: ${base} → ${target}`);
  say();
  say(
    `Fork head: \`${git("rev-parse", "--short", head)}\` on ${base}, ${lines(git("rev-list", `${base}..${head}`)).length} fork commits to replay. Upstream commits in range: ${commits.length}. Every \`[ ]\` line is something to read or do; this report judges nothing safe. What verify checks after the rebase is FORK.md step 5.`,
  );

  // Node: FORK.md step 2 runs git and vp under the target's engines.node.
  say("\n## Node");
  const nodeBase = nodeVersionAt(base);
  const nodeTarget = nodeVersionAt(target);
  const exactTarget = exactVersion(nodeTarget);
  if (exactTarget === null)
    item(
      `engines.node at ${target} is \`${nodeTarget}\`, not one version: rebase and verify compare exact versions only and refuse it; pick a Node that satisfies it and run FORK.md's steps by hand.`,
    );
  else if (nodeBase === nodeTarget) say(`- unchanged: ${nodeTarget}`);
  else
    item(
      `engines.node ${nodeBase} → ${nodeTarget}: \`mise install node@${nodeTarget}\`, then run git and vp through \`mise exec node@${nodeTarget} --\`.`,
    );

  const forkChanges = parseNameStatus(git("diff", "--name-status", "-M", base, head));
  const upstreamChanges = parseNameStatus(git("diff", "--name-status", "-M", base, target));
  const upstreamByPath = new Map(upstreamChanges.map((change) => [change.path, change]));
  const forkOwned = new Set(
    forkChanges
      .filter((change) => change.status === "A" || change.status === "R")
      .map((change) => change.to ?? change.path),
  );
  const forkEdits = diffBodies(git(...WIDE, "--diff-filter=MT", base, head));

  // Migrations: read every one the target adds or changes (FORK.md rules 1 to 3).
  say("\n## Migrations");
  const manifestBase = manifestAt(base);
  const manifestTarget = manifestAt(target);
  say(
    `- upstream migration head: ${headOf(manifestBase) ?? "unknown"} → ${headOf(manifestTarget) ?? "unknown"}`,
  );
  for (const [ref, manifest] of [
    [base, manifestBase],
    [target, manifestTarget],
  ] as const)
    if (manifest.unreadable.length > 0)
      item(
        `${ref}'s \`${MIGRATIONS_FILE}\` has manifest lines this tool cannot read (${manifest.unreadable.join("; ")}): read the manifest by hand; the lists below may miss entries.`,
      );
  const entries = manifestChanges(manifestBase, manifestTarget);
  for (const entry of entries.added) item(`new migration ${entry}: read it.`);
  for (const entry of entries.removed)
    item(`upstream's manifest no longer has migration ${entry}: read why.`);
  for (const entry of entries.changed)
    item(`upstream's manifest changed migration ${entry}: read why.`);
  for (const change of otherMigrationChanges(upstreamChanges, manifestBase, manifestTarget))
    item(`\`${change.path}\` ${changeText(change)} upstream: read it.`);

  say("\n## Upstream queries on the fork's tables");
  const known = new Set<string>();
  for (const ref of [head, target]) {
    const hits = grepHits(
      gitRun(
        "grep",
        "-l",
        "-i",
        "-E",
        "create +(temp(orary)? +)?(virtual +)?table|rename +to",
        ref,
        "--",
        "*.ts",
        ":!.repos",
      ),
    );
    if (typeof hits === "string")
      fail(`${hits} (listing the tables production code creates at ${ref})`);
    for (const hit of hits) {
      const path = hit.slice(ref.length + 1);
      if (isProduction(path))
        for (const name of createdTables(repo.read(ref, path) ?? "")) known.add(name);
    }
  }
  const forkSql = [
    ...[...forkOwned].filter(isProduction).map((path) => repo.read(head, path) ?? ""),
    ...[...forkEdits].filter(([path]) => isProduction(path)).map(([, body]) => body.join("\n")),
  ].join("\n");
  const found = forkTablesIn(forkSql, known);
  const forkTables = typeof found === "string" ? new Set<string>() : found;
  if (typeof found === "string") item(`${found}.`);
  else
    say(
      `- the fork's tables: ${forkTables.size === 0 ? "none" : [...forkTables].toSorted().join(", ")} (\`forkTablesIn\` says how they are found)`,
    );
  const upstreamEdits = diffBodies(
    git(...WIDE, "--diff-filter=AMD", base, target, "--", "*.ts", "*.tsx", ":!.repos"),
  );
  let queried = 0;
  for (const [path, body] of upstreamEdits) {
    if (!isProduction(path) || path.startsWith(MIGRATIONS_DIR) || path === MIGRATIONS_FILE)
      continue;
    const tables = [...tablesIn(body.join("\n"), forkTables)].toSorted();
    if (tables.length === 0) continue;
    queried += 1;
    item(
      `\`${path}\`: upstream's change sits in statements that name ${tables.join(", ")}; read it beside the fork's queries on them.`,
    );
  }
  if (queried === 0) say("- no upstream change outside migrations names one of them");

  say("\n## ~/.t3's migration ledger");
  const live = liveDbOf(repo.read(target, CONFIG_FILE) ?? "");
  const dbFile = live.file ?? LIVE_DB_FILE;
  if (live.dirs === null || !live.dirs.includes(LIVE_DB_DIR))
    item(
      `\`${CONFIG_FILE}\` at ${target} ${live.dirs === null ? "no longer names its state folder as `stateDir = join(…)`" : `joins its state folder from ${live.dirs.map((dir) => `"${dir}"`).join(", ")}, not "${LIVE_DB_DIR}"`}: read where the target keeps ~/.t3's database; this reads \`~/.t3/${LIVE_DB_DIR}\`.`,
    );
  if (live.file !== LIVE_DB_FILE)
    item(
      `\`${CONFIG_FILE}\` at ${target} ${live.file === null ? 'no longer names its database as `dbPath = join(stateDir, "…")`' : `opens \`${live.file}\`, not \`${LIVE_DB_FILE}\``}: read how the target finds ~/.t3's database; this reads \`${dbFile}\`.`,
    );
  const dbPath = args.db ?? NodePath.join(NodeOS.homedir(), ".t3", LIVE_DB_DIR, dbFile);
  const ledger = ledgerRows(dbPath);
  const builds = [
    [`the target ${target}`, manifestTarget],
    [`the base ${base}`, manifestBase],
  ] as const;
  let nightlyManifest: MigrationManifest | null = null;
  if (installed === "none") say("- the installed Nightly: none (`--nightly none`)");
  else if (nightly === null)
    item(
      `no Nightly app in /Applications or ~/Applications (this reads macOS app bundles only): pass --nightly <tag> with the build this machine falls back to, or install the Nightly of ${target} (FORK.md step 1).`,
    );
  else if (!NIGHTLY_TAG.test(nightly) || !isFetchedTag(nightly))
    item(
      `the installed Nightly ${nightly} is not a fetched Nightly tag, so its manifest is unread: git fetch upstream tag ${nightly} --no-tags, then rerun.`,
    );
  else {
    nightlyManifest = manifestAt(nightly);
    if (commitOf(nightly) !== targetSha)
      item(`the target ${target} is not the installed Nightly ${nightly} (FORK.md step 1).`);
  }
  if (typeof ledger === "string")
    item(
      `\`${dbPath}\` is unreadable (${ledger}): read its \`effect_sql_migrations\` with \`sqlite3 -readonly\` before running any build on it.`,
    );
  else {
    say(
      `- \`${dbPath}\` has run upstream migrations to ${Math.max(...ledger.map((row) => row.id))} (read read-only)`,
    );
    for (const [label, manifest] of builds) {
      const facts = ledgerFacts(manifest, ledger);
      if (facts.length === 0)
        say(
          `- ${label}: every recorded id is in its manifest under the same name (head ${headOf(manifest) ?? "unknown"})`,
        );
      else
        item(
          `${label}: ${facts.join("; ")}. Read what its \`${MIGRATIONS_FILE}\` does at startup with these (FORK.md step 1).`,
        );
    }
    // The Nightly falls back to the database the fork at the target leaves, not today's.
    if (nightlyManifest !== null) {
      const after = ledgerFacts(nightlyManifest, ledgerAfter(ledger, manifestTarget));
      if (after.length > 0)
        item(
          `once the fork runs ${target}'s migrations, the installed Nightly ${nightly}: ${after.join("; ")}. Read what its \`${MIGRATIONS_FILE}\` does at startup with these before falling back to it (FORK.md step 1).`,
        );
      else
        say(
          `- once the fork runs ${target}'s migrations, the installed Nightly ${nightly} knows every recorded id under the same name`,
        );
    }
  }

  say("\n## Upstream files the fork changes");
  const fates = upstreamFileFates(forkChanges, upstreamChanges);
  const forkDoc = repo.read(head, "FORK.md") ?? "";
  say(
    `- the fork changes ${forkChanges.filter((c) => c.status !== "A").length} upstream files; upstream also changed ${fates.hot.length} of them in this range`,
  );
  for (const line of fates.flags) item(line);
  for (const path of fates.hot) {
    const [plus = "?", minus = "?"] = git(
      "diff",
      "--numstat",
      "--no-renames",
      base,
      target,
      "--",
      path,
    ).split("\t");
    const at = seamLines(forkDoc, path);
    item(
      `\`${path}\` (+${plus} −${minus} upstream): ${at.length > 0 ? `re-apply its seam, FORK.md:${at.join(",")}` : "FORK.md does not name this path: keep both sides, then add its seam to FORK.md"}.`,
    );
  }

  say("\n## Upstream files fork code imports");
  const isTool = (path: string) => path.startsWith("scripts/fork/");
  const importers: Array<readonly [string, Import]> = [
    ...[...forkOwned]
      .filter((path) => /\.tsx?$/.test(path) && !isTool(path))
      .flatMap((path) => importsOf(repo.read(head, path) ?? "").map((imp) => [path, imp] as const)),
    ...[...forkEdits]
      .filter(([path]) => /\.tsx?$/.test(path) && !isTool(path))
      .flatMap(([path, body]) =>
        importsOf(repo.read(head, path) ?? "")
          .filter((imp) => touches(imp, added(body)))
          .map((imp) => [path, imp] as const),
      ),
  ];
  // One line per upstream-changed file, naming every fork file that imports it: each change is read once.
  const importedBy = new Map<string, Set<string>>();
  const unresolved = new Set<string>();
  for (const [file, imp] of importers) {
    const resolved = imp.spec === null ? "unresolved" : resolveSpec(repo, head, file, imp.spec);
    if (resolved === "unresolved")
      unresolved.add(
        imp.spec === null
          ? `\`${file}\` has a computed \`import()\`: read what it loads.`
          : `\`${file}\` imports \`${imp.spec}\`, which names no file at ${head}: read what it loads.`,
      );
    else if (resolved !== "package" && !forkOwned.has(resolved.path))
      importedBy.set(resolved.path, (importedBy.get(resolved.path) ?? new Set()).add(file));
  }
  let imported = 0;
  for (const [path, files] of [...importedBy].toSorted(([a], [b]) => a.localeCompare(b))) {
    const change = upstreamByPath.get(path);
    if (change === undefined) continue;
    imported += 1;
    item(
      `\`${path}\` ${changeText(change)} upstream; fork code imports it in ${[...files].map((file) => `\`${file}\``).join(", ")}: read upstream's change against what those files use from it.`,
    );
  }
  for (const line of unresolved) item(line);
  say(
    `- ${imported} upstream-changed file(s) imported by the fork's own files, or by upstream files where the fork's added lines use an import's name or specifier; packages are left to the typecheck, and a barrel (\`export * from\`) is listed only when the barrel itself changed`,
  );

  // Tooling: rules that fail fork code the old ones let through (the i18n rule arrived this way).
  say("\n## Lint rules and tooling");
  const lintAt = (ref: string): LintInputs => ({
    pkg: readJson(repo, ref, "package.json"),
    workspace: repo.read(ref, "pnpm-workspace.yaml") ?? "",
  });
  const lint = lintFlags(upstreamChanges, lintAt(base), lintAt(target));
  if (lint.length === 0)
    say(
      `- no file under ${LINT_PLUGIN_DIR} and no version of ${LINT_TOOLS.join(" or ")} changed upstream`,
    );
  for (const line of lint) item(line);

  // Native versions of fork features (FORK.md step 4: stop and ask the owner).
  say("\n## Upstream commits that may overlap fork features");
  const forkPaths = new Set(forkChanges.map((change) => change.to ?? change.path));
  let overlaps = 0;
  for (const entry of gitLog("--format=%x00%h %s", "--name-only", `${base}..${target}`)
    .split("\0")
    .slice(1)) {
    const [line = "", ...paths] = lines(entry.trim());
    if (!overlapsFork(line.slice(line.indexOf(" ") + 1), paths, forkPaths)) continue;
    overlaps += 1;
    item(
      `\`${line}\`: read it; if upstream shipped its own version of a fork feature, ask the owner before rebasing.`,
    );
  }
  if (overlaps === 0) say("- none whose subject and paths both name a fork feature");

  if (args.notes) {
    say("\n## Release notes");
    const tags = lines(git("tag", "-l", "v*-nightly.*", "--sort=creatordate")).filter(
      (tag) => buildNumber(tag) > buildNumber(base) && buildNumber(tag) <= buildNumber(target),
    );
    for (const tag of tags) {
      const note = releaseNote(
        tag,
        NodeChildProcess.spawnSync(
          "gh",
          ["release", "view", tag, "-R", UPSTREAM_REPO, "--json", "body", "-q", ".body"],
          { encoding: "utf8" },
        ),
      );
      if ("flag" in note) item(note.flag);
      else say(note.say);
    }
  }

  say("\n## Next");
  say(
    `- Now, in the background: \`suite\` in a worktree at ${target} (FORK.md step 5), so its baseline is kept by the time verify runs.`,
  );
  say(
    `- \`node scripts/fork/upstream-sync.ts rebase --target ${target}\` (under node ${exactTarget ?? nodeTarget}), resolve conflicts by FORK.md step 4, then \`… verify --target ${target}\`, which reads that baseline.`,
  );
  say(`\n${items} item(s) to read or do.`);
  return report.join("\n");
};

const requireNode = (target: string): void => {
  const engines = nodeVersionAt(target);
  const wanted =
    exactVersion(engines) ??
    fail(
      `${target}'s engines.node is \`${engines}\`, not one version; this tool compares exact versions only: run FORK.md's steps by hand under a Node that satisfies it`,
    );
  if (process.version.replace(/^v/, "") !== wanted)
    fail(
      `run this under the target's Node: mise install node@${wanted} && mise exec node@${wanted} -- node ${import.meta.filename} …`,
    );
};
// Children find this validated Node first, then the checkout's vp (mise's shim has no version set);
// verify's run of this script's own test makes its 4864 proof fail rather than skip without its refs.
// The T3 service's T3CODE_PORT and T3CODE_HOST hang AppRoot browser tests (FORK.md, "Known noise").
const nodeEnv = (): NodeJS.ProcessEnv => {
  const { T3CODE_PORT: _port, T3CODE_HOST: _host, ...env } = process.env;
  return {
    ...env,
    PATH: [
      NodePath.dirname(process.execPath),
      NodePath.join(ROOT_DIR, "node_modules", ".bin"),
      env.PATH ?? "",
    ].join(NodePath.delimiter),
    UPSTREAM_SYNC_PROOF: "required",
  };
};
const spawnIn = (dir: string, command: string, args: string[]): number | null =>
  NodeChildProcess.spawnSync(command, args, { cwd: dir, stdio: "inherit", env: nodeEnv() }).status;
/** The checkout's vp, once it starts under this Node; a missing or broken one refuses before any step. */
const requireVp = (root: string): string => {
  const vp = NodePath.join(root, "node_modules", ".bin", "vp");
  const probe = NodeChildProcess.spawnSync(vp, ["--version"], {
    cwd: root,
    encoding: "utf8",
    env: nodeEnv(),
  });
  return probe.status === 0
    ? vp
    : fail(
        `${vp} does not start (${probe.error?.message ?? (probe.stderr.trim() || `exit ${probe.status}`)}); run vp i in ${root} first`,
      );
};
/** The packages the full suite runs at `ref`: verify and suite refuse alike, before running anything, when there are none. */
const suitePackages = (ref: string): string[] => {
  const packages = testPackages(repo, ref);
  return packages.length > 0
    ? packages
    : fail(
        `found no workspace package with a test script (pnpm-workspace.yaml's packages at ${ref})`,
      );
};
const rebasing = (): boolean =>
  ["rebase-merge", "rebase-apply"].some((name) =>
    NodeFS.existsSync(git("rev-parse", "--path-format=absolute", "--git-path", name)),
  );
// status.showUntrackedFiles=no would hide untracked files from a bare `git status --porcelain`.
const STATUS = ["status", "--porcelain", "--untracked-files=normal"];
const isDirty = (): boolean => git(...STATUS) !== "";

export interface RebaseState {
  readonly rebasing: boolean;
  readonly dirty: boolean;
  readonly branch: string;
  readonly keep: string;
  /** The backup branch's commit, or null when it does not exist yet. */
  readonly keepSha: string | null;
  readonly headSha: string;
  /** Whether origin/fork/main, just fetched, is in local fork/main's history. */
  readonly hasOrigin: boolean;
  /** Whether `<base>..fork/main` holds a merge commit. */
  readonly merges: boolean;
}
/** Why `rebase` must not start; null when it may. A backup equal to fork/main is an aborted run: rerun. */
export const rebaseRefusal = (state: RebaseState): string | null => {
  if (state.rebasing)
    return "a rebase is in progress: finish it (git rebase --continue) or abort it (git rebase --abort), then rerun";
  if (state.dirty) return "the working tree has changes; commit or remove them first";
  if (state.branch !== "fork/main") return "check out fork/main first";
  if (!state.hasOrigin)
    return "origin/fork/main has commits local fork/main lacks (pushed from another machine): pull them in first, or the rebase drops them";
  if (state.merges)
    return "fork/main has merge commits; the rebase would flatten them and lose what only a merge holds: flatten them (git rebase <base> fork/main), push fork/main with --force-with-lease, then rerun";
  if (state.keepSha !== null && state.keepSha !== state.headSha)
    return `${state.keep} exists and fork/main has moved since: a rebase onto this target already ran. Verify it, or delete ${state.keep} if it is stale`;
  return null;
};

// The origin/fork/main commit rebase checked before rewriting: the final push leases against it, so a
// push from another machine since, even one a background fetch brought in, makes the push fail.
const LEASE = "upstream-sync-lease";
// An explicit refspec: `git fetch origin fork/main` updates origin/fork/main only when the remote's
// configured fetch refspec covers it, and a narrowed one leaves it stale.
const FETCH_ORIGIN = ["fetch", "origin", "+refs/heads/fork/main:refs/remotes/origin/fork/main"];
const leaseFile = (): string => git("rev-parse", "--path-format=absolute", "--git-path", LEASE);
const pushCommand = (checked: string): string =>
  `git push --force-with-lease=refs/heads/fork/main:${checked} origin fork/main`;

/** What to say when `git rebase` exits non-zero: a stop, on conflicts or not, or a failure before it began. */
export const rebaseStopped = (state: {
  readonly rebasing: boolean;
  readonly conflicted: ReadonlyArray<string>;
  readonly before: string;
  readonly after: string;
  readonly keep: string;
}): string[] =>
  state.rebasing
    ? state.conflicted.length === 0
      ? [
          "The rebase stopped without a conflict: read git's message above (an empty commit, a failed hook) and act on it, `git rebase --continue`, then run verify.",
        ]
      : [
          `The rebase stopped on ${state.conflicted.length} conflicted file(s):`,
          ...state.conflicted.map((path) => `  ${path}`),
          "Re-apply the fork's intent, not the old hunk (FORK.md step 4), `git rebase --continue`, then run verify.",
        ]
    : state.before === state.after
      ? [
          `git rebase failed before it began (no rebase is in progress): nothing was rewritten, fork/main is still ${state.before} and ${state.keep} holds it on origin. Fix what git printed above, then rerun.`,
        ]
      : [
          `git rebase failed and no rebase is in progress, yet fork/main moved from ${state.before} to ${state.after}: compare it with ${state.keep} (git range-diff ${state.keep}...fork/main) or reset it there (git reset --hard ${state.keep}).`,
        ];

const rebase = (args: Args): void => {
  const target = args.target ?? fail("rebase needs --target <tag>; read plan's report first");
  const base = baseTagOf("fork/main");
  const targetSha = requireTarget(target, base);
  requireNode(target);
  const keep = `fork/main-pre-${buildNumber(target)}`;
  if (spawnIn(ROOT_DIR, "git", FETCH_ORIGIN) !== 0)
    fail("could not fetch origin's fork/main, so commits pushed from another machine are unknown");
  const checked =
    gitTry("rev-parse", "--verify", "--quiet", "refs/remotes/origin/fork/main^{commit}") ??
    fail("origin has no fork/main to lease the final push against");
  const headSha = git("rev-parse", "fork/main");
  const refusal = rebaseRefusal({
    rebasing: rebasing(),
    dirty: isDirty(),
    branch: gitTry("symbolic-ref", "--short", "HEAD") ?? "(detached)",
    keep,
    keepSha: gitTry("rev-parse", "--verify", "--quiet", `refs/heads/${keep}`),
    headSha,
    hasOrigin: gitTry("merge-base", "--is-ancestor", checked, "fork/main") !== null,
    merges: git("rev-list", "--merges", `${base}..fork/main`) !== "",
  });
  if (refusal !== null) fail(refusal);
  NodeFS.writeFileSync(leaseFile(), `${checked}\n`);
  console.log(
    `Checked origin/fork/main at ${checked}. Once verify passes, push with: ${pushCommand(checked)}`,
  );
  if (gitTry("rev-parse", "--verify", "--quiet", `refs/heads/${keep}`) === null)
    git("branch", keep, "fork/main");
  // The backup goes up before anything is rewritten: a rebase that goes wrong on this machine
  // must not take the only copy of the old head with it.
  if (spawnIn(ROOT_DIR, "git", ["push", "origin", keep]) !== 0)
    fail(`could not push ${keep}; nothing was rebased. Push it, then rerun`);
  console.log(`Kept and pushed the old head as ${keep}.`);
  // `base` is the fork's merge-base with upstream/main (FORK.md step 2): the Nightly tags sit on
  // main. Commits, not names, go to git; --no-update-refs keeps rebase.updateRefs from moving `keep`.
  const status = spawnIn(ROOT_DIR, "git", [
    "rebase",
    "--no-update-refs",
    "--onto",
    targetSha,
    git("rev-parse", `${base}^{commit}`),
    "fork/main",
  ]);
  if (status !== 0) {
    const inProgress = rebasing();
    console.error(
      `\n${rebaseStopped({
        rebasing: inProgress,
        conflicted: inProgress ? lines(git("diff", "--name-only", "--diff-filter=U")) : [],
        before: headSha,
        after: git("rev-parse", "fork/main"),
        keep,
      }).join("\n")}`,
    );
    process.exit(1);
  }
  console.log(
    `Rebased onto ${target}. Next: vp i, then node scripts/fork/upstream-sync.ts verify --target ${target}, once suite has kept the baseline at ${target} (FORK.md step 5)`,
  );
};

export interface VerifyState {
  readonly rebasing: boolean;
  /** Tracked changes or untracked files git does not ignore: check:changed reads the working tree. */
  readonly dirty: boolean;
  readonly branch: string;
  /** The Nightly tag below HEAD, and its commit; the target's commit. */
  readonly onto: string;
  readonly ontoCommit: string;
  readonly targetCommit: string;
}
/** Why `verify` must not run; null when it may. It checks the rebased fork/main, whole and committed. */
export const verifyRefusal = (state: VerifyState): string | null => {
  if (state.rebasing)
    return "a rebase is in progress: finish it (git rebase --continue) before verifying";
  if (state.dirty)
    return "the working tree has changes or untracked files: check:changed would check them, not the commits; commit or remove them first";
  if (state.branch !== "fork/main")
    return `HEAD is ${state.branch}, not fork/main: verify checks the rebased fork/main; check it out`;
  if (state.ontoCommit !== state.targetCommit)
    return `HEAD sits on ${state.onto}, not on the target's commit: rebase onto the target first`;
  return null;
};
/** An advisory, never a refusal: a newer install record proves nothing, and `vp i` is the step anyway. */
const lockAdvice = (lock: number | undefined, installed: number | undefined): string | null =>
  lock !== undefined && (installed === undefined || installed < lock)
    ? "node_modules/.pnpm/lock.yaml is older than pnpm-lock.yaml (or missing): run vp i if you have not since the rebase."
    : null;
const verify = async (args: Args): Promise<void> => {
  const target = args.target ?? fail("verify needs --target <tag>, the tag rebase moved onto");
  // The fork's tests are the test files it adds or changes. A test the rebase dropped is in the
  // kept head's list and not HEAD's, so the expected list comes from the kept head.
  const keep = `fork/main-pre-${buildNumber(target)}`;
  if (gitTry("rev-parse", "--verify", "--quiet", `refs/heads/${keep}`) === null)
    fail(
      `${keep} is missing: verify checks a rebase onto ${target} against the head rebase kept there; is ${target} the tag rebase moved onto?`,
    );
  const keptBase = baseTagOf(keep);
  const targetSha = requireTarget(target, keptBase);
  const onto = baseTagOf("HEAD");
  const refusal = verifyRefusal({
    rebasing: rebasing(),
    dirty: isDirty(),
    branch: gitTry("symbolic-ref", "--short", "HEAD") ?? "(detached)",
    onto,
    ontoCommit: git("rev-parse", `refs/tags/${onto}^{commit}`),
    targetCommit: targetSha,
  });
  if (refusal !== null) fail(refusal);
  requireNode(target);
  // `--baseline <file>` when given, else the one `suite` kept for the target, if any.
  const kept = keptBaseline(targetSha);
  const writing = args.baseline === null && !NodeFS.existsSync(kept) ? writingRefusal(kept) : null;
  if (writing !== null) fail(writing);
  const baselineFile = args.baseline ?? (NodeFS.existsSync(kept) ? kept : null);
  if (baselineFile === null) console.log(`No kept baseline at ${kept}.`);
  const named = `${args.baseline === null ? "the kept baseline" : "--baseline"} ${baselineFile}`;
  const recorded =
    baselineFile === null
      ? null
      : baselineAt(
          NodeFS.existsSync(baselineFile)
            ? NodeFS.readFileSync(baselineFile, "utf8")
            : fail(`${named} does not exist`),
          targetSha,
        );
  const baseline = typeof recorded === "string" ? fail(`${named} ${recorded}`) : recorded;
  if (baselineFile !== null) console.log(`Full-suite baseline: ${baselineFile}`);
  // A commit a conflict resolution skipped (`git rebase --skip`) leaves no failing test behind.
  const subjects = (range: string) => lines(gitLog("--no-merges", "--format=%s", range));
  // range-diff, like this, leaves merges out.
  const forkCommits = subjects(`${keptBase}..${keep}`);
  const lostCommits = lost(forkCommits, subjects(`${targetSha}..HEAD`), args.droppedCommits);
  if (lostCommits.length > 0)
    fail(
      `fork commits in ${keep} whose subject HEAD no longer has: ${lostCommits.map((s) => `"${s}"`).join(", ")}. Name each one the rebase meant to drop or reword with --dropped-commit <subject>, then rerun`,
    );
  // A subject that survived says nothing of its hunks: one dropped from a file no test reads
  // (index.css, agentContextBudget.json, AGENTS.md) passes every step below.
  const rangeArgs = ["range-diff", "--no-color", `${keptBase}..${keep}`, `${targetSha}..HEAD`];
  const range = `git ${rangeArgs.join(" ")}`;
  const { patches, refusal: unread } = changedPatches(
    git(...rangeArgs),
    (sha) => git("show", NO_SIGNATURE, "--format=", "--numstat", "--no-renames", sha),
    forkCommits.length,
  );
  if (unread !== null) fail(`\`${range}\` (${keep}): ${unread}`);
  console.log(
    patches.length === 0
      ? `Every fork commit's patch is unchanged by the rebase, and HEAD adds none (${range}).`
      : `Fork commits whose patch the rebase changed, dropped or added: read each in \`${range}\`:\n${patches.map((line) => `- [ ] ${line}`).join("\n")}`,
  );
  const mtime = (path: string) =>
    NodeFS.statSync(NodePath.join(ROOT_DIR, path), { throwIfNoEntry: false })?.mtimeMs;
  const advice = lockAdvice(mtime("pnpm-lock.yaml"), mtime("node_modules/.pnpm/lock.yaml"));
  if (advice !== null) console.log(advice);
  const testsBetween = (from: string, to: string) =>
    lines(git("diff", "--name-only", "--no-renames", "--diff-filter=AM", from, to)).filter(isTest);
  const tests = testsBetween(targetSha, "HEAD");
  // The fork's own changes, before the rebase: on HEAD, a conflict resolution that dropped an
  // upstream test would excuse its file.
  const forkChanged = new Set(lines(git("diff", "--name-only", "--no-renames", keptBase, keep)));
  const lostTests = lost(testsBetween(keptBase, keep), tests, args.dropped);
  if (lostTests.length > 0)
    fail(
      `fork test files in ${keep} that HEAD no longer has: ${lostTests.join(", ")}. Name each one the rebase meant to drop or rename with --dropped <path>, then rerun`,
    );
  if (tests.length === 0) fail(`no fork test files between ${target} and HEAD`);
  const vp = requireVp(ROOT_DIR);
  const listing = NodeChildProcess.spawnSync(vp, ["test", "list", "--filesOnly", ...tests], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    env: nodeEnv(),
  });
  if (listing.status !== 0)
    fail(
      `vp test list failed (${listing.error?.message ?? listing.stderr.trim()}); run vp i first`,
    );
  const missing = undiscovered(listing.stdout, tests);
  if (missing.length > 0)
    fail(
      `no Vite test project includes these, so vp test run would skip them: ${missing.join(", ")}`,
    );
  const packages = suitePackages("HEAD");
  const steps: ReadonlyArray<readonly [string, () => boolean]> = [
    ["check:changed", () => spawnIn(ROOT_DIR, vp, ["run", "check:changed", target]) === 0],
    [
      `${tests.length} fork test files`,
      () => spawnIn(ROOT_DIR, vp, ["test", "run", ...tests]) === 0,
    ],
  ];
  const failed = steps
    .filter(([name, step]) => {
      console.log(`\n== ${name}`);
      return !step();
    })
    .map(([name]) => name);
  // Why the full suite runs, and why its failures are read rather than fail verify: FORK.md step 5.
  console.log(`\n== the full test suite (${packages.length} packages' test scripts)`);
  const run = await suiteRun(ROOT_DIR, vp, packages);
  const lease = NodeFS.existsSync(leaseFile())
    ? NodeFS.readFileSync(leaseFile(), "utf8").trim()
    : null;
  console.log("\n== Still owed by a person (FORK.md steps 6 and 7):");
  if (patches.length > 0)
    console.log(`- Read the ${patches.length} fork commit(s) listed above from git range-diff.`);
  if (failed.length > 0)
    console.log(
      `- Fix each failed step (${failed.join(", ")}); a failure FORK.md "Known noise" lists also fails upstream, and any other blocks the push.`,
    );
  for (const line of suiteOwed(run, baseline, target, forkChanged)) console.log(line);
  console.log(`- FORK.md: update every note the rebase changed, and add the seams you re-applied.`);
  console.log("- Live check on an isolated .t3 (step 6), after migrate-dev-db.");
  console.log(
    `- Build with scripts/fork/build.sh (step 7); only after all of this passes, push: ${
      lease === null
        ? `no lease recorded at ${leaseFile()} (rebase writes it): git fetch origin fork/main, confirm origin/fork/main is in ${keep}'s history, then ${pushCommand("<that origin/fork/main sha>")}`
        : pushCommand(lease)
    }`,
  );
  if (failed.length > 0) process.exit(1);
};

/** One package's test script; its output is held until it ends, so runs side by side do not interleave. */
const runPackage = (
  root: string,
  vp: string,
  name: string,
  report: string,
  children: Set<NodeChildProcess.ChildProcess>,
) =>
  new Promise<number | null>((resolve) => {
    const child = NodeChildProcess.spawn(
      vp,
      [
        "run",
        "--filter",
        name,
        "test",
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${report}`,
      ],
      { cwd: root, env: nodeEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
    children.add(child);
    // Its output waits for its end, so this line is what shows a package that hangs.
    process.stdout.write(`== ${name} started\n`);
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    // A child that never started emits `error` and may not emit `close`: null, as spawnSync's status.
    let ended = false;
    const end = (exit: number | null, note = "") => {
      if (ended) return;
      ended = true;
      children.delete(child);
      process.stdout.write(`\n== ${name}: its test script exited ${exitText(exit)}${note}\n`);
      process.stdout.write(Buffer.concat(output));
      resolve(exit);
    };
    child.on("error", (error) => end(null, ` (${error.message})`));
    child.on("close", (exit) => end(exit));
  });
/**
 * How many test scripts `suite` runs side by side. Ceiling: one per four CPUs, as each Vitest
 * spreads over every CPU (one per CPU timed out four tests a lone run passes, 2026-11-21). To raise
 * it, lower the divisor and compare the failures.
 */
export const suiteWidth = (cpus: number): number => Math.max(1, Math.floor(cpus / 4));
const suiteReports = (): string =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "upstream-sync-suite-"));
/**
 * The full suite at `root`: each package's own `test` script (`vp run -r test` stops at the first
 * failure; a root `vp test run` runs files no CI job runs), each failure as `<package>: <failure>`.
 * `width` scripts run side by side (suiteWidth). Each report goes in `reports`, removed at the end;
 * `children` holds the scripts still running, for a caller that stops them on a signal.
 */
export const suiteRun = async (
  root: string,
  vp: string,
  packages: ReadonlyArray<string>,
  {
    width = suiteWidth(NodeOS.availableParallelism()),
    reports = suiteReports(),
    children = new Set<NodeChildProcess.ChildProcess>(),
  } = {},
): Promise<Suite> => {
  const report = (index: number) => NodePath.join(reports, `${index}.json`);
  // Each result at its package's index, so they read in the packages' order whatever order they
  // finished in: the baseline and the owed list read alike.
  const results: Array<{ readonly name: string; readonly exit: number | null }> = [];
  // One iterator shared by every worker: each takes the next package when it is free.
  const queue = packages.entries();
  const worker = async () => {
    for (const [index, name] of queue)
      results[index] = {
        name,
        exit: await runPackage(root, vp, name, report(index), children),
      };
  };
  await Promise.all(Array.from({ length: Math.min(packages.length, width) }, worker));
  const failures: string[] = [];
  const runs = new Map<string, PackageRun>();
  for (const [index, { name, exit }] of results.entries()) {
    const read = readReport(
      NodeFS.existsSync(report(index)) ? NodeFS.readFileSync(report(index), "utf8") : "",
      root,
    );
    runs.set(name, { exit, files: read.files });
    failures.push(...read.failures.map((failure) => `${name}: ${failure}`));
  }
  NodeFS.rmSync(reports, { recursive: true, force: true });
  return { failures, packages: runs };
};
/** Where `suite` keeps the baseline of `commit`: the git common dir, which every worktree of this checkout shares. */
const keptBaseline = (commit: string): string =>
  NodePath.join(
    git("rev-parse", "--path-format=absolute", "--git-common-dir"),
    "upstream-sync",
    `baseline-${commit}.txt`,
  );
/**
 * verify's refusal while a running suite writes `kept` (its `<kept>.<pid>`), or null; a crashed
 * one's file is passed over. Ceiling: a crashed suite's pid that a live process reuses reads as
 * running, which the refusal names the file for.
 */
export const writingRefusal = (kept: string): string | null => {
  const prefix = `${NodePath.basename(kept)}.`;
  const entries = NodeFS.existsSync(NodePath.dirname(kept))
    ? NodeFS.readdirSync(NodePath.dirname(kept))
    : [];
  for (const entry of entries) {
    const pid = entry.startsWith(prefix) ? Number(entry.slice(prefix.length)) : Number.NaN;
    if (!Number.isInteger(pid)) continue;
    try {
      // Signal 0 only asks whether it runs.
      process.kill(pid, 0);
      return `suite (pid ${pid}) is still writing the baseline to ${kept}.${pid}; run verify once it ends, or pass --baseline <file> (if pid ${pid} is no suite, remove that file)`;
    } catch {
      // It no longer runs.
    }
  }
  return null;
};
/**
 * verify's baseline: the full suite in the checkout this runs in, under its own Node. That checkout
 * is a worktree of this script's, so this repo reads its commit; the header names only the commit,
 * so the checkout must be clean. It is kept by commit, where verify looks for it by default.
 */
const suite = async (): Promise<void> => {
  const root = git("-C", process.cwd(), "rev-parse", "--show-toplevel");
  const head = git("-C", root, "rev-parse", "HEAD");
  if (gitTry("cat-file", "-e", `${head}^{commit}`) === null)
    fail(
      `${root}'s HEAD ${head} is not in ${ROOT_DIR}: run suite in a worktree of it (FORK.md step 5)`,
    );
  if (git("-C", root, ...STATUS) !== "")
    fail(
      `${root} has changes; the baseline names only its commit ${head}: run suite on a clean worktree`,
    );
  requireNode(head);
  const packages = suitePackages(head);
  const vp = requireVp(root);
  // Written from the start and renamed into place at the end, so verify never reads half of one,
  // and knows by `<kept>.<pid>` that one is coming (writingRefusal). Removed however this ends
  // short (a crash, fail, or a signal), so verify never waits on a suite that is gone.
  const kept = keptBaseline(head);
  const writing = `${kept}.${process.pid}`;
  NodeFS.mkdirSync(NodePath.dirname(kept), { recursive: true });
  process.on("exit", () => NodeFS.rmSync(writing, { force: true }));
  // A signal (a `kill`, which reaches this process alone) stops the test scripts too, removes what
  // the run wrote, and ends this process by that signal, so its caller reads how it ended. `once`
  // has removed the listener when it runs, so the signal's default action ends the process.
  const reports = suiteReports();
  const children = new Set<NodeChildProcess.ChildProcess>();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, () => {
      for (const child of children) child.kill(signal);
      NodeFS.rmSync(reports, { recursive: true, force: true });
      NodeFS.rmSync(writing, { force: true });
      process.kill(process.pid, signal);
    });
  NodeFS.writeFileSync(writing, "");
  const text = `${baselineText(head, await suiteRun(root, vp, packages, { reports, children }))}\n`;
  NodeFS.writeFileSync(writing, text);
  NodeFS.renameSync(writing, kept);
  console.log(`\n${text}\nKept at ${kept}.`);
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "plan") console.log(plan(args));
  else if (args.command === "rebase") rebase(args);
  else if (args.command === "suite") await suite();
  else await verify(args);
};

if (import.meta.main) await main();
