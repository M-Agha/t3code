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

| Commit subject                                                                                       | What it adds                  |
| ---------------------------------------------------------------------------------------------------- | ----------------------------- |
| `feat: track end-of-reply decision questions natively`                                               | Questions and decisions       |
| `feat: per-thread parked items with /park and t3_park`                                               | Parked items                  |
| `feat: per-thread Artifacts tab`                                                                     | Artifacts                     |
| `refactor: take question logic from session-kit's reply.ts`                                          | Shared logic with session-kit |
| `fix: read a reply that finishes after its run ended`                                                | A listener gap                |
| `chore: name fork builds T3 Code (Fork) with their own bundle ID`                                    | App identity                  |
| `feat: mark fork-launched Claude processes with T3CODE_OWNS_BOARD`                                   | Outside this repo             |
| `fix: install.sh backs up a quit app's database`                                                     | Installing                    |
| `fix: the stage-label schema accepts Fork, so the fork app launches`                                 | App identity                  |
| `feat: Accept and Drop add to the draft; long questions keep their buttons`                          | Questions and decisions       |
| `fix: fork builds keep T3 Connect, and install.sh refuses one without it`                            | Rebasing, step 7              |
| `(fork) decisions: open questions show one at a time, like T3's own question panel`                  | Questions and decisions       |
| `(fork) decisions: answers on AskUserQuestion cards close the matching question`                     | Questions and decisions       |
| `(fork) decisions: a model judge reads your replies, as in the terminal, with its model in settings` | Questions and decisions       |
| `(fork) decisions: the right panel is called Tracker`                                                | Questions and decisions       |
| `(fork) decisions: Accept and send, and Yes to all, in the question panel`                           | Questions and decisions       |

The table names features; `docs:` and `chore: re-copy session-kit's reply.ts` commits are left out.
`git log --oneline <base>..fork/main` lists every fork commit with its hash, where `<base>` is the
upstream release the fork sits on (`git merge-base fork/main upstream/main`).

### Questions and decisions

- **Source:** T3's server reads a finished reply's Q-block text. Agents keep writing text, so the
  same reply works in a terminal and in T3, for every provider. _Rejected:_ a tool agents must
  remember to call.
- **Closing:** from the user's own messages, as the terminal closes them. session-kit's model judge
  (`judge.ts`: `JUDGE_SYSTEM`, `judgePrompt`, `parseVerdict`, `scopeVerdict`) reads every message a
  person typed while questions are open, with the open questions and the reply it follows, and its
  verdict decides; `scopeVerdict` only removes labels (a blanket "yes" never closes a question an
  earlier reply asked unless the message or the last reply names it). The rules (`closingFor`, over
  session-kit's `readReply`: `Q4: yes`, "go with your picks", "not a decision") decide only when the
  call fails, takes over 20 s, or its answer does not parse (logged as a warning). So a bare "yes" right after a question
  block, "merge it" or "go with 2" closes what it answers, and a message that answers nothing (a
  clarifying question) closes nothing. The model is the "Decision judge" setting (Settings → Threads,
  below the text generation model; `decisionJudgeModelSelection`, where null follows
  `textGenerationModelSelection`, as transcript cleanup's setting does), called through T3's
  text-generation path, so any provider T3 is signed in to works. That path has no free-text
  operation: `generateTranscriptionPostProcessing` is the one whose input is the whole prompt and
  whose output is one string, so the verdict's JSON travels in that string, and the prompt spells out
  the envelope `{"transcription":"<verdict JSON>"}` for text generators, which enforce no schema
  (`DecisionJudge.ts`; a fork-only operation on every provider is the upgrade path if a model will not
  put it there). That path also has no system slot: `JUDGE_SYSTEM` rides at the top of the user turn,
  under the provider's own system prompt, so session-kit's measured accuracy (its judge sends
  `JUDGE_SYSTEM` as the system prompt) does not carry over; T3's is unmeasured. The timeout is 20 s,
  not the terminal's 8: each call starts a provider CLI (2.3 s and 4.8 s with Claude Sonnet,
  2026-11-17). Model calls run under the thread's lock but never inside a transaction: the rows
  before each user message commit first (so the questions it may close include those they asked),
  then it is judged, then its closing commits with the watermark past it. The listener syncs up to 4
  threads at once, so one thread's judge does not hold up the others. A subscriber gets the current
  rows at once; the backlog is judged in full in the background (never handed to the rules to save
  time) and its changes publish as they commit. A Reopen clicked while a thread's backlog is being
  judged waits for it, as it takes the same lock. The panel's "In draft" preview stays rule-based (no model per keystroke), so it can
  show less than what closes on send. The panel's answers (Accept, Answer…, Not a decision) add one
  line each to the composer instead of sending, so several answers go out as one ordinary message and
  the agent sees every answer. Only messages a person typed count: agent, scheduled-task and relayed
  messages close nothing. (2026-11-17: the owner's Q30 reversed the earlier rejection of a model
  judge. Rules alone left answers by key words, numbered picks and bare assents open, and a judge run
  only on messages the rules left unclosed would keep those false negatives: "Q4: yes, and merge it"
  closes Q4 by rule, so the question "merge it" answers would never reach it. The owner asked for the
  judge's model and effort to be chosen the way T3 chooses its text-generation model.) _Rejected:_
  the judge only on messages the rules leave unclosed; a hard-coded judge model; an agent "close"
  tool.
- **Answers on AskUserQuestion cards** close the question whose label leads the card question's
  text (session-kit's `Q_LINE`, as the terminal reads it). Parts asked as "Q28 (1 of 3)" … gather in
  the card's order into one reply (`Q28: a, b; c; d`); a part left unanswered closes nothing. The
  reply goes through `closingFor` (never the judge) with that label's row alone, so "Not a decision"
  drops it and option text naming another label closes nothing else. Only a question asked before the card was answered
  closes. Each card is read once, after the messages, through its own watermark (fork migration 004's
  columns on `fork_thread_decision_sync`), so a question reopened by hand stays open; a card answered
  while a reply is still unread waits for it. (2026-11-17: Q28 was answered on a card and stayed
  open.) _Rejected:_ a label anywhere in the card's text (a card can cite an older label); a new
  turn-item listener (the run's end already syncs).
- **Reopening:** only a shaped re-ask of a known label (one with "My pick is") reopens or rewords
  it. An unshaped line naming a known label ("Q7: nothing to change." right after the user's
  "Q7: yes") changes nothing; a label never seen before is still recorded. (2026-11-17: agent
  echoes reopened answered questions under the earlier rule, which let any line reopen one.)
- **When a reply is read:** at turn end (a run `waiting` or `completed`), never while a message
  streams; also when an assistant message finishes, and on subscribe, through a per-thread watermark
  (rows are derivable; replies written while an official build ran are backfilled).
- **Display:** the latest reply's open questions above the composer, one at a time, built like T3's
  own AskUserQuestion panel: a header (label, key words, `1/3` with Previous/Next, collapse, Open
  Tracker, whose tooltip counts earlier open questions), the question as markdown, then option rows
  Accept: <pick> (its reason below it), Answer… and Not a decision. The selected row follows the draft
  (`questionsClosedByDraft`, the server's fallback rules `closingFor`: "go with your picks" or an
  exact Accept line selects Accept) and the header says "In draft". Accept and Not a decision move to
  the next question the draft does not close, only once the composer took the line; Answer… stays.
  Accept's row ends in a quiet send button (Accept and send: a muted arrow, primary only on hover
  or focus, so it does not compete with the composer's own send) that adds the same line and then
  sends the whole draft through the composer's own send (`ChatComposerHandle.submit`, the send
  button's path, so a busy run queues or steers as the user set); adding stays the default, since
  answers are usually chained. From two open questions up, the header has a quiet Yes to all, which
  adds one line `Yes to your picks: Q3, Q4` (the transcript mod's `yesToAll` format: in order, only
  questions with a pick that the draft does not already close, `yesToAllLine`), and its own send
  button. That line selects Accept for what it names, so a second press has nothing to add. Once the
  draft holds a send button's line (Accept selected; for Yes to all, every pick already answered),
  the button only sends. Both send buttons are disabled while their send is in flight.
  `useInsertAndSend` in `ThreadDecisions.tsx` does the sending: it commits the line before sending
  (`flushSync`; otherwise the composer sends the last render's draft, and an empty draft in an
  interrupted thread resumed the run instead), then tells by the draft: a sent or queued one is
  cleared, and one still holding exactly the line was refused or put back after a failed send, so it
  returns to what it was before the line. "Not sent" is shown only when the composer refused without
  a word (`submit()` returns "blocked": dictating, sending disabled, no right to operate); every
  other refusal already shows T3's own reason. It is a hook outside ChatView's body on purpose:
  written inline there, its callback kept earlier renders' thread structures alive, and
  `ChatView.browser.test.tsx` "a mounted thread view lets go of the thread structures it has
  replaced" failed. (2026-11-17: the owner's Q31 asked for both, as the mod has them; the mod's
  "answer all" was left out. Fable 5.2's review asked for the rest; its worry that a weak judge reads
  the Yes to all line as a blanket accept was declined, since the line is the mod's exact format.) Collapse lasts for one reply. While T3's own question is pending, the composer hides this panel
  (`shelfItems`), and a browser test holds that. Nothing shows inside replies, and nothing on mobile.
  (2026-11-17, replacing a strip of one row per question that the owner called ugly; design approved
  by a two-model council.) _Rejected:_ a two-line list (tall, three buttons per row); chips with
  popovers (hide the question); one banner per question; real radios with arrow-key selection (the
  native panel uses buttons too).
- **Tracker:** the right-panel surface with the Questions, Decisions, Parked and Artifacts tabs. Its
  user-visible name is Tracker everywhere (its tab, both add-panel menus, the command palette's "Show
  Tracker", the keybinding's "Tracker: Toggle", the panel header's Open Tracker); the tabs keep their
  names. Its ids stay `decisions` (the surface kind and id in `rightPanelStore.ts` and
  `closedViewStore.ts`, the `decisions.toggle` command, `decisionsPanelTabStore.ts`): persisted panel
  state, reopenable closed tabs and saved keybindings name them. (2026-11-17: the owner's Q31 renamed
  it from "Decisions".)
- **Code:** `apps/server/src/decisions/ThreadDecisions.ts` (one service for ws.ts and MCP),
  `apps/server/src/decisions/DecisionJudge.ts` (the model call),
  `apps/web/src/components/chat/ThreadDecisions.tsx`,
  `apps/web/src/components/settings/DecisionJudgeModelRow.tsx`, contracts in
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

- `packages/shared/src/sessionKit/reply.ts` and `judge.ts` are **byte-for-byte copies** of
  session-kit's `hooks/reply.ts` and `hooks/judge.ts` below their headers. Never edit them here.
  Change session-kit, then copy.
- `drift.test.ts` byte-compares each with its source in
  `~/repos/dotfiles/.claude/mods/session-kit/hooks/` when that checkout exists, and skips otherwise.
- judge.ts's imports resolve to fork shims, so the copy needs no edit: `sessionKit/board-file.ts`
  re-exports `lastTurn` from reply.ts (as session-kit's board-file.ts does), and
  `packages/shared/src/types/index.d.ts` declares the board's `Question` row. If judge.ts starts
  importing more, add it to a shim, never to the copy.
- Fork-only logic beside them (`decisions.ts`, `parks.ts`) must not re-implement anything reply.ts or
  judge.ts exports; `decisions.ts`'s `judgeInput` and `judgedClosing` only map the server's rows to
  session-kit's `Question`. A full core extraction (folder, subtree, package) was judged not worth it.

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
4. **The reply.ts and judge.ts copies stay byte-identical** (see Shared logic). If upstream's tooling
   starts formatting them, keep them exempt in `vite.config.ts` and `knip.jsonc`.
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
   - Seams the fork added to upstream files: `ComposerBannerStack.tsx`'s optional `content` on a
     stack item, drawn in place of the notice row inside the same card (the decisions panel uses it
     so it keeps its place in the stack with no notice header); and `ComposerPendingUserInputPanel.tsx`
     exports `OptionRadio`, so the decisions panel's rows look like the native ones; and
     `ChatComposer.tsx`'s handle has `submit()`, the send button's `submitComposer` (it reports
     whether it refused without a word), which ChatView's
     send buttons call after adding their line (ChatView wraps the composer's `onSend` to keep the
     send in flight, `composerSendingRef`, so it can wait for the outcome). If upstream rebuilds the
     banner stack, give the panel the new stack's way to draw a custom card; if it renames the
     composer's submit, follow it.
   - The decision judge's setting, `decisionJudgeModelSelection`, is built like upstream's
     `speechPostProcessingModelSelection` and sits beside it in each place: the schema and the patch
     in `packages/contracts/src/settings.ts`, `resolveDecisionJudgeModelSelection` and its patch line
     in `packages/shared/src/serverSettings.ts`, the `decision-judge-model` entry in
     `settingsSearch.ts`, the "Decision judge" task in `TextGeneratorsSettings.tsx`'s `TASKS`, and
     `<DecisionJudgeModelRow />` under the text generation row in `SettingsPanels.tsx`
     (`ThreadsSettingsPanel`). If upstream reshapes the cleanup setting, reshape this one the same way.
     `server.ts` provides `DecisionJudge.layer` to `ThreadDecisions.layer`; the judge calls
     `TextGeneration.generateTranscriptionPostProcessing`, so a rename of that operation lands here.
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
   - `packages/shared/src/sessionKit`, the drift test included, and
     `packages/shared/src/serverSettings.test.ts` (the judge's setting).
   - `apps/server/src/decisions`.
   - `apps/server/src/persistence/ForkMigrations.test.ts` and `Sqlite.test.ts`.
   - The desktop identity and environment tests in `apps/desktop/src/app` (`DesktopAppIdentity`,
     `DesktopEnvironment`, `DesktopPreReadyPlatform`).
   - `apps/web/src/components/chat/threadDecisions.logic.test.ts`, `composerSend.logic.test.ts`,
     `ThreadDecisions.parked-focus.browser.test.tsx` and `ThreadDecisions.question-panel.browser.test.tsx`.
6. **Live check:** on a dev server on an isolated home, never `~/.t3`. Reseed it first, since the
   schema moved: `node apps/server/scripts/migrate-dev-db.ts --base-dir "$PWD/.t3"` (reads `~/.t3`
   read-only; its fork tables come along). Then `vp run dev --home-dir "$PWD/.t3"`, since in a main
   checkout dev falls back to `~/.t3`.
   - If the startup pairing URL does not sign in, mint one from `apps/server`:
     `node src/bin.ts pair --base-dir <checkout>/.t3`.
   - Use a desktop-width window (the strip is not shown on mobile widths). Before typing `/park`,
     switch the thread's model to `Replay (dev)`: if the intercept ever fails, the text goes to a free
     provider instead of starting a paid turn.
   - A seeded thread with open questions shows the question panel and the Tracker panel; Accept adds a line
     to the composer, selects it and moves to the next question; `/park x` parks without sending; a thread with
     a `claude.ai/…artifact/…` link lists it in Artifacts; the server log has no schema errors. With a
     cheap Claude Haiku thread (Supervised, scratch project) also: `/park` mid-run and `t3_park`.
7. **Build:** `.env` must exist (`cp .env.example .env`, once per checkout; gitignored). Without it the
   app is built with T3 Connect off and cannot reach machines linked through T3's relay. The values
   are upstream's public production identifiers, the same ones official builds embed. Then run
   `scripts/fork/build.sh`: it moves the old build to the trash, clears any update feed, and stamps
   the version from the upstream tag below HEAD (`v0.1.11-nightly.20261117.4825` becomes
   `0.1.11-fork.20261117.4825`). Without the stamp the app reported package.json's older version and
   linked clients called it out of date; a `-nightly.` version would rebrand it "T3 Code (Nightly)".
   The build must not contain `app-update.yml`. `scripts/fork/install.sh` refuses a build without
   T3 Connect or without a `-fork.` version. Known limits of the `-fork.` version, both unused today
   (Fable 5.2 review, 2026-11-17): an SSH environment started from the fork asks for a
   `v0.1.11-fork.…` server release that does not exist (`DesktopSshEnvironment.ts` passes the app
   version as `archiveVersion`); and a linked server whose core version is below the fork's is offered
   an update to `t3@<fork version>`, which fails. If either is needed, map `-fork.` back to the base tag's
   `-nightly.` at those seams. A killed build can leave the stamped version in tracked `package.json`
   files (the build rewrites and restores them); `git checkout` them. Push with `git push --force-with-lease origin fork/main` only
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
- session-kit's reply.ts and judge.ts carry the logic the fork shares (reply.ts's shared parts came
  with dotfiles PR #600, merged). The drift test reads the files from the local dotfiles checkout, so it
  goes red whenever that checkout is behind or ahead of a copy: compare against the copy's header
  commit before re-copying.

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
