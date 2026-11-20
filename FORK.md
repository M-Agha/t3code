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

| Commit subject                                                                                        | What it adds                  |
| ----------------------------------------------------------------------------------------------------- | ----------------------------- |
| `feat: track end-of-reply decision questions natively`                                                | Questions and decisions       |
| `feat: per-thread parked items with /park and t3_park`                                                | Parked items                  |
| `feat: per-thread Artifacts tab`                                                                      | Artifacts                     |
| `refactor: take question logic from session-kit's reply.ts`                                           | Shared logic with session-kit |
| `fix: read a reply that finishes after its run ended`                                                 | A listener gap                |
| `chore: name fork builds T3 Code (Fork) with their own bundle ID`                                     | App identity                  |
| `feat: mark fork-launched Claude processes with T3CODE_OWNS_BOARD`                                    | Outside this repo             |
| `fix: install.sh backs up a quit app's database`                                                      | Installing                    |
| `fix: the stage-label schema accepts Fork, so the fork app launches`                                  | App identity                  |
| `feat: Accept and Drop add to the draft; long questions keep their buttons`                           | Questions and decisions       |
| `fix: fork builds keep T3 Connect, and install.sh refuses one without it`                             | Rebasing, step 7              |
| `(fork) decisions: open questions show one at a time, like T3's own question panel`                   | Questions and decisions       |
| `(fork) decisions: answers on AskUserQuestion cards close the matching question`                      | Questions and decisions       |
| `(fork) decisions: a model judge reads your replies, as in the terminal, with its model in settings`  | Questions and decisions       |
| `(fork) decisions: the right panel is called Tracker`                                                 | Questions and decisions       |
| `(fork) decisions: Accept and send, and Yes to all, in the question panel`                            | Questions and decisions       |
| `(fork) decisions: a sent Veto line marks its choice vetoed`                                          | Questions and decisions       |
| `(fork) decisions: answers are one line per question, and no question sends`                          | Questions and decisions       |
| `(fork) decisions: the Tracker's final look, with Select mode, a draft bar and Reopen with Undo`      | Questions and decisions       |
| `(fork) decisions: the judge reads only messages sent after it was in place`                          | Questions and decisions       |
| `(fork) tracker: Parked and Artifacts are right-panel tabs of their own, in theme colours`            | Questions and decisions       |
| `(fork) artifacts: rows name their type, show what claude.ai no longer finds, and take links by hand` | Artifacts                     |
| `(fork) parked: items are for the agent or for you, and go in the draft as chips that mark them sent` | Parked items                  |

The table names features; `docs:` and `chore: re-copy session-kit's reply.ts` commits are left out.
`git log --oneline <base>..fork/main` lists every fork commit with its hash, where `<base>` is the
upstream release the fork sits on (`git merge-base fork/main upstream/main`). Today that is
`v0.1.11-nightly.20261118.4864`, whose last upstream migration is 098.

### Questions and decisions

- **Source:** T3's server reads a finished reply's Q-block text. Agents keep writing text, so the
  same reply works in a terminal and in T3, for every provider. _Rejected:_ a tool agents must
  remember to call.
- **Closing:** from the user's own messages, as the terminal closes them. session-kit's model judge
  (`judge.ts`: `JUDGE_SYSTEM`, `judgePrompt`, `parseVerdict`, `scopeVerdict`) reads every message a
  person typed while questions are open, in a thread the fork has read before and sent since the
  judge took over (below), with the open questions and the reply it follows, and its verdict
  decides; `scopeVerdict` only removes labels (a blanket "yes" never closes a question an earlier
  reply asked unless the message or the last reply names it). The rules (`closingFor`, over
  session-kit's `readReply`: `Q4: yes`, "go with your picks", "not a decision") decide only when the
  call fails, takes over 20 s, or its answer does not parse (logged as a warning). So a bare "yes"
  right after a question block, "merge it" or "go with 2" closes what it answers, and a message that
  answers nothing (a clarifying question) closes nothing. The model is the "Decision judge" setting
  (Settings → Threads, in its own Tracker section after Text generation;
  `decisionJudgeModelSelection`, where null follows `textGenerationModelSelection`, as transcript
  cleanup's setting does), called through T3's
  text-generation path, so any provider T3 is signed in to works. That path has no free-text
  operation: `generateTranscriptionPostProcessing` is the one whose input is the whole prompt and
  whose output is one string, so the verdict's JSON travels in that string, and the prompt spells
  out the envelope `{"transcription":"<verdict JSON>"}` for text generators, which enforce no schema
  (`DecisionJudge.ts`; a fork-only operation on every provider is the upgrade path if a model will
  not put it there). That path also has no system slot: `JUDGE_SYSTEM` rides at the top of the user
  turn, under the provider's own system prompt, so session-kit's measured accuracy (its judge sends
  `JUDGE_SYSTEM` as the system prompt) does not carry over; T3's is unmeasured. The timeout is 20 s,
  not the terminal's 8: each call starts a provider CLI (2.3 s and 4.8 s with Claude Sonnet,
  2026-11-17). Model calls run under the thread's lock but never inside a transaction: the rows
  before each user message commit first (so the questions it may close include those they asked),
  then it is judged, then its closing commits with the watermark past it. The listener syncs up to 4
  threads at once, so one thread's judge does not hold up the others. The rules alone, with no model
  call, read two kinds of message. First, one sent before the judge took over: it was answered under
  them. That time is fork migration 005's one row, `fork_decision_judge_cutoff.judged_from`, written
  by the first start that runs 005 and never moved by a restart or a re-run; `syncMessages` compares
  each message's `created_at` with it. A missing row logs a warning at start and leaves every
  message to the rules. Second, every message of a pass that finds no `fork_thread_decision_sync`
  row for its thread, that is, the first time the fork reads it: an imported terminal session (which
  keeps its own times and `createdBy: user`) or a thread an official build ran. Opening a thread the
  fork never read costs no model call and shows its questions at once. A new fork thread is not
  starved: its first pass runs on its first message, before any question, so its answers are judged.
  Accepted gaps: a message sent between the judge's first build and 005's, in a thread no build read
  meanwhile, goes to the rules; so does one sent before 005 but held behind a run still running at
  the restart that ran it. A subscriber gets the current rows at once; the backlog is read in the
  background, its judged messages in full (never handed to the rules to save time), and its changes
  publish as they commit. A Reopen clicked while a thread's backlog is being judged waits for it, as
  it takes the same lock. The panel's "In draft" preview stays rule-based (no model per keystroke),
  so it can show less than what closes on send. The panel's answers (Accept, Answer…, Not a
  decision) add one line each to the composer instead of sending, so several answers go out as one
  ordinary message and the agent sees every answer. Only messages a person typed count: agent,
  scheduled-task and relayed messages close nothing. (2026-11-17: the owner's Q30 reversed the
  earlier rejection of a model judge. Rules alone left answers by key words, numbered picks and bare
  assents open, and a judge run only on messages the rules left unclosed would keep those false
  negatives: "Q4: yes, and merge it" closes Q4 by rule, so the question "merge it" answers would
  never reach it. The owner asked for the judge's model and effort to be chosen the way T3 chooses
  its text-generation model.) (2026-11-19: the owner's Q38 superseded Q30's "every message" for
  history. Opening a thread the fork had never read judged its whole history first: one old thread
  cost 71 Sonnet calls before its panel showed, and the owner's database held 79 such threads with
  485 user messages. That history was answered under the label rules, so they read it, and its
  questions show at once.) _Rejected:_ the judge only on messages the rules leave unclosed; a
  hard-coded judge model; an agent "close" tool; judging a never-read thread's whole backlog (Q30's
  default), or only its newest message.
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
  (`questionsClosedByDraft`, the server's fallback rules `closingFor`: "go with your picks", or a
  question's own part of the draft reading as its Accept line in any case, selects Accept) and the header says "In draft". Accept and Not a decision move to
  the next question the draft does not close, only once the composer took the line; Answer… stays
  (its bare `Qn: ` is a place to type: the draft state reads it as Answer chosen, but the Tracker's
  draft bar names it as unanswered and will not send it). From two open
  questions up, the header has a quiet Yes to all, which adds one Accept line per question (`Q3:
  yes`, `Q4: no`: `answerLines`, the helper the Tracker's "Accept N picks" and Select mode also use),
  in order, only for questions with a pick that the draft does not already close, so a second press
  has nothing to add. Nothing in the panel sends: the only send outside the composer is the Tracker's
  labelled "Send draft". (2026-11-17: the owner's Q31 added Accept and send and a Yes to all line
  `Yes to your picks: Q3, Q4`; Q34 removed both send arrows, since an unlabelled arrow sends
  half-typed text in one mis-click; Q36's design moved Yes to all to one line per question, the lines
  every other answer writes.) Collapse lasts for one reply. While T3's own question is pending, the composer hides this panel
  (`shelfItems`), and a browser test holds that. Nothing shows inside replies, and nothing on mobile.
  (2026-11-17, replacing a strip of one row per question that the owner called ugly; design approved
  by a two-model council.) _Rejected:_ a two-line list (tall, three buttons per row); chips with
  popovers (hide the question); one banner per question; real radios with arrow-key selection (the
  native panel uses buttons too).
- **Tracker:** the right-panel surface with the Questions and Decisions tabs. Parked and Artifacts
  are right-panel surfaces of their own beside it (kinds and ids `parked` and `artifacts`,
  per-thread singletons like it; MAIN-57, MAIN-58, 2026-11-19), each with its count on its strip
  tab and in the tab's accessible name (open parked items; every artifact row): `surfaceCounts` on
  `RightPanelTabs`, filled by ChatView from the snapshot. Their add-panel letters are K (Parked) and
  A (Artifacts), their icons the palette's `ArchiveIcon` and `ShapesIcon`; a bare `/park` and the
  palette's "Show parked items" / "Show artifacts" open them. `decisions.toggle` still toggles the
  Tracker alone. Its user-visible name is Tracker everywhere (its tab, both add-panel menus, the command palette's "Show
  Tracker", the keybinding's "Tracker: Toggle" in `KeybindingsSettings.logic.ts`'s
  `LATE_COMMAND_LABELS`, the panel header's Open Tracker); the tabs keep their
  names. Its ids stay `decisions` (the surface kind and id in `rightPanelStore.ts` and
  `closedViewStore.ts`, the `decisions.toggle` command, `decisionsPanelTabStore.ts`): persisted panel
  state, reopenable closed tabs and saved keybindings name them. (2026-11-17: the owner's Q31 renamed
  it from "Decisions".) Its look is the owner's approved final design (Q36, 2026-11-17; boards and
  spec in the dotfiles repo's `.local/.execution/t3-native-board/notes/tracker-final-design.md`):
  - Tabs are T3's segmented toggle (`w-fit`, its compact `segmented` size) with neutral counts; the
    selected one has a `muted-foreground` border (at least 3:1). Questions counts open questions; Decisions counts the choices the newest
    reply with any made without asking, less those vetoed or in the draft (`choicesToReview`).
  - **Questions:** a status bar ("2 to answer · 1 in draft", Select); one group per asking reply with
    its age, a button that shows that reply in the chat, and "Accept N picks" (`answerLines`: only
    questions with a pick the draft does not close, hidden at zero). A row has its label chip (open,
    or "In draft" in words), key words, the question and "Pick: …" as markdown, then Accept: <pick>
    (none without a pick), Answer… and Not a decision. Once the draft closes a question, the row shows
    the line that does it (`draftLineOf`): its own `Qn: …` line with Edit (the caret goes to the end
    of that line) and Remove (that line leaves the draft, `withoutLine`), or a shared line ("go with
    your picks", one naming several) with Edit in composer only. The label may be typed in any case.
    Only Answer… and Edit move focus to the composer: Accept, Not a decision, Accept N picks, Veto
    and Add add their lines without it (`insert`'s `focus: false`), and focus goes to the row's next
    control (Edit after Accept, Accept or Answer… after Remove, Remove after Veto and back, Select
    after Add; `useFocusAfter`), so a keyboard user answers row after row. The panel is keyed by its
    thread (`RightPanelSurfaceContent.tsx`), so Select mode never carries over to another thread.
  - **Show in the chat** goes through T3's citation reveal (`assistantCitationNavigation`), quoting
    the group's first `Qn, key words` (or a choice's text): it scrolls to the reply and highlights the
    quote. The quote has no real offsets, so one that occurs twice in the reply, or whose markdown
    renders differently, still scrolls there but shows T3's "The quoted text has changed".
  - **Select mode:** the whole row toggles; a reply's checkbox counts only selectable rows and is
    mixed for some; rows the draft holds are disabled (without the board's dashed box: `Checkbox`
    owns its border and has no such variant). The dock previews the whole draft after the
    action (existing lines, `+` new ones; questions without a pick are listed as skipped under
    Accept picks) and has one "Add N to draft", after which Select mode ends. The capped preview
    scrolls to the lines it adds and takes keyboard focus. Select mode also ends by itself once
    nothing is left to select.
  - **Draft bar** (Questions and Decisions, not in Select mode, while the draft holds Tracker lines:
    `draftSummary` is more than plain `"text"`, that is answers, vetoes or an unfinished `Qn:`; a
    draft of plain text is the composer's alone; MAIN-61, MAIN-64), styled like T3's panel footers
    (`ThreadPullRequestsPanel.tsx`: `border-border/60`, `text-2xs`, `xs` buttons): what the draft holds
    (`draftSummary`: "2 answers · 1 veto + other text"; a bare `Qn: ` is not counted but named, "Q5
    unanswered", and holds Send draft back), Review (focuses the composer) and "Send draft", the
    composer's own send (`ChatComposerHandle.submit()`, so the same refusals, queueing
    and steering; "Not sent" only when it refused without a word). `useDraftActions` in
    `ThreadDecisions.tsx` holds the send and the line edits; it is a hook outside ChatView's body on
    purpose: written inline there, an earlier send hook's callback kept earlier renders' thread
    structures alive, and `ChatView.browser.test.tsx` "a mounted thread view lets go of the thread
    structures it has replaced" failed. While the composer answers T3's own pending question its
    prompt is that answer, so the line edits read the draft from the draft store, and Edit, Remove
    and Send draft are disabled meanwhile (`answeringPendingInput`).
  - **Decisions:** "Decided without asking" first, a group per reply. Veto adds `Veto: <text>`; the
    row then shows "In draft", the line and Remove; once sent it reads "Vetoed". Vetoed comes from the
    server: the snapshot marks an item `vetoed` when a person-typed message after its reply holds
    that line (lines read trimmed, as the panel reads its draft; one read of the thread's messages
    with a `Veto: ` line, matched in TypeScript), and a message with a `Veto: ` line publishes a snapshot even when it closes no
    question. (A client-side check would miss messages the timeline has not loaded.) Then Answered
    (green chip) and Not a decision (grey chip), each with "You" and the question's own part of the
    answer (`answerPart` in `packages/shared/src/sessionKit/decisions.ts`, derived on the server from
    the full message: from the label to the next label that opens an answer, the whole message when
    the label is not named), "Pick was: …" when that part's first line does not read as the Accept
    line in any case and without trailing punctuation (`acceptsPick`), and a per-row Reopen.
  - **Reopen** is held behind a toast with Undo for 8 s of Base UI's toast timer, which pauses while
    the pointer is over any toast, while a toast has keyboard focus, and while the window is in the
    background. The reopen RPC goes out only once the toast is gone (`onRemove`), so an Undo that
    reaches it while it fades still counts; each toast acts on its own hold only, so a toast still
    fading after Undo cannot send a newer Reopen of the same row. Undo and the ✕ cancel; Escape and a
    swipe close the toast like its timer, so they send it (Base UI reports them as an ordinary
    close). Closing the panel, leaving the thread, or the page going away (`pagehide`, best effort)
    sends what is still held. It is the only Tracker action that skips the draft; the row's Reopen
    stays disabled while held or sent, until the snapshot moves the question back. No bulk Reopen.
    (2026-11-17: a window timer that ignored hover, and a ✕ that committed, reopened a question the
    owner had undone.)
  - **Colours:** every colour comes from a role a T3 theme sets (`themePalette.ts`
    `APP_THEME_VARIABLES`), so changing the theme restyles the Tracker, Parked and Artifacts
    (MAIN-59, 2026-11-19; _rejected:_ the fixed Tailwind palette it had before). `success` and `info`
    are fixed Tailwind colours no theme sets, so the fork uses neither: `warning-foreground` on
    `warning-surface` for open, `accent` with `foreground` for answered and for a selected row (its
    `ring` border marks it), `muted`/`secondary-foreground` for not a decision, `primary` for Send
    draft and Add, and three fork tokens in `index.css`: `--tracker-draft` is the primary (message
    action) role, `--tracker-pick` the update role's foreground, `--tracker-agent` the warning role's
    foreground. Primary is a button fill no theme solves against the panel, so `--tracker-draft` is
    mixed a fifth toward the foreground in both modes (5.0:1 or more on the default theme; a custom
    theme with a pale message action can still fall short). Reopen's toast takes no `type`, since
    the info icon is fixed blue. On the default theme
    the draft and the pick are both blue, since its update role is its primary; each colour sits
    beside a word. Parked's kind icons use the update and warning roles' foregrounds, each beside its
    words.
- **Code:** `apps/server/src/decisions/ThreadDecisions.ts` (one service for ws.ts and MCP),
  `apps/server/src/decisions/DecisionJudge.ts` (the model call),
  `apps/web/src/components/chat/ThreadDecisions.tsx` with its rules in `threadDecisions.logic.ts`,
  `ThreadParked.tsx` and `ThreadArtifacts.tsx` beside it (the two surfaces, on the same snapshot;
  Artifact calls are read by `apps/server/src/decisions/artifactCalls.ts`),
  `apps/web/src/components/settings/DecisionJudgeModelRow.tsx`, contracts in
  `packages/contracts/src/threadDecisions.ts`.

### Parked items

- **Kinds** `agent` ("For the agent": words to send it later) and `me` ("For me"); states `open`,
  `done`, `dropped` and `sent`; parked by `user` or `agent`; per thread. Fork migration 007 mapped
  the stored kinds: `prompt` to `agent`, `todo` and `later` to `me` (MAIN-67, MAIN-68, 2026-11-19,
  with session-kit's own rename, dotfiles PR #732). _Rejected:_ the three old kinds, which said when,
  not who acts. On the wire both ends stay readable by a build from before the rename (GPT-6 Sol,
  round 7): the server sends each row's kind in the older word and the clients park and move in it
  (`OLDER_KIND_WORD` in `packages/shared/src/sessionKit/parks.ts`); the server takes every word, old
  or new, and the clients read any (`ThreadParkedItem.kind` is a string, read through `parkKind`, an
  unknown word the person's). Switch the wire to the new words once no build from before the rename
  is in use.
- `/park <text>` is T3-local: it never reaches the provider. It is parsed with session-kit's
  `readParks`/`isPlaceholder`, so the syntax matches session-kit's `/board`: `agent` and `me`, the
  old words still accepted, and a bare `agent` or `me` names a kind only on the first line (after it,
  `agent:`), since those words start lines of prose. It is refused while editing a queued message,
  with attachments, on an unstarted thread, and on mobile. A bare `/park` opens the Parked surface.
- `t3_park` in the thread MCP toolkit, for every provider: its `kind` takes `agent` or `me`, and the
  old words, which `ThreadDecisions.ts` maps when it stores the row (`PARK_KIND_OF_WORD` in
  `packages/shared/src/sessionKit/parks.ts`, a total record that `parks.test.ts` holds equal to
  session-kit's `parkKind`). A stored row an older build wrote with an old word is read through
  `parkKind` too, so it stays listed. Its description was cut to keep the tool list within
  `fork/main`'s agent context budget (`agentContextBudget.json`). The "Agent context budget" CI check
  compares with the repo's `main`, an older upstream, and fails for every fork PR without its
  `agent-context-increase` label. It refuses delegated child threads and placeholder
  text. Its eval cases (`evals/mcp-tool-use/cases/parked.ndjson`) have only run with `--dry-run`; a
  real run is owed.
- **Add to draft and Sent** (MAIN-75, the owner's Q55 design, 2026-11-20):
  - **A chip.** Add to draft (an open item for the agent) puts the item in the composer as a chip of
    the fork's composer-context kind `parked` (`ParkedContextRecord` in
    `packages/contracts/src/composerContext.ts`), the way T3 attaches a thread or a machine: the
    chip's reference goes in the text, its record in the draft's `parkedContexts`, and a send
    carries the record in the message's `context`. The provider gets the words through upstream's
    `projectComposerContextForProvider`, as every kind does: a `[Parked: …; ref=…]` marker where the
    chip stood and the words in the `<t3_context>` envelope (`composerContextReferences.ts`'s
    `parked` case). Focus stays in the panel, so several items go in one message. After a closing
    code fence the chip goes on a line of its own (`endsAtClosingFence` in
    `threadDecisions.logic.ts`, read with the composer's own document builder), since one joined to
    the fence line would reopen the block and sit in it as code (Sol round 3, S4). Add to draft is
    off while the composer edits a queued message, answers the agent's question (that send is the
    answer), as `/park` is, or the thread cannot take a message; the button stays focusable
    (`aria-disabled`) so its tooltip, and the menu item's second line, say which, and a screen
    reader hears it as the button's description (`aria-describedby` to a visually hidden reason:
    Base UI's tooltip describes nothing; Opus round 2, O1). The menu's Add to draft is blocked the
    way the lock blocks an action (below).
  - **Locked while drafted** (the owner's Q56, MAIN-82, 2026-11-20): while a draft this client holds
    has an item's chip, the thread's own draft or an open queued message's edit (either would send the
    words it holds; the lead's ruling R3), its row says In draft, and Edit, Mark done, Move and Drop
    stay in its menu, focusable and unavailable, each with "remove the chip from your draft first" under
    its name and as its description (`aria-describedby` to a visually hidden reason;
    `ParkedMenuAction` in `ThreadParked.tsx`, which says why the actions need no guard of their own,
    and which the menu's blocked Add to draft uses too). An editor opened before the chip went in
    cannot Save either (its Save and its text field are described by the reason, since Cmd/Ctrl+Enter
    then saves nothing). Copy text stays, and a resolved item's Reopen is never locked (the person's
    override, R1), even while a queued message's edit holds its chip. Deleting the chip frees them.
    Nothing rewrites a draft's chips: a chip holds the words it was added with until the user deletes
    it or sends.
  - **Undo** has one gate, in the editor (`removesRefusedParkedChips` in
    `ComposerPromptEditorTiptap.tsx`, which calls the fork's `removeParkedChips` in
    `apps/web/src/composer-parked-chips.ts`; the lead's rulings R5 and R7): a parked chip an undo or
    redo brings back without a live record stays only if its item is still Open and for the agent, the
    record the composer kept when the chip was deleted has the item's current words, and the chip's
    label is that record's label, cleaned as a chip's label is (`parkedChipRestorable` in
    `threadDecisions.logic.ts`, and `ChatComposer.tsx`'s `restoresParkedChip`, which says why it is
    compared cleaned). The label matters because a later chip of the same item replaces the kept
    record: without it, an older chip came back carrying the newer record's words (Opus round 4, C1).
    A refused chip goes again with one space beside it, in a transaction kept out of undo history, so
    the selection maps through the deletion and the agent is sent no `unavailable` marker (as upstream
    replaces a stale skill chip after an undo); several go in one transaction, each range mapped
    through the ones before, since two chips one space apart both claim that space (C2). The gate runs
    before the composer hears of the change, from `onSelectionUpdate` too, which Tiptap emits before
    `onUpdate`; the composer then restores the kept record of every returning chip it hears of. A
    queued message's edit holds the chips that message carries (its items Sent by it): one comes back
    while its item is still Sent, with the same words (`parkedChipRestorable`'s `editingQueuedRun`,
    from `useParkedDraft` in `ThreadDecisions.tsx`); reopened and then edited or marked Done, it stays
    out (Opus round 6, C1). Sent is judged without knowing which message sent it (the snapshot
    carries no message id), so another window's send of the item lets such a chip back in: the
    cross-window limit below (R8).
  - _Known limit:_ another client can edit or resolve an item while it is drafted here; nothing can
    stop it. Another client includes another window or tab of this app on the same machine: drafts do
    not sync between windows, so the lock holds only in the window whose draft has the chip (the
    lead's ruling R8). The row shows the new words or state, and the chip stays until the user deletes
    it or sends; the message carries the words its sender saw. What the server then does is the Sent
    rule's: an item still Open (edited elsewhere) is marked Sent by that message; one already Done or
    Dropped stays as it is, since the pass reads only Open and Sent items, though the agent got its
    words.
  - _Known limit_ (the lead's ruling R4): a chip dragged from one composer to another arrives without
    its record, as upstream's thread and machine chips do, and reaches the agent as `unavailable`;
    nothing strips it. Delete it and use Add to draft.
  - _Superseded_ (2026-11-20): the chip followed its item: every edit, resolution or move rewrote the
    chips in the draft, kept out of undo history. Round 3 of PR #9's chip review found it raced the
    snapshot (a delayed Save landing in another machine's draft, a stale snapshot putting old words
    back), erased undo history between two chips, collapsed a selection, ignored IME composition and
    shared state between composers, so the owner chose the lock (Q56) over fixing each case.
  - **Stash, paste and recall carry no parked record.** A stash restore and a paste drop parked chips
    from the text (`withoutParkedReferences` in `packages/shared/src/parkedReferences.ts`, which web and
    mobile share: each chip goes with one space beside it, and nothing else is trimmed, so trailing
    spaces the user wrote stay), as prompt-history recall already does, since the item may be another
    thread's, resolved or edited since, and a chip without its record reaches the agent as
    `unavailable`. A pasted chip the draft already holds stays single. Add to draft attaches
    it again (Sol S5, Opus O1). A cut and paste of a chip within one draft drops it too; undo or Add to
    draft brings it back. A paste into a fenced code block drops them as well, since the provider's
    projector reads a reference inside a fence too (Sol round 2, S6). Mobile drops them on paste too
    (Sol round 2, S1). A paste of parked chips alone does nothing on either
    (`pastesOnlyParkedReferences`): on mobile it leaves the selection, and the attachments a selected
    chip holds, in place (Sol round 3, S5). A plain-text paste the native editor keeps to itself never
    reaches that code, and its chip, without a record, marks nothing. Mobile's context sheet shows a
    parked chip's words.
  - **In draft is shown, never stored:** a row says In draft while the thread's own draft, or an open
    queued message's edit, holds its chip (`parkedIdsInDraft`: a record whose reference the text still
    has; `useParkedDraft` reads both drafts, whichever the composer shows). Deleting the chip from the
    composer takes it out (the composer prunes an unreferenced record, as it does a thread's). Nothing
    about the draft reaches the server.
  - **Sent** (`syncParkedSends` in `ThreadDecisions.ts`, from the records, no model, no text matched):
    a recorded user message carrying an open item marks it Sent (resolved, `sent_message_id` that
    message, the time it was sent), queued or not, as soon as the listener reads it. Carrying means the
    message's `context` holds the item's `parked` record and its text still references the chip, as the
    provider is sent it (`parkedItemsCarried`), and the record names the message's thread
    (`payload.threadId`): item ids are per database, so a chip copied on one machine and pasted in a
    thread on another would otherwise mark that thread's item of the same number (Sol round 2, S1).
    Each sync works the state out again from every carrying message (`carriedPairs`), so nothing read
    once is skipped later: a chip edited out of a queued message and put back (two clients saving the
    same message) marks the item Sent again (Sol S2).
  - **Back to Open:** only when the message never reached the agent: its run was cancelled before it
    started (`status` `cancelled` with no `$.startedAt`, which the orchestrator writes as a run turns
    `running`; a queued send cancelled, or a thread archived with it queued), or the chip was edited
    out of the queued message. Another message carrying the item since its last Reopen keeps it Sent,
    with that message. Nothing else changes it: steers, declined steers, provider failures and usage
    limits leave the message to T3, which delivers or retries it.
  - **Reopen** returns a Sent item to Open. In the same transaction it reads every message recorded
    so far that carries the item and sets each aside (`fork_thread_parked_set_aside`, keyed by thread,
    item and message), so none of them marks it Sent again, including one recorded just before the
    Reopen that no sync had read yet (Sol S1: a first build set aside only what syncs had seen). A
    cancel of a set-aside message changes nothing. Only a message that carries the item after the
    Reopen marks it, which includes a message recorded before it: a queued message whose chip was
    edited out before the Reopen and put back after it (a second client saving its earlier copy) will
    deliver the words, so it marks the item Sent. There is no creation boundary, because Sent means a
    message carrying the item has reached or will reach the agent, and a boundary would leave the item
    Open while that message waits to deliver it (Sol round 2, S2; the lead's ruling R1, 2026-11-20).
    Reopen is the person's override: it sets aside even a carrying message that is still queued, so
    the item stays Open while that message waits to deliver its words (Opus round 3).
  - The pass runs first in every sync (each user message and each ended run, as the listener already
    syncs), in one transaction and outside the thread's lock, since it waits on no model, and what it
    changes is published as soon as that transaction commits: the rest of the sync can wait seconds on
    the decision judge, or fail, and must not hold back a Sent (Sol round 3, S6). It reads the
    thread's set-aside rows by the table's key (a search, not a scan; Sol S6) and the thread's user
    messages whose payload names a parked record, through upstream's `(thread_id, created_at,
    message_id)` index. Ceiling: it parses every such message on each sync; a thread with thousands
    would want a watermark over the messages already read.
  - Rows from before (fork/main's Send button) are `sent` with no message: Sent under Resolved, Reopen
    works, and no pass reads them back.
  - **Official builds** (they share `~/.t3`): the record has upstream's forward-compatible unknown-kind
    shape (`{ kind, contextId, label, payload }`), so an official build decodes `parked` as an unknown
    kind, keeps it, and its projector sends the agent `JSON.stringify(payload)`, the item's whole text
    (Sol S4, Opus O5). Run twice on 2026-11-20 against `upstream/main` (59651c1761) and `fork/main`
    (a8bfd72c08), their own `composerContext.ts` and `composerContextReferences.ts` copied beside the
    tests: both decoders kept the record and their projectors delivered the full text, the second time
    with `threadId` in the payload (a 369-character item); the first draft's shape (fields at the top
    level) was sent as `unavailable` both times.
    `composerContext.test.ts` holds the shape to the slot. An official build editing a queued fork
    message keeps the record (its edit keeps every record it does not own, which is threads and
    machines), so if its user leaves the chip the item stays Sent, and if they delete it the agent
    does not get the words and the fork returns the item to Open; either way the item says what the
    agent got. A promotion to a steer keeps the same stored message (inferred from the orchestrator,
    not run). The fork alone decodes the record typed: `"payload" in record` is how upstream code
    tells an unknown record, so the fork's readers of known records (`asKnownContextRecord`, the
    provider projector, and mobile's `ComposerContextSheet.tsx`) make an exception for a `parked` one.
  - _Superseded_ (2026-11-20): MAIN-69/MAIN-70's lifecycle (the Q47 design): Add to draft pasted the
    item's text and stored an In-draft mark; a sent message holding the text claimed and started the
    item (In progress); a per-turn model judge read each finished reply and answered finished, ongoing or
    untouched, with "Sent, not done" sending it back. Eight review rounds on PR #9 kept finding timing
    cases in it: when a queued or steered message counts as delivered (steer effects, which needed the
    outbox's pruner changed), the order of sends of one millisecond, claims across cancels and declines,
    judge cursors and catch-up for items that started behind the judge, and a draft mark the composer
    had to end on send. Every case came from matching text and judging turns rather than reading what
    T3 records, so the owner dropped it (Q55, MAIN-75) for the chip above. The `EffectOutbox.ts`
    pruning change went with it (that file is upstream's again). No database ran that 007 or its 008.
- **Surface** (`ThreadParked.tsx`, its own right-panel tab), the owner's approved boards
  (`NativeParked.dc.html`, `NativeParkedEmpty.dc.html` in the dotfiles repo's
  `.local/.execution/t3-native-board/notes/tracker-design/project/`): groups Open and Resolved
  (folds), each with its count. A row is the kind's icon (`BotIcon` in the update role's foreground,
  `UserIcon` in the warning role's; a resolved row its state's icon, muted), decorative since the
  words below say the same, then the full text as markdown, then "for the agent · by you", In draft
  in `--tracker-draft` while the composer holds its chip, and the time at the right (parked, or
  resolved: Sent at its message's time). Actions show on hover, on keyboard focus and while the menu
  is open, always on a touch screen; right-click opens the same menu. An open item for the agent has
  an Add to draft button (gone once In draft) and "…" (Add to draft, Edit, Mark done, Move to For me,
  Copy text, Drop); one for me "…" without the draft; a resolved one (Done, Dropped, Sent) Reopen and
  Copy text. Drop is not styled destructive: Reopen undoes it. Edit is inline; Escape or Save
  returns focus to the row's "…". When an open item leaves, focus goes to the next row (else the one
  before), else to the surface itself, never to the finished item's Reopen. When a row keeps its
  place in the list but loses the focused control (its chip goes in the draft and Add to draft goes;
  a row moves to another group and remounts: Reopen, Sent), focus goes to that row's first control,
  the "…" once In draft; only while focus fell to the page, and not once the user moved it out of
  the list. On a touch screen the always-shown actions sit in the row's flow, beside the time, not
  over it (Sol S7). Rows carry whether they are In draft (`ParkedRowItem`), so a chip added or
  deleted in the composer re-runs that focus fix (a first build read it beside the rows and focus
  fell to the page).
  A row being edited stays in the group it was in, in its place (`parkedGroups`' pin), so a send
  marking it Sent meanwhile neither remounts its editor nor folds it into a collapsed Resolved; the
  panel holds the editor's text until Save succeeds. The add field sits at the bottom, in the empty
  state too (MAIN-65): "Park something for later…", a For the agent / For me choice (real radios:
  `RadioGroup`'s fork `segmented` variant with `SegmentedRadio`s, drawn as the Tracker's
  `segmented-bordered` toggles, so one is checked and arrow keys move it; For the agent by default),
  Enter parks, Shift+Enter is a new line, a Park button; an empty field and the server's refusals
  (placeholders) show under it as an alert. A park in flight clears the field only if it still holds
  what was parked. The Send button and the old cards are gone.
- The startup sweep deletes parked rows and their `fork_thread_parked_set_aside` only for
  soft-deleted threads: unlike questions, they cannot be rebuilt.

### Artifacts

- Rows from Claude Code's `Artifact` tool calls (`dynamic_tool` turn items, driver `claudeAgent`),
  from `claude.ai/artifact/<id>` and `claude.ai/code/artifact/<uuid>` links in assistant messages,
  and from links the user adds. `apps/server/src/decisions/artifactCalls.ts` reads a call: its
  `$.status`, `$.input.action`, `url` and `type_url`, and its output as JSON or as text. Only a
  completed create or publish (no `action`, or `publish`) adds a published row; a read, list or
  quickstart names none. `/code/` links match the publish's `artifact_id`; whether those two ids
  always agree is unverified, so both are stored. Links are read (both forms, `?query` and `#hash`
  left out) by `packages/shared/src/sessionKit/artifacts.ts`, which the Link dialog shares.
- One row per artifact: first-seen kept, title and time from the latest publish. A publish wins
  over a mention or a manual link, and a `code/artifact/` row folds into the publish naming its
  uuid, keeping the user's title when the publish names none. A type, once a publish names it, stays
  when a later publish names none. A reply's link to an Artifact type itself (a core type URL, or one
  in `fork_artifact_type_names`) is not shown as an artifact, nor counted. Ceiling: a not-found read
  by `code/artifact/<uuid>` misses a row only ever created, since a create's output carries no uuid.
  Its own watermarks, the tool one advancing over every `dynamic_tool` row so threads are not
  re-parsed.
- **Type** (MAIN-62): a create or publish output's `type.url`, else the input's `type_url`, types
  the row; a publish without either is a plain page (markdown when its `path` ends `.md`). Mentions
  and manual links stay "Type unknown" until such an output names them. The name comes from
  `fork_artifact_type_names` (global: any thread's `list scope:types` output, `artifact_types[]`,
  and any read output's `type.{url,title}`), joined when a snapshot is read, so a name learned later
  names older rows; then `CORE_ARTIFACT_TYPE_NAMES` (the 8 core types this account listed on
  2026-11-19; the same URLs on other accounts is unverified); else the panel says "Typed artifact".
  Evidence: the dotfiles repo's `.local/.execution/t3-native-board/notes/artifact-types/`. Ceiling:
  a name one thread learns reaches another thread's open panel at that panel's next snapshot.
- **Not found** (MAIN-63): a failed call whose output contains `artifact not found` and whose
  `input.url` names a listed row (by its own id or its publish's uuid) marks it not found at that
  time; a later completed read or publish of it clears that. It never adds a row, and no other
  failure counts. The exact error text is a fixture in `ThreadDecisions.test.ts`.
- **Manual links** (MAIN-63): `threadDecisions.linkArtifact` (a URL and an optional title; an
  artifact already listed, by either id, keeps its row and only gains a title it lacks, except a
  mention, which becomes the user's link with their title, so it can be unlinked) and
  `threadDecisions.unlinkArtifact`, for rows the user linked only: a published or mentioned row
  comes from the thread itself.
- **Surface** (`ThreadArtifacts.tsx`, its own right-panel tab), the owner's approved boards
  (`NativeArtifacts.dc.html`, `NativeArtifactsEmpty.dc.html`, `NativeArtifactsLink.dc.html` in the
  dotfiles repo's `.local/.execution/t3-native-board/notes/tracker-design/project/`), built from T3's
  pull-request panel: groups Published here, Linked and Not found (a missing published artifact is
  under Not found); rows on `PULL_REQUEST_ROW_CLASS` and `PullRequestRowLines` with a type icon whose
  accessible name is the type, the title, then "<Type> · description" and the time at the right (the
  not-found time on a Not found row, whose title is muted, never struck through). The row opens the
  artifact (`useOpenLink`); Open in browser, Copy link and "…" (Open, Copy link, and Unlink from
  thread on a row the user linked; right-click opens it too) show on hover and on keyboard focus,
  and always on a touch screen.
  The footer counts the groups beside a ghost Link button; the empty state has an outline Link
  artifact button. `LinkArtifactDialog` is built like `LinkPullRequestDialog`: inline validation, a
  line naming the artifact the link reads as, an optional title, and focus back on the Link button
  on screen when it closes (the empty state's, or the footer's once a link fills the panel). It is
  rendered once outside both states, so an artifact arriving while it is open keeps what was typed.
  No embedding, no claude.ai API.

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
  judge.ts exports (`parks.ts` re-exports reply.ts's `parkKind` and `KIND_LABEL`: the server's
  `ThreadDecisions.ts` reads stored kinds through `parkKind`, and the Parked surface uses both,
  `parkKind` in `threadDecisions.logic.ts` and `KIND_LABEL` in `ThreadParked.tsx`); `decisions.ts`'s
  `judgeInput` and `judgedClosing` only map the server's rows to
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

### Translation

Upstream translates the app with `gt-react` (present at 4825; the app-wide rollout and the lint rule
`t3code/no-untranslated-copy` arrived in `v0.1.11-nightly.20261118.4864`). The rule fails on bare
copy in `apps/web/src`, `apps/mobile/src` and `packages/client-runtime/src`, minus its excludes in
`vite.config.ts` (tests, `packages/client-runtime/src/rpc/**`).

- Fork copy inside upstream files uses the helper its neighbours use: `gt()` in components, `msg()`
  in tables that are resolved later (surface labels, keybinding labels, settings search), and
  `resolve(msg())` / `m(msg())` outside React (`composerParkDecision` takes upstream's optional
  `resolve` argument, as `approvalRedirectNotice` does). `DecisionJudgeModelRow.tsx` follows
  upstream's `CleanupModelRow`.
- `ThreadDecisions.tsx`, `ThreadParked.tsx`, `ThreadArtifacts.tsx` and `ParkedContextChip.tsx` are
  English only: one file-level `oxlint-disable` for the rule at the top of each. The
  translation catalogs (`apps/web/src/i18n/translations/*.json`) are generated by upstream's tooling
  and hold no fork strings, so wrapping its ~110 strings would show the same English in every locale.
  A string the catalogs already hold (upstream uses the same words) is wrapped all the same, since it
  then translates, and every such string in `ThreadDecisions.tsx` and `ThreadParked.tsx` is wrapped,
  in the form the catalog holds it: `gt()` (or `msg()` in a table) for an ICU entry, `<T>` for a
  string held in JSX form only (Edit, Remove, Review). Found by hashing each string literal and JSX
  text with `generaltranslation`'s `hashSource` (ICU and JSX formats) against `fr.json`; a JSX text
  that is part of a longer sentence ("Add {n} to draft") is not the catalog's string and stays bare.
  A wrap is one call and is not tested; the one test is the path that resolves later, a status from
  `ThreadParked.tsx`'s `msg()` table through `useMessages` (`ThreadParked.browser.test.tsx`'s last
  case).
  Upgrade path if the fork ever needs another language: wrap them (`<T>`, `gt()`, `msg()`), drop the
  disable comment, and generate the fork's catalog entries. (2026-11-18, the 4864 rebase.)
- Wrapped fork copy has no catalog entries either, so `vp run i18n:check` (CI runs it;
  `check:changed` does not) lists only fork keys and exits 1; they render in English. That is
  expected. Do not run `vp run i18n:generate` to silence it: it writes fork keys into every
  upstream-generated catalog, which then conflicts at each rebase.

## Rules a rebase must keep

1. **Storage never touches upstream's migration ids.** Fork tables are created by a second
   `effect/sql/Migrator` run with its own ledger, `fork_sql_migrations`
   (`apps/server/src/persistence/ForkMigrations.ts`, run from `Sqlite.ts` after upstream's).
   - The Migrator skips every id at or below the highest recorded, so a fork id in upstream's table
     would silently block upstream's next migrations.
   - Fork migrations are idempotent, with no foreign keys or triggers on upstream tables.
   - New fork state goes in a new numbered fork migration. Never edit a committed one.
   - 006 (`ThreadArtifactTypes`) is also a replay: it resets every thread's artifact item
     watermark, so the sync reads old Artifact calls again and fills the new columns and type names
     through its own idempotent upserts, rather than parsing provider JSON in SQL. Threads replay
     as they next sync (a subscribe or a run event), not at startup.
   - 007 (`ThreadParkedSends`) maps the old parked kinds (`prompt` to `agent`, `todo` and `later`
     to `me`), adds `sent_message_id` and creates `fork_thread_parked_set_aside` (Parked items, "Add
     to draft and Sent"). It was rewritten before any database ran it (the owner's live ledger was at
     005), and the lifecycle's 008 dropped; round 1 of PR #9's chip review changed it in place again,
     still unmerged. A database that recorded an earlier 007 would lack `sent_message_id` and the
     set-aside table, so this holds only while none exists.
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
     so it keeps its place in the stack with no notice header; upstream's row is split out as
     `NoticeRow`, which holds its own `useGT()`); and `ComposerPendingUserInputPanel.tsx`
     exports `OptionRadio`, so the decisions panel's rows look like the native ones; and
     `ChatComposer.tsx`'s handle has `submit()`, the send button's `submitComposer` (it reports
     whether it refused without a word), which the Tracker's Send draft calls (ChatView wraps the
     composer's `onSend` to keep the send in flight, `composerSendingRef`, so it can wait for the
     outcome). The Tracker's Edit and Remove use the handle's upstream `focusAt` and
     `resetCursorState`, and its "show in the chat" upstream's `assistantCitationNavigation`. The
     handle's `insertTextAtEnd` takes a fork option, `focus: false` (passed on as
     `focusEditorAfterReplace: false`), so the Tracker can add a line without moving focus.
     `radio-group.tsx` has a fork `segmented` variant of `RadioGroup` and a fork `SegmentedRadio`, the
     same look keyed on a radio's `data-checked` (Parked's add field; the lint forbids borrowing
     `toggleVariants` and restyling a `RadioGroup`). `toggle.tsx` has a fork variant,
     `segmented-bordered` (segmented, with a `muted-foreground`
     border on the selected item), which the Tracker's tabs use: the lint's `no-restyle` rule keeps
     colours out of a Toggle's className, and the approved design asks for that border. If upstream rebuilds the
     banner stack, give the panel the new stack's way to draw a custom card; if it renames the
     composer's submit, follow it; if it rebuilds citations, give "show in the chat" the new way to
     reveal a message.
   - The decision judge's setting, `decisionJudgeModelSelection`, is built like upstream's
     `speechPostProcessingModelSelection` and sits beside it in each place: the schema and the patch
     in `packages/contracts/src/settings.ts`, `resolveDecisionJudgeModelSelection` and its patch line
     in `packages/shared/src/serverSettings.ts`, the `decision-judge-model` entry in
     `settingsSearch.ts` (the row takes it through upstream's `useSearchableSetting`), the "Decision
     judge" task in `TextGeneratorsSettings.tsx`'s `TASKS`, and
     `<DecisionJudgeModelRow />` alone in a fork `tracker` section right after the `text-generation`
     section in `SettingsPanels.tsx` (`ThreadsSettingsPanel`). If upstream reshapes the cleanup setting, reshape this one the same way.
     `server.ts` provides `DecisionJudge.layer` to `ThreadDecisions.layer`; the judge calls
     `TextGeneration.generateTranscriptionPostProcessing`, so a rename of that operation lands here.
   - Parked's chip is a composer-context kind added the way upstream added `environment`
     (5e9d56416f): `parked` in `COMPOSER_CONTEXT_KINDS` and `ParkedContextRecord` in
     `KnownComposerContextRecord` (`packages/contracts/src/composerContext.ts`), shaped as
     `UnknownContextRecord` so official builds keep it; its provider text in
     `composerContextReferences.ts`'s `formatComposerContextProviderPayload`, which `formatEnvelopeEntry`
     and the web's `asKnownContextRecord` reach through a `parked` exception to their `"payload" in
     record` test (a new upstream reader of known records needs the same); and on the web a
     `parkedContexts` slot beside `environmentContexts` everywhere that one goes
     (`composerDraftStore.ts`, `composerContextRecords.ts`'s `buildMessageContext`,
     `composerContextPresentation.tsx`, `contextPresentationRegistry.ts`, `UserMessageContextChips.tsx`,
     `CollapsedComposerPromptPreview.tsx`, `ContextChip.tsx` and `contextChipAccents.ts`,
     `ChatComposer.tsx`'s send context, pruning and copy, `useComposerSend.ts`, `ChatView.logic.ts`'s
     send snapshot, `chatViewSend.ts`, `useQueuedRunEdit.ts`, `composerContextUndo.ts`,
     `composerSend.logic.ts`, `useComposerStash.ts` and `composerInlineTokenPaste.ts`, which drop the
     chip). Most hunks are a
     `parked` line beside its `environment` twin; the rest carry a `Fork (Parked)` comment. If
     upstream adds a kind in a new place, add `parked` there too; if upstream reshapes how kinds are
     declared, follow it. Beyond the kind's slots: `ComposerPromptEditorTiptap.tsx` takes a fork prop,
     `restoresParkedChip` (the undo gate), and calls `removesRefusedParkedChips` (which runs the
     fork's `removeParkedChips` from `composer-parked-chips.ts`) at the top of `onSelectionUpdate`
     and of `onUpdate`, before upstream's stale-skill check, whose condition also counts
     `PARKED_CHIPS_REMOVED` as part of the undo; its `handlePaste` strips parked chips before its
     code-block branch. If upstream rewrites any of these hooks, keep each call in the same place;
     "Parked items" (Undo) says why.
     `ChatComposer.tsx` builds that prop from the record it kept on delete (its label cleaned, equal
     to the chip's) and `parkedChipRestorable`, and restores the kept record of every returning chip
     the editor lets through. `ChatView.tsx` calls `useParkedDraft` (`ThreadDecisions.tsx`) and passes
     its
     `actions` to the Tracker and its `chipRestorable` to the composer as `parkedChipRestorable`.
     `packages/shared/package.json` exports the fork's `./parkedReferences` beside its `sessionKit`
     entries; web (`useComposerStash.ts`, `composerInlineTokenPaste.ts`, the editor's paste) and mobile
     strip pasted chips through it. On mobile: `composerContextClipboard.ts`'s import and
     `ComposerEditor.tsx`'s plain-text fallback strip parked chips, `ComposerEditor.tsx`'s
     `pasteContext` ignores a paste of parked chips alone, `ComposerContextSheet.tsx` shows one's words
     before its unknown-kind branch, and `apps/mobile/vite.config.ts` lists
     `ComposerContextSheet.test.tsx` among its React tests. `t3_park`'s `kind` in
     `thread/tools.ts` takes `ThreadParkedKindWord`. In tests: `apps/web/test/fakeEnvironment.ts` has
     `answerStreamRpc` (a subscription the test pushes snapshots into), `core.test.ts`'s `t3_park`
     case reads the stored kind through `parkKind`, and `ChatView.logic.test.ts`,
     `composerSend.logic.test.ts` and `useQueuedRunEdit.browser.test.tsx` carry the `parkedContexts`
     slot.
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
   `node_modules/.bin/vp` (`vp run i18n:check` is expected to fail on fork keys only; see
   "Translation"):
   - `packages/shared/src/sessionKit`, the drift test included, and
     `packages/shared/src/serverSettings.test.ts` (the judge's setting).
   - `apps/server/src/decisions`.
   - `apps/server/src/persistence/ForkMigrations.test.ts` and `Sqlite.test.ts`.
   - The desktop identity and environment tests in `apps/desktop/src/app` (`DesktopAppIdentity`,
     `DesktopEnvironment`, `DesktopPreReadyPlatform`).
   - `apps/web/src/components/chat/threadDecisions.logic.test.ts`, `composerSend.logic.test.ts`,
     `ThreadParked.browser.test.tsx` (its last case: a status from a `msg()` table, in French),
     `ThreadParked.touch.browser.test.tsx` (with the stylesheet) and
     `ThreadDecisions.question-panel.browser.test.tsx`.
   - Parked's chip: `packages/shared/src/composerContextReferences.test.ts` (its provider text),
     `packages/contracts/src/composerContext.test.ts` (the unknown-kind shape),
     `apps/web/src/composerDraftStore.test.ts` ("parked contexts"),
     `apps/web/src/components/ChatView.parked.browser.test.tsx` (the real composer: add, delete and
     undo, the Q56 guard that a change from elsewhere leaves the chip as it was, the undo gate's
     wiring with the caret mapped and no unavailable marker, an older chip refused once a newer one
     replaced its record, a long item's chip whose label was cut after a space coming back, two refused
     chips leaving the text beside them, the send's record, a closing
     code fence, stash and paste, a fence included), `threadDecisions.logic.test.ts`
     (`parkedChipRestorable`'s conditions, `endsAtClosingFence`), `useParkedDraft.browser.test.tsx`
     (In draft from the thread's draft and a queued message's edit; that edit's undo, and none once
     its item is no longer Sent with the chip's words),
     `ThreadParked.browser.test.tsx` (the lock: unavailable actions and their description, Save and
     its field held, all free again once the chip goes; the blocked Add to draft in the menu),
     `useQueuedRunEdit.browser.test.tsx` (an edit opens with the chip and saves without it),
     `packages/shared/src/parkedReferences.test.ts` (the strip, and chips alone pasting nothing),
     `apps/server/src/decisions/ThreadDecisions.test.ts` (Sent published while the judge still reads
     the message), and on mobile `apps/mobile/src/lib/composerContextClipboard.test.ts` (a paste drops
     it), `apps/mobile/src/components/ComposerEditor.ios.test.tsx` (a paste of chips alone keeps the
     selection) and `apps/mobile/src/components/ComposerContextSheet.test.tsx` (its words).
   - The Parked and Artifacts surfaces: `apps/web/src/rightPanelStore.test.ts` (order, active tab and
     an older layout across a reload; reopening a closed one), `closedViewStore.test.ts` (closed
     ones survive a migration) and `RightPanelTabs.browser.test.tsx` (strip counts), and
     `ThreadArtifacts.browser.test.tsx` (groups, row actions, the Link dialog).
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
  with dotfiles PR #600, merged; the parked kinds `agent` and `me` with #732, and their first-line
  rule with #738, both merged; the copy is refreshed from dotfiles main 7b96f4bc). The drift test
  reads the files from the local dotfiles checkout, so it
  goes red whenever that checkout is behind or ahead of a copy: compare against the copy's header
  commit before re-copying.

## Known noise

- On macOS two Linux icon tests in `apps/desktop/src/app/DesktopLinuxUrlHandler.test.ts` fail
  upstream too: APFS is case-insensitive, so the two icon spellings are one file.
- `check:changed`'s "unused patches" step has failed intermittently on a pnpm peer-dependency warning
  (`@tiptap/core`), also on clean branches.
- `apps/web/src/components/ChatView.browser.test.tsx` "a shortcut conditioned on rightPanelOpen sees
  the thread's open right panel" times out when the whole file runs on this Mac, and passes alone. It
  fails the same on the plain `v0.1.11-nightly.20261117.4825` and `v0.1.11-nightly.20261118.4864`
  tags.
- `npm:vite-plus` run through mise fails Effect tests ("Vitest failed to find the current suite"); use
  the repo's `node_modules/.bin/vp`.
