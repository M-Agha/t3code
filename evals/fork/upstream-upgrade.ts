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
// The server loads this with type stripping and does not type-check it; evals' typecheck does, and
// upstream-upgrade.test.ts beside it drives it in the real engine. Rule 3 of the workflow skill
// holds: once a run is unfinished, a changed body is a new `version`, with the old one kept in this
// file until its runs end.
//
// T3_FORK_CHECKOUT (the fork checkout, ~/repos/t3code by default), T3_FORK_APPLICATIONS_DIR
// (install.sh's) and T3_FORK_FETCH_TIMEOUT_MS are for that test and a live check.
//
// A workflow file may not import effect (the workflow skill, rule 4), so Node is its only way to
// run a process or read the environment and the disk.
// @effect-diagnostics nodeBuiltinImport:off processEnvInEffect:off
// @effect-diagnostics globalErrorInEffectCatch:off globalErrorInEffectFailure:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const { workflow, step, agent, ask, skip, stop, title, runs, store, daily, Tick } = T3;

const NAME = "upstream-upgrade";
const NIGHTLY = "v*-nightly.*";
const MIGRATIONS = "apps/server/src/persistence/Migrations/";
// The run that owns the checkout, while it is unfinished: set by `claim` once `approve` is answered
// Upgrade. One stored owner, set in a transaction, so of two runs answered Upgrade one goes on,
// whichever was answered first.
const OWNER = store.entry(`${NAME}/checkout`, Schema.String);
// The build whose install the owner answered Not now: never offered again, a newer one is.
const DECLINED = store.entry(`${NAME}/declined-build`, Schema.String);
// The owner's default model; MAIN-85 asks for Opus reviews, and the upgrade is the same model.
const OPUS = {
  instanceId: "claudeAgent",
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "high" }],
};
// Under a day, so a question nobody answered ends before the next morning's run looks.
const ANSWER_WITHIN = "23 hours";
// Questions the upgrade agent may put to the owner before the run gives up on it.
const OWNER_ROUNDS = 5;
// A fetch over ssh that stops answering is cut off, so the run ends instead of holding the checkout
// (and, while its step runs, every install: auto-install.sh's idle check) for good.
const FETCH_ENV = {
  GIT_SSH_COMMAND:
    "ssh -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4",
};
// build.sh's version: the upstream tag's with "nightly" swapped for "fork", plus a build number.
const FORK_VERSION = /^(\d+)\.(\d+)\.(\d+)-fork\.(\d+)\.(\d+)\.(\d+)$/;

const run = NodeUtil.promisify(NodeChildProcess.execFile);
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
  return Effect.tryPromise({
    try: () =>
      run(command, [...args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        timeout,
        maxBuffer: 16 * 1024 * 1024,
      }).then((out) => out.stdout.trim()),
    catch: (error) =>
      new Error(
        `${command} ${args.join(" ")}: ${
          error instanceof Error && "killed" in error && error.killed === true
            ? `no answer within ${timeout / 1000}s`
            : String(error)
        }`,
      ),
  });
};
const gitFetch = (checkout: string, ...args: ReadonlyArray<string>) =>
  exec("git", ["fetch", "--quiet", ...args], {
    cwd: checkout,
    timeoutMs: Number(process.env.T3_FORK_FETCH_TIMEOUT_MS ?? 10 * 60_000),
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

// Read-only for the checkout's branches and files: fetches move only tags and remote refs.
const readUpstream = Effect.gen(function* () {
  const checkout =
    process.env.T3_FORK_CHECKOUT ?? NodePath.join(NodeOS.homedir(), "repos", "t3code");
  const git = (...args: ReadonlyArray<string>) => exec("git", args, { cwd: checkout });
  yield* gitFetch(checkout, "upstream", "--tags");
  yield* gitFetch(checkout, "origin", "fork/main");
  const base = yield* git(
    "describe",
    "--tags",
    "--abbrev=0",
    "--match",
    NIGHTLY,
    "origin/fork/main",
  );
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

// Q74 (pending): the install question and the launch, the run's last steps. Without it the run
// ends with the build, and scripts/fork/auto-install.sh installs it by hand.
const install = Effect.fn("install")(function* (checkout: string, build: string, why?: string) {
  const answer = yield* askAnnounced("install", `Install the fork build ${build}?`, {
    title: [
      `Install the fork build ${build} now?`,
      ...(why === undefined ? [] : [why]),
      "Every T3 Code app closes and T3 Code (Fork) reopens once no run is active.",
    ].join(" "),
    choices: ["Install", "Not now"],
    data: { afterInstall: AFTER_INSTALL },
    timeout: ANSWER_WITHIN,
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
  // auto-install.sh waits for this run to end (it counts a workflow run while a step runs), so
  // its quit never lands mid-step. A second launch while the first waits is refused by its lock.
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

// Version 2 (Q75's notifications): version 1 never had a run, and a version names one body.
export default workflow(
  NAME,
  { version: 2, payload: Tick, triggers: [daily("08:00")] },
  Effect.fn(function* (_tick, self) {
    // Another run that owns the checkout, or null.
    const otherOwner = Effect.gen(function* () {
      const owner = Option.getOrNull(yield* OWNER.get);
      if (owner === null || owner === self.id) return null;
      const all = yield* runs({ workflow: NAME });
      return all.some((other) => other.id === owner && other.endedAt === null) ? owner : null;
    });
    const earlier = yield* step(
      "earlier-run",
      { returns: Schema.NullOr(Schema.String) },
      otherOwner,
    );
    if (earlier !== null) return yield* skip(`run ${earlier} of ${NAME} is upgrading the fork`);

    const read = yield* step.try("upstream", { returns: Upstream }, readUpstream);
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
          `It is fork/main's build; T3 Code (Fork) is still ${installed}.`,
        ),
      };
    }
    yield* title(`Upgrade the fork to ${target}?`);

    const approved = yield* askAnnounced("approve", `Upgrade the fork to ${target}?`, {
      title: upgradeQuestion(upstream, target),
      choices: ["Upgrade", "Not now"],
      data: upstream,
      timeout: ANSWER_WITHIN,
    });
    if (Option.isNone(approved) || approved.value.choice !== "Upgrade") {
      return yield* stop(`not upgraded to ${target}`);
    }
    yield* title(`Upgrading the fork ${upstream.base} → ${target}`);
    // Two runs can both have asked (a run started by hand beside the morning's): one upgrades.
    const taken = yield* step(
      "claim",
      { returns: Schema.NullOr(Schema.String) },
      store.transaction(
        Effect.tap(otherOwner, (owner) => (owner === null ? OWNER.set(self.id) : Effect.void)),
      ),
    );
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
      install: yield* install(upstream.checkout, buildVersion),
    };
  }),
);
