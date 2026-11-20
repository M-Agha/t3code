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
    options: { utc?: string } = {},
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
        const { result, release, version, log } = yield* build(yield* buildRepo());
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(release, [`t3-${version}-darwin-arm64.tar.gz`]);
        assert.equal(version, `${versions.tag}.20261120120000`);
        assert.isTrue(isExactServiceVersion(version));
        assert.equal(compareExactServiceVersions(version, versions.tag), 1);
        const steps = log.join("\n");
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
});

it.layer(NodeServices.layer)("scripts/fork/install.sh", (it) => {
  const appName = "T3 Code (Fork).app";
  const plist = (version: string) =>
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      `<key>CFBundleShortVersionString</key><string>${version}</string>`,
      "</dict></plist>",
      "",
    ].join("\n");

  // A repo with the two scripts and a release/, a HOME with ~/.t3 and a database but no service unit,
  // an Applications folder, and stand-ins for what would touch the machine: pgrep (no app runs),
  // launchctl (the service runs when SERVICE_RUNNING=1), mise (runs the rest with this node), and mv
  // (KILL_AFTER_ASIDE=1 kills install.sh right after it moves the old app to the trash).
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
    for (const script of ["install.sh", "seed-runtime.sh"]) {
      yield* fs.copyFile(
        `${repoRoot}scripts/fork/${script}`,
        path.join(repo, "scripts", "fork", script),
      );
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
    yield* tool("pgrep", "exit 1");
    yield* tool("launchctl", '[ "$1" = print ] && [ "${SERVICE_RUNNING:-}" = 1 ]');
    yield* tool("mise", 'shift 3; exec "$@"');
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
    // unless UNRECORDED=1 (upstream then only warns).
    const runtime = (version: string) =>
      [
        "#!/bin/sh",
        'if [ "$1" = install ]; then',
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

    const install = (env: Record<string, string> = {}) =>
      runner.run({
        command: path.join(repo, "scripts", "fork", "install.sh"),
        args: [],
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
    // `t3 service install` leaves its unit, and the service state naming the runtime it runs.
    const service = (activeVersion?: string) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(
          path.join(home, "Library", "LaunchAgents", "com.t3tools.t3code.service.plist"),
          "",
        );
        if (activeVersion === undefined) return;
        yield* fs.writeFileString(
          path.join(runtimeDir, "service-state.json"),
          JSON.stringify({ protocol: 4, activeVersion }),
        );
      });
    return {
      home,
      apps,
      forkBin,
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
    "seeds before it moves the app, puts the previous app back on failure, and says which t3 to run",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const m = yield* machine();
        const restart = `run: "${m.shimPath}" service restart`;

        // The earlier build, with `t3` already its CLI. Its `t3 install` cannot record the launcher
        // (upstream only warns): refused, and the app is taken back out.
        yield* m.release(versions.earlier);
        yield* m.shim(versions.earlier);
        const unrecorded = yield* m.install({ UNRECORDED: "1" });
        assert.notEqual(unrecorded.code, 0);
        assert.include(unrecorded.stderr, "did not record");
        assert.isUndefined(yield* m.installedVersion);

        // Seeded, its launcher written and recorded, installed; no service yet, so install one.
        const first = yield* m.install();
        assert.equal(first.code, 0, first.stderr);
        assert.equal(yield* m.installedVersion, versions.earlier);
        assert.equal(yield* m.linked, versions.earlier);
        assert.include(first.stdout, `on this build, run: "${m.shimPath}" service install`);
        assert.notInclude(first.stdout, "stopped");
        const backups = (yield* m.backups).length;

        // A T3CODE_HOME other than ~/.t3, which an app opened from Finder never sees: refused
        // before the backup.
        yield* m.release(versions.current);
        const elsewhere = yield* m.install({ T3CODE_HOME: path.join(m.home, "other") });
        assert.notEqual(elsewhere.code, 0);
        assert.include(elsewhere.stderr, "unset T3CODE_HOME");
        assert.lengthOf(yield* m.backups, backups);
        assert.deepEqual(yield* m.seededVersions, [versions.earlier]);

        // The service runs on the earlier build: refused before the backup, nothing changes.
        yield* m.service(versions.earlier);
        const busy = yield* m.install({ SERVICE_RUNNING: "1" });
        assert.notEqual(busy.code, 0);
        assert.include(busy.stderr, "launchctl bootout gui/");
        assert.include(busy.stderr, `"${m.shimPath}" service restart starts it again`);
        assert.notInclude(busy.stderr, restart);
        assert.lengthOf(yield* m.backups, backups);
        assert.deepEqual(yield* m.seededVersions, [versions.earlier]);

        // Stopped for this run, then refused for its T3CODE_HOME: it still says how to start it again.
        const stoppedElsewhere = yield* m.install({ T3CODE_HOME: path.join(m.home, "other") });
        assert.notEqual(stoppedElsewhere.code, 0);
        assert.include(stoppedElsewhere.stderr, restart);

        // No runtime archive: refused, the app stays, and the stopped service gets its command.
        yield* m.release(versions.current, { runtime: "missing" });
        const missing = yield* m.install();
        assert.notEqual(missing.code, 0);
        assert.include(missing.stderr, "no runtime archive");
        assert.include(missing.stderr, restart);
        assert.equal(yield* m.installedVersion, versions.earlier);

        // The seed fails: it comes first, so the app is never moved.
        yield* m.release(versions.current, { runtime: "corrupt" });
        const unseeded = yield* m.install();
        assert.notEqual(unseeded.code, 0);
        assert.equal(yield* m.installedVersion, versions.earlier);
        assert.deepEqual(yield* m.seededVersions, [versions.earlier]);

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

        // Installed, but `t3` is another app's CLI: open the fork app first.
        yield* m.shim("0.1.11-nightly.20261119.4900");
        const installed = yield* m.install();
        assert.equal(installed.code, 0, installed.stderr);
        assert.equal(yield* m.installedVersion, versions.current);
        assert.equal(yield* m.linked, versions.current);
        assert.include(
          installed.stdout,
          `Open T3 Code (Fork) once, then run: "${m.shimPath}" service install`,
        );
        assert.notInclude(installed.stdout, "on this build");
        // Done: the previous app stays in the trash, and nothing is put back on the way out.
        const aside = /^Moved the previous fork app to (.+)\.$/m.exec(installed.stdout)?.[1] ?? "";
        assert.isTrue(yield* fs.exists(path.join(aside, "Contents", "Info.plist")), aside);
        assert.notInclude(installed.stderr, "install:");

        // The same build again, its service already on it, where `service install` would answer
        // "already installed" and leave it stopped: restart it.
        yield* m.shim(versions.current);
        yield* m.service(versions.current);
        const again = yield* m.install();
        assert.equal(again.code, 0, again.stderr);
        assert.include(again.stdout, "The background service is stopped.");
        assert.include(again.stdout, `on this build, run: "${m.shimPath}" service restart`);
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
