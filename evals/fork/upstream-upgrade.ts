// Fork-only (FORK.md, "The daily upgrade workflow"). A T3 workflow, not a script: install.sh copies
// this file into ~/.t3/workflows, and the server runs it once Settings → Labs → Workflows is on.
//
// Each morning it looks for an upstream Nightly newer than the one the fork sits on, asks the
// owner whether to upgrade, and on yes runs `/t3code-fork upgrade <tag>` (agent-skills'
// t3code-fork skill) through push and build in the checkout, two read-only Opus reviews (MAIN-85),
// one fix round, and then asks before launching scripts/fork/auto-install.sh. With no newer
// Nightly it offers fork/main's build when the installed Fork app is older (an install that was
// launched and failed), unless the owner answered Not now to that build.
//
// That is the upgrader role; the installer role, and why there are two, are FORK.md's "Roles".
//
// The server loads this with type stripping and does not type-check it; evals' typecheck does, and
// upstream-upgrade.test.ts beside it drives it in the real engine. Rule 3 of the workflow skill
// holds: once a run is unfinished, a changed body is a new `version` (the note at `version:` below).
//
// T3_FORK_CHECKOUT (the fork checkout, ~/repos/t3code by default), T3_FORK_APPLICATIONS_DIR
// (install.sh's), T3_FORK_ROLE_FILE, T3_FORK_FETCH_TIMEOUT_MS and T3_FORK_UPSTREAM_RETRY_AFTER_MS
// are for that test and a live check.
//
// A workflow file may not import effect (the workflow skill, rule 4), so Node is its only way to
// run a process or read the environment and the disk.
// @effect-diagnostics nodeBuiltinImport:off processEnvInEffect:off
// @effect-diagnostics globalErrorInEffectCatch:off globalErrorInEffectFailure:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const { workflow, step, agent, ask, sleep, skip, stop, title, runs, store, daily, Tick } = T3;

const NAME = "upstream-upgrade";
const NIGHTLY = "v*-nightly.*";
const MIGRATIONS = "apps/server/src/persistence/Migrations/";
// The run that owns the checkout, while it is unfinished: set by `claim` once `approve` is answered
// Upgrade. One stored owner, set in a transaction, so of two runs answered Upgrade one goes on,
// whichever was answered first.
const OWNER = store.entry(`${NAME}/checkout`, Schema.String);
// The build whose install the owner answered Not now: never offered again, a newer one is.
const DECLINED = store.entry(`${NAME}/declined-build`, Schema.String);
// The installer's: the fork/main commit the owner answered Not now to building.
const DECLINED_COMMIT = store.entry(`${NAME}/declined-commit`, Schema.String);
const Role = Schema.Literals(["upgrader", "installer"]);
// install.sh's record of this machine's role (FORK.md, "Roles"). The server loads only .ts files
// from this folder.
const roleFile = () =>
  process.env.T3_FORK_ROLE_FILE ??
  NodePath.join(NodeOS.homedir(), ".t3", "workflows", `${NAME}.role`);
// The owner's default model; MAIN-85 asks for Opus reviews, and the upgrade is the same model.
const OPUS = {
  instanceId: "claudeAgent",
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "high" }],
};
// How long a question after the claim waits. The stored owner already makes the next morning's run
// skip, so this only ends a run nobody answers.
const ANSWER_WITHIN = "23 hours";
// A question before the claim ends this long after the run was due: an hour before the next
// morning's run, however late the upstream fetch's tries let it be asked, so that run never finds
// the same question still open.
const ASK_BEFORE_NEXT_RUN_MS = 23 * 60 * 60 * 1000;
// Questions the upgrade agent may put to the owner before the run gives up on it.
const OWNER_ROUNDS = 5;
// A fetch over ssh that stops answering is cut off, so the run waits and tries again instead of
// holding the checkout (and, while its step runs, every install: auto-install.sh's idle check).
const FETCH_ENV = {
  GIT_SSH_COMMAND:
    "ssh -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4",
};
// The 08:00 run can start in a dark wake (v1's only run, 2026-11-24, stopped on a fetch that hung),
// so a failed fetch sleeps an hour and tries again, through a morning of sleep. Not step.try's
// `retry:`: its wait is in memory with the step `running`, which auto-install.sh counts as busy,
// and a restart starts it over. A `sleep` holds no step running.
const UPSTREAM_TRIES = 8;
const upstreamRetryAfter = () =>
  Duration.millis(Number(process.env.T3_FORK_UPSTREAM_RETRY_AFTER_MS ?? 60 * 60_000));
// build.sh's version: the upstream tag's with "nightly" swapped for "fork", plus a build number.
const FORK_VERSION = /^(\d+)\.(\d+)\.(\d+)-fork\.(\d+)\.(\d+)\.(\d+)$/;

// How long a process group asked to end (SIGTERM) has before it is killed (SIGKILL).
const KILL_AFTER_MS = 5_000;
// The lines of stderr a failure quotes.
const STDERR_LINES = 20;

// `command`'s stdout, run in a process group of its own (spawn's `detached`; execFile ignores it).
// A timeout or interrupt SIGTERMs the whole group (build.sh's builds, git's ssh), and SIGKILLs it
// KILL_AFTER_MS later if still there: `close` is no sign, as what ignores SIGTERM may have left our
// pipes. Ceiling: a group id reused within those seconds is killed too (unlikely; inferred).
const exec = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly timeoutMs?: number;
    readonly env?: Readonly<Record<string, string>>;
  },
) => {
  const timeout = options.timeoutMs ?? 60_000;
  const failed = (why: string) => new Error(`${command} ${args.join(" ")}: ${why}`);
  return Effect.tryPromise({
    try: (abort) =>
      new Promise<string>((resolve, reject) => {
        const child = NodeChildProcess.spawn(command, [...args], {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
        let stdout = "";
        // Its last STDERR_LINES lines only: execFile's 16 MiB cap went with execFile, and a build's
        // stderr has no other bound. Ceiling: one line that never ends is kept whole.
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr = (stderr + chunk).split("\n").slice(-STDERR_LINES).join("\n");
        });
        abort.addEventListener("abort", () => {
          const group = child.pid;
          if (group === undefined) return;
          const signal = (name: NodeJS.Signals) => {
            try {
              process.kill(-group, name);
            } catch {
              // The group is already gone.
            }
          };
          signal("SIGTERM");
          // @effect-diagnostics-next-line globalTimers:off -- the fiber is interrupted by now; this outlives it.
          setTimeout(() => signal("SIGKILL"), KILL_AFTER_MS);
        });
        child.on("error", reject);
        child.on("close", (code, signal) =>
          code === 0
            ? resolve(stdout.trim())
            : reject(new Error(`exited ${code ?? signal}: ${stderr.trim()}`)),
        );
      }),
    catch: (error) => failed(error instanceof Error ? error.message : String(error)),
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timeout),
      orElse: () => Effect.fail(failed(`no answer within ${timeout / 1000}s`)),
    }),
  );
};
const gitFetch = (checkout: string, ...args: ReadonlyArray<string>) =>
  exec("git", ["fetch", "--quiet", ...args], {
    cwd: checkout,
    timeoutMs: Number(process.env.T3_FORK_FETCH_TIMEOUT_MS ?? 2 * 60_000),
    env: FETCH_ENV,
  });

// Q75 (MAIN-116): T3 raises no notification or badge when a workflow asks, so each question is
// announced on macOS first. The words go in as argv, never into the AppleScript source. A
// notification that fails is noted on its step and the run goes on to ask anyway.
const notify = (name: string, question: string) =>
  step.try(
    `notify-${name}`,
    { returns: Schema.String },
    Effect.as(
      exec(
        "osascript",
        [
          "-e",
          "on run argv",
          "-e",
          "display notification (item 2 of argv) with title (item 1 of argv)",
          "-e",
          "end run",
          "T3 Code (Fork)",
          `${question} ⌘K → Open workflows`,
        ],
        { cwd: NodeOS.homedir(), timeoutMs: 10_000 },
      ),
      question,
    ),
  );
/** `ask`, announced first by a notification that says `short`. */
const askAnnounced = <const Choices extends ReadonlyArray<string>>(
  name: string,
  short: string,
  options: Parameters<typeof ask<Choices>>[1],
) => Effect.andThen(notify(name, short), ask(name, options));

// The file's text, or "" without one.
const readOrEmpty = (path: string) =>
  Effect.tryPromise({
    try: () => NodeFSP.readFile(path, "utf8"),
    catch: (error) => new Error(String(error)),
  }).pipe(Effect.orElseSucceed(() => ""));
// build.sh's record of each build in the checkout's clone, `<version> <commit>` a line (build.sh
// says why it is there), as [version, commit] pairs.
const forkBuilds = (checkout: string) =>
  Effect.flatMap(
    exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: checkout }),
    (dir) =>
      Effect.map(readOrEmpty(NodePath.join(dir, "fork-builds")), (text) =>
        text.split("\n").map((line) => line.split(" ")),
      ),
  );

// The highest numbered migration at `ref`: upstream's own head, as FORK.md's step 1 reads it.
const migrationHead = (checkout: string, ref: string) =>
  Effect.map(exec("git", ["ls-tree", "--name-only", ref, MIGRATIONS], { cwd: checkout }), (out) =>
    Math.max(
      0,
      ...out.split("\n").flatMap((path) => {
        const id = /\/(\d+)_[^/]*$/.exec(path)?.[1];
        return id === undefined ? [] : [Number(id)];
      }),
    ),
  );

/** The fork's version of upstream Nightly `tag`, without the build number. */
const forkVersionOf = (tag: string) => `${tag.replace(/^v/, "").replace("-nightly.", "-fork.")}.`;
/** Whether fork version `a` is older than `b`; false when either is not one. */
const olderThan = (a: string, b: string) => {
  const [x, y] = [FORK_VERSION.exec(a), FORK_VERSION.exec(b)];
  if (x === null || y === null) return false;
  for (let at = 1; at < x.length; at++) {
    if (Number(x[at]) !== Number(y[at])) return Number(x[at]) < Number(y[at]);
  }
  return false;
};

// The installed Fork app's version, or null without one.
const installedVersion = Effect.suspend(() =>
  exec(
    "/usr/libexec/PlistBuddy",
    [
      "-c",
      "Print CFBundleShortVersionString",
      NodePath.join(
        process.env.T3_FORK_APPLICATIONS_DIR ?? "/Applications",
        "T3 Code (Fork).app",
        "Contents",
        "Info.plist",
      ),
    ],
    { cwd: NodeOS.homedir() },
  ),
).pipe(Effect.orElseSucceed(() => null));

// The version of the zip install.sh would install (its `ls -t`, install.sh:85), or null without one.
const releaseVersion = (checkout: string) =>
  Effect.tryPromise({
    try: async () => {
      const release = NodePath.join(checkout, "release");
      const builds = await Promise.all(
        (await NodeFSP.readdir(release))
          .filter((name) => /^T3-Code-.+-arm64\.zip$/.test(name))
          .map(async (name) => ({
            version: name.slice("T3-Code-".length, -"-arm64.zip".length),
            at: (await NodeFSP.stat(NodePath.join(release, name))).mtimeMs,
          })),
      );
      return builds.toSorted((a, b) => b.at - a.at)[0]?.version ?? null;
    },
    catch: (error) => new Error(String(error)),
  }).pipe(Effect.orElseSucceed(() => null));

const BuildVersion = Schema.String.check(Schema.isPattern(FORK_VERSION));
const Upstream = Schema.Struct({
  checkout: Schema.String,
  /** The Nightly the fork sits on. */
  base: Schema.String,
  /** The newest Nightly, when it is newer than `base`. */
  target: Schema.NullOr(Schema.String),
  commits: Schema.Number,
  /** The migrations the target adds, when it adds any. */
  migrations: Schema.NullOr(Schema.Struct({ from: Schema.Number, to: Schema.Number })),
  /**
   * With no target: fork/main's build in release/, when the installed Fork app is older (a
   * launched install that failed).
   */
  uninstalled: Schema.NullOr(Schema.Struct({ build: BuildVersion, installed: Schema.String })),
});
type Upstream = typeof Upstream.Type;

// The checkout, once git finds it: a local failure, so the run stops at once rather than retry.
const findCheckout = Effect.suspend(() => {
  const checkout =
    process.env.T3_FORK_CHECKOUT ?? NodePath.join(NodeOS.homedir(), "repos", "t3code");
  return Effect.as(exec("git", ["rev-parse", "--git-dir"], { cwd: checkout }), checkout);
});
// The only part that reaches the network, and so the only part tried again. Fetches move only tags
// and remote refs, never the checkout's branches or files.
const fetchUpstream = (checkout: string) =>
  Effect.as(
    Effect.andThen(
      gitFetch(checkout, "upstream", "--tags"),
      gitFetch(checkout, "origin", "fork/main"),
    ),
    null,
  );

// The Nightly origin's fork/main sits on.
const forkBase = (checkout: string) =>
  exec("git", ["describe", "--tags", "--abbrev=0", "--match", NIGHTLY, "origin/fork/main"], {
    cwd: checkout,
  });

// Local and read-only: what the fetches brought.
const readUpstream = Effect.fn("readUpstream")(function* (checkout: string) {
  const git = (...args: ReadonlyArray<string>) => exec("git", args, { cwd: checkout });
  const base = yield* forkBase(checkout);
  const newest = (yield* git("tag", "-l", NIGHTLY, "--sort=-version:refname")).split("\n")[0];
  if (newest === undefined || newest === "" || newest === base) {
    // Ceiling: the build in release/ is taken for fork/main's when it is of fork/main's base; one
    // built from another branch on the same base would be offered too.
    const build = yield* releaseVersion(checkout);
    const installed = yield* installedVersion;
    const declined = yield* DECLINED.get;
    const uninstalled =
      build !== null &&
      build.startsWith(forkVersionOf(base)) &&
      installed !== null &&
      olderThan(installed, build) &&
      Option.getOrNull(declined) !== build
        ? { build, installed }
        : null;
    return {
      checkout,
      base,
      target: null,
      commits: 0,
      migrations: null,
      uninstalled,
    } satisfies Upstream;
  }
  const commits = Number(yield* git("rev-list", "--count", `${base}..${newest}`));
  const from = (yield* migrationHead(checkout, base)) + 1;
  const to = yield* migrationHead(checkout, newest);
  return {
    checkout,
    base,
    target: newest,
    commits,
    migrations: to >= from ? { from, to } : null,
    uninstalled: null,
  } satisfies Upstream;
});

// The recorded role. None, or anything else, stops the run: a guess is wrong on one of the machines,
// and a wrong upgrader races the other to force-push fork/main.
const readRole = Effect.tryPromise({
  try: () => NodeFSP.readFile(roleFile(), "utf8"),
  catch: (error) =>
    new Error(
      error instanceof Error && "code" in error && error.code === "ENOENT"
        ? `none is recorded in ${roleFile()}: install with --role upgrader (the one machine that upgrades) or --role installer (every other), e.g. scripts/fork/auto-install.sh --role installer`
        : String(error),
    ),
}).pipe(
  Effect.map((text) => text.trim()),
  Effect.filterOrFail(
    Schema.is(Role),
    (text) => new Error(`${roleFile()} holds "${text}", not upgrader or installer`),
  ),
);

const ForkMain = Schema.Struct({
  checkout: Schema.String,
  /** origin/fork/main's commit, which a Build builds. */
  sha: Schema.String,
  /** The Nightly it sits on. */
  base: Schema.String,
  /** The Fork app's version, or null without one. */
  installed: Schema.NullOr(Schema.String),
  /** The commit that version was built from (build.sh's record), or null when none is recorded. */
  installedCommit: Schema.NullOr(Schema.String),
  /** Whether the owner answered Not now to building `sha`. */
  declined: Schema.Boolean,
});
type ForkMain = typeof ForkMain.Type;

// Local and read-only: fork/main as the fetches left it, and what the Fork app was built from. The
// app's own version is the key into build.sh's record, so an install by hand or a release/ build.sh
// cleared still answers.
const readForkMain = Effect.fn("readForkMain")(function* (checkout: string) {
  const sha = yield* exec("git", ["rev-parse", "origin/fork/main"], { cwd: checkout });
  const base = yield* forkBase(checkout);
  const installed = yield* installedVersion;
  const builds = yield* forkBuilds(checkout);
  const installedCommit =
    installed === null
      ? null
      : (builds.findLast(([version]) => version === installed)?.[1] ?? null);
  const declined = Option.getOrNull(yield* DECLINED_COMMIT.get) === sha;
  return { checkout, sha, base, installed, installedCommit, declined } satisfies ForkMain;
});

// The checkout, on a clean fork/main whose head is not a local commit, moved to `sha` without
// a checkout of anything else: a reset, which a fast-forward is one case of (fork/main is rebased, so
// it seldom is). The old head stays in the reflog. Anything else stops the run rather than lose work.
const moveCheckout = Effect.fn("moveCheckout")(function* (checkout: string, sha: string) {
  const git = (...args: ReadonlyArray<string>) => exec("git", args, { cwd: checkout });
  const branch = yield* git("symbolic-ref", "--quiet", "--short", "HEAD").pipe(
    Effect.orElseSucceed(() => "(detached HEAD)"),
  );
  if (branch !== "fork/main") {
    return yield* Effect.fail(new Error(`${checkout} is on ${branch}, not fork/main`));
  }
  const dirty = yield* git("status", "--porcelain");
  if (dirty !== "") {
    return yield* Effect.fail(
      new Error(`${checkout} has changes: ${dirty.split("\n").slice(0, 5).join("; ")}`),
    );
  }
  // A head is known when it is `sha`, a commit this clone built (an installer's is, once it has
  // built), or one origin's fork/main held per its reflog (old and new values: a clone writes none).
  // Not "on a remote branch", which no head is once fork/main is rebased; the reflog alone forgets
  // a head after gc's 30 days. No reflog (reftable) leaves the first two.
  const head = yield* git("rev-parse", "HEAD");
  const built = yield* forkBuilds(checkout);
  const reflog = yield* readOrEmpty(
    yield* git(
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "logs/refs/remotes/origin/fork/main",
    ),
  );
  const known = [
    sha,
    ...built.map(([, commit]) => commit),
    ...reflog.split("\n").flatMap((line) => line.split(" ").slice(0, 2)),
  ];
  if (!known.includes(head)) {
    return yield* Effect.fail(
      new Error(
        `${checkout}'s fork/main is at ${head.slice(0, 10)}, which neither this clone built nor origin's held; once nothing on it matters, run: git -C ${checkout} reset --hard origin/fork/main`,
      ),
    );
  }
  yield* git("reset", "--hard", "--quiet", sha);
  return sha;
});

// build.sh in the checkout (its `vp i` included); the version it left in release/.
const buildCheckout = Effect.fn("buildCheckout")(function* (checkout: string) {
  // Two minutes as a rule; once (2026-11-23) it hung after signing, so a cut-off ends the run.
  yield* exec(NodePath.join(checkout, "scripts", "fork", "build.sh"), [], {
    cwd: checkout,
    timeoutMs: 45 * 60_000,
  });
  const built = yield* releaseVersion(checkout);
  // Checked here, not left to the step's `returns`: a value that fails it pauses the run for a
  // person (workflow.ts, `unstorable`) instead of coming back as failed, and the run stops.
  if (built === null || !FORK_VERSION.test(built)) {
    return yield* Effect.fail(new Error(`build.sh left ${built ?? "no build"} in release/`));
  }
  return built;
});

const Verify = Schema.Struct({
  /** Each failure FORK.md's Known noise covers, with the entry that covers it. */
  knownNoise: Schema.Array(Schema.String),
  /** Every other failure. */
  newFailures: Schema.Array(Schema.String),
});
const NeedsOwner = Schema.Struct({
  outcome: Schema.Literal("needs-owner"),
  /** The question in plain words, with the agent's pick. */
  question: Schema.String,
});
const Built = Schema.Struct({
  outcome: Schema.Literal("built"),
  pushedSha: Schema.String,
  backupBranch: Schema.String,
  buildVersion: BuildVersion,
  verify: Verify,
  /** The upgrade's account, for the reviewers. */
  report: Schema.String,
});
const Finding = Schema.Struct({
  severity: Schema.Literals(["P1", "P2", "P3"]),
  file: Schema.String,
  line: Schema.NullOr(Schema.Number),
  scenario: Schema.String,
  fix: Schema.String,
  verified: Schema.Boolean,
});
type Finding = typeof Finding.Type;
const Review = Schema.Struct({ findings: Schema.Array(Finding) });
const Fixed = Schema.Struct({
  pushedSha: Schema.String,
  buildVersion: BuildVersion,
  verify: Verify,
  answers: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      outcome: Schema.Literals(["fixed", "wrong", "open"]),
      note: Schema.String,
    }),
  ),
});

// "5 upstream commits, migrations 106-110", as the owner reads it in a question.
const scope = ({ commits, migrations }: Upstream) =>
  `${commits} upstream commit${commits === 1 ? "" : "s"}, ${
    migrations === null
      ? "no new migrations"
      : migrations.from === migrations.to
        ? `migration ${migrations.from}`
        : `migrations ${migrations.from}-${migrations.to}`
  }`;
const upgradeQuestion = (upstream: Upstream, target: string) =>
  `Upgrade the fork from ${upstream.base} to ${target}? (${scope(upstream)})`;

const NO_REVIEW =
  "The workflow runs MAIN-85's two Opus reviews after your push; start no review yourself.";
const WHEN_DONE =
  "You may end a turn while a background task runs; submit your result only when you are done.";

const upgradeBrief = (upstream: Upstream, target: string) =>
  [
    `The owner answered Upgrade to "${upgradeQuestion(upstream, target)}". Run /t3code-fork upgrade ${target} steps 1-5 (~/repos/agent-skills/t3code-fork/SKILL.md) in ${upstream.checkout}.`,
    "",
    "What this workflow adds to the skill:",
    `- The target is fixed at ${target}: do not chase a newer Nightly.`,
    "- STOP BEFORE step 6, Install: the workflow asks the owner and installs. Hand over no install steps.",
    "- Judge verify against FORK.md's Known noise, not by its exit code (it exits 1 when only Known noise fails).",
    `- ${NO_REVIEW}`,
    `- ${WHEN_DONE}`,
    "",
    "Your result (t3_submit_output):",
    "- Done: outcome \"built\", the pushed fork/main SHA, the backup branch, the build version, verify's failures split into Known noise (each with the entry that covers it) and new ones, and `report`: what plan listed and how each item was settled, each conflict and how it was resolved (FORK.md seams file by file), verify's result quoted with the baseline comparison, the live check, and where the plan, verify and build logs are.",
    '- At every point the skill or FORK.md says to ask the owner: outcome "needs-owner" with the question in plain words and your pick. The owner\'s answer comes back in this thread.',
  ].join("\n");

const reviewBrief = (
  focus: "correctness" | "simplicity",
  upstream: Upstream,
  target: string,
  built: typeof Built.Type,
) =>
  [
    `Read-only ${focus === "correctness" ? "CORRECTNESS" : "SIMPLICITY AND THE OWNER'S RULES"} review of an upstream rebase (a second Opus reviewer covers ${focus === "correctness" ? "simplicity and the owner's rules" : "correctness"}).`,
    "",
    `Under review: the rebase of the owner's T3 Code fork (M-Agha/t3code, checkout ${upstream.checkout}) from upstream ${upstream.base} onto ${target} (${scope(upstream)}). fork/main = ${built.pushedSha}, pushed; the old head is ${built.backupBranch}. Built as ${built.buildVersion}, not yet installed: the install waits on this review.`,
    "Read only: do not switch branches, fetch, push or change files; start no app; ~/.t3 read-only (sqlite3 -readonly). Run focused tests with `cd <checkout> && env -u T3CODE_PORT -u T3CODE_HOST mise exec node@<engines.node> -- node_modules/.bin/vp test run <paths>`.",
    `What the rebase changed in the fork's own patches: \`git -C ${upstream.checkout} range-diff ${upstream.base}..${built.backupBranch} ${target}..${built.pushedSha}\`. Runbook and the owner's rulings: FORK.md at ${built.pushedSha}.`,
    "",
    "The upgrade agent's account:",
    built.report,
    "",
    `Verify: Known noise ${JSON.stringify(built.verify.knownNoise)}; other failures ${JSON.stringify(built.verify.newFailures)}.`,
    "",
    focus === "correctness"
      ? "Look hardest at: each conflict resolution (lost or misplaced entries in lists that grew on both sides), every fix the rebase added (right, complete, tested), the migrations the target adds against the fork's reads and scripts/fork/auto-install.sh's SQL, and upstream changes to the seams FORK.md lists."
      : "The owner's rules: /Users/magha/repos/dotfiles/.claude/rules.global/minimal.md and engineering-standards.md beside it. Look for: resolutions that grew a seam more than needed, duplicated code from keep-both merges, FORK.md accuracy (base line, seams by full path, Known noise tags), and each fork commit whole (fixups squashed into the right commit).",
    "",
    WHEN_DONE,
    "Your result (t3_submit_output): every finding, most severe first, with severity P1 (blocks the install), P2 or P3, file and line (line null when none applies), a concrete failure scenario, the fix, and whether you verified it or inferred it. No findings is an empty list.",
  ].join("\n");

const fixBrief = (findings: ReadonlyArray<{ readonly id: string } & Finding>) =>
  [
    "Two read-only reviews of your upgrade found the following. Fix each finding or answer it with the reason it is wrong.",
    "",
    ...findings.map(
      (finding) =>
        `${finding.id} (${finding.severity}, ${finding.verified ? "verified" : "inferred"}) ${finding.file}${finding.line === null ? "" : `:${finding.line}`}: ${finding.scenario} Fix: ${finding.fix}`,
    ),
    "",
    "Fold each fix into the fork commit it belongs to (`git commit --fixup=<commit>`, then FORK.md step 4's autosquash), run verify again, rebuild with scripts/fork/build.sh, and push fork/main with the leased command verify prints. Stop before Install, as before.",
    NO_REVIEW,
    WHEN_DONE,
    "",
    'Your result (t3_submit_output): the pushed fork/main SHA (the same one when nothing changed), the build version, verify\'s failures as before, and one answer per finding id: "fixed", "wrong" (the note says why), or "open" (the note says what the owner must decide).',
  ].join("\n");

// The skill's step 6, for the owner once the install is launched.
const AFTER_INSTALL = [
  "Update the fallback T3 Code (Nightly) with its in-app updater only after this install, and only to a version no newer than the fork's base (FORK.md rule 3).",
  "Then quit Nightly, and quit and relaunch T3 Code (Fork): opening Nightly rewrites ~/.t3/bin/t3, and only the Fork app's start writes it back.",
  "Run no `t3 service …` or `t3 update` until `head -12 ~/.t3/bin/t3` names T3 Code (Fork).app.",
  "In Nightly, ignore any update-server banner and never use Update track or Update everything.",
];

// Another unfinished run than `self` that owns the checkout, or null.
const otherOwner = Effect.fn("otherOwner")(function* (self: string) {
  const owner = Option.getOrNull(yield* OWNER.get);
  if (owner === null || owner === self) return null;
  const all = yield* runs({ workflow: NAME });
  return all.some((other) => other.id === owner && other.endedAt === null) ? owner : null;
});
// Two runs can both have asked (a run started by hand beside the morning's): one goes on.
const claim = (self: string) =>
  step(
    "claim",
    { returns: Schema.NullOr(Schema.String) },
    store.transaction(
      Effect.tap(otherOwner(self), (owner) => (owner === null ? OWNER.set(self) : Effect.void)),
    ),
  );

// Q74 (pending): the install question and the launch, the run's last steps. Without it the run
// ends with the build, and scripts/fork/auto-install.sh installs it by hand.
const install = Effect.fn("install")(function* (
  checkout: string,
  build: string,
  within: Parameters<typeof Duration.toMillis>[0],
  why?: string,
) {
  const answer = yield* askAnnounced("install", `Install the fork build ${build}?`, {
    title: [
      `Install the fork build ${build} now?`,
      ...(why === undefined ? [] : [why]),
      "Every T3 Code app closes and T3 Code (Fork) reopens once no run is active.",
    ].join(" "),
    choices: ["Install", "Not now"],
    data: { afterInstall: AFTER_INSTALL },
    timeout: within,
  });
  if (Option.isNone(answer) || answer.value.choice !== "Install") {
    // An unanswered question is asked again the next morning; a Not now is not.
    if (Option.isSome(answer)) {
      yield* step("declined", { returns: Schema.String }, Effect.as(DECLINED.set(build), build));
    }
    return yield* stop(
      `built ${build}, not installed: run scripts/fork/auto-install.sh to install it`,
    );
  }
  return yield* launchInstall(checkout, build);
});

// The installer's run once fork/main is not the commit the Fork app was built from: asks, then
// moves the checkout to it, builds and launches the install. It never rebases, reviews or pushes.
const buildForkMain = Effect.fn("buildForkMain")(function* (
  self: string,
  forkMain: ForkMain,
  within: Parameters<typeof Duration.toMillis>[0],
) {
  const short = forkMain.sha.slice(0, 10);
  const question = `Build and install fork/main ${short} (upstream ${forkMain.base})?`;
  yield* title(question);
  const built =
    forkMain.installedCommit === null
      ? "no recorded commit"
      : forkMain.installedCommit.slice(0, 10);
  const build = yield* askAnnounced("build", question, {
    title: [
      question,
      forkMain.installed === null
        ? "T3 Code (Fork) is not installed."
        : `T3 Code (Fork) is ${forkMain.installed}, built from ${built}.`,
      "Every T3 Code app closes and T3 Code (Fork) reopens once the build is done and no run is active.",
    ].join(" "),
    choices: ["Build", "Not now"],
    data: { ...forkMain, afterInstall: AFTER_INSTALL },
    timeout: within,
  });
  if (Option.isNone(build) || build.value.choice !== "Build") {
    // As the upgrader's install question: unanswered is asked again, Not now is not.
    if (Option.isSome(build)) {
      yield* step(
        "declined",
        { returns: Schema.String },
        Effect.as(DECLINED_COMMIT.set(forkMain.sha), forkMain.sha),
      );
    }
    return yield* stop(`fork/main ${short} not built`);
  }
  yield* title(`Building fork/main ${short}`);
  const taken = yield* claim(self);
  if (taken !== null) return yield* stop(`run ${taken} took the checkout first`);
  const moved = yield* step.try(
    "move-checkout",
    { returns: Schema.String },
    moveCheckout(forkMain.checkout, forkMain.sha),
  );
  if (moved.outcome === "failed") return yield* stop(`not built: ${moved.reason}`);
  const made = yield* step.try(
    "make-build",
    { returns: BuildVersion },
    buildCheckout(forkMain.checkout),
  );
  if (made.outcome === "failed") return yield* stop(`not built: ${made.reason}`);
  return {
    forkMain: forkMain.sha,
    buildVersion: made.value,
    install: yield* launchInstall(forkMain.checkout, made.value),
  };
});

// auto-install.sh waits for this run to end (it counts a workflow run while a step runs), so its
// quit never lands mid-step. A second launch while the first waits is refused by its lock.
const launchInstall = Effect.fn("launchInstall")(function* (checkout: string, build: string) {
  const launched = yield* step.try(
    "launch-install",
    { returns: Schema.String },
    Effect.gen(function* () {
      const installed = yield* installedVersion;
      if (installed === build) return `${installed} is already installed`;
      const release = yield* releaseVersion(checkout);
      if (release !== build) {
        return yield* Effect.fail(
          new Error(`release/ holds ${release ?? "no build"}, not ${build}; nothing launched`),
        );
      }
      const out = yield* exec(NodePath.join(checkout, "scripts", "fork", "auto-install.sh"), [], {
        cwd: checkout,
      });
      return `launched, not confirmed: ${/Log: (.+)$/m.exec(out)?.[1] ?? out}`;
    }),
  );
  if (launched.outcome === "failed") return yield* stop(`not installed: ${launched.reason}`);
  return launched.value;
});

// Version 4 (the installer role, Q77). Version 3 is not kept: the server holds a file back while it
// drops a version with unfinished runs, and loads it once they end (WorkflowRuntime.ts, HELD_RETRY).
export default workflow(
  NAME,
  { version: 4, payload: Tick, triggers: [daily("08:00")] },
  Effect.fn(function* (tick, self) {
    const role = yield* step.try("role", { returns: Role }, readRole);
    if (role.outcome === "failed") return yield* stop(`no role: ${role.reason}`);
    const installer = role.value === "installer";
    const earlier = yield* step(
      "earlier-run",
      { returns: Schema.NullOr(Schema.String) },
      otherOwner(self.id),
    );
    if (earlier !== null) {
      return yield* skip(
        `run ${earlier} of ${NAME} is ${installer ? "building fork/main" : "upgrading the fork"}`,
      );
    }

    const found = yield* step.try("checkout", { returns: Schema.String }, findCheckout);
    if (found.outcome === "failed") return yield* stop(`no fork checkout: ${found.reason}`);
    const fetchTry = (tried: number) =>
      step.try(`upstream-${tried}`, { returns: Schema.Null }, fetchUpstream(found.value));
    let fetched = yield* fetchTry(1);
    for (let tried = 1; fetched.outcome === "failed" && tried < UPSTREAM_TRIES; tried++) {
      yield* sleep(`upstream-wait-${tried}`, upstreamRetryAfter());
      fetched = yield* fetchTry(tried + 1);
    }
    if (fetched.outcome === "failed") {
      return yield* stop(
        `could not fetch upstream in ${UPSTREAM_TRIES} tries, ${Duration.format(upstreamRetryAfter())} apart: ${fetched.reason}`,
      );
    }
    // The timeout of a question before the claim, read off the clock in a step so a replay gets
    // the same one. A run already past it (or whose payload's `scheduledAt` is no time: NaN) leaves
    // the question to the next morning's.
    const beforeNextRun = Effect.gen(function* () {
      const left = yield* step(
        "ask-within",
        { returns: Schema.Number },
        Effect.clockWith((clock) =>
          Effect.map(
            clock.currentTimeMillis,
            (now) => Date.parse(tick.scheduledAt) + ASK_BEFORE_NEXT_RUN_MS - now,
          ),
        ),
      );
      if (!(left > 0)) {
        return yield* stop(
          `too late to ask: due at ${tick.scheduledAt}, so the next morning's run asks`,
        );
      }
      return Duration.millis(left);
    });
    if (installer) {
      const read = yield* step.try(
        "read-fork-main",
        { returns: ForkMain },
        readForkMain(found.value),
      );
      if (read.outcome === "failed") return yield* stop(`could not read fork/main: ${read.reason}`);
      const forkMain = read.value;
      const short = forkMain.sha.slice(0, 10);
      if (forkMain.installedCommit === forkMain.sha) {
        return yield* skip(`T3 Code (Fork) ${forkMain.installed} is fork/main's ${short}`);
      }
      if (forkMain.declined) return yield* skip(`fork/main ${short} was answered Not now`);
      return yield* buildForkMain(self.id, forkMain, yield* beforeNextRun);
    }

    const read = yield* step.try("read", { returns: Upstream }, readUpstream(found.value));
    if (read.outcome === "failed") return yield* stop(`could not read upstream: ${read.reason}`);
    const upstream = read.value;
    const target = upstream.target;
    if (target === null) {
      if (upstream.uninstalled === null) {
        return yield* skip(`the fork is on the newest Nightly, ${upstream.base}`);
      }
      const { build, installed } = upstream.uninstalled;
      yield* title(`Install the fork build ${build}?`);
      return {
        buildVersion: build,
        install: yield* install(
          upstream.checkout,
          build,
          yield* beforeNextRun,
          `It is fork/main's build; T3 Code (Fork) is still ${installed}.`,
        ),
      };
    }
    yield* title(`Upgrade the fork to ${target}?`);

    const approved = yield* askAnnounced("approve", `Upgrade the fork to ${target}?`, {
      title: upgradeQuestion(upstream, target),
      choices: ["Upgrade", "Not now"],
      data: upstream,
      timeout: yield* beforeNextRun,
    });
    if (Option.isNone(approved) || approved.value.choice !== "Upgrade") {
      return yield* stop(`not upgraded to ${target}`);
    }
    yield* title(`Upgrading the fork ${upstream.base} → ${target}`);
    const taken = yield* claim(self.id);
    if (taken !== null) return yield* stop(`run ${taken} took the checkout first`);

    const working = {
      returns: Schema.Union([Built, NeedsOwner]),
      timeout: "8 hours",
      quiet: "45 minutes",
    } as const;
    let upgrade = yield* agent("upgrade", {
      ...working,
      project: upstream.checkout,
      model: OPUS,
      runtimeMode: "full-access",
      title: `Fork upgrade to ${target}`,
      brief: upgradeBrief(upstream, target),
    });
    for (let round = 1; upgrade.value.outcome === "needs-owner"; round++) {
      if (round > OWNER_ROUNDS) {
        return yield* stop(
          `the upgrade still asks after ${OWNER_ROUNDS} answers: ${upgrade.value.question}`,
        );
      }
      const answer = yield* askAnnounced(
        `owner-${round}`,
        `The upgrade to ${target} has a question for you.`,
        {
          title: `The upgrade to ${target} asks: ${upgrade.value.question} (Go on takes its pick; a reason is your answer.)`,
          choices: ["Go on", "Stop"],
          timeout: ANSWER_WITHIN,
        },
      );
      if (Option.isNone(answer) || answer.value.choice !== "Go on") {
        return yield* stop(
          `the upgrade to ${target} stopped at: ${upgrade.value.question} (the checkout is as thread ${upgrade.thread.threadId} left it)`,
        );
      }
      upgrade = yield* agent(`upgrade-${round}`, {
        ...working,
        thread: upgrade.thread,
        brief: `The owner answered: ${answer.value.reason ?? "go with your pick"}. Carry on with the upgrade, under the same brief and result.`,
      });
    }
    const built = upgrade.value;

    const reviewing = {
      project: upstream.checkout,
      model: OPUS,
      runtimeMode: "full-access",
      returns: Review,
      timeout: "3 hours",
      quiet: "45 minutes",
    } as const;
    const [correctness, simplicity] = yield* Effect.all(
      [
        agent("review-correctness", {
          ...reviewing,
          title: `Fork upgrade to ${target}: correctness review`,
          brief: reviewBrief("correctness", upstream, target, built),
        }),
        agent("review-simplicity", {
          ...reviewing,
          title: `Fork upgrade to ${target}: simplicity review`,
          brief: reviewBrief("simplicity", upstream, target, built),
        }),
      ],
      { concurrency: 2 },
    );
    const findings = [
      ...correctness.value.findings.map((finding, at) => ({ ...finding, id: `C${at + 1}` })),
      ...simplicity.value.findings.map((finding, at) => ({ ...finding, id: `S${at + 1}` })),
    ];

    // One fix round. A P1 not fixed (still open, or argued wrong) goes to the owner.
    const shipped: typeof Fixed.Type =
      findings.length === 0
        ? { ...built, answers: [] }
        : (yield* agent("fix", {
            thread: upgrade.thread,
            returns: Fixed,
            timeout: "4 hours",
            quiet: "45 minutes",
            brief: fixBrief(findings),
          })).value;
    const answered = new Map(shipped.answers.map((answer) => [answer.id, answer]));
    const blockers = [
      ...shipped.verify.newFailures.map((failure) => `verify: ${failure}`),
      ...findings
        .filter(
          (finding) => finding.severity === "P1" && answered.get(finding.id)?.outcome !== "fixed",
        )
        .map(
          (finding) =>
            `${finding.id} ${finding.file}: ${answered.get(finding.id)?.note ?? "not answered"}`,
        ),
    ];
    if (blockers.length > 0) {
      const goOn = yield* askAnnounced(
        "blockers",
        `The fork on ${target} has ${blockers.length} blocker(s) left: go on anyway?`,
        {
          title: `The fork on ${target} (build ${shipped.buildVersion}) still has ${blockers.length} blocker(s) after the fix round: ${blockers.join("; ")}. Go on anyway?`,
          choices: ["Go on", "Stop"],
          data: { blockers },
          timeout: ANSWER_WITHIN,
        },
      );
      if (Option.isNone(goOn) || goOn.value.choice !== "Go on") {
        return yield* stop(
          `not installed: ${blockers.length} blocker(s) left on ${shipped.pushedSha}`,
        );
      }
    }

    const { pushedSha, buildVersion, verify } = shipped;
    return {
      target,
      pushedSha,
      buildVersion,
      verify,
      install: yield* install(upstream.checkout, buildVersion, ANSWER_WITHIN),
    };
  }),
);
