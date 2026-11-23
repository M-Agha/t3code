// Fork-only (FORK.md, "The daily upgrade workflow"): upstream-upgrade.ts beside it, loaded by the
// server's loader and driven in the real engine by workflow-authoring's grade.ts, with a stand-in
// for its agents, a git checkout whose remotes are local repositories (the fake upstream), and a
// stand-in auto-install.sh. macOS only, as the install it launches is: it reads the installed app's
// version with PlistBuddy.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { afterEach, expect, it } from "vite-plus/test";

import type * as Workflows from "../../apps/server/src/workflows/Workflows.ts";
import { type AgentTurnInput, type Case, grade, type World } from "../workflow-authoring/grade.ts";

const file = NodePath.join(import.meta.dirname, "upstream-upgrade.ts");
const BASE = "v0.1.12-nightly.20261123.5124";
const NEWER = "v0.1.12-nightly.20261125.5150";
const TICK = { scheduledAt: "2026-11-25T08:00:00.000Z" };
const VERSION = "0.1.12-fork.20261125.5150.1";
const FIXED_VERSION = "0.1.12-fork.20261125.5150.2";
// Builds of fork/main on BASE.
const BASE_BUILD = "0.1.12-fork.20261123.5124.2";
const BASE_OLDER = "0.1.12-fork.20261123.5124.1";
const BASE_NEWEST = "0.1.12-fork.20261123.5124.3";

const macOnly = HostProcess.Platform.defaultValue() !== "darwin";
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

// The user's own git config (signing, hooks, URL rewrites) stays out of the fake repositories.
const gitEnv = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, env: { ...process.env, ...gitEnv }, encoding: "utf8" },
  ).trim();
const write = (path: string, text: string) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, text);
};

/**
 * Upstream with Nightly tags (`NEWER` adds migrations 111-112), fork/main on `BASE`, the checkout,
 * and a stand-in auto-install.sh that logs each launch. `installed`: the Fork app's version;
 * `release`: the build in release/; `hang`: upstream is reached over an ssh that never answers.
 */
const machine = (options: {
  readonly newer: boolean;
  readonly installed?: string;
  readonly release?: string;
  readonly hang?: boolean;
}) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-upgrade-"));
  const upstream = NodePath.join(root, "upstream");
  const migration = (id: string) =>
    write(NodePath.join(upstream, "apps/server/src/persistence/Migrations", `${id}.ts`), "");
  NodeFS.mkdirSync(upstream);
  git(upstream, "init", "-q");
  migration("109_IssueTrackerAccounts");
  git(upstream, "add", ".");
  git(upstream, "commit", "-q", "-m", "older");
  git(upstream, "tag", "v0.1.12-nightly.20261122.5111");
  migration("110_Workflows");
  write(NodePath.join(upstream, "apps/server/src/persistence/Migrations/legacyKey.ts"), "");
  git(upstream, "add", ".");
  git(upstream, "commit", "-q", "-m", "base");
  git(upstream, "tag", BASE);
  if (options.newer) {
    migration("111_A");
    git(upstream, "add", ".");
    git(upstream, "commit", "-q", "-m", "a");
    migration("112_B");
    git(upstream, "add", ".");
    git(upstream, "commit", "-q", "-m", "b");
    git(upstream, "tag", NEWER);
  }
  const origin = NodePath.join(root, "origin");
  git(root, "clone", "-q", upstream, origin);
  git(origin, "checkout", "-q", "-b", "fork/main", BASE);
  write(NodePath.join(origin, "FORK.md"), "fork\n");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "(fork) a change");
  const checkout = NodePath.join(root, "checkout");
  git(root, "clone", "-q", "--no-tags", "-b", "fork/main", origin, checkout);
  git(checkout, "remote", "add", "upstream", upstream);
  const launches = NodePath.join(root, "launches.log");
  const log = NodePath.join(root, "auto-install_1.log");
  write(
    NodePath.join(checkout, "scripts/fork/auto-install.sh"),
    `#!/bin/sh\necho launched >>"${launches}"\necho "Started the install job."\necho "the fork installs. Log: ${log}"\n`,
  );
  NodeFS.chmodSync(NodePath.join(checkout, "scripts/fork/auto-install.sh"), 0o755);
  if (options.release !== undefined) {
    write(NodePath.join(checkout, "release", `T3-Code-${options.release}-arm64.zip`), "");
  }
  const apps = NodePath.join(root, "Applications");
  if (options.installed !== undefined) {
    write(
      NodePath.join(apps, "T3 Code (Fork).app/Contents/Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${options.installed}</string></dict></plist>`,
    );
  }
  const ssh = NodePath.join(root, "ssh.log");
  if (options.hang === true) {
    git(checkout, "remote", "set-url", "upstream", "ssh://example.invalid/upstream.git");
    // Found on PATH through the workflow's GIT_SSH_COMMAND; it outlives the fetch by a few seconds.
    write(NodePath.join(root, "bin", "ssh"), `#!/bin/sh\necho "$@" >>"${ssh}"\nexec sleep 5\n`);
    NodeFS.chmodSync(NodePath.join(root, "bin", "ssh"), 0o755);
    process.env.PATH = `${NodePath.join(root, "bin")}:${process.env.PATH}`;
    process.env.T3_FORK_FETCH_TIMEOUT_MS = "1000";
  }
  Object.assign(process.env, gitEnv, {
    T3_FORK_CHECKOUT: checkout,
    T3_FORK_APPLICATIONS_DIR: apps,
  });
  return {
    checkout,
    log,
    launches: () =>
      NodeFS.existsSync(launches) ? NodeFS.readFileSync(launches, "utf8").trim().split("\n") : [],
    ssh: () => (NodeFS.existsSync(ssh) ? NodeFS.readFileSync(ssh, "utf8") : ""),
  };
};

/** The question the run asks under `name`, once it asks it, or nothing after ten seconds. */
const asked = (workflows: Workflows.Workflows["Service"], runId: string, name: string) =>
  workflows.watch.pipe(
    Stream.filterMap((snapshot) => {
      const question = snapshot.questions.find(
        (open) => open.runId === runId && open.name === name,
      );
      return question === undefined ? Result.failVoid : Result.succeed(question);
    }),
    Stream.runHead,
    Effect.timeoutOption("10 seconds"),
    Effect.map(Option.flatten),
  );
const titleOf = (question: Option.Option<{ readonly request: unknown }>) =>
  Option.getOrUndefined(question)?.request as { title: string; data?: unknown } | undefined;
const answer = (
  workflows: Workflows.Workflows["Service"],
  runId: string,
  name: string,
  value: { readonly choice: string; readonly reason?: string },
) => workflows.signal({ runId, wait: name }, value, { id: `${runId}/${name}` });

const step = (turn: AgentTurnInput) => turn.origin.step;
const built = (pushedSha: string, buildVersion = VERSION) => ({
  outcome: "built",
  pushedSha,
  backupBranch: "fork/main-pre-5150",
  buildVersion,
  verify: { knownNoise: ["DesktopLinuxUrlHandler.test.ts (Known noise: APFS)"], newFailures: [] },
  report: "plan: two migrations, no conflicts",
});
const finding = (severity: "P1" | "P3", file: string) => ({
  severity,
  file,
  line: 12,
  scenario: `${file} breaks`,
  fix: `mend ${file}`,
  verified: true,
});

const start = (workflows: Workflows.Workflows["Service"], key: string) =>
  Effect.map(
    workflows.start("upstream-upgrade", TICK, { idempotencyKey: key }),
    ({ runId }) => runId,
  );
/** Answers Upgrade, then Install once it is asked. */
const upgradeThenInstall = Effect.fn(function* (
  workflows: Workflows.Workflows["Service"],
  runId: string,
) {
  yield* asked(workflows, runId, "approve");
  yield* answer(workflows, runId, "approve", { choice: "Upgrade" });
  const install = yield* asked(workflows, runId, "install");
  if (Option.isSome(install)) yield* answer(workflows, runId, "install", { choice: "Install" });
  return install;
});
/** An upgrade that builds `VERSION` and reviews that find nothing. */
const clean = (turn: AgentTurnInput) =>
  step(turn) === "upgrade" ? { output: built("aaa111") } : { output: { findings: [] } };

/** One test: the workflow in a server of its own, with `agent` for its agents; `body`'s problems. */
const upgradeIt = (
  title: string,
  agent: Case["scenarios"][number]["agent"],
  body: (
    workflows: Workflows.Workflows["Service"],
    world: World,
  ) => Effect.Effect<ReadonlyArray<string>, Workflows.WorkflowError>,
) =>
  it.skipIf(macOnly)(title, async () => {
    const problems = await grade(file, {
      id: "fork-upstream-upgrade",
      source: "evals/fork/upstream-upgrade.ts",
      task: "",
      scenarios: [{ name: title, agent, check: (world) => world.server((w) => body(w, world)) }],
    });
    expect(problems).toEqual([]);
  });

upgradeIt(
  "skips quietly when no Nightly is newer and fork/main's build is installed",
  () => ({}),
  Effect.fn(function* (workflows, world) {
    machine({ newer: false, installed: BASE_BUILD, release: BASE_BUILD });
    const runId = yield* start(workflows, "a");
    const run = Option.getOrUndefined(
      yield* world.reaches(workflows, runId, "skipped", "stopped", "paused"),
    );
    return [
      ...(run?.status === "skipped" && run.detail === `the fork is on the newest Nightly, ${BASE}`
        ? []
        : [`It ended ${run?.status}: ${run?.detail}`]),
      ...(world.turns.length === 0 ? [] : ["It started an agent."]),
      ...((yield* workflows.questions).length === 0 ? [] : ["It asked a question."]),
    ];
  }),
);

// W6: an install that was launched and failed leaves the Fork app older than fork/main's build.
upgradeIt(
  "with no newer Nightly offers fork/main's build when the Fork app is older, and launches it",
  () => ({}),
  Effect.fn(function* (workflows, world) {
    const m = machine({ newer: false, installed: BASE_OLDER, release: BASE_BUILD });
    const runId = yield* start(workflows, "a");
    const problems: Array<string> = [];
    const question = titleOf(yield* asked(workflows, runId, "install"));
    if (question?.title.startsWith(`Install the fork build ${BASE_BUILD} now?`) !== true) {
      return [`It asked ${question?.title}`];
    }
    yield* answer(workflows, runId, "install", { choice: "Install" });
    const ended = Option.getOrUndefined(
      yield* world.reaches(workflows, runId, "completed", "stopped", "paused"),
    );
    const result = ended?.result as { install?: string } | null | undefined;
    if (result?.install !== `launched, not confirmed: ${m.log}`) {
      problems.push(`It ended ${ended?.status} with ${JSON.stringify(result)}`);
    }
    if (m.launches().length !== 1) problems.push(`It launched ${m.launches().length} times.`);
    return problems;
  }),
);

// C2: a build the owner answered Not now is not offered each morning; a newer one is.
upgradeIt(
  "offers fork/main's build no more once answered Not now, and offers a newer build",
  () => ({}),
  Effect.fn(function* (workflows, world) {
    const m = machine({ newer: false, installed: BASE_OLDER, release: BASE_BUILD });
    const problems: Array<string> = [];
    const first = yield* start(workflows, "first");
    if (Option.isNone(yield* asked(workflows, first, "install"))) return ["It never asked."];
    yield* answer(workflows, first, "install", { choice: "Not now" });
    yield* world.reaches(workflows, first, "stopped", "completed", "paused");

    const second = yield* start(workflows, "second");
    const quiet = Option.getOrUndefined(
      yield* world.reaches(workflows, second, "skipped", "waiting", "paused"),
    );
    if (quiet?.status !== "skipped") {
      problems.push(`After Not now it ended ${quiet?.status}: ${quiet?.detail}`);
    }

    // A newer build of fork/main, the one install.sh would take (`ls -t`).
    const zip = NodePath.join(m.checkout, "release", `T3-Code-${BASE_NEWEST}-arm64.zip`);
    write(zip, "");
    // Newer than the first by mtime even within the same millisecond: 2100-01-01.
    NodeFS.utimesSync(zip, 4_102_444_800, 4_102_444_800);
    const third = yield* start(workflows, "third");
    const question = titleOf(yield* asked(workflows, third, "install"));
    if (question?.title.startsWith(`Install the fork build ${BASE_NEWEST} now?`) !== true) {
      problems.push(`For a newer build it asked ${question?.title}`);
    }
    yield* answer(workflows, third, "install", { choice: "Not now" });
    return problems;
  }),
);

// W2(b), C1: a run owns the checkout only once answered Upgrade, only until it ends, and of two
// runs answered Upgrade only the first answered upgrades.
upgradeIt(
  "asks with the commits and migrations, and upgrades in one run at a time",
  (turn) =>
    step(turn) === "upgrade"
      ? { output: { outcome: "needs-owner", question: "Keep upstream's side?" } }
      : { ending: "failed" as const, detail: `no stand-in for ${step(turn)}` },
  Effect.fn(function* (workflows, world) {
    machine({ newer: true });
    const problems: Array<string> = [];
    const first = yield* start(workflows, "first");
    const expected = `Upgrade the fork from ${BASE} to ${NEWER}? (2 upstream commits, migrations 111-112)`;
    const title = titleOf(yield* asked(workflows, first, "approve"))?.title;
    if (title !== expected) problems.push(`It asked ${title}, not ${expected}`);

    // A run that only asks does not hold the next one.
    const second = yield* start(workflows, "second");
    if (Option.isNone(yield* asked(workflows, second, "approve"))) {
      problems.push("A run that only asked held the next one.");
    }

    // Both answered Upgrade, the later-started one first: it upgrades, the other stops.
    yield* answer(workflows, second, "approve", { choice: "Upgrade" });
    if (Option.isNone(yield* asked(workflows, second, "owner-1"))) {
      problems.push("The upgrade's question was never asked.");
    }
    yield* answer(workflows, first, "approve", { choice: "Upgrade" });
    const lost = Option.getOrUndefined(
      yield* world.reaches(workflows, first, "stopped", "completed", "paused"),
    );
    if (lost?.detail !== `run ${second} took the checkout first`) {
      problems.push(`The run answered second ended ${lost?.status}: ${lost?.detail}`);
    }
    const upgrades = world.turns.filter((turn) => step(turn) === "upgrade").length;
    if (upgrades !== 1) problems.push(`${upgrades} upgrade agents ran.`);

    // Upgrading and waiting on the owner: it holds the next one.
    const third = yield* start(workflows, "third");
    const skipped = Option.getOrUndefined(
      yield* world.reaches(workflows, third, "skipped", "waiting", "paused"),
    );
    if (skipped?.detail !== `run ${second} of upstream-upgrade is upgrading the fork`) {
      problems.push(`The third run ended ${skipped?.status}: ${skipped?.detail}`);
    }

    // Ended, it holds nothing.
    yield* answer(workflows, second, "owner-1", { choice: "Stop" });
    const stopped = Option.getOrUndefined(
      yield* world.reaches(workflows, second, "stopped", "completed", "paused"),
    );
    if (stopped?.status !== "stopped") problems.push(`Stop ended ${stopped?.status}.`);
    const fourth = yield* start(workflows, "fourth");
    if (Option.isNone(yield* asked(workflows, fourth, "approve"))) {
      problems.push("An ended run held the next one.");
    }
    yield* answer(workflows, fourth, "approve", { choice: "Not now" });
    const notNow = Option.getOrUndefined(
      yield* world.reaches(workflows, fourth, "stopped", "completed", "paused"),
    );
    if (notNow?.status !== "stopped") problems.push(`Not now ended ${notNow?.status}.`);
    return problems;
  }),
);

// W2(a), W3: a fetch that hangs is cut off, and the run ends rather than pausing for good.
upgradeIt(
  "ends the run when a fetch over ssh stops answering",
  () => ({}),
  Effect.fn(function* (workflows, world) {
    const m = machine({ newer: true, hang: true });
    const runId = yield* start(workflows, "a");
    const ended = Option.getOrUndefined(
      yield* world.reaches(workflows, runId, "stopped", "paused", "skipped"),
    );
    return [
      ...(ended?.status === "stopped" &&
      ended.detail?.startsWith("could not read upstream: ") === true &&
      ended.detail.includes("no answer within 1s")
        ? []
        : [`It ended ${ended?.status}: ${ended?.detail}`]),
      ...(m.ssh().includes("BatchMode=yes") ? [] : [`ssh ran as: ${m.ssh()}`]),
    ];
  }),
);

upgradeIt(
  "upgrades, asks the agent's question, reviews, fixes, asks about a P1 left, then launches the install",
  (turn) => {
    switch (step(turn)) {
      case "upgrade":
        return {
          output: { outcome: "needs-owner", question: "Keep upstream's side? My pick is yes." },
        };
      case "upgrade-1":
        return { output: built("aaa111") };
      case "review-correctness":
        return { output: { findings: [finding("P1", "apps/server/src/a.ts")] } };
      case "review-simplicity":
        return { output: { findings: [finding("P3", "FORK.md")] } };
      case "fix":
        return {
          output: {
            pushedSha: "bbb222",
            buildVersion: FIXED_VERSION,
            verify: { knownNoise: [], newFailures: [] },
            answers: [
              { id: "C1", outcome: "open", note: "needs the owner's call" },
              { id: "S1", outcome: "fixed", note: "done" },
            ],
          },
        };
      default:
        return { ending: "failed" as const, detail: `no stand-in for ${step(turn)}` };
    }
  },
  Effect.fn(function* (workflows, world) {
    const m = machine({ newer: true, installed: VERSION, release: FIXED_VERSION });
    const runId = yield* start(workflows, "a");
    const problems: Array<string> = [];
    const answered = function* (name: string, choice: string, reason?: string) {
      const question = titleOf(yield* asked(workflows, runId, name));
      if (question === undefined) {
        problems.push(`It never asked ${name}.`);
        return { title: "", data: undefined };
      }
      yield* answer(workflows, runId, name, {
        choice,
        ...(reason === undefined ? {} : { reason }),
      });
      return question;
    };
    yield* answered("approve", "Upgrade");
    const question = (yield* answered("owner-1", "Go on", "Keep both sides.")).title;
    if (!question.includes("Keep upstream's side? My pick is yes.")) {
      problems.push(`The agent's question was asked as: ${question}`);
    }
    const blockers = (yield* answered("blockers", "Go on")).title;
    if (
      !blockers.includes("1 blocker(s)") ||
      !blockers.includes("C1 apps/server/src/a.ts: needs the owner's call")
    ) {
      problems.push(`The P1 left was asked as: ${blockers}`);
    }
    const install = yield* answered("install", "Install");
    if (!install.title.startsWith(`Install the fork build ${FIXED_VERSION} now? Every`)) {
      problems.push(`The install was asked as: ${install.title}`);
    }
    // W7: the skill's step 6 travels with the question.
    if (!JSON.stringify(install.data).includes("head -12 ~/.t3/bin/t3")) {
      problems.push(`The install question carries ${JSON.stringify(install.data)}`);
    }
    const ended = Option.getOrUndefined(
      yield* world.reaches(workflows, runId, "completed", "stopped", "paused"),
    );
    if (ended?.status !== "completed") {
      return [...problems, `It ended ${ended?.status}: ${ended?.detail}`];
    }
    const result = ended.result as { install?: string } | null;
    if (result?.install !== `launched, not confirmed: ${m.log}`) {
      problems.push(`It returned ${JSON.stringify(result)}`);
    }
    const turns = world.turns;
    const order = turns.map(step);
    if (
      order[0] !== "upgrade" ||
      order[1] !== "upgrade-1" ||
      order.slice(2, 4).toSorted().join() !== "review-correctness,review-simplicity" ||
      order[4] !== "fix" ||
      order.length !== 5
    ) {
      problems.push(`Its agents ran as ${order.join(", ")}.`);
    }
    const first = turns[0]!;
    if (first.project !== m.checkout || first.model?.model !== "claude-opus-5-5") {
      problems.push(`The upgrade started in ${first.project} on ${first.model?.model}.`);
    }
    // W9, W5: the skill by path, what the workflow adds, and no review of its own.
    for (const words of [
      `Run /t3code-fork upgrade ${NEWER} steps 1-5 (~/repos/agent-skills/t3code-fork/SKILL.md)`,
      "STOP BEFORE",
      "start no review yourself",
    ]) {
      if (!first.prompt.includes(words)) problems.push(`The upgrade's brief lacks "${words}".`);
    }
    const own = `thread-${first.key}`;
    for (const later of turns.filter((turn) => ["upgrade-1", "fix"].includes(step(turn)))) {
      if (later.thread !== own) {
        problems.push(`${step(later)} did not continue the upgrade's thread.`);
      }
    }
    if (!turns[1]!.prompt.includes("The owner answered: Keep both sides.")) {
      problems.push("The owner's answer did not reach the agent.");
    }
    for (const review of turns.filter((turn) => step(turn).startsWith("review-"))) {
      if (
        review.thread !== undefined ||
        review.model?.model !== "claude-opus-5-5" ||
        !review.prompt.includes(`range-diff ${BASE}..fork/main-pre-5150 ${NEWER}..aaa111`) ||
        !review.prompt.includes("submit your result only when you are done")
      ) {
        problems.push(`${step(review)} is not a new Opus thread reading the range-diff.`);
      }
    }
    const fix = turns[4]!.prompt;
    if (
      !fix.includes("C1 (P1, verified) apps/server/src/a.ts:12") ||
      !fix.includes("S1 (P3") ||
      !fix.includes("start no review yourself")
    ) {
      problems.push(`The fix brief lacks the findings: ${fix}`);
    }
    // The installed app is the first build, not the fixed one: launched once.
    if (m.launches().length !== 1) {
      problems.push(`auto-install.sh ran ${m.launches().length} times.`);
    }
    return problems;
  }),
);

upgradeIt(
  "with no findings goes straight to the install question, and launches nothing for a build already installed",
  clean,
  Effect.fn(function* (workflows, world) {
    const m = machine({ newer: true, installed: VERSION, release: VERSION });
    const runId = yield* start(workflows, "a");
    if (Option.isNone(yield* upgradeThenInstall(workflows, runId))) {
      return ["It never asked to install."];
    }
    const ended = Option.getOrUndefined(
      yield* world.reaches(workflows, runId, "completed", "stopped", "paused"),
    );
    const result = ended?.result as { install?: string } | null | undefined;
    return [
      ...(world.turns.map(step).includes("fix") ? ["It ran a fix with no findings."] : []),
      ...(ended?.status === "completed" && result?.install === `${VERSION} is already installed`
        ? []
        : [`It ended ${ended?.status} with ${JSON.stringify(result)}`]),
      ...(m.launches().length === 0 ? [] : ["It launched auto-install.sh."]),
    ];
  }),
);

// W4: "Install build X?" never installs another build that happens to be in release/.
upgradeIt(
  "stops rather than install a release/ build other than the one asked about",
  clean,
  Effect.fn(function* (workflows, world) {
    const m = machine({ newer: true, installed: BASE_BUILD, release: FIXED_VERSION });
    const runId = yield* start(workflows, "a");
    yield* upgradeThenInstall(workflows, runId);
    const ended = Option.getOrUndefined(
      yield* world.reaches(workflows, runId, "completed", "stopped", "paused"),
    );
    const expected = `not installed: release/ holds ${FIXED_VERSION}, not ${VERSION}; nothing launched`;
    return [
      ...(ended?.status === "stopped" && ended.detail?.includes(expected) === true
        ? []
        : [`It ended ${ended?.status}: ${ended?.detail}`]),
      ...(m.launches().length === 0 ? [] : ["It launched auto-install.sh."]),
    ];
  }),
);

// W8: a build version that is not a fork version is never asked about or installed.
upgradeIt(
  "pauses on a build version that is not a fork version",
  (turn) =>
    step(turn) === "upgrade"
      ? { output: built("aaa111", "0.1.12-nightly.20261125.5150") }
      : { output: { findings: [] } },
  Effect.fn(function* (workflows, world) {
    machine({ newer: true });
    const runId = yield* start(workflows, "a");
    yield* asked(workflows, runId, "approve");
    yield* answer(workflows, runId, "approve", { choice: "Upgrade" });
    const ended = Option.getOrUndefined(
      yield* world.reaches(workflows, runId, "paused", "completed", "stopped"),
    );
    return [
      ...(ended?.status === "paused" && ended.detail?.includes("buildVersion") === true
        ? []
        : [`It ended ${ended?.status}: ${ended?.detail}`]),
      ...(world.turns.map(step).some((name) => name.startsWith("review-"))
        ? ["It reviewed a build with a bad version."]
        : []),
    ];
  }),
);
