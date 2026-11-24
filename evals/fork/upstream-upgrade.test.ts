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
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
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
const VERSION = "0.1.12-fork.20261125.5150.1";
const FIXED_VERSION = "0.1.12-fork.20261125.5150.2";
// Builds of fork/main on BASE.
const BASE_BUILD = "0.1.12-fork.20261123.5124.2";
const BASE_OLDER = "0.1.12-fork.20261123.5124.1";
const BASE_NEWEST = "0.1.12-fork.20261123.5124.3";

const macOnly = HostProcess.Platform.defaultValue() !== "darwin";
// A durable sleep wakes at the engine's next look at its messages, 10 seconds apart on a server;
// the upstream fetch's retries sleep up to seven times.
process.env.ENTITY_MESSAGE_POLL_INTERVAL = "200 millis";
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
 * logging stand-ins for auto-install.sh and osascript (`notifyFails`: it exits 1). `unreachable`:
 * the first `tries` ssh connections fail (or `hang`); a failed fetch is tried again `retryAfterMs` on.
 */
const machine = (options: {
  readonly newer: boolean;
  readonly installed?: string;
  readonly release?: string;
  readonly unreachable?: {
    readonly tries: number;
    readonly hang?: boolean;
    readonly retryAfterMs?: number;
  };
  readonly notifyFails?: boolean;
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
  const bin = NodePath.join(root, "bin");
  const tool = (name: string, script: string) => {
    write(NodePath.join(bin, name), `#!/bin/sh\n${script}`);
    NodeFS.chmodSync(NodePath.join(bin, name), 0o755);
  };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  // Every test, so none shows a real notification: the title and the text, the last two arguments.
  const notifications = NodePath.join(root, "notifications.log");
  tool(
    "osascript",
    `printf '%s|%s\\n' "$7" "$8" >>"${notifications}"\n${options.notifyFails === true ? 'echo "not allowed" >&2\nexit 1\n' : ""}`,
  );
  const ssh = NodePath.join(root, "ssh.log");
  if (options.unreachable !== undefined) {
    const { tries, hang, retryAfterMs = 1000 } = options.unreachable;
    git(checkout, "remote", "set-url", "upstream", "ssh://example.invalid/upstream.git");
    // Found on PATH through the workflow's GIT_SSH_COMMAND. A hang outlives the fetch by seconds.
    tool(
      "ssh",
      `echo "$@" >>"${ssh}"\nif [ "$(wc -l <"${ssh}")" -le ${tries} ]; then\n${
        hang === true
          ? "  exec sleep 5\n"
          : '  echo "ssh: Could not resolve hostname example.invalid" >&2\n  exit 255\n'
      }fi\nexec git upload-pack "${upstream}"\n`,
    );
    process.env.T3_FORK_FETCH_TIMEOUT_MS = "1000";
    process.env.T3_FORK_UPSTREAM_RETRY_AFTER_MS = String(retryAfterMs);
  }
  Object.assign(process.env, gitEnv, {
    T3_FORK_CHECKOUT: checkout,
    T3_FORK_APPLICATIONS_DIR: apps,
  });
  return {
    upstream,
    origin,
    checkout,
    log,
    launches: () =>
      NodeFS.existsSync(launches) ? NodeFS.readFileSync(launches, "utf8").trim().split("\n") : [],
    ssh: () => (NodeFS.existsSync(ssh) ? NodeFS.readFileSync(ssh, "utf8").trim().split("\n") : []),
    notifications: () =>
      NodeFS.existsSync(notifications)
        ? NodeFS.readFileSync(notifications, "utf8").trim().split("\n")
        : [],
  };
};

/**
 * Q75: each question in `asks` (name → its notification's text) is announced by the step just
 * before it, which the stand-in osascript showed.
 */
const announced = Effect.fn(function* (
  workflows: Workflows.Workflows["Service"],
  runId: string,
  shownBy: ReadonlyArray<string>,
  asks: Readonly<Record<string, string>>,
) {
  const { steps } = yield* workflows.get(runId);
  const problems: Array<string> = [];
  for (const [name, text] of Object.entries(asks)) {
    const at = steps.findIndex((one) => one.kind === "ask" && one.name === name);
    const before = steps[at - 1];
    if (
      at < 1 ||
      before?.name !== `notify-${name}` ||
      JSON.stringify(before.result) !== JSON.stringify({ outcome: "done", value: text })
    ) {
      problems.push(`${name} came after ${before?.name}: ${JSON.stringify(before?.result)}`);
    }
  }
  const expected = Object.values(asks).map(
    (question) => `T3 Code (Fork)|${question} ⌘K → Open workflows`,
  );
  if (JSON.stringify(shownBy) !== JSON.stringify(expected)) {
    problems.push(`osascript showed ${JSON.stringify(shownBy)}, not ${JSON.stringify(expected)}`);
  }
  return problems;
});

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

/** A run of the 08:00 trigger, due `dueAgo` back: a question before the claim ends 23 hours on. */
const start = (workflows: Workflows.Workflows["Service"], key: string, dueAgo = Duration.zero) =>
  Effect.gen(function* () {
    const due = DateTime.subtractDuration(yield* DateTime.now, dueAgo);
    const tick = { scheduledAt: DateTime.formatIso(due) };
    const { runId } = yield* workflows.start("upstream-upgrade", tick, { idempotencyKey: key });
    return runId;
  });
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

/** One test: the workflow with `agent` for its agents; `check`'s problems. */
const gradeIt = (
  title: string,
  agent: Case["scenarios"][number]["agent"],
  check: Case["scenarios"][number]["check"],
) =>
  it.skipIf(macOnly)(title, async () => {
    const problems = await grade(file, {
      id: "fork-upstream-upgrade",
      source: "evals/fork/upstream-upgrade.ts",
      task: "",
      scenarios: [{ name: title, agent, check }],
    });
    expect(problems).toEqual([]);
  });
/** One test: the workflow in one server lifetime, with `agent` for its agents; `body`'s problems. */
const upgradeIt = (
  title: string,
  agent: Case["scenarios"][number]["agent"],
  body: (
    workflows: Workflows.Workflows["Service"],
    world: World,
  ) => Effect.Effect<ReadonlyArray<string>, Workflows.WorkflowError>,
) => gradeIt(title, agent, (world) => world.server((w) => body(w, world)));

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

/** Until the run sleeps at `name` (or ends): what it is then, and its steps. */
const asleepAt = Effect.fn(function* (
  workflows: Workflows.Workflows["Service"],
  runId: string,
  name: string,
) {
  yield* workflows
    .waitFor(runId, (run) => run.endedAt !== null || run.detail === `sleep ${name}`)
    .pipe(Effect.timeoutOption("10 seconds"));
  return yield* workflows.get(runId);
});

/**
 * Each of the run's waits between upstream fetches, `waits` of them: asleep, the run holds no
 * install (auto-install.sh's `active_runs` counts a run that is `running` or has a `step` running),
 * and it sleeps `seconds`, durably, before it wakes.
 */
const sleepsThrough = Effect.fn(function* (
  workflows: Workflows.Workflows["Service"],
  runId: string,
  waits: ReadonlyArray<number>,
  seconds = 1,
) {
  const problems: Array<string> = [];
  for (const wait of waits) {
    const name = `upstream-wait-${wait}`;
    const { run, steps } = yield* asleepAt(workflows, runId, name);
    if (run.status !== "waiting" || run.detail !== `sleep ${name}`) {
      return [...problems, `At ${name} it was ${run.status}: ${run.detail}`];
    }
    const busy = steps.filter((one) => one.status === "running" && one.kind === "step");
    if (busy.length > 0) problems.push(`Asleep at ${name}, ${busy[0]?.name} was running.`);
    const sleep = steps.find((one) => one.name === name);
    const length = Date.parse(sleep?.detail ?? "") - Date.parse(sleep?.startedAt ?? "");
    if (sleep?.kind !== "sleep" || Math.abs(length - seconds * 1000) > 500) {
      problems.push(`${name} was ${sleep?.kind} until ${sleep?.detail}, from ${sleep?.startedAt}.`);
    }
    const woke = yield* workflows
      .waitFor(runId, (run) => run.detail !== `sleep ${name}`)
      .pipe(Effect.timeoutOption("10 seconds"));
    if (Option.isNone(woke)) return [...problems, `It never woke from ${name}.`];
  }
  return problems;
});

// A Mac asleep at 08:00 (v1's only run, 2026-11-24): a fetch that fails waits and tries again, and
// a server restart while it sleeps repeats no try that ended.
gradeIt(
  "tries upstream again after a fetch fails, across a restart while it sleeps, and then asks",
  () => ({}),
  Effect.fn(function* (world) {
    // A wait long enough that the first server is gone before the run wakes.
    const m = machine({ newer: true, unreachable: { tries: 2, retryAfterMs: 3000 } });
    const runId = yield* world.server(
      Effect.fn(function* (workflows) {
        const runId = yield* start(workflows, "a");
        yield* asleepAt(workflows, runId, "upstream-wait-1");
        return runId;
      }),
    );
    // The restart came while it slept: only the first try had run.
    const before = m.ssh().length;
    return yield* world.server(
      Effect.fn(function* (workflows) {
        const problems = [
          ...(before === 1 ? [] : [`Before the restart ssh ran ${before} times.`]),
          ...(yield* sleepsThrough(workflows, runId, [2], 3)),
        ];
        const question = titleOf(yield* asked(workflows, runId, "approve"));
        if (question?.title.startsWith(`Upgrade the fork from ${BASE} to ${NEWER}?`) !== true) {
          return [...problems, `It asked ${question?.title}`];
        }
        const { steps } = yield* workflows.get(runId);
        const tries = steps
          .filter((one) => one.name.startsWith("upstream-"))
          .map(
            (one) =>
              `${one.name} ${one.kind === "sleep" ? one.status : (one.result as { outcome?: string } | null)?.outcome}`,
          );
        const expected = [
          "upstream-1 failed",
          "upstream-wait-1 completed",
          "upstream-2 failed",
          "upstream-wait-2 completed",
          "upstream-3 done",
        ];
        if (JSON.stringify(tries) !== JSON.stringify(expected)) {
          problems.push(`Its tries were ${JSON.stringify(tries)}.`);
        }
        // One connection a try: none of the three repeated.
        if (m.ssh().length !== 3) problems.push(`ssh ran ${m.ssh().length} times.`);
        yield* answer(workflows, runId, "approve", { choice: "Not now" });
        return problems;
      }),
    );
  }),
);

// R4: only the fetches reach the network; a local read that fails (here git describe, with no
// Nightly tag) stops the run at once with its reason.
upgradeIt(
  "stops at once, without trying again, when a local read fails",
  () => ({}),
  Effect.fn(function* (workflows, world) {
    const m = machine({ newer: false });
    // The checkout too: a local `clone --no-tags -b` still copies the tag its branch is on.
    for (const repository of [m.upstream, m.origin, m.checkout]) {
      git(repository, "tag", "-d", BASE, "v0.1.12-nightly.20261122.5111");
    }
    const runId = yield* start(workflows, "a");
    const ended = Option.getOrUndefined(
      yield* world.reaches(workflows, runId, "stopped", "waiting", "paused", "skipped"),
    );
    const { steps } = yield* workflows.get(runId);
    return [
      ...(ended?.status === "stopped" &&
      ended.detail?.startsWith("could not read upstream: git describe") === true
        ? []
        : [`It ended ${ended?.status}: ${ended?.detail}`]),
      ...(steps.some((one) => one.kind === "sleep") ? ["It slept to try again."] : []),
    ];
  }),
);

// R1: the reads can end late in the day; a question before the claim still ends before the next
// morning's run asks it again, and a run already past that asks nothing.
upgradeIt(
  "ends a question before the claim an hour before the next morning's run",
  () => ({}),
  Effect.fn(function* (workflows, world) {
    const m = machine({ newer: true, unreachable: { tries: 1 } });
    // Due 23 hours less 6 seconds ago: its question has 6 seconds, less the retry, to be answered.
    const late = yield* start(workflows, "late", Duration.millis(23 * 60 * 60 * 1000 - 6_000));
    const problems: Array<string> = [];
    if (Option.isNone(yield* asked(workflows, late, "approve"))) return ["It never asked."];
    // The engine's sweep, every 15 seconds, delivers the timeout.
    const ended = Option.getOrUndefined(
      yield* workflows
        .waitFor(late, (run) => run.endedAt !== null)
        .pipe(Effect.timeoutOption("30 seconds")),
    );
    const approve = (yield* workflows.get(late)).steps.find((one) => one.name === "approve");
    if (ended?.detail !== `not upgraded to ${NEWER}` || approve?.detail !== "timed out") {
      problems.push(`It ended ${ended?.status}: ${ended?.detail}; approve: ${approve?.detail}`);
    }

    // Past that hour already: it leaves the question to the next morning's run.
    const pastRun = yield* start(workflows, "past", Duration.hours(24));
    const stopped = Option.getOrUndefined(
      yield* world.reaches(workflows, pastRun, "stopped", "waiting", "paused"),
    );
    if (stopped?.status !== "stopped" || stopped.detail?.startsWith("too late to ask") !== true) {
      problems.push(`Past the hour it ended ${stopped?.status}: ${stopped?.detail}`);
    }
    if (m.notifications().length !== 1) {
      problems.push(`osascript ran ${m.notifications().length} times.`);
    }
    return problems;
  }),
);

// W2(a), W3: a fetch that hangs is cut off, and after its last try the run ends with the reason
// rather than pausing for good.
upgradeIt(
  "stops after its last try when a fetch over ssh never answers",
  () => ({}),
  Effect.fn(function* (workflows, world) {
    const m = machine({ newer: true, unreachable: { tries: 99, hang: true } });
    const runId = yield* start(workflows, "a");
    const problems = yield* sleepsThrough(workflows, runId, [1, 2, 3, 4, 5, 6, 7]);
    const ended = Option.getOrUndefined(
      yield* world.reaches(workflows, runId, "stopped", "paused", "skipped"),
    );
    const { steps } = yield* workflows.get(runId);
    return [
      ...problems,
      ...(ended?.status === "stopped" &&
      ended.detail?.startsWith("could not fetch upstream in 8 tries, 1s apart: ") === true &&
      ended.detail.includes("no answer within 1s")
        ? []
        : [`It ended ${ended?.status}: ${ended?.detail}`]),
      ...(m.ssh().length === 8 && m.ssh().every((line) => line.includes("BatchMode=yes"))
        ? []
        : [`ssh ran as: ${JSON.stringify(m.ssh())}`]),
      ...(steps.some((one) => one.name === "upstream-wait-8")
        ? ["It slept after its last try."]
        : []),
    ];
  }),
);

// Q75: a notification that cannot be shown is noted on its step; the run still asks.
upgradeIt(
  "asks even when the notification fails, and notes why on its step",
  () => ({}),
  Effect.fn(function* (workflows, world) {
    const m = machine({ newer: true, notifyFails: true });
    const runId = yield* start(workflows, "a");
    if (Option.isNone(yield* asked(workflows, runId, "approve"))) {
      return [`It never asked: ${JSON.stringify(yield* workflows.get(runId))}`];
    }
    const { steps } = yield* workflows.get(runId);
    const result = steps.find((one) => one.name === "notify-approve")?.result as
      | { outcome?: string; reason?: string }
      | null
      | undefined;
    yield* answer(workflows, runId, "approve", { choice: "Not now" });
    const ended = Option.getOrUndefined(
      yield* world.reaches(workflows, runId, "stopped", "completed", "paused"),
    );
    return [
      ...(result?.outcome === "failed" && result.reason?.includes("not allowed") === true
        ? []
        : [`notify-approve recorded ${JSON.stringify(result)}`]),
      ...(m.notifications().length === 1
        ? []
        : [`osascript ran ${m.notifications().length} times.`]),
      ...(ended?.status === "stopped" && ended.detail === `not upgraded to ${NEWER}`
        ? []
        : [`It ended ${ended?.status}: ${ended?.detail}`]),
    ];
  }),
);

// Q75: a notify step's result is kept, so a server restart that replays the run shows none again.
gradeIt(
  "shows a question's notification once, across a restart while it waits",
  () => ({}),
  Effect.fn(function* (world) {
    const m = machine({ newer: false, installed: BASE_OLDER, release: BASE_BUILD });
    const runId = yield* world.server(
      Effect.fn(function* (workflows) {
        const runId = yield* start(workflows, "a");
        yield* asked(workflows, runId, "install");
        return runId;
      }),
    );
    const before = m.notifications();
    return yield* world.server(
      Effect.fn(function* (workflows) {
        yield* answer(workflows, runId, "install", { choice: "Not now" });
        const ended = Option.getOrUndefined(
          yield* world.reaches(workflows, runId, "stopped", "completed", "paused"),
        );
        return [
          ...(before.length === 1 ? [] : [`osascript ran ${before.length} times before.`]),
          ...(JSON.stringify(m.notifications()) === JSON.stringify(before)
            ? []
            : [`After the restart osascript showed ${JSON.stringify(m.notifications())}.`]),
          ...(ended?.status === "stopped" && ended.detail?.includes("not installed") === true
            ? []
            : [`It ended ${ended?.status}: ${ended?.detail}`]),
        ];
      }),
    );
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
    problems.push(
      ...(yield* announced(workflows, runId, m.notifications(), {
        approve: `Upgrade the fork to ${NEWER}?`,
        "owner-1": `The upgrade to ${NEWER} has a question for you.`,
        blockers: `The fork on ${NEWER} has 1 blocker(s) left: go on anyway?`,
        install: `Install the fork build ${FIXED_VERSION}?`,
      })),
    );
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
