# Fork: what this branch adds to T3 Code, and how to carry it forward

This is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). It is never
merged upstream (upstream's CONTRIBUTING.md refuses unsolicited features). `fork/main` is upstream
`main` plus the fork's commits, in order, every one tagged `(fork)` in its subject. When upstream
moves, `fork/main` is rebased onto it. This file is what a session needs to do that, including
redoing a change differently when upstream has moved under it.

Read it before rebasing, resolving a conflict, or changing anything the fork added. Commit messages
carry each change's detail; this file carries the intent, the decisions, and the rules a rebase must
keep. Where they disagree with the code, the code is what ships; fix this file.

## The goal

The owner ends agent replies with decision questions in one shape, from their global agent rules:

`Q<n>, <key words>: <question> My pick is <pick>: <reason>`

In a terminal, their Claude Code plugin **session-kit** (dotfiles repo,
`.claude/mods/session-kit/`) tracks those questions, parked items and artifacts on a "board". In T3
those parts of session-kit cannot draw anything, so the fork makes the same features native to T3:
stored per thread, for every provider, shown in T3's own UI. The owner chose each design below; the
reasons are the ones they accepted.

## The changes (oldest first)

| Commit subject                                                              | What it adds                  |
| --------------------------------------------------------------------------- | ----------------------------- |
| `feat: track end-of-reply decision questions natively`                      | Questions and decisions       |
| `feat: per-thread parked items with /park and t3_park`                      | Parked items                  |
| `feat: per-thread Artifacts tab`                                            | Artifacts                     |
| `refactor: take question logic from session-kit's reply.ts`                 | Shared logic with session-kit |
| `fix: read a reply that finishes after its run ended`                       | A listener gap                |
| `chore: name fork builds T3 Code (Fork) with their own bundle ID`           | App identity                  |
| `feat: mark fork-launched Claude processes with T3CODE_OWNS_BOARD`          | Outside this repo             |
| `fix: install.sh backs up a quit app's database`                            | Installing                    |
| `fix: the stage-label schema accepts Fork, so the fork app launches`        | App identity                  |
| `feat: Accept and Drop add to the draft; long questions keep their buttons` | Questions and decisions       |
| `fix: fork builds keep T3 Connect, and install.sh refuses one without it`   | Rebasing, step 7              |

The table names features; `docs:` and `chore: re-copy session-kit's reply.ts` commits are left out.
`git log --oneline <base>..fork/main` lists every fork commit with its hash, where `<base>` is the
upstream release the fork sits on (`git merge-base fork/main upstream/main`).

### Questions and decisions

- **Source:** T3's server reads a finished reply's Q-block text. Agents keep writing text, so the
  same reply works in a terminal and in T3, for every provider. _Rejected:_ a tool agents must
  remember to call.
- **Closing:** deterministic, from the user's own messages, with session-kit's `readReply`
  (`Q4: yes`, "go with your picks", "not a decision"). A message naming no label closes nothing, so
  clarifying questions are safe. The buttons (Accept, Answer, Drop) add one line each to the
  composer instead of sending, so several answers go out as one ordinary message and the agent
  sees every answer; a question the draft already closes shows "in draft". Only messages a person typed count: agent, scheduled-task and relayed
  messages close nothing. _Rejected:_ a model judging each message; an agent "close" tool.
- **When a reply is read:** at turn end (a run `waiting` or `completed`), never while a message
  streams; also when an assistant message finishes, and on subscribe, through a per-thread watermark
  (rows are derivable; replies written while an official build ran are backfilled).
- **Display:** the latest open questions in a strip above the composer; a right-panel "Decisions"
  surface with Questions and Decisions tabs; nothing inside replies. Not on mobile.
- **Code:** `apps/server/src/decisions/ThreadDecisions.ts` (one service for ws.ts and MCP),
  `apps/web/src/components/chat/ThreadDecisions.tsx`, contracts in
  `packages/contracts/src/threadDecisions.ts`.

### Parked items

- Kinds `todo`, `later`, `prompt`; states `open`, `done`, `dropped`, `sent`; parked by `user` or
  `agent`; per thread.
- `/park <text>` is T3-local: it never reaches the provider. It is parsed with session-kit's
  `readParks`/`isPlaceholder`, so the syntax matches session-kit's `/board`. It is refused while
  editing a queued message, with attachments, on an unstarted thread, and on mobile.
- `t3_park` in the thread MCP toolkit, for every provider. It refuses delegated child threads and
  placeholder text. Its eval cases (`evals/mcp-tool-use/cases/parked.ndjson`) have only run with
  `--dry-run`; a real run is owed.
- A Parked tab: Send (an ordinary message, queued during a run), inline Edit, Done, Drop, Reopen.
- The startup sweep deletes parked rows only for soft-deleted threads: unlike questions, they
  cannot be rebuilt.

### Artifacts

- Rows from Claude Code's `Artifact` tool calls (`dynamic_tool` turn items, driver `claudeAgent`,
  output carrying a `url`) and from `claude.ai/artifact/<id>` and `claude.ai/code/artifact/<uuid>`
  links in assistant messages. A tool call wins over a mention. `/code/` links match the publish's
  `artifact_id`; whether those two ids always agree is unverified, so both are stored.
- One row per artifact: first-seen kept, title and time from the latest publish. Its own
  watermarks, the tool one advancing over every `dynamic_tool` row so threads are not re-parsed.
- Opened through `useOpenLink`, plus a system-browser button. No embedding, no claude.ai API, no
  manual add or remove.

### Shared logic with session-kit

- `packages/shared/src/sessionKit/reply.ts` is a **byte-for-byte copy** of session-kit's
  `hooks/reply.ts` below its header. Never edit it here. Change session-kit, then copy.
- `reply.drift.test.ts` byte-compares it with `~/repos/dotfiles/.claude/mods/session-kit/hooks/reply.ts`
  when that checkout exists, and skips otherwise.
- Fork-only logic beside it (`decisions.ts`, `parks.ts`) must not re-implement anything reply.ts
  exports. A full core extraction (folder, subtree, package) was judged not worth it.

### A reply that finishes after its run ended

A run can read as ended (`waiting`) while its last message still streams. The listener also syncs
when an assistant message finishes, so those questions are not held until the next event.

### App identity

- The fork's macOS app is `T3 Code (Fork)`, bundle ID `com.t3tools.t3code.fork`, and the runtime
  stage label `Fork`. It installs beside the owner's official `T3 Code (Nightly)`, kept as a fallback.
- Both share `~/.t3` and Electron's `t3code-v2` data folder on purpose: same threads, one app
  running at a time.
- Saved remote connections are encrypted with a keychain key named after the app, so they may need
  re-entering in the fork (inferred, unverified).

## Rules a rebase must keep

1. **Storage never touches upstream's migration ids.** Fork tables are created by a second
   `effect/sql/Migrator` run with its own ledger, `fork_sql_migrations`
   (`apps/server/src/persistence/ForkMigrations.ts`, run from `Sqlite.ts` after upstream's).
   - The Migrator skips every id at or below the highest recorded, so a fork id in upstream's table
     would silently block upstream's next migrations.
   - Fork migrations are idempotent, with no foreign keys or triggers on upstream tables.
   - New fork state goes in a new numbered fork migration. Never edit a committed one.
   - _Rejected:_ new orchestration event types, since official builds reject unknown events on
     server replay.
2. **The fork refuses a database ahead of it.** On startup the fork refuses when
   `effect_sql_migrations` holds ids above its own head (an official build migrated further). Keep
   that guard. Official builds only warn on a newer database, so the fork must be the stricter one.
3. **Before the owner installs a newer official Nightly, rebase and rebuild the fork.** The newer
   Nightly migrates `~/.t3` past the fork's head, and the fork then refuses to start until rebuilt
   from an upstream that has those migrations.
4. **The reply.ts copy stays byte-identical** (see Shared logic). If upstream's tooling starts
   formatting it, keep it exempt in `vite.config.ts` and `knip.jsonc`.
5. **Mobile stays untouched** except the `/park` refusal in `use-thread-composer-state.ts`.

## Rebasing onto upstream

1. **Pick the target: the official Nightly the owner runs, not `upstream/main`.** The Nightly is their
   fallback; `upstream/main` may carry migrations the Nightly lacks, and a fork built from it would
   migrate `~/.t3` past what the Nightly can open. Use that Nightly's tag
   (`v<version>-nightly.<date>.<n>`, `git fetch upstream --tags`) and check its migration head: the last
   entry in `apps/server/src/persistence/Migrations.ts` at the tag.
2. Keep the old head first: `git branch fork/main-pre-<version> fork/main`, push it. Then
   `git rebase --onto <tag> $(git merge-base fork/main upstream/main) fork/main`.
   - Node comes from the **target's** `package.json` `engines.node` and may change between releases:
     `mise install node@<v>`, run git through `mise exec node@<v> -- git …` (the pre-commit hook
     runs `vp staged`), and `vp i` once the rebase is done.
3. `git diff --name-status <tag> fork/main` lists every upstream file the fork modifies (`M`) and every
   file it adds (`A`). The modified ones are where conflicts happen.
   - The hot spots are `ws.ts`, `server.ts`, `Sqlite.ts`, `rpc.ts`, `ChatView.tsx`,
     `rightPanelStore.ts`, `RightPanelTabs.tsx`, `RightPanelSurfaceContent.tsx`, the composer send
     path, the MCP thread toolkit, and `ClaudeAdapterV2.ts` (the `T3CODE_OWNS_BOARD` line, in the
     query `env` beside `PortScanner.AGENT_THREAD_ENV`).
   - Most conflicts are two lists growing at once (imports, surface kinds, layers, test cases):
     keep both.
   - `apps/server/src/provider/agentContextBudget.json` must equal the measured size exactly; the fork's
     `t3_park` adds to `mcpToolListJsonBytes`. Set it from `AgentContextBudget.test.ts`'s output.
4. **On a conflict, re-apply the intent, not the old hunk.** If upstream rebuilt a seam the fork used
   (for example, the right panel's surfaces or the composer's slash commands), attach the feature to
   the new seam the way upstream's own features now do, and record the change here.
   - If upstream shipped a native version of a fork feature, stop and ask the owner; if they agree,
     prefer upstream's and delete the fork's, keeping the owner's decisions above as the acceptance test.
   - Seams already moved: MCP tools that act as their calling thread must carry
     `.annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients)`, or every
     toolkit layer dies at build ("t3_park acts as its calling thread, so outside clients must not be
     offered it"). `t3_park` has it since v0.1.11.
   - Fix-ups go in as `git commit --fixup=<fork commit>`, then
     `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash <tag>`, so each fork commit stays whole.
5. **Check:** `vp run check:changed <tag>`, plus these tests, under that Node, using the repo's own
   `node_modules/.bin/vp`:
   - `packages/shared/src/sessionKit`, the drift test included.
   - `apps/server/src/decisions`.
   - `apps/server/src/persistence/ForkMigrations.test.ts` and `Sqlite.test.ts`.
   - The desktop identity and environment tests in `apps/desktop/src/app` (`DesktopAppIdentity`,
     `DesktopEnvironment`, `DesktopPreReadyPlatform`).
   - `apps/web/src/components/chat/threadDecisions.logic.test.ts`, `composerSend.logic.test.ts` and
     `ThreadDecisions.parked-focus.browser.test.tsx`.
6. **Live check:** on a dev server on an isolated home, never `~/.t3`. Reseed it first, since the
   schema moved: `node apps/server/scripts/migrate-dev-db.ts --base-dir "$PWD/.t3"` (reads `~/.t3`
   read-only; its fork tables come along). Then `vp run dev --home-dir "$PWD/.t3"`, since in a main
   checkout dev falls back to `~/.t3`.
   - If the startup pairing URL does not sign in, mint one from `apps/server`:
     `node src/bin.ts pair --base-dir <checkout>/.t3`.
   - Use a desktop-width window (the strip is not shown on mobile widths). Before typing `/park`,
     switch the thread's model to `Replay (dev)`: if the intercept ever fails, the text goes to a free
     provider instead of starting a paid turn.
   - A seeded thread with open questions shows the strip and the Decisions panel; Accept adds a line
     to the composer and marks the question "in draft"; `/park x` parks without sending; a thread with
     a `claude.ai/…artifact/…` link lists it in Artifacts; the server log has no schema errors. With a
     cheap Claude Haiku thread (Supervised, scratch project) also: `/park` mid-run and `t3_park`.
7. **Build:** `.env` must exist (`cp .env.example .env`, once per checkout; gitignored). Without it the
   app is built with T3 Connect off and cannot reach machines linked through T3's relay. The values
   are upstream's public production identifiers, the same ones official builds embed. Move any old
   `release/T3-Code-*-arm64.*` aside, then
   `env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY vp run dist:desktop:dmg:arm64`.
   No update feed may be set; the build must not contain `app-update.yml`. `scripts/fork/install.sh`
   refuses a build without T3 Connect. Push with `git push --force-with-lease origin fork/main` only
   after every check passes.

## Installing

`scripts/fork/install.sh` refuses while any T3 Code app runs. It then copies the live
`~/.t3/userdata/statev2.sqlite` to `~/.claude/trash/` with SQLite's online backup, checks the copy's
integrity, and installs `T3 Code (Fork).app` from `release/` beside the official apps. The first start
of a newer build migrates `~/.t3` one way, and that copy is the only way back.

## Outside this repo

- session-kit stands down from what the fork owns (finding and judging questions, `/board` parking
  and the `park` tool) when `T3CODE_OWNS_BOARD=1` is in the agent's environment. The fork's Claude
  adapter sets it (`ClaudeAdapterV2.ts`, beside `T3CODE_THREAD_ID`); official builds never do. Keep
  it on every rebase: without it session-kit and the fork both track questions. Keying on
  `T3CODE_THREAD_ID` was wrong, because official builds set that too, and session-kit would go quiet
  inside an official T3 that tracks nothing natively. Dotfiles PR #596.
- session-kit's reply.ts carries the logic the fork shares (dotfiles PR #600, merged). The drift test
  reads the file from the local dotfiles checkout, so it goes red whenever that checkout is behind or
  ahead of the copy: compare against the copy's header commit before re-copying.

## Known noise

- On macOS two Linux icon tests in `apps/desktop/src/app/DesktopLinuxUrlHandler.test.ts` fail
  upstream too: APFS is case-insensitive, so the two icon spellings are one file.
- `check:changed`'s "unused patches" step has failed intermittently on a pnpm peer-dependency warning
  (`@tiptap/core`), also on clean branches.
- `apps/web/src/components/ChatView.browser.test.tsx` "a shortcut conditioned on rightPanelOpen sees
  the thread's open right panel" times out when the whole file runs on this Mac, and passes alone. It
  fails the same on the plain `v0.1.11-nightly.20261117.4825` tag.
- `npm:vite-plus` run through mise fails Effect tests ("Vitest failed to find the current suite"); use
  the repo's `node_modules/.bin/vp`.
