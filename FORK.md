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
| `(fork) service: fork builds seed the t3 runtime that t3 service install pins`                        | Background service            |
| `(fork) upstream-sync: a rerunnable plan, rebase and verify for moving onto a newer upstream`         | Rebasing onto upstream        |
| `(fork) tracker: the startup sweep keeps what the user made, and artifacts are read in time order`    | Artifacts                     |
| `(fork) decisions: an answer sent mid-run stays answered when that run's reply asks again`            | Questions and decisions       |
| `(fork) decisions: Dismiss closes a question without a message, and a send hides questions till read` | Questions and decisions       |
| `(fork) timeline: Mark unread from here on agent messages, with a New divider and a jump on open`     | Mark unread from here         |
| `(fork) workflows: a daily upstream-upgrade workflow, and workflow steps never park`                  | The daily upgrade workflow    |
| `(fork) tracker: a deleted thread's rows go on each compaction pass, beside its conversation`         | Parked items                  |

The table names features; `docs:` and `chore: re-copy session-kit's reply.ts` commits are left out.
`git log --oneline <base>..fork/main` lists every fork commit with its hash, where `<base>` is the
upstream release the fork sits on (`git merge-base fork/main upstream/main`). Today that is
`v0.1.13-nightly.20261125.5258`, whose last upstream migration is 119.

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
  echoes reopened answered questions under the earlier rule, which let any line reopen one.) A
  re-ask also leaves closed a question answered by a message the reply could not have seen: one of
  a later run than the reply's (the `orchestration_v2_projection_runs.ordinal` of each message's
  `run_id`), or one whose run is still `queued`. A message sent while the agent works queues behind
  that run (possibly behind others) or is delivered into it as a steer. A queued run's ordinal is
  final only once it starts: when a newer run started while it waited, the Orchestrator's
  queued-run start renumbers it past the runs that started meanwhile, so until then a run that
  started ahead of it carries a higher ordinal than it. A steer carries the running run's own id,
  so a re-ask after one still reopens; when either message has no run (an imported message, a
  card's answer), time order decides, as before. A user message whose run never started
  (`neverStarted` in ThreadDecisions.ts) never reached the agent: it answers nothing, its
  `Veto:` lines veto nothing, and a parked chip it carries is not Sent. (2026-11-19: "Q46: yes",
  sent mid-run, was reopened by that run's reply.) _Known limits, not reproduced:_ (a) a queued
  answer read at turn end and then cancelled before its run starts stays answered, since the
  watermark never reads it again; (b) a steer the provider declines is re-sent as a follow-up run
  under the same message id, and until the resend moves that message's `run_id` to the new run, a
  re-ask in the running run's reply read in that window reopens it (and it stays open); (c) a
  `Veto:` line in a queued message whose run is then cancelled before it starts stays shown until
  the next snapshot is read; (d) an answer skipped because its run failed to start is not read again
  if T3 retries that run under the same id (only a run created with deferred start, a new thread's
  first message, can be retried that way).
  _Rejected:_ the run's start time (`$.startedAt`): a run queued before the answer can start after
  it without seeing it, and a steer arrives after the start yet is seen.
- **Dismissing:** Dismiss, on the question card (upstream's `ComposerBanner.Dismiss`, the ✕ its own card
  has for "Dismiss question without answering") and on a Tracker question row, closes the question at
  once as `dismissed` (`threadDecisions.dismiss`), sending nothing to the agent, and a toast offers Undo
  for 8 s, which reopens it (an ordinary `threadDecisions.reopen`, so unlike Reopen nothing is held
  back; the toast says "Reopening Q4…" until it is done, since Reopen waits on the thread's lock). It
  lists under the Decisions tab's Dismissed with Reopen; a later shaped re-ask reopens it as it
  reopens any closed question, and a later answer naming it changes nothing, since only open
  questions close. "Not a decision" stays a draft line the agent reads. It takes no thread lock (a
  judge call can hold that for 20 s): a sync's closings write only open questions, so none lands on a
  dismissed one; the one sync write that changes a dismissed question is the re-ask upsert
  (`applyRows`), which reopens it by design. Dismiss and Reopen both name the question as the user
  saw it (`ThreadDecisionQuestionInput`: label and `sourceMessageId`), so a re-ask racing the click
  (a new source message) is not dismissed unseen: the Dismiss is refused and reported, as a Reopen
  (or Undo) of a question asked again and answered since is ("Q4 was asked again since; nothing was
  reopened"). Reopen of a question already open (asked again, or reopened elsewhere) succeeds and
  changes nothing, so an Undo after a re-ask reports no error. The card's Dismiss waits while the
  draft answers its question, as the Tracker row's does (the row offers it only undrafted); after a
  Dismiss the card shows the next question with focus on its row, and the Tracker moves focus to the
  next row (`neighbourOf`); with none left, in either, the composer has focus. ChatView holds it
  (`useDismissWithUndo`), so the Undo outlives the card and the panel. The state is a new value in
  `fork_thread_decision_questions.state`, a plain TEXT column, so no fork migration; a client from
  before it drops such rows (`ForwardCompatibleArray`). (2026-11-21: the owner could close a
  question the agent had replaced only by sending a message.) _Rejected:_ a table of its own;
  holding the dismiss behind its toast as Reopen is held (the card would stay up for 8 s). Tests:
  `ThreadDecisions.test.ts` "dismisses an open question without a message, …", "reopens a dismissed
  question when a later reply asks it again, …" and "acts only on the question as the user saw it,
  …"; `ThreadDecisions.question-panel.browser.test.tsx` "Dismiss on the card …", "Dismiss on a
  Tracker row …", "the card's Dismiss waits while the draft …", "dismissing the card's last question
  …", "dismissing the Tracker's last open question …" and "Undo says it is reopening …".
- **Hidden while a send is judged:** after the user sends a message while questions are open, the card
  and the Tracker's open questions (and the Questions count) are hidden, the Tracker saying "Reading
  your message", until the server has read it or its run ends, whichever is first; then they show with
  whatever the judge closed. `questionsHeld` (`threadDecisions.logic.ts`) decides from what the client
  already has: the message the user sent (an optimistic one if there is one, else the newest in the
  server's `(created_at, message_id)` order, its time from the projection's messages, of those queued
  outside the timeline and the timeline's last typed one, so a steer typed after a queued message is
  the one sent), its run's status
  (`ENDED_RUN_STATUSES`, which `packages/contracts/src/threadDecisions.ts` exports for the server and
  the client), and the snapshot's `lastTypedMessageRead`: the newest person-typed message at or before
  the message watermark (`fork_thread_decision_sync`) in that same order, read in `snapshot`. Read
  means it names the sent message, both sides having picked by the server's times. The server
  publishes a snapshot whenever it reads a person-typed message with text while questions are open,
  even one that closes nothing; every composer send has text (an image-only one carries
  `ATTACHMENT_ONLY_BOOTSTRAP_PROMPT`), and a message without text would show only at its run's end.
  Nothing is hidden with no question open. The panel's `actions.questionsHeld` carries it to the card
  (`threadDecisionsBannerItem`) and the Tracker. A message sent mid-run is read when the running run
  ends (the watermark waits at its still-growing reply), so its questions stay hidden until then and
  show at that moment, the judge done; it queues behind that run, and its own run's end comes later.
  (2026-11-21, the owner: "hide the questions till we get back a response from the judge or we get
  back your answer fully".) _Rejected:_ a "judging" flag in the snapshot (the server cannot publish
  when a message arrives that it cannot read yet); publishing the watermark itself (round 1): it
  usually ends on the run's later reply, which the client cannot place against a queued message not
  yet in its timeline, so such a send stayed hidden until the next run ended; comparing
  `(created_at, message_id)` with the sent message's: the server stamps a user message with its own
  clock (`Orchestrator.ts`, `DateTime.now`), not the client command's `createdAt`, so the optimistic
  copy's time is not the stored one; picking a queued message ahead of the timeline's (round 1): a
  steer typed after it is the one the server reads, so the hold lasted through the queued run. Tests:
  `threadDecisions.logic.test.ts` "holding questions back
  while a sent message is judged"; `ThreadDecisions.test.ts` "names the newest typed message read, …";
  the browser tests "a sent message hides the open questions until the judge has read it", "… come
  back when its run ends, …" and "a send's hold keeps the card's question and collapse".
- **When a reply is read:** at turn end (a run `waiting` or `completed`), never while a message
  streams; also when an assistant message finishes, and on subscribe, through a per-thread watermark
  (rows are derivable; replies written while an official build ran are backfilled).
- **Display:** the latest reply's open questions above the composer, one at a time, built like T3's
  own AskUserQuestion panel: a header (label, key words, `1/3` with Previous/Next, upstream's
  `ComposerBanner.ToggleIcon` chevron, Open Tracker, whose tooltip counts earlier open questions, and
  Dismiss), the question as markdown, then option rows
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
  every other answer writes.) Collapse lasts for one reply: a store in `ThreadDecisions.tsx`
  (`useQuestionCardViews`, by thread) holds the card's shown question and collapse per reply, so a
  send's hold, which unmounts the card, does not reset it. The whole header row is its one collapse
  control, as upstream's card's row is, so it has one hover: a full-row `CollapsibleTrigger` under the
  row ("Hide Q4" / "Show Q4"), the label and chevron drawn over it with pointer events passing
  through, and the other controls above it. Upstream makes its row the button and nests its Dismiss in
  it as a `span role="button"`; with five controls here that would be five nested pseudo-buttons, so
  the trigger sits under them instead. (2026-11-21: the owner's screenshot showed two collapse
  controls with different hovers.) The browser test "the question card's whole row is its one
  collapse control, …" counts the `aria-expanded` elements. While T3's own question is pending, the composer hides this panel
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
  palette's "Show parked items" (not in a side chat) / "Show artifacts" open them. `decisions.toggle`
  still toggles the Tracker alone. Its user-visible name is Tracker everywhere (its tab, both
  add-panel menus, the command palette's "Show Tracker", the keybinding's "Tracker: Toggle" in
  `KeybindingsSettings.logic.ts`'s `LATE_COMMAND_LABELS`, the panel header's Open Tracker); the tabs
  keep their names. Its ids stay `decisions` (the surface kind and id in `rightPanelStore.ts` and
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
    (none without a pick), Answer…, Not a decision and Dismiss (above). Once the draft closes a question, the row shows
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
    that line (lines read trimmed; a message whose run never started, `neverStarted`, is ignored; as the panel reads its draft; one read of the thread's messages
    with a `Veto: ` line, matched in TypeScript), and a message with a `Veto: ` line publishes a snapshot even when it closes no
    question. (A client-side check would miss messages the timeline has not loaded.) Then Answered
    (accent chip), Not a decision and Dismissed (muted chips), each answered one with "You" and the question's own part of the
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
    close). ChatView holds it (`useReopenWithUndo`, passed in the Tracker's actions), not the panel,
    so switching to Parked or Artifacts, which unmounts the panel, keeps the Undo (Astra on #7); the
    hold names its thread, so its toast reopens that one after a thread switch too. ChatView
    unmounting or the page going away (`pagehide`, best effort) sends what is still held. With Dismiss (above), it is one of the two Tracker actions that skip the draft; the row's Reopen
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
    theme with a pale message action can still fall short). Reopen's toast and `/park`'s (Parked,
    and Left out a placeholder) take no `type`, since the info icon is fixed blue and the success
    icon fixed green. On the default theme
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
  with attachments, on an unstarted thread, on mobile (a queued message edited to `/park` too), and
  in a side chat, in its pane or at its own URL: a side chat never holds parks, as `t3_park` and the
  server refuse it (Astra on #7; in its pane the panel is its parent's, `hostRightPanel`, so a bare
  `/park` would open the parent's). The menu leaves `/park` out there too, and at its own URL the
  panel offers no Parked tab. A subagent (one T3 or a linked machine delegated: the contracts'
  `isDelegatedAppThread`) is refused the same way (MAIN-105): only the main thread parks on the
  owner's list. So is a workflow run's agent step (`lineage.workflowStep`, MAIN-114, 2026-11-23),
  with its own words ("A workflow step can't park", `WORKFLOW_STEP_PARK_MESSAGE`): its thread is
  read through its run, where no Parked tab is shown. One helper decides it on the client:
  `threadParks` beside `isDelegatedAppThread` in `packages/contracts/src/orchestrationV2.ts`
  (upstream's `isListedThreadLineage` and not delegated); `isDelegatedAppThread` stays upstream's
  (its other callers decide prompt suggestions and thread lists by it). The composer's refusal only
  saves a round trip: `ThreadDecisions.park` refuses the same threads in SQL for every caller (the
  Parked tab's field, `t3_park`, any client), held equal to `threadParks` by "refuses to park
  exactly the threads threadParks rules out" in `ThreadDecisions.test.ts`, and to `parkRefusal`
  beside it (why not, for each refusal's words). The Command Palette offers no "Show parked items"
  where `threadParks` says no. A bare `/park` opens the Parked surface. On conflict: if upstream's
  `isListedThreadLineage` gains an exclusion, `ThreadDecisions.park`'s SQL and `parkRefusal` must
  follow it (until then `parkRefusal` reads the new kind as a workflow step).
- `t3_park` in the thread MCP toolkit, for every provider: its `kind` takes `agent` or `me`, and the
  old words, which `ThreadDecisions.ts` maps when it stores the row (`PARK_KIND_OF_WORD` in
  `packages/shared/src/sessionKit/parks.ts`, a total record that `parks.test.ts` holds equal to
  session-kit's `parkKind`). A stored row an older build wrote with an old word is read through
  `parkKind` too, so it stays listed. Its description was cut to keep the tool list within
  `fork/main`'s agent context budget (`agentContextBudget.json`). The "Agent context budget" CI check
  compares with the repo's `main`, an older upstream, and fails for every fork PR without its
  `agent-context-increase` label. It refuses delegated child threads itself, and passes on
  `ThreadDecisions.park`'s refusals as `invalid_request`: a side chat (`SIDE_CHAT_PARK_MESSAGE`, the
  one rule, as `/park`), a subagent (`SUBAGENT_PARK_MESSAGE`, for a caller other than `t3_park`,
  which refuses one first), a workflow step (`WORKFLOW_STEP_PARK_MESSAGE`) and placeholder text.
  Its eval cases
  (`evals/mcp-tool-use/cases/parked.ndjson`) have only run with `--dry-run`; a real run is owed.
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
    chip holds, in place (Sol round 3, S5). A drop of text onto the web composer (since 5191 upstream's
    `handleDrop` calls the paste's `insertClipboardText`) drops them too, and a drop of chips alone
    adds nothing; `ChatView.parked.browser.test.tsx` drops both beside its paste cases. A plain-text paste the native editor keeps to itself never
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
  - **Back to Open:** only when the message never reached the agent: its run never started
    (`neverStarted`: a queued send cancelled, a thread archived with it queued, or a run that could
    not start), or the chip was edited
    out of the queued message. Another message carrying the item since its last Reopen keeps it Sent,
    with that message. Nothing else changes it: steers, declined steers, provider failures after the
    start and usage limits leave the message to T3, which delivers or retries it.
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
  returns focus to the row's "…". When an open item leaves, focus goes to the next row still open
  (else the nearest before; one another client resolved meanwhile is passed over, `rowFocusAfter`),
  else to the surface itself, never to the finished item's Reopen. When a row keeps its
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
- The sweep (`sweepDeletedThreads.ts`) deletes parked rows and their `fork_thread_parked_set_aside`
  only for soft-deleted threads: unlike questions, they cannot be rebuilt. Artifacts' rows and
  watermark follow the same rule (see Artifacts). It runs when the server starts and on each
  six-hour compaction pass, beside upstream's purge of a deleted thread's conversation (5258), so a
  deleted thread's Tracker, Parked and Artifacts text goes by the next pass (about six hours), not
  at the next start (the owner's choice, 2026-11-26, over a hook in upstream's per-thread purge). It
  does not follow the purge's exemptions (a thread a live run fork or parent still reads keeps its
  conversation): such a thread's rows go anyway, and a sync of it writes no questions back
  (`applyRows` skips a deleted thread, so a sync that waited on the judge cannot undo a sweep).

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
  when a later publish names none, and an older call naming it still types the row (migration 006's
  replay meets rows a later untyped publish already dated). A reply's link to an Artifact type itself (a core type URL, or one
  in `fork_artifact_type_names`) is not shown as an artifact, nor counted. Ceiling: a not-found read
  by `code/artifact/<uuid>` misses a row only ever created, since a create's output carries no uuid.
  Its own watermarks, the tool one advancing over every `dynamic_tool` row so threads are not
  re-parsed. Calls and reply links are read in one time order (a call first at the same time), and a
  reply still streaming holds the calls after it too, so a catch-up sync ends as incremental ones do:
  a not-found after the reply linking it marks that row either way (Astra on #8). A not-found never
  marks a row first seen at or after it: the sync that first read it found no row, so 006's replay
  leaves it unmarked too. Ceiling: a reply stuck at `streaming = 1` holds back that thread's later
  Artifact calls for good (the live DB had no such row on 2026-11-20); the upgrade is a cutoff by age.
- The sweep deletes a thread's artifact rows and watermark only once the thread is
  soft-deleted, as Parked's: they hold what the user made (links, titles), which nothing rebuilds.
  A thread merely absent from the projection keeps them (Astra on #8: they went with it before).
  Ceiling: rows of a thread removed outright stay; no upstream path hard-deletes a projected thread.
- **Type** (MAIN-62): a create or publish output's `type.url`, else the input's `type_url`, types
  the row; a publish without either is a plain page (markdown when its `path` ends `.md`). Mentions
  and manual links stay "Type unknown" until such an output names them. The name comes from
  `fork_artifact_type_names` (global: any thread's `list scope:types` output, `artifact_types[]`,
  and any read output's `type.{url,title}`), joined when a snapshot is read, so a name learned later
  names older rows; the name seen latest wins, and the same name seen again moves its time, so an
  older thread read later does not revert it; then `CORE_ARTIFACT_TYPE_NAMES` (the 8 core types this account listed on
  2026-11-19; the same URLs on other accounts is unverified); else the panel says "Typed artifact".
  Evidence: the dotfiles repo's `.local/.execution/t3-native-board/notes/artifact-types/`. Ceiling:
  a name one thread learns reaches another thread's open panel at that panel's next snapshot.
- **Not found** (MAIN-63): a failed call whose output contains `artifact not found` and whose
  `input.url` names a listed row (by its own id or its publish's uuid) marks it not found at that
  time; a later completed read or publish of it clears that. It never adds a row, and no other
  failure counts. The exact error text is a fixture in `ThreadDecisions.test.ts`.
- **Manual links** (MAIN-63): `threadDecisions.linkArtifact` (a URL and an optional title; an
  artifact already listed, by either id, keeps its row and only gains a title it lacks, except a
  mention, which becomes the user's link with their title, dated now so it lists among the newest
  rows however old the mention, so it can be unlinked) and
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
  and always on a touch screen. Once the snapshot drops an unlinked row, focus goes to the next row
  (else the nearest before, `rowFocusAfter`), else to the empty state's Link artifact button. The
  Link dialog's line says a link's type stays unknown until this thread publishes it: a read names
  no row's type.
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

### Background service

`t3 service install` (the background service) must work from the fork app's launcher, `~/.t3/bin/t3`,
and keep working after every fork rebuild.

- **Decision:** a service install pins a runtime at the CLI's own version and downloads it from
  pingdotgg/t3code's releases, where no `-fork.` version exists (404 on `SHA256SUMS`, 2026-11-20).
  A runtime already complete in `<T3 home>/runtime/versions/<version>/` is used instead
  (`installPinnedRuntime`, `apps/server/src/cloud/pinnedRuntime.ts`). So `scripts/fork/build.sh`
  builds that runtime beside the app, with release-desktop.yml's steps and smoke test, and
  `scripts/fork/install.sh` seeds it with `scripts/fork/seed-runtime.sh` at install, not at build:
  `~/.t3` is live data, and the build writes only `release/`. _Rejected:_ the service on upstream
  Nightly's runtime (it may refuse a database the fork migrated past); fork releases with
  `T3CODE_RELEASE_BASE_URL` pointed at them (a release pipeline for one machine; a seeded runtime is
  used before any URL is built, so that variable needs neither setting nor blocking); upstream's own
  installer (it cannot take a local archive).
- **One version per build:** T3 reuses a runtime, and judges a service current, by version alone.
  So `build.sh` adds a build number to the tag's version (`0.1.11-fork.20261118.4864.<n>`), counted
  in the git common dir and never below the UTC time, and `t3 service install` moves the service to
  each new build through upstream's own path instead of reusing the last one's runtime. The format
  passes `isExactServiceVersion`, sorts above the bare tag version, and still reads as Stable and as
  the fork's branding (checked 2026-11-20).
- **The T3 home is `~/.t3`:** an app opened from Finder does not see a shell's `T3CODE_HOME`, so
  install.sh refuses any other value, and the backup is always of the database the app migrates.
  _Rejected:_ resolving the home from the shell as the CLI does (it backs up and seeds a home the
  app does not use). Other homes are unsupported; the upgrade path is resolving the app's own home.
- **The fork version rule:** a version is the fork's when its prerelease starts with `fork.`
  (`apps/server/src/cloud/forkLeaveGuard.ts`); build.sh, install.sh and seed-runtime.sh match it.
- **Kept from prune:** each service start prunes every runtime over an hour old that nothing names
  (`prunePinnedRuntimes`). Once the new app is in place, install.sh runs that runtime's own
  `t3 install` with its bin dir at `~/.t3/runtime/fork-bin`: upstream records the launcher it
  writes in `runtime/launchers`, which the prune keeps (install.sh checks the record: `t3 install`
  only warns when it cannot write one), and the folder shadows no `t3` on PATH. It writes nothing
  else: `forkServiceRuntime.test.ts` checks that the home then holds only `runtime/versions`,
  `runtime/fork-bin` and `runtime/launchers`. Until then a failure or interrupt puts the previous
  app back; the launcher then names the previous runtime unless `t3 install` already ran.
- **The seed** never replaces or removes a runtime: a version already there is the same build. It
  publishes by a rename that never clobbers, so of two seeds at once one fails ("something took
  that name"). A SIGKILL skips its cleanup and can leave a `~/.t3/runtime/versions/.fork-seed.*`
  folder (about 150 MB) that prune never removes; once no seed runs, delete it with `rm -rf`.
- **Leaving the fork:** a `-fork.` version reads as Stable, and upstream's v0.1.11 (2026-11-20, last
  migration 102) is newer than every 0.1.11-fork build and runs on the fork's database (the fork's
  tables have their own ledger, so `servicePreflight.ts` finds nothing it does not know). So
  `t3 update` and a client's server update would complete a switch to upstream, and the next fork
  build would meet the service's downgrade guard. A fork build refuses to pin a runtime that is not
  a fork version unless `T3CODE_LEAVE_FORK=1` is set (in the shell for `t3 update`, in `service.env`
  for the service). The guard protects only commands run by fork code: every packaged T3 Code app
  points `~/.t3/bin/t3` at its own CLI when it starts (`DesktopCliShim.ts`), and after an official
  app ran, `t3 service install` or `t3 update` is upstream's code, with no guard. So install.sh
  runs the service step through the new build's own runtime
  (`~/.t3/runtime/versions/<version>/t3`), never `~/.t3/bin/t3`.
- **Seam:** one, `ensurePinnedRuntimeInstalled` in `pinnedRuntime.ts`, chained after
  `refuseLeavingFork` beside it. On conflict keep upstream's body and chain the guard before it
  again; if upstream splits the function, the guard goes where `t3 update`, the server's self-update
  and `t3 service install` all still pass.
- **Test seam:** upstream's `selfUpdate.test.ts` "keeps preparing after the progress stream closes"
  ended while the detached update still wrote its SSH launch marker, and removing the temp folder
  then failed with `ENOTEMPTY`. The seam's extra step made that race show: 5 of 40 runs failed with
  four runs at a time (0 of 40 one at a time), 2026-11-20. The test's harness now completes a
  `Deferred` when the marker is renamed into place (the update's last write), and the test awaits
  it: 0 of 80 under the same load, 4 of 40 with the await taken out. On conflict keep upstream's
  test and re-add the `markerPublished` option and await; drop them once upstream's test waits for
  the update itself.
- **Conflict guidance:** `apps/server/src/cloud/forkServiceRuntime.test.ts` fails when upstream
  changes what makes a runtime reusable (the sentinel, the layout, the install call in
  `bootService.ts` `install`, its version check), what `t3 install` writes and records, or what the
  prune keeps. Make the seed and install.sh produce what the new code accepts; if a service install
  now insists on a published release, stop and ask the owner. If upstream's `status` starts
  reading launchd in a new way, extend the harness's read-only filter (its comment says why).

### Mark unread from here

The owner asked for "a mark unread from a specific message similar to the mark unread on the thread
menu item" and answered Q64 "yes, with the divider" (2026-11-21; _rejected:_ the menu item alone).

- **The action:** "Mark unread from here" with an agent message's own actions, web and desktop
  (mobile untouched, rule 5), hidden while the thread's latest run is under way, when the server
  refuses as it does the menu's, and without the right to operate the thread: unlike the menu's
  item, which upstream leaves to read-only clients, since every `dispatchCommand` (this one too)
  needs `orchestration:operate` (`apps/server/src/auth/RpcAuthorization.ts`, checked 2026-11-21).
  It takes the menu's path with the message's time:
  `thread.mark-unread` carries an optional `from`, and the server sets the watermark 1 ms before
  the earlier of `from` and the latest run's end. No new storage and no new event; an official
  server drops `from` on decode (Effect Schema's default for a struct, checked 2026-11-21; its RPC
  layer's own options _unverified_) and marks from its latest run.
- **The divider:** a "New" separator above the first unread entry of the visit, against the
  watermark as it was at open. Ordinary unread (the menu's mark, the run's end less 1 ms) shows it
  at the start of that run's reply; another watermark with no agent message after it, at the
  message being written then (updated after it, in any run), else at the latest run's first entry
  that has a row. A watermark older than the loaded history shows no divider until the user pages
  back to it.
- **The jump:** on the opening whose first decision found a divider, upstream's
  `startTimelinePositionRestore` scrolls its row below the top fade, once, after upstream's own
  opening restore; not while the latest run is under way, nor after the user's own navigation.
  _Rejected:_ feeding the divider into upstream's opening restore itself, which needs the rows when
  the thread changes (they often load later) and touches every reader of the remembered position.
- **Where:** `UnreadFromHere.tsx` and `unreadFromHere.logic.ts` in `apps/web/src/components/chat/`
  (their doc comments carry the rules).
- **Seams:** `packages/contracts/src/orchestrationV2.ts` (`from` on `thread.mark-unread`),
  `apps/server/src/orchestration-v2/Orchestrator.ts` (the clamp),
  `packages/client-runtime/src/operations/commands.ts` (`MarkThreadUnreadInput.from`),
  `apps/web/src/hooks/useThreadActions.ts` (`useMarkThreadUnread` exported, with `from`, returning
  the command's result), `apps/web/src/components/Sidebar.logic.ts` (`hasUnseenCompletion`'s
  parameter narrowed to the run and the watermark, so the divider calls it),
  `apps/web/src/components/chat/TimelineAssistantRows.tsx` (the button in `AssistantMessageMeta`),
  `apps/web/src/components/chat/MessagesTimeline.tsx` (the `unreadMarker` prop, the
  `useUnreadDivider` call, the divider in `renderItem`, its row in `listExtraData`), and
  `apps/web/src/components/ChatView.tsx` (the `useUnreadMarker` call and the prop).
- **Tests:** `apps/server/src/orchestration-v2/Orchestrator.markUnreadFrom.test.ts`,
  `apps/web/src/hooks/useThreadActions.markUnreadFrom.test.ts`, and `unreadFromHere.logic.test.ts`
  and `UnreadFromHere.browser.test.tsx` in `apps/web/src/components/chat/`. Not covered: ChatView's
  wiring.
- **Conflict guidance:** if upstream gives `thread.mark-unread` a time of its own, drop the fork's
  field and call upstream's. If upstream moves an agent message's actions, put the button with them.
  If upstream rebuilds the timeline's rows or its opening restore, keep the divider on the row that
  holds (or folds) the first unread entry and the jump after the restore; if upstream renames a
  tool group's row ids or stops giving folds their `runId`, `rowHoldingEntry` and its tests go
  first. If upstream ships its own unread divider, stop and ask the owner (step 4).

### The daily upgrade workflow

The owner's Q73 (2026-11-23, MAIN-113): "once the fork is on 5124, build a small workflow that
checks upstream daily, asks you whether to upgrade, and runs the upgrade and both reviews, then
stops before the install".

- **What runs:** `evals/fork/upstream-upgrade.ts`, a T3 workflow (upstream's Labs feature,
  `docs/user/workflows.md`; it does nothing while Settings → Labs → Workflows is off). Its header
  says what it does each morning; its steps, questions and briefs are in the file. The install
  question and its launch (the owner's Q74, pending) are the `install` function, the run's last
  steps, easy to take out.
- **Roles** (the owner's Q77, 2026-11-24, MAIN-121): one machine, the personal Mac, is the
  `upgrader` and does all of the above. Every other machine (the work Mac) is an `installer`: when
  origin's fork/main is not the commit the installed Fork app was built from, it asks to build and
  install it, and on Build moves its clean checkout there, builds and launches the install. It never
  rebases, reviews or pushes: two upgraders would both force-push fork/main, as the checkout's claim
  is per machine. Each machine's first install names its role (`--role`, see "Installing"); later
  installs keep it. With none recorded, install.sh copies no workflow (and moves a copy from before
  roles to the trash) and the workflow stops rather than guess. The comparison is "differs", not
  "newer": fork/main is rebased, so its commits are not ancestors of each other. The code: `readRole`, `readForkMain` and `buildForkMain` (with
  `moveCheckout` and `buildCheckout`) in the file, the role in install.sh, the build's commit at the
  end of build.sh. _Rejected:_ the upgrader driving the installer's machine through an agent on a
  linked environment (couples the two machines' uptime); recording the commit in `release/` and
  again in the T3 home on install (two writers; the version the app carries is already the key);
  upgrading when no role is recorded (an agent's plain first install on a new machine would make a
  second upgrader).
- **Decisions:** a run owns the checkout only once `approve` is answered Upgrade (its title then
  starts with `Upgrading the fork`), until it ends: a run that only asks holds nothing, and every
  question times out within the day. Its `claim` step records it as the owner in the workflow
  store (`upstream-upgrade/checkout`), in a transaction, so of two runs answered Upgrade only the
  first answered goes on. _Rejected:_ the earlier-started run wins (the review's first pick): a
  run started earlier and answered later would upgrade beside the one already upgrading. A build
  whose install the owner answered Not now (`upstream-upgrade/declined-build`) is not offered
  again; a newer build is, and an unanswered question is asked again the next morning: a
  question before the claim ends an hour before that run (`ASK_BEFORE_NEXT_RUN_MS`). A step that
  can fail on the outside world ends the run with its reason instead of pausing it:
  `launch-install` and the local reads at once, the upstream fetch only after its last try
  (`UPSTREAM_TRIES`, `upstreamRetryAfter` apart, for a Mac asleep at 08:00; a sleeping run holds no
  install). Fetches run with a timeout and ssh in batch mode, so a hung network never leaves a run
  holding the checkout. The launch installs only the build it asked about (`release/` must hold
  that version) and nothing when the Fork app already has it; a second launch while the first
  waits is refused by `auto-install.sh`'s lock, and the run stops with that reason. With no newer
  Nightly the next morning's run offers fork/main's build when the Fork app is older (an install
  that was launched and failed).
- **Installed as a copy:** `install.sh` copies the file into `~/.t3/workflows` once the app is in
  place (a differing copy, an edit in the Workflows page, goes to `~/.claude/trash` first), so a
  branch switched in the checkout never changes what runs. A body changed while a run is unfinished
  is a new `version` (the workflow skill's rule 3; the note at `version:` in the file).
- **Notifications** (the owner's Q75, MAIN-116; T3 raises none for a workflow question): every
  question goes through `askAnnounced` in the file, which shows one on macOS in a
  `notify-<question>` step before the `ask`; one that fails is noted on its step and the run still
  asks. macOS credits them to Script Editor, which must be allowed in System Settings →
  Notifications: osascript exits 0 even when nothing is shown.
- **The install's idle check:** a workflow run holds an install only while code of it runs, never
  while it only waits; `active_runs` in `scripts/fork/auto-install.sh` says why.
- **Where it lives:** in `evals/`, so `check:changed` typechecks it (evals' own typecheck, under the
  globals `evals/workflow-authoring/fixtures/globals.d.ts` declares) and runs the test beside it
  whenever it changes. `scripts/` is a composite project, which cannot take the server files those
  globals come from. `knip.jsonc` lists it as an entry of `evals`, since only the server loads it.
- _Rejected:_ `git ls-remote` instead of the fetch (the count of commits needs the objects);
  reviewing again after the fix (one round); worktrees for the reviews (they only read, and the
  upgrade is done by then); retrying the fetch within a run (the next morning's run is the retry),
  superseded 2026-11-24: v1's only run stopped on a fetch made while the Mac slept (see
  `UPSTREAM_TRIES`).
- **Tests:** `evals/fork/upstream-upgrade.test.ts` loads the file with the server's loader and
  drives it in the real engine on a throwaway database through `evals/workflow-authoring/grade.ts`,
  with stand-in agents, a checkout whose remotes are local repositories, stand-in `auto-install.sh`
  and `build.sh`, and an ssh that fails or hangs on its first N connections (macOS only: it reads
  the app's version with PlistBuddy); the "as an installer, …" tests cover the installer.
  `apps/server/src/cloud/forkServiceRuntime.test.ts`: "counts a workflow run only while code of it
  runs, …" and "passes --role through the launchd job …" (auto-install.sh), "copies the upgrade
  workflow into the T3 home …" and "records the --role it is given …" (install.sh), and "stamps
  every build …" (build.sh's `fork-builds` record).
- **Live check** (2026-11-23, of the first version): a server from the checkout on an isolated home
  with workflows on registered `upstream-upgrade@1` and its daily trigger (next due 08:00 local).
  Against a fake upstream, a run skipped with no newer Nightly; with one, it asked, and Not now
  stopped it. Its agent steps have run only under the test's stand-ins.
- **Conflict guidance:** a change to upstream's workflow API reaches the file only when it loads
  (each call refuses an option it does not take), so the test fails first; follow it. If upstream
  changes `workflow_runs`' or `workflow_steps`' statuses, kinds or columns, follow them in
  `active_runs`.

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
     005), and the lifecycle's 008 dropped; round 1 of PR #9's chip review changed it in place again
     before it merged. The owner's live ledger recorded this 007 on 2026-11-20, so it is now as fixed
     as the rest: never edit it.
   - A new value in a TEXT state column needs no migration: `dismissed` (Questions and decisions,
     Dismissing) went into `fork_thread_decision_questions.state`, which has no CHECK.
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
5. **Mobile stays untouched** except the `/park` refusals in `use-thread-composer-state.ts` and
   their test.

## Rebasing onto upstream

`scripts/fork/upstream-sync.ts` does the parts of this a script can; run it with node under the
target's Node. Its `USAGE` line names the commands and flags; `targetProblem`, `rebaseRefusal`
and `verifyRefusal` say the main refusals, and the others are in `requireNode` and `verify`.

- `plan` reads only and judges nothing safe: each `[ ]` line is a file or fact to read. After the
  rebase, before anything is pushed and while the backup branch exists, `verify` catches only what
  its checks reach (step 5). What to do with each kind of line:
  - **Node:** install the target's `engines.node` and run every step under it (step 2).
  - **Migrations:** read each migration the target adds, removes or renames, and every other file
    upstream changed under `Migrations/`: does it reshape a table the fork reads (rule 1), and does
    the fork's code still match? A manifest line the script cannot read means reading the manifest
    by hand.
  - **Upstream queries on the fork's tables:** read each listed change beside the fork's queries on
    that table. When the script finds no table in the fork's SQL, read the fork's queries by hand.
  - **`~/.t3`'s migration ledger:** read what each listed build's `Migrations.ts` does at startup
    with the ids listed (step 1); the script does not say.
  - **Upstream files the fork changes:** re-apply each seam from the line of this file the item
    names (step 3's list); for a path this file does not name, keep both sides, then add its seam;
    for a file one side moved or deleted, or both added, follow step 4.
  - **Upstream files fork code imports:** read upstream's change against what the listed fork files
    use from it. File level only: packages and a barrel's forwards are left to the typecheck.
  - **Lint:** a rule source or a lint tool's version changed upstream, or the script cannot find
    where the target pins it; `verify`'s `check:changed` lints the fork's files against it
    ("Translation" says how the fork answers rules it cannot follow).
  - **Commits:** an upstream commit that may be its own version of a fork feature: read it, and ask
    the owner before rebasing (step 4).
  - **Release notes:** pass `--notes` to print each Nightly's notes in the range. A
    `gh release view … failed` item means they were not read.
- `rebase` keeps the old head as `fork/main-pre-<n>` and pushes it before rewriting anything, then
  prints the leased push step 7 uses.
- `verify` checks the rebased `fork/main` (step 5) and ends by printing that push command.
- `suite` records the target's own full suite (each package's exit, each test file's tests run,
  every failure), the baseline `verify` reads (step 5). It keeps it in the git common dir by the
  target's commit, where `verify` finds it, so start it in the background right after `plan`.
- `suite` and `verify` run the workspace packages' test scripts side by side (`suiteRun` in the
  script says how many at once, and why no more), each in full, naming it when it starts and
  printing its output whole when it ends; their children never see the T3 service's `T3CODE_PORT`
  and `T3CODE_HOST` ("Known noise").

Read the plan before every upgrade. Its test, `scripts/fork/upstream-sync.test.ts`, runs from the
repo root (`vp test run scripts/fork/upstream-sync.test.ts`) or from `scripts/` through the
package's own command (`vp test run --config ../vite.config.ts --dir . fork/upstream-sync.test.ts`;
without the root config the replay outlasts Vitest's 5 s default). It holds each check to synthetic
input and replays the 4825 → 4864 rebase, whose plan must list the two breaks that rebase had
(`settingsSearch.ts`, which `DecisionJudgeModelRow.tsx` imports, and the new
`no-untranslated-copy.ts` rule). Without `fork/main-pre-4864`, the tag and `upstream/main` (CI's
checkout) the replay skips and says why; `verify` sets `UPSTREAM_SYNC_PROOF=required`, under which
it fails instead. The steps below are what the script encodes and what stays a person's job.

1. **Pick the target: the official Nightly the owner runs, not `upstream/main`.** The Nightly is their
   fallback; `upstream/main` may carry migrations the Nightly lacks, and a fork built from it would
   migrate `~/.t3` past what the Nightly knows. An official build does not refuse such a database:
   4825 logs recorded ids unknown to it as a divergence warning and starts anyway
   (`Migrations.ts` ~L338-355 at that tag), running code older than the schema. Use that Nightly's
   tag (`v<version>-nightly.<date>.<n>`, `git fetch upstream --tags`) and check its migration head:
   the last entry in `apps/server/src/persistence/Migrations.ts` at the tag.
   - For each build `plan`'s ledger section lists, read that build's `Migrations.ts` at its tag for
     what it does at startup with the ids listed: a refusal (newer builds refuse to skip some ids,
     e.g. `skippedV2Migrations`), a warning, or a reconciliation, and decide before running it on
     `~/.t3`. That includes the installed Nightly once the fork at the target has run the target's
     migrations (the ids above the ledger's last, the only ones upstream's migrator runs): that is
     the database it falls back to. `plan` also says when the target is not the installed Nightly.
   - A ledger with ids above the target's head (an official build newer than the target already
     migrated `~/.t3`) stops the fork itself, not upstream's warn-only code: the rebuilt fork
     refuses to start (`assertDatabaseNotAheadOfFork`, `ForkMigrations.ts`; rule 2). Pick a
     target at least as new as that build (rule 3).
2. Pull in any `fork/main` commits pushed from another machine, then keep the old head:
   `git branch fork/main-pre-<n> fork/main`, push it. Then
   `git rebase --no-update-refs --onto <tag> <base tag> fork/main`, where the base tag is
   `git describe --tags --abbrev=0 --match 'v*-nightly.*' fork/main`. Nightly tags sit on
   `upstream/main`, so that is `git merge-base fork/main upstream/main` (checked for 4825 and 4864),
   without needing a fresh `upstream/main`.
   - Node comes from the **target's** `package.json` `engines.node` and may change between releases:
     `mise install node@<v>`, run git through `mise exec node@<v> -- git …` (the pre-commit hook
     runs `vp staged`), and `node_modules/.bin/vp i` once the rebase is done.
3. `git diff --name-status <tag> fork/main` lists every upstream file the fork modifies (`M`) and every
   file it adds (`A`). The modified ones are where conflicts happen.
   - Every upstream file the fork modifies, by its seam. `plan` looks for these full paths: a file
     it reports that is missing here gets "keep both sides"; add it with its seam once resolved.
     - Thread decisions over RPC (the fork's methods beside upstream's, each list growing at once):
       `packages/contracts/src/rpc.ts`, `packages/contracts/src/index.ts`,
       `packages/contracts/src/clientRpcPermissions.ts`, `apps/server/src/auth/RpcAuthorization.ts`,
       `apps/server/src/observability/RpcInstrumentation.ts`, `apps/server/src/ws.ts`,
       `apps/server/src/server.ts`, `packages/client-runtime/src/rpc/client.ts`,
       `packages/client-runtime/src/state/server.ts`; and in tests, each layer that mocks
       `ThreadDecisions` or lists the methods: `apps/server/src/ws.test.ts`,
       `apps/server/src/peer/PeerForwarding.test.ts`, `apps/server/src/mcp/linkOrigin.test.ts`,
       `apps/server/src/mcp/toolkits/core.test.ts`,
       `packages/client-runtime/src/state/commandPermissions.test.ts`.
     - `t3_park`, the MCP thread toolkit: `apps/server/src/mcp/toolkits/thread/tools.ts`,
       `apps/server/src/mcp/toolkits/thread/handlers.ts`, and the budget it grows,
       `apps/server/src/provider/agentContextBudget.json` with
       `apps/server/src/provider/AgentContextBudget.test.ts`.
     - Storage: `apps/server/src/persistence/Sqlite.ts` (fork migrations after upstream's, and the
       ahead-of-fork guard; rule 1) and `apps/server/src/persistence/Sqlite.test.ts`; and
       `apps/server/src/binCli.test.ts`, whose "keeps migration warnings out of JSON thread output"
       migrates a database past upstream's head, which the fork refuses (rule 2): its assertions
       expect that refusal (MAIN-104).
     - The deleted-thread sweep on each compaction pass (Parked items):
       `apps/server/src/persistence/DatabaseStorage.ts` calls `sweepDeletedThreads` right after
       upstream's `pruneEventStore` in `compact`, with its case at the end of
       `apps/server/src/persistence/DatabaseStorage.test.ts`. If upstream moves the pass, follow it.
     - `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`: the `T3CODE_OWNS_BOARD` line,
       in the query `env` beside `PortScanner.AGENT_THREAD_ENV`.
     - `/park` in the composer send path: `apps/web/src/composer-logic.ts`,
       `apps/web/src/components/chat/composerSend.logic.ts`,
       `apps/web/src/components/chat/composerSend.logic.test.ts`,
       `apps/web/src/components/chat/composerSlashCommandSearch.ts`,
       `apps/web/src/components/chat/useComposerMenuItems.ts`,
       `apps/web/src/components/chat/useComposerSend.ts` (the park branch before a send reaches
       the provider), and mobile's refusals, `apps/mobile/src/state/use-thread-composer-state.ts`
       (a send's right before upstream's `/side` handling, which 5024 moved below the attachment and
       context checks; a queued message's save right before its `/side` check in
       `saveQueuedRunEdit`), with their case in `apps/mobile/src/state/thread-task-permissions.test.ts`
       (its `queued-run-edit` mock reads `state.queuedEdit`).
     - The right panel's surfaces: `apps/web/src/rightPanelStore.ts`,
       `apps/web/src/rightPanelStore.test.ts`, `apps/web/src/closedViewStore.ts`,
       `apps/web/src/closedViewStore.test.ts`, `apps/web/src/components/RightPanelTabs.tsx`,
       `apps/web/src/components/RightPanelTabs.browser.test.tsx`,
       `apps/web/src/components/chat/RightPanelSurfaceContent.tsx`,
       `apps/web/src/components/chat/useRightPanelActions.ts`, and the palette's Show Tracker,
       parked and Artifacts actions in `apps/web/src/components/CommandPalette.tsx`, no parked one
       in a side chat, a subagent or a workflow step (MAIN-114; its cases and the `activeThread`
       mock in `apps/web/src/components/CommandPalette.browser.test.tsx`, which falls back to the
       hook's own thread: the palette's thread actions test `activeThread !== null`, and upstream's
       mock passes `undefined`). Since 5024 upstream's thread surfaces are `thread` and
       `linked-thread` (7c6e889ddb renamed `side-chat`, and `decodeThreadSurface` still reads a
       saved `side-chat`). The fork's kinds `decisions`, `parked` and `artifacts` sit right after
       `issue` (before `thread`) in `RIGHT_PANEL_KINDS`, the surface union and the tab switches, and
       among the singletons (after `pull-requests`) in `closedViewStore.ts`'s check and
       `rightPanelStore.ts`'s `singletonSurface`.
     - The `decisions.toggle` shortcut: `packages/contracts/src/keybindings.ts`,
       `packages/shared/src/keybindings.ts`, `apps/web/src/components/settings/KeybindingsSettings.logic.ts`,
       and `apps/web/src/keybindings.test.ts`, whose "fills missing number shortcuts…" expects
       `mod+shift+y` unbound upstream and `decisions.toggle` here (MAIN-104 kept the chord).
     - The composer seams below: `apps/web/src/components/chat/ComposerBannerStack.tsx`,
       `apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx`,
       `apps/web/src/components/chat/ChatComposer.tsx`, `apps/web/src/components/ChatView.tsx`,
       `apps/web/src/components/ui/toggle.tsx`, `apps/web/src/components/ui/radio-group.tsx`, and the
       Tracker's colours in `apps/web/src/index.css`.
     - Parked's chip (its note below): `packages/shared/src/composerContextReferences.ts`,
       `packages/shared/src/composerContextReferences.test.ts`,
       `packages/contracts/src/composerContext.test.ts`, `apps/web/src/composerDraftStore.ts`,
       `apps/web/src/composerDraftStore.test.ts`, `apps/web/src/lib/composerContextRecords.ts`,
       `apps/web/src/lib/contextChipAccents.ts`,
       `apps/web/src/components/composerContextPresentation.tsx`,
       `apps/web/src/components/contextPresentationRegistry.ts`,
       `apps/web/src/components/ContextChip.tsx`, `apps/web/src/components/composerInlineTokenPaste.ts`,
       `apps/web/src/components/ComposerPromptEditorTiptap.tsx`,
       `apps/web/src/components/ChatView.logic.ts`, `apps/web/src/components/ChatView.logic.test.ts`,
       `apps/web/src/components/chat/UserMessageContextChips.tsx`,
       `apps/web/src/components/chat/CollapsedComposerPromptPreview.tsx`,
       `apps/web/src/components/chat/chatViewSend.ts`,
       `apps/web/src/components/chat/composerContextUndo.ts`,
       `apps/web/src/components/chat/useComposerStash.ts`,
       `apps/web/src/components/chat/useQueuedRunEdit.ts`,
       `apps/web/src/components/chat/useQueuedRunEdit.browser.test.tsx`, and on mobile
       `apps/mobile/src/lib/composerContextClipboard.ts`,
       `apps/mobile/src/lib/composerContextClipboard.test.ts`,
       `apps/mobile/src/components/ComposerEditor.tsx`,
       `apps/mobile/src/components/ComposerEditor.ios.test.tsx`,
       `apps/mobile/src/components/ComposerContextSheet.tsx`.
     - The background service ("Background service" above): `apps/server/src/cloud/pinnedRuntime.ts`
       and its test seam, `apps/server/src/cloud/selfUpdate.test.ts`.
     - The decision judge's setting (below): `packages/contracts/src/settings.ts`,
       `packages/shared/src/serverSettings.ts`, `packages/shared/src/serverSettings.test.ts`,
       `apps/web/src/components/settings/settingsSearch.ts`,
       `apps/web/src/components/settings/TextGeneratorsSettings.tsx`,
       `apps/web/src/components/settings/SettingsPanels.tsx`.
     - `packages/shared/package.json`: the `./sessionKit/*` subpath exports.
     - App identity ("App identity" above): `packages/contracts/src/ipc.ts` (the `Fork` stage label),
       `apps/desktop/src/app/DesktopEnvironment.ts`, `scripts/build-desktop-artifact.ts`, and their
       tests `apps/desktop/src/app/DesktopEnvironment.test.ts`,
       `apps/desktop/src/app/DesktopAppIdentity.test.ts`,
       `apps/desktop/src/app/DesktopPreReadyPlatform.test.ts`, `scripts/build-desktop-artifact.test.ts`.
     - Mark unread from here (its section above): `packages/contracts/src/orchestrationV2.ts`,
       `apps/server/src/orchestration-v2/Orchestrator.ts`,
       `packages/client-runtime/src/operations/commands.ts`, `apps/web/src/hooks/useThreadActions.ts`,
       `apps/web/src/components/Sidebar.logic.ts`,
       `apps/web/src/components/chat/TimelineAssistantRows.tsx`,
       `apps/web/src/components/chat/MessagesTimeline.tsx`, and `apps/web/src/components/ChatView.tsx`.
     - Tooling: `vite.config.ts` and `knip.jsonc` (rule 4's exemptions; `knip.jsonc` also lists the
       upgrade workflow as an entry of `evals`), and `AGENTS.md` (the pointer to this file).
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
     `apps/web/src/components/chat/ChatComposer.tsx`'s send context, pruning, copy and its detached
     dictation send, `apps/web/src/components/chat/useComposerSend.ts` (with the send context it
     re-reads after an image hold), `ChatView.logic.ts`'s send snapshot, `chatViewSend.ts`,
     `useQueuedRunEdit.ts`, `composerContextUndo.ts`, `composerSend.logic.ts`, `useComposerStash.ts`
     and `composerInlineTokenPaste.ts`, which drop the chip). Most hunks are a `parked` line beside
     its `environment` twin; the rest carry a `Fork (Parked)` comment.
     `chatViewSend.ts` restores a refused send's parked chips through upstream's `withRestored`,
     keyed on `contextId`, as it restores the other kinds. Since 5024 a `/side` command starts its
     side chat with the draft's context (upstream refuses context only while answering a pending
     question); `useComposerSend.ts` still refuses one carrying a parked chip, since the chip marks
     its item sent in the parent thread and Parked stays out of side chats. If
     upstream adds a kind in a new place, add `parked` there too; if upstream reshapes how kinds are
     declared, follow it. Beyond the kind's slots: `ComposerPromptEditorTiptap.tsx` takes a fork prop,
     `restoresParkedChip` (the undo gate), and calls `removesRefusedParkedChips` (which runs the
     fork's `removeParkedChips` from `composer-parked-chips.ts`) at the top of `onSelectionUpdate`
     and of `onUpdate`, before upstream's stale-skill check, whose condition also counts
     `PARKED_CHIPS_REMOVED` as part of the undo; its `insertClipboardText`, which upstream's
     `handlePaste` and (since 5191) `handleDrop` call, strips parked chips before its code-block
     branch, so a dropped chip goes the way a pasted one does. If upstream rewrites any of these hooks, keep each call in the same place;
     "Parked items" (Undo) says why.
     `ChatComposer.tsx` builds that prop from the record it kept on delete (its label cleaned, equal
     to the chip's) and `parkedChipRestorable`, and restores the kept record of every returning chip
     the editor lets through. `ChatView.tsx` calls `useParkedDraft` (`ThreadDecisions.tsx`) and passes
     its
     `actions` to the Tracker and its `chipRestorable` to the composer as `parkedChipRestorable`.
     It also puts `useReopenWithUndo` and `useDismissWithUndo` in the Tracker's actions (`reopen` and
     `dismiss`, so their toasts outlive the panel), and `questionsHeld` (from `threadDecisions`,
     `serverVisibleTurnItems`, `serverProjection`'s messages and runs, and `optimisticUserMessages`;
     "Hidden while a send is judged"), and keys the composer menu's `parkAvailable` and the panel's
     `onAddParked` on `parkOffered`, which is `threadParks` (contracts) of the thread; `threadParks`
     reads `isDelegatedAppThread`, whose parameter `packages/contracts/src/orchestrationV2.ts`
     widens to take the null `delegatedFrom` of client-runtime's `EnvironmentThreadShell`.
     `useComposerSend.ts` passes `parkRefusal` (contracts: why `threadParks` says no, for the
     refusal's words) to `composerParkDecision` (`composerSend.logic.ts`), which refuses `/park` on
     any.
     `apps/web/test/fakeEnvironment.ts` gives a thread `workflowStep` for the step's cases.
     `packages/shared/package.json` exports the fork's `./parkedReferences` beside its `sessionKit`
     entries; web (`useComposerStash.ts`, `composerInlineTokenPaste.ts`, the editor's paste) and mobile
     strip pasted chips through it. On mobile: `composerContextClipboard.ts`'s import and
     `ComposerEditor.tsx`'s plain-text fallback strip parked chips, `ComposerEditor.tsx`'s
     `pasteContext` ignores a paste of parked chips alone, `ComposerContextSheet.tsx` shows one's words
     before its unknown-kind branch, and `apps/mobile/vite.config.ts` lists
     `ComposerContextSheet.test.tsx` among its React tests. `t3_park`'s `kind` in
     `thread/tools.ts` takes `ThreadParkedKindWord`. In tests: `apps/web/test/fakeEnvironment.ts` has
     `answerStreamRpc` (a subscription the test pushes snapshots into) and a thread's `delegateOf`
     (a subagent `delegate_task` started, which has a composer, unlike `providerSubagentOf`),
     `core.test.ts`'s `t3_park` case holds its own refusal (a delegated child) and the server's it passes on (a side chat, a
     placeholder), and reads the stored kind through `parkKind`, and `ChatView.logic.test.ts`,
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
     offered it"). `t3_park` has it since v0.1.11. Since 5024 `t3_park` sits after upstream's
     `t3_submit_output`, which carries the same annotation: a keep-both resolution that puts the
     fork's tool inside the other tool's `.annotate(...)` chain still parses (ASI) and silently
     drops that tool's last annotation. `AgentContextBudget.test.ts` caught it in the 5024 rebase.
   - Fix-ups go in as `git commit --fixup=<fork commit>`, then
     `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash <tag>`, so each fork commit stays whole.
5. **Check:** `node scripts/fork/upstream-sync.ts verify --target <tag>` runs,
   with vp under the validated Node, `vp run check:changed <tag>` (the typecheck, lint, and the
   test files beside the changed files), then every test file the fork adds or changes, then the
   full test suite once (each workspace package's own `test` script, as CI runs them, every one
   even after another fails): upstream's tests of a file the fork modifies sit anywhere, and
   `ci.yml` never runs on a push to `fork/main`. A failed `check:changed` or fork test file fails
   `verify`; a failure "Known noise" lists also fails upstream. The full suite never fails
   `verify`, because many of its tests fail on this Mac without the fork (a root `vp test run`, a
   different set of projects from the package scripts `verify` runs, failed 60 tests in 35 files
   on 2026-11-20). `verify` lists what the full suite leaves to read under "Still owed by a
   person", compared with a baseline recorded at the target: `suiteOwed` in the script says what
   each line means. It compares counts, not names, so an upstream test the rebase replaced
   one-for-one in a test file the fork changes is not listed; its commit shows in the `range-diff`
   list below. Record the baseline right after `plan`, in the background while you rebase (its
   worktree is independent of the rebase), in a worktree of the fork checkout at the tag, under the
   target's Node (step 2):
   ```
   git worktree add --detach /tmp/t3-<n> <tag>
   cd /tmp/t3-<n> && <fork checkout>/node_modules/.bin/vp i &&
     node <fork checkout>/scripts/fork/upstream-sync.ts suite
   ```
   `suite` keeps the baseline at `<git common dir>/upstream-sync/baseline-<commit>.txt`, which every
   worktree of the checkout shares, and `verify` reads the target's from there unless
   `--baseline <file>` names another; while a `suite` still writes it, `verify` refuses and says
   so. Once it is kept, `git worktree remove /tmp/t3-<n>` from the fork checkout.
   What `suite` refuses is `suite` in the script; what `verify` refuses in a baseline, kept or
   given (another commit, a line `suite` does not write), is `baselineAt`. A failure whose message
   names the checkout's path reads as new. What none of these reach (a live run, the build) is steps 6 and 7.
   When `verify` names a fork commit or test file the rebase lost, name each one the rebase meant
   to drop, reword or rename with `--dropped-commit <subject>` or `--dropped <path>`: a
   `git rebase --skip` while resolving a conflict leaves no failing test behind. It then lists, from `git range-diff`, each fork commit
   whose patch the rebase changed, with the files that differ, and each commit the rebase dropped
   or HEAD adds, with its files: read each, since a hunk dropped from a file no test reads
   (`index.css`, `agentContextBudget.json`, `AGENTS.md`), or undone by a commit added while
   resolving a conflict, passes every check. `vp run i18n:check` is expected to fail on fork keys
   only; see "Translation".
6. **Live check:** on a dev server on an isolated home, never `~/.t3`. Reseed it first, since the
   schema moved: `node apps/server/scripts/migrate-dev-db.ts --base-dir "$PWD/.t3"` (reads `~/.t3`
   read-only; its fork tables come along). Then `vp run dev --home-dir "$PWD/.t3"`: outside a
   linked worktree dev otherwise uses `T3CODE_HOME` or `~/.t3/dev`, which every such checkout
   shares and the reseed did not fill (since upstream 4c099280f6 a home of `~/.t3` also lands on
   `~/.t3/dev`, never the live `~/.t3/userdata`).
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
   `scripts/fork/build.sh`: one at a time per checkout, it installs the dependencies (`vp i` with the
   lockfile as committed), moves the old build to the trash, clears any update feed, and stamps
   the version from the upstream tag below HEAD and a build number
   (`v0.1.11-nightly.20261117.4825` becomes `0.1.11-fork.20261117.4825.<n>`, see "Background
   service"). Without the stamp the app reported package.json's older version and
   linked clients called it out of date; a `-nightly.` version would rebrand it "T3 Code (Nightly)".
   It then builds the background service's runtime archive at the same version and smoke-tests it
   (see "Background service").
   The build must not contain `app-update.yml`. `scripts/fork/install.sh` refuses a build without
   T3 Connect or without a `-fork.` version. Known limits of the `-fork.` version, both unused today
   (Fable 5.2 review, 2026-11-17): an SSH environment started from the fork asks for a
   `v0.1.11-fork.…` server release that does not exist (`DesktopSshEnvironment.ts` passes the app
   version as `archiveVersion`); and a linked server whose core version is below the fork's is offered
   an update to `t3@<fork version>`, which fails. If either is needed, map `-fork.` back to the base tag's
   `-nightly.` at those seams. A killed build can leave the stamped version in tracked `package.json`
   files (the build rewrites and restores them); `git checkout` them. Only after every check passes,
   push with the line `rebase` and `verify` print,
   `git push --force-with-lease=refs/heads/fork/main:<sha> origin fork/main`, where `<sha>` is the
   `origin/fork/main` commit rebase checked: a bare `--force-with-lease` compares with whatever a
   background fetch last wrote to `origin/fork/main`, so it can overwrite a push from another machine.

## Installing

`scripts/fork/install.sh` installs `T3 Code (Fork).app` from `release/` beside the official apps and
moves a background service it stopped to that build; its header says when it refuses, what it puts
back after a failure, and what it prints. The first start of a newer build migrates `~/.t3` one way,
so before it installs anything it copies the live `~/.t3/userdata/statev2.sqlite` to
`~/.claude/trash/` (SQLite's online backup, integrity-checked): that copy is the only way back.

**Automatically** (the default, MAIN-106): at the end of `/t3code-fork upgrade` or `ship`, after the
push and the build, the agent runs `scripts/fork/auto-install.sh` and tells the owner T3 will close
and reopen. It returns at once, having handed the work to a one-shot launchd job that waits until no
run is active, quits every T3 Code app, stops the service, and runs install.sh, opening the fork
again itself only when something failed and no T3 Code app runs. Its header says what counts as
active (a workflow run only while code of it runs: `active_runs`), how long it waits, where it
logs and how its last line reads, and why a launchd job rather than `nohup`.
install.sh also copies the daily upgrade workflow into `~/.t3/workflows`.

**The first install names the machine's role** (the owner's Q77; "The daily upgrade workflow",
Roles): `scripts/fork/auto-install.sh --role upgrader` on the personal Mac, `--role installer` on
every other machine (the work Mac). It passes the flag to install.sh, which records it; later
installs, the workflow's own included, keep it. An install that names none where none is recorded
installs the app but not the workflow (a copy from before roles goes to the trash), and says so;
auto-install.sh's last line says so too.

An installer builds in its own checkout, so it first needs what `build.sh` needs: `~/repos/t3code`
on a clean `fork/main` with `origin` and `upstream` remotes, its dependencies installed once
(`vp i`), the repo's `.env`, and Rust (`cargo`) with the `aarch64-apple-darwin` target, for the
resource monitor the desktop build compiles (`scripts/build-desktop-artifact.ts`). The workflow's
build runs in the T3 server's environment, which under the background service is its launch
agent's: after the first install, check that `plutil -extract EnvironmentVariables.PATH raw
~/Library/LaunchAgents/com.t3tools.t3code.service.plist` finds `mise`, `jq` and `cargo`.

Whether macOS asks before osascript, run by the job, may quit an app (Automation consent) is
_unverified_; a refusal ends the run with `FAILED` and nothing installed.

**By hand** (the fallback):

1. Quit every T3 Code app, then run install.sh from a terminal T3 did not start.
2. The first time only: turn Local environment off in Settings → Environments, then run the
   command install.sh's last lines name (`~/.t3/runtime/versions/<version>/t3 service install`).
3. Pair the app with `http://127.0.0.1:3773` (the first time only).
4. Read the doctor's "T3 Code" step install.sh printed (or run `./doctor.sh` in the dotfiles repo).

If the app will not open after a first service install: `~/.t3/runtime/versions/<version>/t3 service
uninstall`, then reopen it.

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
  the thread's open right panel" times out when the whole file runs on this Mac, and passes alone.
  It fails the same on the plain `v0.1.11-nightly.20261117.4825` and `v0.1.11-nightly.20261118.4864`
  tags, on `fork/main` at 7c371b246e (5024), and on the plain `v0.1.12-nightly.20261121.5038`,
  `v0.1.12-nightly.20261123.5124`, `…5191`, `v0.1.12-nightly.20261124.5209` and
  `v0.1.13-nightly.20261125.5258` tags.
- `npm:vite-plus` run through mise fails Effect tests ("Vitest failed to find the current suite"), and
  mise's `vp` shim now has no version set at all ("No version is set for shim: vp"); use the repo's
  `node_modules/.bin/vp`, which upstream-sync puts on its children's PATH.
- `apps/server/src/cloud/pinnedRuntime.test.ts` "removes a runtime only its own entry names when its
  real directory in a symlinked home …" fails on this Mac on the plain
  `v0.1.12-nightly.20261121.5024`, `…5038`, `…5124`, `…5191`, `v0.1.12-nightly.20261124.5209` and
  `v0.1.13-nightly.20261125.5258` tags too (it returns
  no removed runtime), so `check:changed` fails on it whenever the fork changes `pinnedRuntime.ts`.
- `apps/server/src/environmentTheme.test.ts` "publishes themes when a linked theme directory's
  original grandparent is restored between probes" fails on this Mac on the plain
  `v0.1.12-nightly.20261124.5191`, `v0.1.12-nightly.20261124.5209` and
  `v0.1.13-nightly.20261125.5258` tags; "publishes later edits after a linked theme directory's
  grandparent is restored" fails beside it on `…5191` and `…5209`.
- Run tests by hand from a shell T3 Code started (an agent's terminal) with
  `env -u T3CODE_PORT -u T3CODE_HOST`: with the service's values inherited, every web browser test
  that renders `AppRoot` over the fake environment hangs to its 15 s timeout (checked on the plain
  `v0.1.12-nightly.20261121.5024` tag, 2026-11-20). `upstream-sync.ts` clears them for its children.
