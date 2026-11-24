// Fork-only (FORK.md, "Background service"). `t3 service install` must work from the fork app and keep
// working after every fork rebuild, with no "-fork." release to download.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { vi } from "vite-plus/test";

import { installCli } from "../cli/install.ts";
import { reconcileService } from "../cli/service.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as BootService from "./bootService.ts";
import { FORK_LEAVE_ENV } from "./forkLeaveGuard.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimePaths,
  prunePinnedRuntimes,
} from "./pinnedRuntime.ts";
import {
  compareExactServiceVersions,
  isExactServiceVersion,
  parseServiceState,
} from "./serviceProtocol.ts";

// Versions as scripts/fork/build.sh stamps them: the upstream tag's, then the build number.
const versions = vi.hoisted(() => {
  const tag = "0.1.11-fork.20261118.4864";
  return { tag, earlier: `${tag}.20261119080000`, current: `${tag}.20261120093700` };
});
// This CLI is the current fork build, as APP_VERSION stamps it into a built one.
vi.mock("../../package.json", async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  return { default: { ...actual.default, version: versions.current } };
});

const repoRoot = new URL("../../../../", import.meta.url).pathname;
const seedScript = `${repoRoot}scripts/fork/seed-runtime.sh`;
const skipOnWindows = HostProcess.Platform.defaultValue() === "win32";
const printsVersion = (version: string) => `#!/bin/sh\necho "t3 v${version}"\n`;

// What a stand-in appended to a log, one entry per line; none when it never ran.
const lines = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file).pipe(
      Effect.map((text) => text.split("\n").filter((line) => line !== "")),
      Effect.orElseSucceed((): Array<string> => []),
    );
  });

const fakeResult = (stdout = "", code = 0) => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

/**
 * Runs scripts/fork/seed-runtime.sh with `home` as HOME, so into `<home>/.t3`, on an archive laid out
 * as build-cli-archive.ts writes one.
 */
const seed = Effect.fn(function* (
  home: string,
  script: string,
  version = versions.current,
  env: Record<string, string> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-seed-" });
  const stem = `t3-${version}-darwin-arm64`;
  yield* fs.makeDirectory(path.join(scratch, stem));
  yield* fs.writeFileString(path.join(scratch, stem, "t3"), script);
  yield* fs.chmod(path.join(scratch, stem, "t3"), 0o755);
  const archive = path.join(scratch, `${stem}.tar.gz`);
  yield* runner.run({ command: "tar", args: ["-czf", archive, "-C", scratch, stem] });
  return yield* runner.run({
    command: seedScript,
    args: [version, archive],
    env: { HOME: home, ...env },
  });
});

it.layer(NodeServices.layer)("scripts/fork/seed-runtime.sh", (it) => {
  it.effect.skipIf(skipOnWindows)(
    "never replaces a runtime already at that version, and refuses one it did not finish",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-home-" });
        const t3Home = path.join(home, ".t3");
        const first = printsVersion(versions.current);
        // Always ~/.t3, the home an app opened from Finder uses, whatever the shell says.
        const elsewhere = path.join(home, "elsewhere");
        assert.equal(
          (yield* seed(home, first, versions.current, { T3CODE_HOME: elsewhere })).code,
          0,
        );
        assert.isFalse(yield* fs.exists(elsewhere));
        const again = yield* seed(home, `#!/bin/sh\n# another\necho "t3 v${versions.current}"\n`);
        assert.equal(again.code, 0, again.stderr);
        const entry = pinnedRuntimePaths(path, t3Home, versions.current, "darwin").entryPath;
        assert.equal(yield* fs.readFileString(entry), first);

        // A directory at the version without the sentinel is not this script's: leave it be.
        const other = path.join(t3Home, "runtime", "versions", versions.earlier);
        yield* fs.makeDirectory(other, { recursive: true });
        yield* fs.writeFileString(path.join(other, "keep"), "mine");
        const refused = yield* seed(home, printsVersion(versions.earlier), versions.earlier);
        assert.notEqual(refused.code, 0);
        assert.deepEqual(yield* fs.readDirectory(other), ["keep"]);

        // FORK.md's fork version rule: the prerelease starts with "fork.".
        const notFork = "0.1.11-nightly.20261119-fork.1";
        assert.include(
          (yield* seed(home, printsVersion(notFork), notFork)).stderr,
          "not a fork version",
        );
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect.skipIf(skipOnWindows)(
    "keeps the runtime `t3 install` names through a service restart's prune, and only that one",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-home-" });
        const t3Home = path.join(home, ".t3");
        const oldest = `${versions.tag}.20261118080000`;
        for (const version of [oldest, versions.earlier, versions.current]) {
          assert.equal((yield* seed(home, printsVersion(version), version)).code, 0);
        }
        // install.sh, once the current build's app is in place.
        const runtime = pinnedRuntimePaths(path, t3Home, versions.current, "darwin").entryPath;
        yield* installCli().pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.IsExecutable, true),
          Effect.provideService(HostProcess.ExecutablePath, runtime),
          Effect.provideService(HostProcess.Environment, {
            T3CODE_INSTALL_BIN_DIR: path.join(t3Home, "runtime", "fork-bin"),
          }),
        );
        // It writes its launcher and the record of it, and nothing else.
        assert.deepEqual(yield* fs.readDirectory(t3Home), ["runtime"]);
        assert.deepEqual((yield* fs.readDirectory(path.join(t3Home, "runtime"))).toSorted(), [
          "fork-bin",
          "launchers",
          "versions",
        ]);
        // The service still runs the earlier build; the current one was seeded over an hour ago.
        yield* fs.writeFileString(
          path.join(t3Home, "runtime", "service-state.json"),
          JSON.stringify({ protocol: 4, activeVersion: versions.earlier }),
        );
        const now = Date.UTC(2026, 10, 20, 12);
        yield* TestClock.setTime(now);
        // Node reads a number as seconds.
        const twoHoursAgo = (now - 7_200_000) / 1000;
        for (const version of [oldest, versions.earlier, versions.current]) {
          const sentinel = path.join(t3Home, "runtime", "versions", version, ".install-complete");
          yield* fs.utimes(sentinel, twoHoursAgo, twoHoursAgo);
        }

        const removed = yield* prunePinnedRuntimes({ baseDir: t3Home, keep: [] }).pipe(
          Effect.provideService(
            ProcessRunner.ProcessRunner,
            ProcessRunner.ProcessRunner.of({ run: () => Effect.succeed(fakeResult("p1\n")) }),
          ),
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Environment, {}),
        );

        assert.deepEqual(removed, [oldest]);
        assert.deepEqual(
          (yield* fs.readDirectory(path.join(t3Home, "runtime", "versions"))).toSorted(),
          [versions.earlier, versions.current],
        );
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect.skipIf(skipOnWindows)(
    "publishes only a runtime that runs, and never into a name something else took",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const pathEnv = (yield* HostProcess.Environment).PATH ?? "";
        // tar unpacks the archive, then does what the case says.
        const seedWithTar = Effect.fn(function* (after: string) {
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-home-" });
          const bin = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-bin-" });
          yield* fs.writeFileString(
            path.join(bin, "tar"),
            `#!/bin/sh\n/usr/bin/tar "$@" && ${after}\n`,
          );
          yield* fs.chmod(path.join(bin, "tar"), 0o755);
          const result = yield* seed(home, printsVersion(versions.current), versions.current, {
            PATH: `${bin}:${pathEnv}`,
          });
          return {
            result,
            target: path.join(home, ".t3", "runtime", "versions", versions.current),
          };
        });

        // Another seed publishes the version while this one unpacks: its runtime stays as it is.
        const raced = yield* seedWithTar(
          `mkdir -p "$HOME/.t3/runtime/versions/${versions.current}" && echo mine >"$HOME/.t3/runtime/versions/${versions.current}/keep"`,
        );
        assert.notEqual(raced.result.code, 0);
        assert.include(raced.result.stderr, "something took that name");
        assert.deepEqual(yield* fs.readDirectory(raced.target), ["keep"]);

        // An archive whose t3 does not run is refused before it takes the version's name.
        const broken = yield* seedWithTar(`chmod -x "$4/t3"`);
        assert.notEqual(broken.result.code, 0);
        assert.include(broken.result.stderr, "holds no executable t3");
        assert.isFalse(yield* fs.exists(broken.target));
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );
});

it.layer(NodeServices.layer)("scripts/fork/build.sh", (it) => {
  // A repo with only what build.sh reads, a mise that logs each step instead of building, and a clock
  // that says what the test says.
  const buildRepo = Effect.fn(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-build-" });
    const repo = path.join(root, "repo");
    const bin = path.join(root, "bin");
    yield* fs.makeDirectory(path.join(repo, "scripts", "fork"), { recursive: true });
    yield* fs.copyFile(
      `${repoRoot}scripts/fork/build.sh`,
      path.join(repo, "scripts/fork/build.sh"),
    );
    yield* fs.writeFileString(path.join(repo, ".env"), "T3_CONNECT_KEY=pk_live_test\n");
    yield* fs.writeFileString(path.join(repo, ".gitignore"), "release/\n");
    const monitor = path.join(repo, "native/resource-monitor/target/aarch64-apple-darwin/release");
    yield* fs.makeDirectory(monitor, { recursive: true });
    yield* fs.writeFileString(path.join(monitor, "t3-resource-monitor"), "");
    yield* fs.makeDirectory(path.join(repo, "release"));
    yield* fs.makeDirectory(bin);
    const tool = (name: string, body: string) =>
      fs
        .writeFileString(path.join(bin, name), `#!/bin/bash\n${body}`)
        .pipe(Effect.andThen(fs.chmod(path.join(bin, name), 0o755)));
    yield* tool("jq", "echo 26.13.1\n");
    yield* tool("date", 'case "$1" in -u) echo "$FAKE_UTC" ;; *) echo 20261120_120000 ;; esac\n');
    yield* tool(
      "mise",
      [
        "shift 3",
        'echo "desktop=${T3CODE_DESKTOP_VERSION-} app=${APP_VERSION-} $*" >>"$MISE_LOG"',
        'case "$*" in',
        '  *"vp i"*) echo "CI=${CI-}" >>"$MISE_LOG"; [ -z "${VP_I_FAILS-}" ] || exit 1 ;;',
        '  *dist:desktop*) [ -z "${MOVE_HEAD-}" ] || git -c user.name=t -c user.email=t@t commit -q --allow-empty -m moved ;;',
        "  *build-cli-archive.ts*)",
        '    while [ $# -gt 0 ]; do case "$1" in --version) v="$2" ;; --output-dir) o="$2" ;; esac; shift; done',
        '    mkdir -p "$o/t3-$v-darwin-arm64" && tar -czf "$o/t3-$v-darwin-arm64.tar.gz" -C "$o" "t3-$v-darwin-arm64" ;;',
        "esac",
        "",
      ].join("\n"),
    );
    const git = (...args: Array<string>) =>
      runner.run({
        command: "git",
        args: ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
        cwd: repo,
        env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
    yield* git("init", "-q");
    yield* git("add", "-A");
    yield* git("commit", "-q", "-m", "x");
    yield* git("tag", `v${versions.tag.replace("-fork.", "-nightly.")}`);
    return { root, repo, bin };
  });

  const build = Effect.fn(function* (
    built: { root: string; repo: string; bin: string },
    options: { utc?: string; moveHead?: boolean; vpIFails?: boolean } = {},
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const log = path.join(built.root, "mise.log");
    yield* fs.writeFileString(log, "");
    const result = yield* runner.run({
      command: path.join(built.repo, "scripts/fork/build.sh"),
      args: [],
      env: {
        HOME: built.root,
        PATH: `${built.bin}:/usr/bin:/bin`,
        MISE_LOG: log,
        FAKE_UTC: options.utc ?? "20261120120000",
        MOVE_HEAD: options.moveHead === true ? "1" : undefined,
        VP_I_FAILS: options.vpIFails === true ? "1" : undefined,
        CI: undefined,
        GIT_CONFIG_GLOBAL: "/dev/null",
        // The test runner sets APP_VERSION; a shell running build.sh does not.
        APP_VERSION: undefined,
        T3CODE_DESKTOP_VERSION: undefined,
      },
      timeout: Duration.seconds(60),
    });
    const release = yield* fs.readDirectory(path.join(built.repo, "release"));
    const version = /^t3-(.+)-darwin-arm64\.tar\.gz$/.exec(release[0] ?? "")?.[1] ?? "";
    return { result, release, version, log: (yield* fs.readFileString(log)).split("\n") };
  });

  it.effect.skipIf(skipOnWindows)(
    "stamps every build with a newer version, the same for the app and its runtime",
    () =>
      Effect.gen(function* () {
        const built = yield* buildRepo();
        const runner = yield* ProcessRunner.ProcessRunner;
        const headOf = runner
          .run({ command: "git", args: ["rev-parse", "HEAD"], cwd: built.repo })
          .pipe(Effect.map((out) => out.stdout.trim()));
        const head = yield* headOf;
        // HEAD moves during the build (a commit in another terminal).
        const { result, release, version, log } = yield* build(built, { moveHead: true });
        assert.equal(result.code, 0, result.stderr);
        assert.notEqual(yield* headOf, head);
        assert.deepEqual(release, [`t3-${version}-darwin-arm64.tar.gz`]);
        assert.equal(version, `${versions.tag}.20261120120000`);
        assert.isTrue(isExactServiceVersion(version));
        assert.equal(compareExactServiceVersions(version, versions.tag), 1);
        const steps = log.join("\n");
        // The dependencies first, of the commit being built: pnpm install with no terminal and the
        // lockfile as committed.
        assert.deepEqual(
          log.slice(0, 2),
          ["desktop= app= node_modules/.bin/vp i --frozen-lockfile", "CI=true"],
          steps,
        );
        assert.isTrue(
          log.some((line) => line.startsWith(`desktop=${version} app= `)),
          steps,
        );
        assert.isTrue(
          log.some((line) => line.includes(`app=${version} `) && line.includes("build-exe")),
          steps,
        );
        assert.isTrue(
          log.some((line) => line.includes(`--version ${version} `)),
          steps,
        );
        assert.isTrue(
          log.some((line) => line.includes(`--expect-version ${version}`)),
          steps,
        );
        // The installer role's record: this version was built from the HEAD it started at.
        const fs = yield* FileSystem.FileSystem;
        assert.equal(
          yield* fs.readFileString(`${built.repo}/.git/fork-builds`),
          `${version} ${head}\n`,
        );
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect.skipIf(skipOnWindows)(
    "gives a newer version to a build in the same second, and after the clock went back",
    () =>
      Effect.gen(function* () {
        const repo = yield* buildRepo();
        const first = yield* build(repo);
        const second = yield* build(repo);
        const third = yield* build(repo, { utc: "20261101000000" });
        for (const { result } of [first, second, third])
          assert.equal(result.code, 0, result.stderr);
        assert.equal(compareExactServiceVersions(second.version, first.version), 1);
        assert.equal(compareExactServiceVersions(third.version, second.version), 1);
        // A later time still wins over the count.
        const fourth = yield* build(repo, { utc: "20261121000000" });
        assert.equal(fourth.version, `${versions.tag}.20261121000000`);

        // Another build holds the lock: this one gives up at once and leaves the lock to its owner.
        const fs = yield* FileSystem.FileSystem;
        const lock = `${repo.repo}/.git/fork-build-number.lock`;
        yield* fs.makeDirectory(lock);
        const blocked = yield* build(repo);
        assert.include(blocked.result.stderr, "is held");
        assert.isTrue(yield* fs.exists(lock));
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  // R3: vp i runs before the build number is taken and release/ is touched.
  it.effect.skipIf(skipOnWindows)(
    "leaves release/ and the build number as they were when vp i fails",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const built = yield* buildRepo();
        const previous = `${built.repo}/release/T3-Code-${versions.tag}.1-arm64.zip`;
        yield* fs.writeFileString(previous, "");
        const failed = yield* build(built, { vpIFails: true });
        assert.notEqual(failed.result.code, 0);
        assert.deepEqual(failed.release, [`T3-Code-${versions.tag}.1-arm64.zip`]);
        assert.isFalse(yield* fs.exists(`${built.repo}/.git/fork-build-number`));
        assert.isFalse(yield* fs.exists(`${built.root}/.claude/trash`));
        assert.isFalse(
          yield* fs.readLink(`${built.repo}/.git/fork-build.running`).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        );
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  // R4: one build at a time in a checkout, for the whole run.
  it.effect.skipIf(skipOnWindows)(
    "refuses while another build of the checkout runs, and takes over a lock whose build is gone",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const runner = yield* ProcessRunner.ProcessRunner;
        const built = yield* buildRepo();
        const running = `${built.repo}/.git/fork-build.running`;

        // This test's own pid: alive.
        yield* fs.symlink(String(process.pid), running);
        const refused = yield* build(built);
        assert.notEqual(refused.result.code, 0);
        assert.include(
          refused.result.stderr,
          `another build runs in ${built.repo} (pid ${process.pid}`,
        );
        assert.equal(yield* fs.readLink(running), String(process.pid));
        assert.deepEqual(refused.log, [""]);

        // A pid that has ended: its lock is taken over, and gone once the build is done.
        const ended = yield* runner.run({ command: "/bin/sh", args: ["-c", "echo $$"] });
        yield* fs.remove(running);
        yield* fs.symlink(ended.stdout.trim(), running);
        const after = yield* build(built);
        assert.equal(after.result.code, 0, after.result.stderr);
        assert.include(
          after.result.stdout,
          `Removing a build lock left by pid ${ended.stdout.trim()}`,
        );
        // The link, not what it names (a pid, no file).
        assert.isFalse(
          yield* fs.readLink(running).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        );
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );
});

it.layer(NodeServices.layer)("scripts/fork/install.sh", (it) => {
  const appName = "T3 Code (Fork).app";
  const plistOf = (entries: string) =>
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      `<plist version="1.0"><dict>${entries}</dict></plist>`,
      "",
    ].join("\n");
  const plist = (version: string) =>
    plistOf(`<key>CFBundleShortVersionString</key><string>${version}</string>`);

  // The two scripts and a release/, a HOME with a database, and stand-ins: pgrep (an app runs while
  // $HOME/app-running exists), launchctl (loaded while $HOME/service-loaded exists; logged), mise
  // (runs the rest with this node; APP_STARTS=seed starts an app first), open (logged to events.log,
  // fails with OPEN_FAILS=1), mv (KILL_AFTER_ASIDE=1 kills install.sh once the old app is trashed).
  const machine = Effect.fn(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-install-" });
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    const apps = path.join(root, "Applications");
    const bin = path.join(root, "bin");
    const t3Home = path.join(home, ".t3");
    for (const dir of [path.join(repo, "scripts", "fork"), path.join(repo, "release"), apps, bin]) {
      yield* fs.makeDirectory(dir, { recursive: true });
    }
    yield* fs.makeDirectory(path.join(t3Home, "userdata"), { recursive: true });
    yield* fs.makeDirectory(path.join(t3Home, "bin"));
    yield* fs.makeDirectory(path.join(home, "Library", "LaunchAgents"), { recursive: true });
    for (const file of [
      "scripts/fork/install.sh",
      "scripts/fork/seed-runtime.sh",
      "evals/fork/upstream-upgrade.ts",
    ]) {
      yield* fs.makeDirectory(path.dirname(path.join(repo, file)), { recursive: true });
      yield* fs.copyFile(`${repoRoot}${file}`, path.join(repo, file));
    }
    yield* fs.writeFileString(
      path.join(repo, "package.json"),
      JSON.stringify({ engines: { node: "26.13.1" } }),
    );
    yield* runner.run({
      command: "sqlite3",
      args: [
        path.join(t3Home, "userdata", "statev2.sqlite"),
        "create table t (x); insert into t values (1);",
      ],
    });
    const tool = (name: string, body: string) =>
      fs
        .writeFileString(path.join(bin, name), `#!/bin/bash\n${body}\n`)
        .pipe(Effect.andThen(fs.chmod(path.join(bin, name), 0o755)));
    yield* tool(
      "pgrep",
      '[ -e "$HOME/app-running" ] || exit 1\n[ "$1" != -fl ] || echo "1 /Applications/T3 Code.app/Contents/MacOS/T3 Code"',
    );
    yield* tool("open", 'echo "open $*" >>"$HOME/events.log"\n[ "${OPEN_FAILS:-}" != 1 ]');
    yield* tool(
      "launchctl",
      [
        'echo "$*" >>"$HOME/launchctl.log"',
        'case "$1" in',
        '  print) [ -e "$HOME/service-loaded" ] ;;',
        '  bootout) rm "$HOME/service-loaded" ;;',
        '  bootstrap) touch "$HOME/service-loaded" ;;',
        "esac",
      ].join("\n"),
    );
    yield* tool(
      "mise",
      '[ "${APP_STARTS:-}" != seed ] || touch "$HOME/app-running"\nshift 3\nexec "$@"',
    );
    yield* tool(
      "mv",
      '/bin/mv "$@" || exit\ncase "$2" in *"/trash/T3 Code (Fork)_"*) [ "${KILL_AFTER_ASIDE:-}" != 1 ] || kill -TERM $PPID ;; esac',
    );
    // The app's launcher, as the last app to start left it.
    const shim = (version: string) =>
      fs
        .writeFileString(path.join(t3Home, "bin", "t3"), printsVersion(version))
        .pipe(Effect.andThen(fs.chmod(path.join(t3Home, "bin", "t3"), 0o755)));

    // A runtime whose `t3 install` writes its launcher as upstream's does: staged in
    // T3CODE_INSTALL_BIN_DIR, renamed into place, and recorded by its real path in runtime/launchers,
    // unless UNRECORDED=1 (upstream then only warns; APP_STARTS=install starts an app first). Its
    // `t3 service` logs who ran it and starts the service on its own version, unless SERVICE_FAILS=1.
    const runtime = (version: string) =>
      [
        "#!/bin/sh",
        'if [ "$1" = service ]; then',
        '  echo "$0 $*" >>"$HOME/service.log"',
        '  [ "${SERVICE_FAILS:-}" != 1 ] || { echo "service failed" >&2; exit 1; }',
        '  touch "$HOME/service-loaded"',
        `  printf '{"protocol":4,"activeVersion":"${version}"}' >"$HOME/.t3/runtime/service-state.json"`,
        "  exit",
        "fi",
        'if [ "$1" = install ]; then',
        '  [ "${APP_STARTS:-}" != install ] || touch "$HOME/app-running"',
        '  d="$T3CODE_INSTALL_BIN_DIR" && mkdir -p "$d" && printf \'#!/bin/sh\\nexec %s "$@"\\n\' "$0" >"$d/.t3-$$" &&',
        '    /bin/mv "$d/.t3-$$" "$d/t3" || exit',
        '  [ "${UNRECORDED:-}" = 1 ] || printf \'\\n%s/t3\\n\' "$(cd "$d" && pwd -P)" >>"$(dirname "$(dirname "$(dirname "$0")")")/launchers"',
        "  exit",
        "fi",
        `echo "t3 v${version}"`,
        "",
      ].join("\n");

    // A build as build.sh leaves it: the app's zip and, unless left out or broken, its runtime archive.
    const release = (version: string, options: { runtime?: "missing" | "corrupt" } = {}) =>
      Effect.gen(function* () {
        const releaseDir = path.join(repo, "release");
        for (const entry of yield* fs.readDirectory(releaseDir)) {
          yield* fs.remove(path.join(releaseDir, entry), { recursive: true });
        }
        const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-release-" });
        const app = path.join(scratch, appName);
        yield* fs.makeDirectory(path.join(app, "Contents", "Resources"), { recursive: true });
        yield* fs.writeFileString(path.join(app, "Contents", "Info.plist"), plist(version));
        yield* fs.writeFileString(path.join(app, "Contents", "Resources", "env"), "pk_live_test\n");
        yield* runner.run({
          command: "ditto",
          args: [
            "-c",
            "-k",
            "--keepParent",
            app,
            path.join(releaseDir, `T3-Code-${version}-arm64.zip`),
          ],
        });
        if (options.runtime === "missing") return;
        const stem = `t3-${version}-darwin-arm64`;
        if (options.runtime === "corrupt") {
          return yield* fs.writeFileString(path.join(releaseDir, `${stem}.tar.gz`), "not gzip");
        }
        yield* fs.makeDirectory(path.join(scratch, stem));
        yield* fs.writeFileString(path.join(scratch, stem, "t3"), runtime(version));
        yield* fs.chmod(path.join(scratch, stem, "t3"), 0o755);
        yield* runner.run({
          command: "tar",
          args: ["-czf", path.join(releaseDir, `${stem}.tar.gz`), "-C", scratch, stem],
        });
      });

    const install = (env: Record<string, string> = {}, args: ReadonlyArray<string> = []) =>
      runner.run({
        command: path.join(repo, "scripts", "fork", "install.sh"),
        args: [...args],
        env: {
          HOME: home,
          T3CODE_HOME: undefined,
          T3_FORK_APPLICATIONS_DIR: apps,
          PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin`,
          ...env,
        },
        timeout: Duration.seconds(60),
      });
    const installedVersion = runner
      .run({
        command: "/usr/libexec/PlistBuddy",
        args: [
          "-c",
          "Print CFBundleShortVersionString",
          path.join(apps, appName, "Contents", "Info.plist"),
        ],
      })
      .pipe(Effect.map((result) => (result.code === 0 ? result.stdout.trim() : undefined)));
    const runtimeDir = path.join(t3Home, "runtime");
    const forkBin = path.join(runtimeDir, "fork-bin");
    // The version the launcher `t3 install` wrote runs.
    const linked = fs
      .readFileString(path.join(forkBin, "t3"))
      .pipe(Effect.map((script) => /\/versions\/([^/]+)\/t3 /.exec(script)?.[1]));
    const seededVersions = fs
      .readDirectory(path.join(runtimeDir, "versions"))
      .pipe(Effect.map((entries) => entries.filter((entry) => !entry.startsWith(".")).toSorted()));
    const backups = fs.readDirectory(path.join(home, ".claude", "trash")).pipe(
      Effect.map((entries) => entries.filter((entry) => entry.startsWith("statev2.sqlite_"))),
      Effect.orElseSucceed((): Array<string> => []),
    );
    const runtimeT3 = (version: string) => path.join(runtimeDir, "versions", version, "t3");
    // `t3 service install` leaves its unit, and the service state, both naming the runtime it runs.
    const service = (activeVersion: string) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(
          path.join(home, "Library", "LaunchAgents", "com.t3tools.t3code.service.plist"),
          plistOf(
            `<key>ProgramArguments</key><array><string>${runtimeT3(activeVersion)}</string></array>`,
          ),
        );
        yield* fs.writeFileString(
          path.join(runtimeDir, "service-state.json"),
          JSON.stringify({ protocol: 4, activeVersion }),
        );
      });
    const loaded = (on: boolean) =>
      on
        ? fs.writeFileString(path.join(home, "service-loaded"), "")
        : fs.remove(path.join(home, "service-loaded"), { force: true });
    // ~/.config as a link into a dotfiles checkout whose doctor prints three steps.
    const dotfiles = Effect.gen(function* () {
      const checkout = path.join(root, "dotfiles");
      yield* fs.makeDirectory(path.join(checkout, ".config"), { recursive: true });
      yield* fs.writeFileString(
        path.join(checkout, "doctor.sh"),
        [
          "#!/bin/sh",
          'echo doctor >>"$HOME/events.log"',
          "echo '✓ Machine file            2'",
          "echo '✗ T3 Code                 3  ✗ 1'",
          "echo '    ✗ T3 Code background service is installed but not running'",
          "echo '✓ Editors                 2'",
          "exit 2",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(path.join(checkout, "doctor.sh"), 0o755);
      yield* fs.symlink(path.join(checkout, ".config"), path.join(home, ".config"));
    });
    return {
      home,
      repo,
      t3Home,
      apps,
      forkBin,
      runtimeT3,
      launchctlLog: lines(path.join(home, "launchctl.log")),
      serviceLog: lines(path.join(home, "service.log")),
      events: lines(path.join(home, "events.log")),
      appQuits: fs.remove(path.join(home, "app-running"), { force: true }),
      loaded,
      isLoaded: fs.exists(path.join(home, "service-loaded")),
      dotfiles,
      shimPath: path.join(t3Home, "bin", "t3"),
      shim,
      service,
      release,
      install,
      installedVersion,
      linked,
      seededVersions,
      backups,
    };
  });

  it.effect.skipIf(HostProcess.Platform.defaultValue() !== "darwin")(
    "seeds before it moves the app, puts the previous app and service back on failure, and moves the service through the new runtime",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const m = yield* machine();
        const restart = `run: "${m.shimPath}" service restart`;
        // The version service-state.json names, which the unit's launcher runs.
        const startedAgain = (version: string) =>
          `started the background service again; it runs t3 ${version}.`;
        const dest = path.join(m.apps, appName);
        // What launchctl was asked to do since `from` entries, its reads left out.
        const launchctlSince = (from: number) =>
          m.launchctlLog.pipe(
            Effect.map((log) =>
              log
                .slice(from)
                .filter((line) => !line.startsWith("print"))
                .map((line) => line.split(" ")[0]),
            ),
          );

        // Only its one flag.
        assert.equal((yield* m.install({}, ["--service-stopped", "x"])).code, 2);

        // The earlier build, with `t3` already its CLI. Its `t3 install` cannot record the launcher
        // (upstream only warns): refused, and the app is taken back out.
        yield* m.release(versions.earlier);
        yield* m.shim(versions.earlier);
        const unrecorded = yield* m.install({ UNRECORDED: "1" });
        assert.notEqual(unrecorded.code, 0);
        assert.include(unrecorded.stderr, "did not record");
        assert.isUndefined(yield* m.installedVersion);

        // Seeded, its launcher written and recorded, installed; no service yet, so none is started,
        // and it says how to start one through this build's runtime. No dotfiles: no doctor.
        const first = yield* m.install();
        assert.equal(first.code, 0, first.stderr);
        assert.equal(yield* m.installedVersion, versions.earlier);
        assert.equal(yield* m.linked, versions.earlier);
        assert.include(first.stdout, "turn Local environment off");
        assert.include(first.stdout, `run: "${m.runtimeT3(versions.earlier)}" service install`);
        assert.include(first.stdout, "doctor's T3 Code step not run");
        assert.deepEqual(yield* m.serviceLog, []);
        // It opens the app it installed; the failed run above opened nothing.
        assert.deepEqual(yield* m.events, [`open ${dest}`]);
        const backups = (yield* m.backups).length;

        // A T3CODE_HOME other than ~/.t3, which an app opened from Finder never sees: refused
        // before the backup.
        yield* m.release(versions.current);
        const elsewhere = yield* m.install({ T3CODE_HOME: path.join(m.home, "other") });
        assert.notEqual(elsewhere.code, 0);
        assert.include(elsewhere.stderr, "unset T3CODE_HOME");
        assert.lengthOf(yield* m.backups, backups);
        assert.deepEqual(yield* m.seededVersions, [versions.earlier]);

        // The service runs on the earlier build. Refused before the stop: it keeps running.
        yield* m.service(versions.earlier);
        yield* m.loaded(true);
        const busyElsewhere = yield* m.install({ T3CODE_HOME: path.join(m.home, "other") });
        assert.notEqual(busyElsewhere.code, 0);
        assert.isTrue(yield* m.isLoaded);
        assert.notInclude((yield* m.launchctlLog).join("\n"), "bootout");

        // Stopped by the owner, then refused: it says how to start it again, and leaves it stopped.
        yield* m.loaded(false);
        const stoppedElsewhere = yield* m.install({ T3CODE_HOME: path.join(m.home, "other") });
        assert.notEqual(stoppedElsewhere.code, 0);
        assert.include(stoppedElsewhere.stderr, restart);
        assert.isFalse(yield* m.isLoaded);

        // Running, and no runtime archive: this run stops the service, is refused, and starts the
        // service it stopped again; the app stays.
        yield* m.loaded(true);
        yield* m.release(versions.current, { runtime: "missing" });
        const missing = yield* m.install();
        assert.notEqual(missing.code, 0);
        assert.include(missing.stderr, "no runtime archive");
        assert.include(missing.stderr, startedAgain(versions.earlier));
        assert.notInclude(missing.stderr, restart);
        assert.isTrue(yield* m.isLoaded);
        assert.deepEqual(yield* launchctlSince(0), ["bootout", "bootstrap"]);
        assert.equal(yield* m.installedVersion, versions.earlier);
        assert.deepEqual(yield* m.serviceLog, []);

        // Stopped by its caller (--service-stopped, auto-install.sh): started again as if this run
        // had stopped it, and this run stops nothing itself.
        yield* m.loaded(false);
        const callerStopped = (yield* m.launchctlLog).length;
        const missingStopped = yield* m.install({}, ["--service-stopped"]);
        assert.notEqual(missingStopped.code, 0);
        assert.include(missingStopped.stderr, startedAgain(versions.earlier));
        assert.isTrue(yield* m.isLoaded);
        assert.deepEqual(yield* launchctlSince(callerStopped), ["bootstrap"]);

        // The failures below run with the service stopped by the owner.
        yield* m.loaded(false);

        // The seed fails: it comes first, so the app is never moved.
        yield* m.release(versions.current, { runtime: "corrupt" });
        const unseeded = yield* m.install();
        assert.notEqual(unseeded.code, 0);
        assert.equal(yield* m.installedVersion, versions.earlier);
        assert.deepEqual(yield* m.seededVersions, [versions.earlier]);

        // An app starts while the seed runs: refused before the app is replaced.
        yield* m.release(versions.current);
        const raced = yield* m.install({ APP_STARTS: "seed" });
        yield* m.appQuits;
        assert.notEqual(raced.code, 0);
        assert.include(raced.stderr, "a T3 Code app started during the install");
        assert.equal(yield* m.installedVersion, versions.earlier);
        assert.include(raced.stderr, "put the previous fork app back");

        // The app cannot be replaced: the launcher stays on the installed app's runtime, and the
        // new runtime is left unnamed, for the prune.
        yield* m.release(versions.current);
        yield* fs.chmod(m.apps, 0o555);
        const unmoved = yield* m
          .install()
          .pipe(Effect.ensuring(Effect.orDie(fs.chmod(m.apps, 0o755))));
        assert.notEqual(unmoved.code, 0);
        assert.equal(yield* m.installedVersion, versions.earlier);
        assert.equal(yield* m.linked, versions.earlier);
        assert.deepEqual(yield* m.seededVersions, [versions.earlier, versions.current]);

        // Killed right after the old app went to the trash: it comes back. The runner reports a
        // signal as an error.
        const killed = yield* m.install({ KILL_AFTER_ASIDE: "1" }).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(killed));
        assert.equal(yield* m.installedVersion, versions.earlier);

        // `t3 install` fails after the app moved: the earlier app comes back, and the launcher stays.
        yield* fs.chmod(m.forkBin, 0o555);
        const unlinked = yield* m
          .install()
          .pipe(Effect.ensuring(Effect.orDie(fs.chmod(m.forkBin, 0o755))));
        assert.notEqual(unlinked.code, 0);
        assert.equal(yield* m.installedVersion, versions.earlier);
        assert.equal(yield* m.linked, versions.earlier);
        assert.include(unlinked.stderr, "put the previous fork app back");
        assert.lengthOf(yield* m.events, 1);

        // A service the owner stopped stays stopped after an install, which says how to start it.
        const left = yield* m.install();
        assert.equal(left.code, 0, left.stderr);
        assert.equal(yield* m.installedVersion, versions.current);
        assert.include(
          left.stdout,
          `left so. To run it on this build, run: "${m.runtimeT3(versions.current)}" service install`,
        );
        assert.deepEqual(yield* m.serviceLog, []);
        assert.isFalse(yield* m.isLoaded);
        assert.deepEqual(yield* m.events, [`open ${dest}`, `open ${dest}`]);

        // Installed while the service runs on the earlier build and `t3` is another app's CLI: the
        // service moves to this build through this build's own runtime, and doctor's T3 Code step
        // shows, alone.
        yield* m.release(versions.current);
        yield* m.service(versions.earlier);
        yield* m.loaded(true);
        yield* m.shim("0.1.11-nightly.20261119.4900");
        yield* m.dotfiles;
        // With a role, so no line on stderr is expected.
        const installed = yield* m.install({}, ["--role", "upgrader"]);
        assert.equal(installed.code, 0, installed.stderr);
        assert.equal(yield* m.installedVersion, versions.current);
        assert.equal(yield* m.linked, versions.current);
        assert.deepEqual(yield* m.serviceLog, [`${m.runtimeT3(versions.current)} service install`]);
        assert.isTrue(yield* m.isLoaded);
        assert.include(installed.stdout, `runs on this build (${versions.current})`);
        assert.include(
          installed.stdout,
          "✗ T3 Code                 3  ✗ 1\n    ✗ T3 Code background service is installed but not running\n",
        );
        assert.notInclude(installed.stdout, "Machine file");
        assert.notInclude(installed.stdout, "Editors");
        // The app opens before the doctor runs.
        assert.deepEqual((yield* m.events).slice(-2), [`open ${dest}`, "doctor"]);
        // Done: the previous app stays in the trash, and nothing is put back on the way out.
        const aside = /^Moved the previous fork app to (.+)\.$/m.exec(installed.stdout)?.[1] ?? "";
        assert.isTrue(yield* fs.exists(path.join(aside, "Contents", "Info.plist")), aside);
        assert.notInclude(installed.stderr, "install:");

        // The same build again, its service already on it, where `service install` would answer
        // "already installed" and leave it stopped: restart it. Its caller stopped it this time.
        // The app does not open: said, and the install still succeeds.
        yield* m.release(versions.current);
        yield* m.loaded(false);
        const again = yield* m.install({ OPEN_FAILS: "1" }, ["--service-stopped"]);
        assert.equal(again.code, 0, again.stderr);
        assert.include(again.stderr, `could not open ${dest}; open it by hand.`);
        assert.equal(
          (yield* m.serviceLog).at(-1),
          `${m.runtimeT3(versions.current)} service restart`,
        );
        assert.isTrue(yield* m.isLoaded);

        // An app starts once the new app is in place: installed, but the service is neither moved
        // nor started again while it runs (the app may host its own server); it says how to.
        yield* m.release(versions.current);
        const serviceRuns = (yield* m.serviceLog).length;
        const lateApp = yield* m.install({ APP_STARTS: "install" });
        yield* m.appQuits;
        assert.notEqual(lateApp.code, 0);
        assert.include(
          lateApp.stderr,
          `which is done; the background service stays stopped. Quit the app, then run: "${m.runtimeT3(versions.current)}" service restart`,
        );
        assert.notInclude(lateApp.stderr, "started the background service again");
        assert.equal(yield* m.installedVersion, versions.current);
        assert.lengthOf(yield* m.serviceLog, serviceRuns);
        assert.isFalse(yield* m.isLoaded);

        // The service step fails: said, the app stays installed, and the unit on disk starts again.
        // Its plist still names the earlier runtime; the launcher runs service-state.json's.
        yield* m.loaded(true);
        yield* m.release(versions.current);
        const opens = (yield* m.events).length;
        const unstarted = yield* m.install({ SERVICE_FAILS: "1" });
        assert.notEqual(unstarted.code, 0);
        assert.include(unstarted.stderr, "service restart failed");
        assert.include(unstarted.stderr, startedAgain(versions.current));
        assert.isTrue(yield* m.isLoaded);
        assert.equal(yield* m.installedVersion, versions.current);
        assert.lengthOf(yield* m.events, opens);
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  // MAIN-113: a copy, so a branch switched in the checkout never changes what runs.
  it.effect.skipIf(HostProcess.Platform.defaultValue() !== "darwin")(
    "copies the upgrade workflow into the T3 home once installed, a differing copy to the trash first",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const m = yield* machine();
        const source = path.join(m.repo, "evals", "fork", "upstream-upgrade.ts");
        const copy = path.join(m.t3Home, "workflows", "upstream-upgrade.ts");
        const trashed = fs
          .readDirectory(path.join(m.home, ".claude", "trash"))
          .pipe(
            Effect.map((entries) =>
              entries.filter((entry) => entry.startsWith("upstream-upgrade.ts_")),
            ),
          );
        yield* m.release(versions.earlier);
        yield* m.shim(versions.earlier);

        // Not installed: nothing copied.
        assert.notEqual((yield* m.install({ UNRECORDED: "1" })).code, 0);
        assert.isFalse(yield* fs.exists(copy));

        const first = yield* m.install({}, ["--role", "upgrader"]);
        assert.equal(first.code, 0, first.stderr);
        assert.equal(yield* fs.readFileString(copy), yield* fs.readFileString(source));
        assert.include(first.stdout, `Copied the upgrade workflow to ${path.dirname(copy)}.`);

        // Edited in the Workflows page: kept in the trash, then replaced.
        yield* fs.writeFileString(copy, "// edited\n");
        yield* m.release(versions.current);
        assert.equal((yield* m.install()).code, 0);
        assert.equal(yield* fs.readFileString(copy), yield* fs.readFileString(source));
        const [kept, ...more] = yield* trashed;
        assert.deepEqual(more, []);
        assert.equal(
          yield* fs.readFileString(path.join(m.home, ".claude", "trash", kept!)),
          "// edited\n",
        );

        // The same copy: left alone, nothing trashed.
        yield* m.release(versions.current);
        const again = yield* m.install();
        assert.equal(again.code, 0, again.stderr);
        assert.notInclude(again.stdout, "Copied the upgrade workflow");
        assert.lengthOf(yield* trashed, 1);
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  // Q77: one machine upgrades; the others only install. The role sits beside the workflow's copy.
  it.effect.skipIf(HostProcess.Platform.defaultValue() !== "darwin")(
    "records the --role it is given beside the workflow, keeps it when none is given, and copies no workflow without one",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const m = yield* machine();
        const role = path.join(m.t3Home, "workflows", "upstream-upgrade.role");
        const copy = path.join(m.t3Home, "workflows", "upstream-upgrade.ts");
        const recorded = fs.readFileString(role).pipe(Effect.orElseSucceed(() => "(none)"));

        // Neither role, or none named: refused before anything is done.
        for (const args of [["--role", "builder"], ["--role"], ["--role", "installer", "x"]]) {
          const refused = yield* m.install({}, args);
          assert.equal(refused.code, 2, args.join(" "));
          assert.include(refused.stderr, "usage: install.sh");
        }
        assert.equal(yield* recorded, "(none)");
        assert.deepEqual(yield* m.backups, []);

        // No role ever named: the app installs, the workflow is not copied, and it says how to fix it.
        // A copy from before roles, which would upgrade, goes to the trash.
        yield* fs.makeDirectory(path.dirname(copy), { recursive: true });
        yield* fs.writeFileString(copy, "// before roles\n");
        yield* m.release(versions.earlier);
        yield* m.shim(versions.earlier);
        const plain = yield* m.install();
        assert.equal(plain.code, 0, plain.stderr);
        assert.include(plain.stdout, "Installed ");
        assert.include(
          plain.stderr,
          "no upgrade workflow role, so the workflow was not copied; install again with --role upgrader",
        );
        assert.equal(yield* recorded, "(none)");
        assert.isFalse(yield* fs.exists(copy));
        const trash = path.join(m.home, ".claude", "trash");
        const [old, ...others] = (yield* fs.readDirectory(trash)).filter((entry) =>
          entry.startsWith("upstream-upgrade.ts_"),
        );
        assert.deepEqual(others, []);
        assert.equal(yield* fs.readFileString(path.join(trash, old!)), "// before roles\n");
        assert.include(
          plain.stderr,
          `moved the workflow copy that has no role to ${trash}/${old}.`,
        );

        const named = yield* m.install({}, ["--role", "installer"]);
        assert.equal(named.code, 0, named.stderr);
        assert.equal(yield* recorded, "installer\n");
        assert.include(named.stdout, "Recorded this machine's upgrade workflow role: installer.");
        assert.include(named.stdout, "Copied the upgrade workflow");

        // The next install names none (auto-install.sh's default): kept.
        yield* m.release(versions.current);
        const kept = yield* m.install();
        assert.equal(kept.code, 0, kept.stderr);
        assert.equal(yield* recorded, "installer\n");
        assert.notInclude(kept.stdout, "Recorded");
        assert.notInclude(kept.stderr, "no upgrade workflow role");

        // Changed by naming the other, with the other flag in either order.
        yield* m.release(versions.current);
        const changed = yield* m.install({}, ["--role", "upgrader", "--service-stopped"]);
        assert.equal(changed.code, 0, changed.stderr);
        assert.equal(yield* recorded, "upgrader\n");

        // A role that cannot be recorded: the workflow is not copied either, as a copy without its
        // role would upgrade.
        yield* fs.remove(role);
        yield* fs.makeDirectory(role);
        yield* fs.writeFileString(copy, "// edited\n");
        yield* m.release(versions.current);
        const unrecorded = yield* m.install({}, ["--role", "installer"]);
        assert.equal(unrecorded.code, 0, unrecorded.stderr);
        assert.include(unrecorded.stderr, "could not record the role installer");
        assert.equal(yield* fs.readFileString(copy), "// edited\n");
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );
});

it.layer(NodeServices.layer)("scripts/fork/auto-install.sh", (it) => {
  const official = "com.t3tools.t3code";
  const fork = "com.t3tools.t3code.fork";
  const skip = HostProcess.Platform.defaultValue() !== "darwin";

  // auto-install.sh, an install.sh that logs its arguments and what still runs (and runs INSTALL_HOOK),
  // the tables it reads,
  // and logged stand-ins: osascript ($HOME/running/<bundle id>; quit spares STUBBORN, runs QUIT_HOOK),
  // pgrep ($HOME/helpers/<pid>), open, launchctl ($HOME/service-loaded) and sleep (runs SLEEP_HOOK).
  const machine = Effect.fn(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-auto-" });
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    const apps = path.join(root, "Applications");
    const bin = path.join(root, "bin");
    const forkApp = path.join(apps, "T3 Code (Fork).app");
    const db = path.join(home, ".t3", "userdata", "statev2.sqlite");
    for (const dir of [
      path.join(repo, "scripts", "fork"),
      path.join(forkApp, "Contents"),
      path.join(home, ".t3", "userdata"),
      path.join(home, "running"),
      path.join(home, "helpers"),
      bin,
    ]) {
      yield* fs.makeDirectory(dir, { recursive: true });
    }
    yield* fs.copyFile(
      `${repoRoot}scripts/fork/auto-install.sh`,
      path.join(repo, "scripts", "fork", "auto-install.sh"),
    );
    // A machine installed since roles: install.sh recorded one.
    const role = path.join(home, ".t3", "workflows", "upstream-upgrade.role");
    yield* fs.makeDirectory(path.dirname(role), { recursive: true });
    yield* fs.writeFileString(role, "upgrader\n");
    const script = (file: string, body: string) =>
      fs
        .writeFileString(file, `#!/bin/bash\n${body}\n`)
        .pipe(Effect.andThen(fs.chmod(file, 0o755)));
    yield* script(
      path.join(repo, "scripts", "fork", "install.sh"),
      [
        'service=down; [ ! -e "$HOME/service-loaded" ] || service=up',
        'echo "install.sh [$*]; apps running: [$(ls "$HOME/running" | tr "\\n" " ")]; service $service" >>"$HOME/install.log"',
        'eval "${INSTALL_HOOK:-}"',
        'exit "${INSTALL_EXIT:-0}"',
      ].join("\n"),
    );
    yield* fs.writeFileString(
      path.join(forkApp, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${versions.current}</string></dict></plist>`,
    );
    yield* script(
      path.join(bin, "osascript"),
      [
        'id="${2#*application id \\"}"; id="${id%%\\"*}"',
        'case "$2" in',
        '  *"is running") [ -e "$HOME/running/$id" ] && echo true || echo false ;;',
        '  *"to quit") echo "quit $id" >>"$HOME/osascript.log"; [ "$id" = "${STUBBORN:-}" ] || rm -f "$HOME/running/$id"; eval "${QUIT_HOOK:-}" ;;',
        "  *) exit 1 ;;",
        "esac",
      ].join("\n"),
    );
    yield* script(path.join(bin, "pgrep"), 'ls "$HOME/helpers" | grep .');
    yield* script(path.join(bin, "open"), 'echo "$*" >>"$HOME/open.log"');
    yield* script(
      path.join(bin, "launchctl"),
      [
        'echo "$*" >>"$HOME/launchctl.log"',
        'case "$1 $2" in',
        '  "print "*.service) [ -e "$HOME/service-loaded" ] ;;',
        '  "print "*) exit 1 ;;',
        '  "bootout "*.service) rm "$HOME/service-loaded" ;;',
        "esac",
      ].join("\n"),
    );
    yield* script(
      path.join(bin, "sleep"),
      'echo "$*" >>"$HOME/sleep.log"\n[ -z "${SLEEP_HOOK:-}" ] || eval "$SLEEP_HOOK"',
    );
    // The columns the script reads, named as upstream's migrations name them.
    yield* runner.run({
      command: "sqlite3",
      args: [
        db,
        "CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, title TEXT NOT NULL DEFAULT '', archived_at TEXT, deleted_at TEXT, active_provider_thread_id TEXT, payload_json TEXT NOT NULL DEFAULT '{}');" +
          "CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, thread_id TEXT, status TEXT);" +
          "CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT, thread_id TEXT, payload_json TEXT);" +
          "CREATE TABLE orchestration_v2_projection_turn_items (thread_id TEXT, run_id TEXT, type TEXT, status TEXT, payload_json TEXT);",
      ],
    });
    const sql = (statement: string) =>
      runner.run({ command: "sqlite3", args: [db, statement] }).pipe(Effect.asVoid);
    const running = (...ids: ReadonlyArray<string>) =>
      Effect.forEach(ids, (id) => fs.writeFileString(path.join(home, "running", id), ""), {
        discard: true,
      });
    const logs = path.join(home, "Library", "Logs", "T3 Code (Fork)");
    const lock = path.join(logs, "auto-install.lock");
    const holdLock = (pid: number) =>
      fs
        .makeDirectory(logs, { recursive: true })
        .pipe(Effect.andThen(fs.symlink(String(pid), lock)));
    const run = (args: ReadonlyArray<string>, env: Record<string, string | undefined> = {}) =>
      runner.run({
        command: path.join(repo, "scripts", "fork", "auto-install.sh"),
        args: [...args],
        env: {
          HOME: home,
          PATH: `${bin}:/usr/bin:/bin:/usr/sbin`,
          T3_FORK_APPLICATIONS_DIR: apps,
          T3_FORK_AUTO_INSTALL_POLL: "1",
          T3_FORK_AUTO_INSTALL_WAIT: "5",
          ...env,
        },
        timeout: Duration.seconds(60),
      });
    const lastLine = (stdout: string) => stdout.trimEnd().split("\n").at(-1) ?? "";
    return {
      home,
      repo,
      forkApp,
      role,
      logs,
      lock,
      holdLock,
      sql,
      running,
      helper: (pid: number) => fs.writeFileString(path.join(home, "helpers", String(pid)), ""),
      serviceLoaded: fs.writeFileString(path.join(home, "service-loaded"), ""),
      run,
      lastLine,
      osascript: lines(path.join(home, "osascript.log")),
      opened: lines(path.join(home, "open.log")),
      installs: lines(path.join(home, "install.log")),
      launchctl: lines(path.join(home, "launchctl.log")),
      sleeps: lines(path.join(home, "sleep.log")),
      lockHolders: lines(path.join(home, "lock.log")),
      // The link, not what it names (a pid, no file).
      lockHeld: fs.readLink(lock).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
    };
  });

  it.effect.skipIf(skip)(
    "hands the run to a one-shot launchd job, and refuses while one runs or for another T3 home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const runner = yield* ProcessRunner.ProcessRunner;
        const m = yield* machine();
        // Another home holds other runs and another database: refused, and no job.
        const elsewhere = yield* m.run([], { T3CODE_HOME: "/elsewhere" });
        assert.notEqual(elsewhere.code, 0);
        assert.include(elsewhere.stderr, "unset T3CODE_HOME (it is /elsewhere)");
        assert.deepEqual(yield* m.launchctl, []);

        // T3's own variables, as an agent shell inside T3 has them, stay out of the job.
        const started = yield* m.run([], {
          T3CODE_HOME: `${m.home}/.t3`,
          T3CODE_PORT: "3773",
        });
        assert.equal(started.code, 0, started.stderr);
        const [bootstrap = ""] = yield* m.launchctl;
        const plist = /^bootstrap gui\/\d+ (.+\.plist)$/.exec(bootstrap)?.[1] ?? "";
        assert.isTrue(yield* fs.exists(plist), bootstrap);
        // plutil writes JSON for a container only, and `raw` for a single value.
        const read = (key: string, format: "json" | "raw") =>
          runner
            .run({ command: "plutil", args: ["-extract", key, format, "-o", "-", plist] })
            .pipe(Effect.map((result) => result.stdout.trim()));
        const label = yield* read("Label", "raw");
        assert.match(label, /^com\.t3tools\.t3code\.fork\.auto-install\./);
        assert.equal(yield* read("KeepAlive", "raw"), "false");
        assert.deepEqual(JSON.parse(yield* read("ProgramArguments", "json")), [
          "/bin/bash",
          `${m.repo}/scripts/fork/auto-install.sh`,
          "--run",
          label,
        ]);
        assert.deepEqual(
          Object.keys(JSON.parse(yield* read("EnvironmentVariables", "json"))).toSorted(),
          ["HOME", "LANG", "PATH"],
        );
        assert.include(started.stdout, `Log: ${m.logs}/auto-install_`);

        // A run holds the lock (a link naming its pid): refused, and no second job.
        yield* m.holdLock(process.pid);
        const second = yield* m.run([]);
        assert.notEqual(second.code, 0);
        assert.include(
          second.stderr,
          `another one runs (pid ${process.pid}, holding ${m.lock}); its log is in ${m.logs}. If pid ${process.pid} is not an auto-install, remove ${m.lock}.`,
        );
        assert.lengthOf(yield* m.launchctl, 1);
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  // Q77: the role reaches install.sh, which records it.
  it.effect.skipIf(skip)("passes --role through the launchd job to install.sh", () =>
    Effect.gen(function* () {
      const runner = yield* ProcessRunner.ProcessRunner;
      const m = yield* machine();
      for (const args of [
        ["--role", "builder"],
        ["--role"],
        // One word, as a quoted "--role installer" passes it.
        ["--role installer"],
        ["--run"],
        ["--run", "job.label", "--role", "x"],
      ]) {
        const refused = yield* m.run(args);
        assert.equal(refused.code, 2, args.join(" "));
        assert.include(refused.stderr, "usage: auto-install.sh");
      }
      assert.deepEqual(yield* m.launchctl, []);
      assert.deepEqual(yield* m.installs, []);

      const started = yield* m.run(["--role", "installer"]);
      assert.equal(started.code, 0, started.stderr);
      const plist =
        /^bootstrap gui\/\d+ (.+\.plist)$/.exec((yield* m.launchctl)[0] ?? "")?.[1] ?? "";
      const args = yield* runner.run({
        command: "plutil",
        args: ["-extract", "ProgramArguments", "json", "-o", "-", plist],
      });
      assert.deepEqual(JSON.parse(args.stdout).slice(2), [
        "--run",
        /^bootstrap gui\/\d+ .+\/(.+)\.plist$/.exec((yield* m.launchctl)[0] ?? "")?.[1],
        "--role",
        "installer",
      ]);

      const done = yield* m.run(["--run", "job.label", "--role", "installer"]);
      assert.equal(m.lastLine(done.stdout), "auto-install: SUCCESS: install.sh finished");
      assert.deepEqual(yield* m.installs, [
        "install.sh [--role installer]; apps running: []; service down",
      ]);

      // R1: no role recorded, so install.sh copied no workflow: the last line says so.
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(m.role);
      const roleless = yield* m.run(["--run", "job.label"]);
      assert.equal(
        m.lastLine(roleless.stdout),
        "auto-install: SUCCESS: install.sh finished; the upgrade workflow was not copied: no role (install again with --role upgrader|installer)",
      );
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect.skipIf(skip)(
    "waits until no run is active, quits every T3 Code app, and installs; opens the fork itself only after a failure",
    () =>
      Effect.gen(function* () {
        const m = yield* machine();
        yield* m.sql(
          "INSERT INTO orchestration_v2_projection_threads (thread_id, deleted_at) VALUES ('a', NULL), ('gone', '2026-01-01');" +
            "INSERT INTO orchestration_v2_projection_runs VALUES ('r1', 'a', 'running'), ('r0', 'a', 'completed'), ('r9', 'gone', 'running');",
        );
        yield* m.running(official, fork);
        // A lock left by a run that no longer exists is taken over.
        yield* m.holdLock(99_999_999);
        // The run ends while it waits; a run on a deleted thread never counts. The lock names this
        // job's pid whenever it is read.
        const done = yield* m.run(["--run", "job.label"], {
          SLEEP_HOOK: `sqlite3 "$HOME/.t3/userdata/statev2.sqlite" "UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'r1'"; readlink "$HOME/Library/Logs/T3 Code (Fork)/auto-install.lock" >>"$HOME/lock.log"`,
        });
        assert.equal(done.code, 0, done.stderr);
        assert.equal(m.lastLine(done.stdout), "auto-install: SUCCESS: install.sh finished");
        // Busy once, then idle on two reads in a row.
        assert.deepEqual(yield* m.sleeps, ["1", "1"]);
        const holders = yield* m.lockHolders;
        assert.lengthOf(holders, 2);
        assert.match(holders[0] ?? "", /^\d+$/);
        assert.notEqual(holders[0], "99999999");
        assert.equal(holders[1], holders[0]);
        assert.deepEqual(yield* m.osascript, [`quit ${official}`, `quit ${fork}`]);
        // No service ran, so none was stopped for it.
        assert.deepEqual(yield* m.installs, ["install.sh []; apps running: []; service down"]);
        // install.sh opened the fork itself.
        assert.deepEqual(yield* m.opened, []);
        assert.include(yield* m.launchctl, `bootout gui/${process.getuid?.()}/job.label`);
        assert.isFalse(yield* m.lockHeld);

        // A failed install: the fork opens again on whatever is installed, and the line says so.
        const failed = yield* m.run(["--run", "job.label"], { INSTALL_EXIT: "1" });
        assert.equal(
          m.lastLine(failed.stdout),
          `auto-install: FAILED: install.sh exited 1; read its lines above; opened T3 Code (Fork).app ${versions.current}`,
        );
        assert.deepEqual(yield* m.opened, [m.forkApp]);

        // A failed install while an app started meanwhile: a second app would be a second writer.
        const late = yield* m.run(["--run", "job.label"], {
          INSTALL_EXIT: "1",
          INSTALL_HOOK: `touch "$HOME/running/${official}"`,
        });
        assert.equal(
          m.lastLine(late.stdout),
          `auto-install: FAILED: install.sh exited 1; read its lines above; did not open T3 Code (Fork).app, as a T3 Code app runs: ${official}`,
        );
        assert.deepEqual(yield* m.opened, [m.forkApp]);
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect.skipIf(skip)(
    "reads once more after the apps quit, waits again if a run started, then stops the service for install.sh",
    () =>
      Effect.gen(function* () {
        const m = yield* machine();
        const db = `"$HOME/.t3/userdata/statev2.sqlite"`;
        yield* m.sql(
          "INSERT INTO orchestration_v2_projection_threads (thread_id, deleted_at) VALUES ('a', NULL);",
        );
        yield* m.running(fork);
        yield* m.serviceLoaded;
        // A run starts on the service as the app quits, and ends while it waits again.
        const late = yield* m.run(["--run", "job.label"], {
          QUIT_HOOK: `sqlite3 ${db} "INSERT INTO orchestration_v2_projection_runs VALUES ('late', 'a', 'running')"`,
          SLEEP_HOOK: `sqlite3 ${db} "UPDATE orchestration_v2_projection_runs SET status = 'completed'"`,
        });
        assert.equal(late.code, 0, late.stderr);
        assert.include(late.stdout, "A run started while the apps quit; waiting again.");
        // Idle twice, the read after the quit, then idle twice again.
        assert.deepEqual(yield* m.sleeps, ["1", "1", "1"]);
        assert.deepEqual(yield* m.osascript, [`quit ${fork}`]);
        // Stopped after that read, by the job, and install.sh told so.
        assert.deepEqual(yield* m.installs, [
          "install.sh [--service-stopped]; apps running: []; service down",
        ]);
        assert.include(
          yield* m.launchctl,
          `bootout gui/${process.getuid?.()}/com.t3tools.t3code.service`,
        );
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  // A waiting run is a turn whose checkpoint is not captured yet. Background work outlives its run
  // and a restart cancels it; work that lets the run complete anyway does not count
  // (backgroundWorkHoldsCompletion).
  it.effect.skipIf(skip)(
    "counts a waiting run, and background work that holds, whatever its run's status",
    () =>
      Effect.gen(function* () {
        const task = (fields: object) => JSON.stringify({ taskId: "t1", ...fields });
        const provider = (id: string, ...tasks: ReadonlyArray<string>) =>
          `INSERT INTO orchestration_v2_projection_provider_threads VALUES ('${id}', 'a', '{"pendingBackgroundTasks":[${tasks.join(",")}]}');`;
        const item = (type: string, status: string, payload: object = {}, run = "r1") =>
          `INSERT INTO orchestration_v2_projection_turn_items VALUES ('a', '${run}', '${type}', '${status}', '${JSON.stringify(payload)}');`;
        // The thread's pull request watch, its checks still running: upstream marks it awaited.
        const watch = `UPDATE orchestration_v2_projection_threads SET payload_json = '${JSON.stringify(
          {
            pullRequests: [
              { host: "github.com", repository: "o/r", number: 1, watch: { checksPending: true } },
            ],
          },
        )}';`;
        // Name, r1's status, its thread's work, and whether that reads as active.
        const cases: ReadonlyArray<readonly [string, string, string, boolean]> = [
          ["a waiting run and no work", "waiting", "", true],
          ["a completed run and no work", "completed", "", false],
          [
            "an awaited command",
            "completed",
            provider("p1", task({ kind: "command", awaited: true })),
            true,
          ],
          ["a background subagent", "completed", provider("p1", task({ kind: "subagent" })), true],
          [
            "a task of a kind this does not know",
            "completed",
            provider("p1", task({ kind: "x" })),
            true,
          ],
          ["a task with no kind", "completed", provider("p1", task({})), true],
          [
            "a monitor not awaited, and a pull request watch",
            "completed",
            provider("p1", task({ kind: "monitor" })) + watch,
            false,
          ],
          [
            "an awaited command on a provider thread no longer active",
            "completed",
            provider("p0", task({ kind: "command", awaited: true })),
            false,
          ],
          ["a running subagent item", "completed", item("subagent", "running"), true],
          [
            "a pending dynamic tool",
            "completed",
            item("dynamic_tool", "pending", { input: {} }),
            true,
          ],
          [
            "a persistent dynamic tool",
            "completed",
            item("dynamic_tool", "running", { input: { persistent: true } }),
            false,
          ],
          ["a running command item", "completed", item("command_execution", "running"), false],
          [
            "a subagent item of a rolled-back run",
            "completed",
            item("subagent", "running", {}, "r0") +
              "INSERT INTO orchestration_v2_projection_runs VALUES ('r0', 'a', 'rolled_back');",
            false,
          ],
        ];
        for (const [name, status, work, busy] of cases) {
          const m = yield* machine();
          // The service runs, so the database is read.
          yield* m.serviceLoaded;
          yield* m.sql(
            "INSERT INTO orchestration_v2_projection_threads (thread_id, title, deleted_at, active_provider_thread_id) VALUES ('a', 'A', NULL, 'p1');" +
              `INSERT INTO orchestration_v2_projection_runs VALUES ('r1', 'a', '${status}');` +
              work,
          );
          const result = yield* m.run(["--run", "job.label"], { T3_FORK_AUTO_INSTALL_WAIT: "1" });
          assert.equal(
            m.lastLine(result.stdout),
            busy
              ? 'auto-install: FAILED: threads/background work still active after 1s: a "A"; nothing was installed'
              : "auto-install: SUCCESS: install.sh finished",
            name,
          );
        }
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  // A workflow run holds the install only while code of it runs, and only while workflows are on;
  // the upgrade workflow's own launch step ends its run soon after it starts this (MAIN-113).
  it.effect.skipIf(skip)(
    "counts a workflow run only while code of it runs, with workflows on, and lets a launching run end",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const runs =
          "CREATE TABLE workflow_runs (run_id TEXT, workflow TEXT, title TEXT, status TEXT, ended_at TEXT);" +
          "CREATE TABLE workflow_steps (run_id TEXT, name TEXT, kind TEXT, status TEXT);";
        const run = (status: string, endedAt = "NULL") =>
          `INSERT INTO workflow_runs VALUES ('w1', 'upstream-upgrade', 'Fork upgrade', '${status}', ${endedAt});`;
        const stepOf = (kind: string) =>
          `INSERT INTO workflow_steps VALUES ('w1', 'x', '${kind}', 'running');`;
        const held =
          'auto-install: FAILED: threads/background work still active after 1s: workflow upstream-upgrade run w1 "Fork upgrade"; nothing was installed';
        // Name, settings.json (undefined: none), the tables and rows, the last line when it holds.
        const on = JSON.stringify({ workflowsEnabled: true });
        const cases: ReadonlyArray<
          readonly [string, string | undefined, string, string | undefined]
        > = [
          ["a step running", on, runs + run("running"), held],
          ["a step running beside an agent", on, runs + run("waiting") + stepOf("step"), held],
          [
            "a run waiting on an agent, a question or a sleep",
            on,
            runs + run("waiting") + stepOf("agent"),
            undefined,
          ],
          ["a paused run", on, runs + run("paused"), undefined],
          ["an ended run", on, runs + run("completed", "'2026-11-23'"), undefined],
          [
            "a step running with workflows off",
            JSON.stringify({ workflowsEnabled: false }),
            runs + run("running"),
            undefined,
          ],
          ["a step running with no settings file", undefined, runs + run("running"), undefined],
          // A half-written file: unreadable is busy, whatever the runs.
          [
            "a settings file jq cannot read",
            '{"workflowsEnabled": tr',
            runs,
            "auto-install: FAILED",
          ],
          ["a database from before migration 110", on, "", undefined],
        ];
        for (const [name, settings, rows, holds] of cases) {
          const m = yield* machine();
          yield* m.serviceLoaded;
          if (settings !== undefined) {
            yield* fs.writeFileString(`${m.home}/.t3/userdata/settings.json`, settings);
          }
          if (rows !== "") yield* m.sql(rows);
          const result = yield* m.run(["--run", "job.label"], { T3_FORK_AUTO_INSTALL_WAIT: "1" });
          const last = m.lastLine(result.stdout);
          if (holds === undefined) {
            assert.equal(last, "auto-install: SUCCESS: install.sh finished", name);
          } else {
            assert.isTrue(last.startsWith(holds), `${name}: ${last}`);
          }
        }

        // The launching run's step returns and the run completes while this waits.
        const m = yield* machine();
        yield* m.serviceLoaded;
        yield* fs.writeFileString(
          `${m.home}/.t3/userdata/settings.json`,
          JSON.stringify({ workflowsEnabled: true }),
        );
        yield* m.sql(runs + run("running"));
        const launched = yield* m.run(["--run", "job.label"], {
          SLEEP_HOOK: `sqlite3 "$HOME/.t3/userdata/statev2.sqlite" "UPDATE workflow_runs SET status = 'completed', ended_at = '2026-11-23'"`,
        });
        assert.equal(m.lastLine(launched.stdout), "auto-install: SUCCESS: install.sh finished");
        assert.include(launched.stdout, 'Active: workflow upstream-upgrade run w1 "Fork upgrade".');
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect.skipIf(skip)(
    "changes nothing while runs stay active past its bound, or another run holds the lock",
    () =>
      Effect.gen(function* () {
        const m = yield* machine();
        yield* m.sql(
          "INSERT INTO orchestration_v2_projection_threads (thread_id, title, archived_at, deleted_at) VALUES ('a', 'Stuck', '2026-01-01', NULL), ('b', 'Done', NULL, NULL);" +
            "INSERT INTO orchestration_v2_projection_runs VALUES ('r1', 'a', 'queued'), ('r2', 'b', 'completed');",
        );
        yield* m.running(fork);
        const busy = yield* m.run(["--run", "job.label"], { T3_FORK_AUTO_INSTALL_WAIT: "3" });
        // The thread that holds it, by name, archived or not, logged once while the set stays.
        assert.equal(
          m.lastLine(busy.stdout),
          'auto-install: FAILED: threads/background work still active after 3s: a "Stuck" (archived); nothing was installed',
        );
        assert.lengthOf(busy.stdout.split('Active: a "Stuck" (archived).'), 2);
        assert.lengthOf(yield* m.sleeps, 3);
        assert.deepEqual(yield* m.osascript, []);
        assert.deepEqual(yield* m.installs, []);
        assert.deepEqual(yield* m.opened, []);
        assert.isFalse(yield* m.lockHeld);

        yield* m.holdLock(process.pid);
        const second = yield* m.run(["--run", "job.label"]);
        assert.equal(
          m.lastLine(second.stdout),
          `auto-install: FAILED: another auto-install runs (pid ${process.pid}, holding ${m.lock}); this one changed nothing. If pid ${process.pid} is not an auto-install, remove ${m.lock}`,
        );
        assert.isTrue(yield* m.lockHeld);
        assert.deepEqual(yield* m.installs, []);
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect.skipIf(skip)(
    "installs nothing while an app or its helper outlives the quit, and opens no second app beside it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const m = yield* machine();
        yield* m.running(official, fork);
        const stuck = yield* m.run(["--run", "job.label"], { STUBBORN: official });
        assert.match(
          m.lastLine(stuck.stdout),
          new RegExp(
            `^auto-install: FAILED: still running after 60s: ${official.replaceAll(".", "\\.")}; nothing was installed; did not open T3 Code \\(Fork\\)\\.app, as a T3 Code app runs: ${official.replaceAll(".", "\\.")}$`,
          ),
        );
        assert.deepEqual(yield* m.installs, []);
        assert.deepEqual(yield* m.opened, []);

        // The app quits, and a helper of it does not.
        yield* fs.remove(path.join(m.home, "running", official));
        yield* m.running(fork);
        yield* m.helper(4242);
        const helper = yield* m.run(["--run", "job.label"]);
        assert.match(
          m.lastLine(helper.stdout),
          /^auto-install: FAILED: still running after 60s: pids 4242; nothing was installed; did not open T3 Code \(Fork\)\.app, as a T3 Code app runs: pids 4242$/,
        );
        assert.deepEqual(yield* m.installs, []);
        yield* fs.remove(path.join(m.home, "helpers", "4242"));

        // A run a crash left `running`, and no app or service that could run it: idle at once, with
        // no second read (no sleep) to wait for a run to hand over.
        const sleeps = (yield* m.sleeps).length;
        yield* m.sql(
          "INSERT INTO orchestration_v2_projection_threads (thread_id, deleted_at) VALUES ('a', NULL);" +
            "INSERT INTO orchestration_v2_projection_runs VALUES ('r1', 'a', 'running');",
        );
        const stale = yield* m.run(["--run", "job.label"]);
        assert.match(m.lastLine(stale.stdout), /^auto-install: SUCCESS/);
        assert.include(stale.stdout, "No T3 Code app or service runs, so no run is active.");
        assert.lengthOf(yield* m.sleeps, sleeps);
        assert.lengthOf(yield* m.installs, 1);

        // No app, no service, and no database to read: nothing can be running, so it goes ahead.
        yield* fs.remove(path.join(m.home, ".t3"), { recursive: true });
        const quiet = yield* m.run(["--run", "job.label"]);
        assert.match(m.lastLine(quiet.stdout), /^auto-install: SUCCESS/);
        assert.lengthOf(yield* m.installs, 2);
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );
});

it.layer(NodeServices.layer)("leaving the fork", (it) => {
  const pinUpstream = (environment: Record<string, string>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-home-" });
      const requests: Array<string> = [];
      const exit = yield* ensurePinnedRuntimeInstalled({
        baseDir: home,
        version: "0.1.11",
        fs,
        path: yield* Path.Path,
        runner: yield* ProcessRunner.ProcessRunner,
        platform: "darwin",
        arch: "arm64",
        httpClient: HttpClient.make((request) => {
          requests.push(request.url);
          return Effect.die("no release in a test");
        }),
        validate: () => Effect.void,
      }).pipe(Effect.provideService(HostProcess.Environment, environment), Effect.exit);
      return { exit, requests };
    }).pipe(Effect.provide(ProcessRunner.layer));

  // `t3 update` and a client's server update both pin their target through this call.
  it.effect("refuses upstream's runtime unless asked to leave the fork", () =>
    Effect.gen(function* () {
      const refused = yield* pinUpstream({});
      assert.deepEqual(refused.requests, []);
      assert.isTrue(Exit.isFailure(refused.exit));
      assert.include(String(Exit.isFailure(refused.exit) && refused.exit.cause), FORK_LEAVE_ENV);

      const allowed = yield* pinUpstream({ [FORK_LEAVE_ENV]: "1" });
      assert.isAbove(allowed.requests.length, 0);
    }),
  );
});

it.layer(NodeServices.layer)("t3 service install on a fork build", (it) => {
  // BootService on a temporary home: a runtime's --version runs for real, launchctl only answers.
  const harness = Effect.fn(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const realRunner = yield* ProcessRunner.ProcessRunner;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-service-" });
    const baseDir = path.join(home, ".t3");
    const commands: Array<string> = [];
    const requests: Array<string> = [];
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        input.args.includes("--version")
          ? realRunner.run(input)
          : Effect.sync(() => {
              commands.push(`${input.command} ${input.args.join(" ")}`);
              return fakeResult();
            }),
    });
    const service = (cliVersion: string) =>
      BootService.make({
        baseDir,
        logsDir: path.join(baseDir, "userdata", "logs"),
        cliVersion,
        host: { execPath: "/usr/bin/t3" },
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcess.Platform, "darwin"),
            Layer.succeed(HostProcess.Architecture, "arm64"),
            Layer.succeed(HostProcess.UserId, 501),
            Layer.succeed(HostProcess.ExecutablePath, "/usr/bin/t3"),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) => {
                requests.push(request.url);
                return Effect.die(`downloaded ${request.url}`);
              }),
            ),
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { HOME: home, PATH: "/usr/bin:/bin" } }),
            ),
          ),
        ),
      );
    const reconcile = (cliVersion: string) =>
      Effect.gen(function* () {
        const current = yield* service(cliVersion);
        return yield* reconcileService().pipe(
          Effect.provideService(BootService.BootService, current),
          Effect.provide(ServerConfig.layerTest(home, baseDir)),
        );
      });
    const statePath = path.join(baseDir, "runtime", "service-state.json");
    const activeVersion = fs
      .readFileString(statePath)
      .pipe(Effect.map((text) => parseServiceState(text)?.activeVersion));
    return { home, baseDir, commands, requests, service, reconcile, activeVersion };
  });

  it.effect.skipIf(skipOnWindows)(
    "moves an installed service to the new build's seeded runtime, without a download",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { home, baseDir, commands, requests, service, reconcile, activeVersion } =
          yield* harness();
        for (const version of [versions.earlier, versions.current]) {
          assert.equal((yield* seed(home, printsVersion(version), version)).code, 0);
        }

        // The earlier build's service.
        const plan = yield* (yield* service(versions.earlier)).install();
        assert.equal(yield* activeVersion, versions.earlier);

        // `t3 service install` from the current build: not "already installed".
        commands.length = 0;
        const result = yield* reconcile(versions.current);
        assert.isTrue(result.changed);
        assert.equal(yield* activeVersion, versions.current);
        assert.include(
          yield* fs.readFileString(plan.unitPath),
          `<string>${pinnedRuntimePaths(path, baseDir, versions.current, "darwin").entryPath}</string>`,
        );
        // Stopped, then started on the new runtime.
        assert.deepEqual(
          commands.map((command) => command.split(" ").slice(0, 2).join(" ")),
          ["launchctl bootout", "launchctl enable", "launchctl bootstrap"],
        );
        assert.deepEqual(requests, []);
        assert.isTrue((yield* (yield* service(versions.current)).status).current);
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect.skipIf(skipOnWindows)(
    "refuses a runtime whose sentinel matches but whose t3 reports another version, before stopping the service",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { home, baseDir, commands, requests, service, reconcile, activeVersion } =
          yield* harness();
        assert.equal(
          (yield* seed(home, printsVersion(versions.earlier), versions.earlier)).code,
          0,
        );
        yield* (yield* service(versions.earlier)).install();

        const wrong = path.join(baseDir, "runtime", "versions", versions.current);
        yield* fs.makeDirectory(wrong);
        yield* fs.writeFileString(path.join(wrong, "t3"), printsVersion(versions.earlier));
        yield* fs.chmod(path.join(wrong, "t3"), 0o755);
        yield* fs.writeFileString(path.join(wrong, ".install-complete"), `${versions.current}\n`);

        commands.length = 0;
        const exit = yield* reconcile(versions.current).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(exit));
        assert.include(
          String(Exit.isFailure(exit) && exit.cause),
          "verifying the pinned t3 runtime",
        );
        assert.deepEqual(commands, []);
        assert.deepEqual(requests, []);
        assert.equal(yield* activeVersion, versions.earlier);
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );
});
