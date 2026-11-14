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

| Commit subject                                                    | What it adds                  |
| ----------------------------------------------------------------- | ----------------------------- |
| `feat: track end-of-reply decision questions natively`            | Questions and decisions       |
| `feat: per-thread parked items with /park and t3_park`            | Parked items                  |
| `feat: per-thread Artifacts tab`                                  | Artifacts                     |
| `refactor: take question logic from session-kit's reply.ts`       | Shared logic with session-kit |
| `fix: read a reply that finishes after its run ended`             | A listener gap                |
| `chore: name fork builds T3 Code (Fork) with their own bundle ID` | App identity                  |

`git log --oneline upstream/main..fork/main` lists them with hashes.

### Questions and decisions

- **Source:** T3's server reads a finished reply's Q-block text. Agents keep writing text, so the
  same reply works in a terminal and in T3, for every provider. _Rejected:_ a tool agents must
  remember to call.
- **Closing:** deterministic, from the user's own messages, with session-kit's `readReply`
  (`Q4: yes`, "go with your picks", "not a decision"). A message naming no label closes nothing, so
  clarifying questions are safe. The buttons (Accept, Answer, Drop) send ordinary messages, so the
  agent sees every answer. Only messages a person typed count: agent, scheduled-task and relayed
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

1. `git fetch upstream main`, then `git rebase upstream/main` on `fork/main`.
2. `git diff --name-status $(git merge-base fork/main upstream/main) fork/main` lists every
   upstream file the fork modifies (`M`) and every file it adds (`A`). The modified ones are where
   conflicts happen.
   - The hot spots are `ws.ts`, `server.ts`, `Sqlite.ts`, `rpc.ts`, `ChatView.tsx`,
     `RightPanelSurfaceContent.tsx`, the composer send path, and the MCP thread toolkit.
3. **On a conflict, re-apply the intent, not the old hunk.** If upstream rebuilt a seam the fork
   used (for example, the right panel's surfaces or the composer's slash commands), attach the
   feature to the new seam the way upstream's own features now do, and record the change here.
   - If upstream shipped a native version of a fork feature, prefer upstream's and delete the
     fork's, keeping the owner's decisions above as the acceptance test.
4. **Check:** `vp run check:changed`, plus these tests, under Node from `package.json` `engines`,
   using the repo's own `node_modules/.bin/vp`:
   - `packages/shared/src/sessionKit`, the drift test included.
   - `apps/server/src/decisions`.
   - `apps/server/src/persistence/ForkMigrations.test.ts` and `Sqlite.test.ts`.
   - The desktop identity tests in `apps/desktop/src/app`.
5. **Live check:** on a dev server on an isolated home, never `~/.t3`:
   `vp run dev --home-dir "$PWD/.t3"`, since in a main checkout dev falls back to `~/.t3`. Use a
   Replay thread, or one cheap Claude Haiku thread with permissions set to Supervised in a scratch
   project:
   - a Q-block reply, then Accept;
   - `/park` while idle and mid-run;
   - `t3_park`;
   - an Artifacts row.
6. **Build:** `env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY vp run dist:desktop:dmg:arm64`.
   No update feed may be set; the build must not contain `app-update.yml`.

## Installing

`scripts/fork/install.sh` refuses while any T3 Code app runs. It then copies the live
`~/.t3/userdata/statev2.sqlite` to `~/.claude/trash/` with SQLite's online backup, checks the copy's
integrity, and installs `T3 Code (Fork).app` from `release/` beside the official apps. The first start
of a newer build migrates `~/.t3` one way, and that copy is the only way back.

## Outside this repo

- session-kit stands down in T3, when `T3CODE_THREAD_ID` is set, from what the fork owns: finding
  and judging questions, `/board` parking and the `park` tool. Dotfiles PR #596.
- session-kit's reply.ts carries the logic the fork shares. Dotfiles PR #600; the drift test is red
  until it merges.

## Known noise

- On macOS two Linux icon tests in `apps/desktop/src/app/DesktopLinuxUrlHandler.test.ts` fail
  upstream too: APFS is case-insensitive, so the two icon spellings are one file.
- `check:changed`'s "unused patches" step has failed intermittently on a pnpm peer-dependency warning
  (`@tiptap/core`), also on clean branches.
- `npm:vite-plus` run through mise fails Effect tests ("Vitest failed to find the current suite"); use
  the repo's `node_modules/.bin/vp`.
