// Verbatim copy of ~/repos/dotfiles/.claude/mods/session-kit/hooks/reply.ts at dotfiles 43cd5328, the version
// in dotfiles PR #600; it matches dotfiles main once #600 merges.
// Fork-only: refresh by copying the source again below the marker; reply.drift.test.ts compares them.
// Fork logic built on it lives in ./decisions.ts, never in this file.
// ---- verbatim copy below ----
// The board's capture rules, kept free of `$` so the tests run them alone.

// A decision line as the user's global rule writes one: `Q1`, `- **Q2 …`, at a line's start. A numbered
// list marker (`1. Q1`) is a model's drift from the rule, read the same.
// The label must end at a separator, so "Q2's wording" is prose.
export const Q_LINE = /^\s*(?:[-*]\s+|\d+\.\s+)?(?:\*\*)?(Q\d+)(?=\**[\s:,.)\u2014\u2013-]|$)/
const LIST_MARKER = /^\s*(?:[-*]|\d+\.)\s+/
// The rule's other end-of-reply block, which may follow the decisions: a heading, or its first line.
export const DECIDED_HEADING = /^\s*(?:#+\s*)?\**Decided without asking\b/i
// A heading that introduces Q-lines: a short line ending in a colon ("Still open:", "**Board and tools:**").
// Ceiling: a short prose line ending in one ("Done this turn:") reads the same; the model's reading, which the
// patterns only stand in for, tells them apart.
const BLOCK_HEADING = /^\s*(?:#+\s*)?\**[^:*\n]{1,40}\**:\**\s*$/
// A status line that names labels rather than asking one: "Q6, Q7 and Q8 are still open.", "Q4 (the 19 rows), Q6
// (x) and Q8 (y) are still open.", its first label's own parenthesis allowed. A shaped question ("Q9, key words:")
// has words, not a second label, after its first comma. Ceiling: key words that start with a label ("Q9, Q10 names:")
// read as a status line, and that question is not asked.
const LISTS_LABELS = /^Q\d+\**(?:\s*\([^)]*\))?[\s,]+(?:and\s+)?Q\d+\b/i

export type Asked = { label: string; text: string }

// The questions a reply asks: its trailing block of Q-labelled lines, since the rule puts decisions "in one
// block at the end" and mentions an earlier question only inside a sentence, so a line that starts with a
// label asks it, in a "Still open:" re-listing too. The walk up from the end passes a heading
// right above Q-lines and goes on collecting the Q-lines above it; other prose ends it, so a Q-line mid-reply
// ("Q2 above is moot") is not a question. An indented line under a Q-line continues it; blank lines inside
// the block (a loose list) are skipped. A "Decided without asking" section after the block is cut off first.
export const trailingQuestions = (answer: string): Asked[] => {
  const lines = withoutDecidedSection(answer.replace(/\s+$/, '').split('\n'))
  const asked: Asked[] = []
  let tail: string[] = []
  let underQLine = false // the nearest non-blank line below is a Q-line
  let pastHeading = false // a heading of Q-lines lies below: a "Still open:" re-listing may repeat the block's labels
  for (const line of [...lines].reverse()) {
    const label = Q_LINE.exec(line)?.[1]
    if (label !== undefined) {
      // a label the block already asks: the line is about that question (a list above the block explaining
      // each, as the transcript mod's questions.ts reads it), so the block starts below it. Not past a heading:
      // there the repeat is the block above a "Still open:" re-listing, whose questions are still asked
      if (!pastHeading && asked.some(q => q.label === label)) break
      asked.unshift({ label, text: [line.replace(LIST_MARKER, ''), ...tail].join(' ').replace(/\s+/g, ' ').trim() })
      tail = []
      underQLine = true
    } else if (/^\s+\S/.test(line)) {
      tail.unshift(line.trim()) // kept only if a Q-line above claims it
      underQLine = false
    } else if (underQLine && BLOCK_HEADING.test(line) && !DECIDED_HEADING.test(line)) {
      // the heading of the Q-lines below it; not "Decided without asking:", whose lines are choices made
      underQLine = false
      pastHeading = true
    } else if (line.trim() !== '') {
      break
    }
  }
  // Filtered after the walk, not a break inside it, so Q-lines above a status line are still collected. Ceiling:
  // the walk still reads the status line's first label, so one the block above asks again ends the walk there
  // ("Q4, x: …\n\nQ4 (x) and Q6 are still open." asks nothing).
  return asked.filter(q => !LISTS_LABELS.test(q.text.replace(/\*\*/g, '')))
}

// The lines before the last "Decided without asking" heading, when no Q-line follows it.
const withoutDecidedSection = (lines: string[]): string[] => {
  const at = lines.findLastIndex(line => DECIDED_HEADING.test(line))
  return at === -1 || lines.slice(at).some(line => Q_LINE.test(line)) ? lines : lines.slice(0, at)
}

// What the person's reply does to the open questions. A label answers that question, or drops it when
// its own stretch of text says "not a decision" ("Q1 and Q2: not a decision" answers Q1 and drops Q2: a
// stretch runs to the next label, and a range's labels share one). "Go with your picks" answers every
// question of the newest asking reply that no label settled; with labels present only the plural does, so "Q2: go with your pick" stays Q2's.
// "Not a decision" with no label drops them all. Anything else leaves every question open, which is the
// point of the board. A clause that turns the picks down or asks about them ("don't go with your picks",
// "why go with the picks?") accepts nothing. Ceilings: a label in passing ("the Q1 numbers are in",
// "your picks except Q2", and in any case `lib/q1.sh` or a quarter's "q2") answers it; a typo ("G wit hall your picks") or "use your picks sparingly" is
// misread; the Questions tab's buttons put either right.
// Key words answer nothing here (session-board/DOT-152): the patterns read labels and the picks phrases, never key
// words. Key words answer only through the judge, which reads them in their meaning and holds a question from an
// earlier reply to every one of them appearing in the message (judge.ts scopeVerdict); a word match here would
// close a question on a passing mention.
export type Reply = { answer: string[]; drop: string[]; turn: 'answer' | 'drop' | null }

// In any case: the person types "yes to q68 and q69" more often than "Q68" (12 of the 19 labelled answers in
// this repo's transcript to 2026-10-20, 12 of the 21 messages naming a label), and the case-sensitive read left
// every one of them open. A range ("Q7 to Q10", "Q7-Q10", "Q7–Q10", "Q7—Q10", "Q7 through q10") names every label
// from one end to the other: "Yes to Q7 to q10" left Q8 and Q9 open (2026-10-20, session-board/DOT-204). Its second
// label keeps its Q, so a quarter-year ("Q3-2026", "Q4-23") is no range. Every range in this machine's transcripts
// before DOT-204 kept it: 5 of 5 in user rows, 104 of 104 in the assistant's text (the rows of every .jsonl under
// ~/.claude/projects stamped before 2026-10-20T19:16Z, scratchpad projects, meta rows and subagents' prompts left
// out, a command's arguments read; matched by /\bQ\d+\s*(-|–|—|to|through|thru)\s*Q?\d+\b/i, a passage seen in several
// rows counted once). A reversed range, or one of more than RANGE_MAX labels ("Q1 to Q999"), names only its
// ends. Ceilings: a range of quarters ("Q1–Q4 2026") names Q2 and Q3 as well, as a quarter's "q2" names Q2; "from Q2
// to Q5" in passing names Q3 and Q4 too; a range broken across lines ("Q7 -" ending one, "Q10" starting the next) is
// still one; a path or URL ("lib/Q7-Q10.sh") names the whole range, as `lib/q1.sh` names Q1.
const LABEL = /\bQ(\d+)(?:\s*(?:[-\u2013\u2014]|\bto\b|\bthrough\b)\s*Q(\d+))?\b/gi
const RANGE_MAX = 20
export type Mention = { labels: string[]; index: number }

// Each label or range a text names, in order, with where it starts: the stretches of readReply, and judge.ts
// scopeVerdict's reading of the message and of the last reply.
export const labelMentions = (text: string): Mention[] => [...text.matchAll(LABEL)].map(m => {
  const [from, to] = [Number(m[1]), Number(m[2] ?? m[1])]
  const span = to - from + 1
  const labels = span >= 1 && span <= RANGE_MAX ? Array.from({ length: span }, (_, n) => `Q${from + n}`) : [`Q${from}`, `Q${to}`]
  return { labels, index: m.index }
})

// The person's phrasing, within one clause: "go with / go for … picks", "take / use / follow your picks", or
// a clause that is only "(yes|ok|…) (to) (all) your picks": "Yes to all your picks" is their commonest answer.
const picksSaid = (plural: string): RegExp => new RegExp(String.raw`\bgo(?:ing)?\s+(?:with|for)\b[^.\n]*\b(?:your|the|all)\s+pick${plural}\b`
  + String.raw`|\b(?:take|use|follow)\s+(?:all\s+)?(?:your|the)\s+pick${plural}\b`
  + String.raw`|^\W*(?:(?:yes|ok|okay|sure|fine|agreed|alright)\W+)?(?:to\s+)?(?:all\s+)?your\s+pick${plural}\W*$`, 'i')
const PICKS_ANY = picksSaid('s?')
const PICKS_PLURAL = picksSaid('s')
const REFUSAL = /\b(?:don'?t|do not|not|never|won'?t|wrong|disagree|reject\w*|instead)\b|\?\s*$/i
const NOT_A_DECISION = /\bnot a decision\b/i

// A prompt's clauses: sentences (each keeps its mark, so a question shows), then commas and "but".
const clauses = (prompt: string): string[] => prompt.split(/(?<=[.!?;\n])|,|\bbut\b/i)

export const readReply = (prompt: string): Reply => {
  const hits = labelMentions(prompt)
  const answer: string[] = []
  const drop: string[] = []
  hits.forEach((m, n) => {
    const stretch = prompt.slice(m.index, hits[n + 1]?.index ?? prompt.length)
    const into = NOT_A_DECISION.test(stretch) ? drop : answer
    for (const label of m.labels) if (!answer.includes(label) && !drop.includes(label)) into.push(label)
  })
  const picks = hits.length === 0 ? PICKS_ANY : PICKS_PLURAL
  const accepted = clauses(prompt).some(c => picks.test(c) && !REFUSAL.test(c))
  const turn = accepted ? 'answer' : hits.length === 0 && NOT_A_DECISION.test(prompt) ? 'drop' : null
  return { answer, drop, turn }
}

// An open question as the closing rule reads it; board.py's question row carries these and more. `at` is UTC ISO,
// which sorts as text.
export type OpenRow = { label: string; turn: string; at: string }

// The reply that asked last: the turn of the open question asked most recently. Not the last row: a question
// asked again is updated in place (board.py ask), so an old row can carry the newest turn. A tie keeps the later row.
export const lastTurn = (open: readonly OpenRow[]): string | undefined =>
  open.reduce<OpenRow | undefined>((best, q) => (best === undefined || q.at >= best.at ? q : best), undefined)?.turn

// The open rows a person's reply settles. A label names the newest open row carrying it (the last in file order);
// "your picks", or a bare "not a decision", settles the rest of the newest asking turn. Drops go first, so "go with
// your picks, but Q3 is not a decision" drops Q3 and answers the rest. `answered` and `dropped` hold the labelled
// rows then the swept ones; `swept` names the swept ones apart, which the CLI closes by turn (board-file.ts closes).
export type Settled<T extends OpenRow> = { answered: T[]; dropped: T[]; swept: T[] }
export const settles = <T extends OpenRow>(open: readonly T[], reply: Reply): Settled<T> => {
  const named = (labels: string[]) => labels.flatMap(label => open.filter(q => q.label === label).slice(-1))
  const drop = named(reply.drop)
  const answer = named(reply.answer)
  const settled = new Set([...drop, ...answer])
  const turn = lastTurn(open)
  const swept = reply.turn === null || turn === undefined ? [] : open.filter(q => q.turn === turn && !settled.has(q))
  return {
    answered: [...answer, ...(reply.turn === 'answer' ? swept : [])],
    dropped: [...drop, ...(reply.turn === 'drop' ? swept : [])],
    swept,
  }
}

// The prompt the Questions tab's [ask] fills. Sending it brings a question back; it answers nothing.
export const ASK_PREFIX = 'Back to '
export const isAskBack = (prompt: string): boolean => prompt.startsWith(ASK_PREFIX)

// URLs in text, markdown's `[x](url)` included. Trailing punctuation and `**bold**` marks come off here
// so one link is not two; the CLI trims the same and drops noise. Ceiling: a URL with parentheses in it
// (a Wikipedia title) is cut at the first one, the price of reading `[x](url)`.
const URL = /https?:\/\/[^\s<>()[\]"'`]+/g
export const urlsIn = (text: string): string[] => [...new Set((text.match(URL) ?? []).map(u => u.replace(/[.,;:!?*]+$/, '')))]

// The Bash calls whose output links are worth keeping: GitHub's CLI and pushes.
export const isLinkCommand = (command: string): boolean => /(?:^|[\s;&|(])(?:gh\s|git\s+push\b)/.test(command)

// A Bash call that makes a pull request: `gh pr create`, at a command position (as isLinkCommand reads `gh`),
// with `-R owner/repo` or any flags after it. Its output names the PR it made by its URL, on a line of its own
// (every create in this machine's transcripts to 2026-10-28, 14 of them: alone, or followed by gh's `#17 OPEN · 1
// commit · 9 files` summary, or among a chain's other lines), which is how the board learns this session, or a
// subagent of it, created it (session-board/DOT-296). Ceilings: a PR made another way (the GitHub MCP, a push and
// the web page) is a link at most, never a created PR; a chain that also prints another PR's URL (`gh pr create
// … && gh pr view 5`) marks that one created too; the words unquoted in an echo (`echo gh pr create`) match as
// isLinkCommand's `gh` does, and mark a PR only where the output prints a PR url, which an echo of them does not.
export const isPrCreate = (command: string): boolean => /(?:^|[\s;&|(])gh\s+pr\s+create\b/.test(command)

// The pull-request URLs in text, each once: `gh pr create` prints the PR's; a push's `pull/new/<branch>` is no PR
// (the number is what board.py's link_kind reads too).
const PR_URL = /https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/g
export const prUrlsIn = (text: string): string[] => [...new Set(text.match(PR_URL) ?? [])]

// A Bash call that may change a pull request's state or branches: any `gh pr <verb>` but the ones that only read
// (view, list, status, diff, checks, checkout) and create, which the capture handles. After one, the PR facts the
// board keeps are read again at once rather than at the next poll (`gh pr merge` here would otherwise leave the
// PR on the tab for up to PR_STALE_MS).
export const isPrChange = (command: string): boolean =>
  /(?:^|[\s;&|(])gh\s+pr\s+(?!(?:create|view|list|status|diff|checks|checkout)\b)[a-z-]+/.test(command)

// A Bash call that sends work out of the session, the adoption nudge's trigger (relay redesign v3, S8): a `git push`,
// a `gh pr create`, or a deploy, which is `deploy` run by a deploy CLI or a package manager's script runner (`pnpm
// deploy` is pnpm's own workspace copy and `npm deploy` no command, so those two need `run`). Heredoc bodies, quoted
// text and `#` comments are blanked first, so a search for the words (`pgrep -f 'cdk diff|cdk deploy'`) or a doc a
// heredoc writes ships nothing. Ceilings: a deploy by any other command (a project's own CLI, a script named
// otherwise) is not seen, the push or the PR around it usually is; the words as bare arguments (`echo git push`) are.
const DEPLOY = /(?:^|[\s;&|(])(?:cdk|vercel|flyctl|fly|wrangler|firebase|netlify|serverless|sls|(?:pnpm|npm)\s+run|(?:yarn|bun)(?:\s+run)?)\s+deploy\b/
export const shipsWork = (command: string): boolean => {
  const unquoted = command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g, '<<')
    .replace(/"[^"]*"|'[^']*'/g, '""')
    .replace(/(^|\s)#[^\n]*/g, '$1')
  return /(?:^|[\s;&|(])git\s+push\b/.test(unquoted) || isPrCreate(unquoted) || DEPLOY.test(unquoted)
}

// The canvas an Artifact call made or filled, by its URL, so the Links tab says `canvas`: a canvas's
// URL reads as any artifact's. Made: a create from a type (`type_url`) whose result carries the type's
// instructions, which for the Design type name project/canvas.json; its URL is in the result's first words
// ("Created a new Artifact at <url> (version …) from the Artifact type …": all 10 creates in this machine's
// transcripts on 2026-10-15, every one from the Design type). Filled: a publish to its `url` that sends
// project/canvas.json, as its `file_path` or in its `files`; 68 of the 129 publishes to those canvases did, and
// none of the 102 to other artifacts. Ceiling: a create worded otherwise stays `artifact` until such a publish.
const CANVAS_FILE = 'project/canvas.json'

// A publish's `files` as published paths: the tool takes a map keyed by them or a list of `{ path }`.
const publishedPaths = (files: unknown): unknown[] =>
  Array.isArray(files) ? files.map((f: unknown) => (typeof f === 'object' && f !== null && 'path' in f ? f.path : f))
    : typeof files === 'object' && files !== null ? Object.keys(files) : []

export const canvasUrl = (call: { type_url?: string; url?: string; file_path?: string; files?: unknown }, result: string | undefined): string | undefined => {
  if (call.type_url !== undefined) return result?.includes(CANVAS_FILE) ? /\bCreated a new Artifact at (https:\/\/\S+)/.exec(result)?.[1] : undefined
  // a typed artifact's `file_path` is published at its path under `root`, so it ends as that path does
  const sends = `/${call.file_path ?? ''}`.endsWith(`/${CANVAS_FILE}`) || publishedPaths(call.files).includes(CANVAS_FILE)
  return sends ? call.url : undefined
}

// The Bash calls that can change the joined baton's decisions.
export const isRelayCommand = (command: string): boolean => /(?:^|[\s;&|/('"`])relay\s/.test(command)

// `/board task …`: the vault task this session works on (`board task`), read before readParks, which would park
// "task lc01aa" as a todo. Alone it reports the task, `--clear` clears it, anything else sets it (the CLI
// refuses an id with whitespace). Ceiling: a todo whose text starts with the word "task" needs `/board todo task …`.
export type TaskCommand = { verb: 'show' } | { verb: 'clear' } | { verb: 'set'; id: string } | null
export const readTask = (args: string): TaskCommand => {
  const m = /^\s*task(?:\s+([\s\S]*))?$/i.exec(args)
  if (m === null) return null
  const rest = (m[1] ?? '').trim()
  return rest === '' ? { verb: 'show' } : rest.toLowerCase() === '--clear' ? { verb: 'clear' } : { verb: 'set', id: rest }
}

// `/board close`: the board's panes, all at once (session-board/DOT-173), read before readParks as `task` is. The bare
// word only, in any case as `task` is: `close the door` and `closed` are todos, as any text is, and `/board todo
// close` parks the word itself.
export const isClose = (args: string): boolean => /^\s*close\s*$/i.test(args)

// `/board edit <id> <text>`: a parked item's words replaced in place (`board edit`, session-board/DOT-203), read
// before readParks as `task` and `close` are. The word, in any case as they are, then a number: the rest is the
// text, one item whatever its lines, since they are the item's own words and not a list to split; none is an
// edit the CLI refuses as empty, not a park of "edit 3". Ceiling: a todo that starts with "edit" and a number
// ("edit 3 files") needs `/board todo edit 3 files`; "edit" alone, or before a word, parks as any text does.
export type EditCommand = { id: number; text: string } | null
export const readEdit = (args: string): EditCommand => {
  const m = /^\s*edit\s+(\d+)(?:\s+([\s\S]*))?$/i.exec(args)
  return m === null ? null : { id: Number(m[1]), text: (m[2] ?? '').trim() }
}

// `/board`'s arguments as the items they park, not one per line: the person's own two-line park was one
// thought, and a pasted list still parks as separate items when its lines are marked. The first line
// starts an item, and so does each line that begins with a list marker (`-`, `*`, `•`, `1.`, `1)`, taken off the
// text) or a kind word; any other line, a blank one included, continues the item above, newline-joined, so an
// unmarked list is one item. A kind word is lowercase, or in any case before a colon ("Later:"): a capital that
// starts a sentence ("Todo sessions and bar", parked 2026-10-16) is the text's. A comma may follow a lowercase one,
// and a marker may come before it ("- later fix x"). An item that names no kind takes the first line's kind word,
// which carries to every item after it, or the kind of the last line above it that is only a kind word, else todo.
// Such a heading line starts an item that the plain lines right under it fill, so alone it parks nothing. A
// `prompt` keeps the rest of the text whole, its lines included. None parks nothing: `/board` and `/board later`
// open the board. Ceilings: a line opening with a lowercase kind word in prose ("later we could…") starts an item
// of that kind; a number ending a sentence at a line's start ("2026. was…") reads as a marker; a nested bullet is
// an item of its own.
const KINDS = ['todo', 'prompt', 'later'] as const
export type Kind = typeof KINDS[number]
export type Park = { kind: Kind; text: string }
const MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/
const KIND_WORD = /^([a-z]+)(?:(:)|(?=[\s,]|$))[:,\s]*(.*)$/i

// A line's kind word and what follows it, when the line starts with one (its marker already off).
const kindOf = (line: string): { kind: Kind; rest: string } | undefined => {
  const m = KIND_WORD.exec(line.trimStart())
  const kind = KINDS.find(k => k === m?.[1]?.toLowerCase())
  return m === null || kind === undefined || (m[1] !== kind && m[2] === undefined) ? undefined : { kind, rest: (m[3] ?? '').trim() }
}

export const readParks = (args: string): Park[] => {
  const lines = args.split(/\r?\n/)
  const items: { kind: Kind; lines: string[] }[] = []
  let fallback: Kind = 'todo'
  for (const [n, line] of lines.entries()) {
    const marker = MARKER.exec(line)?.[0] ?? ''
    const body = line.slice(marker.length)
    const named = kindOf(body)
    const current = items.at(-1)
    if (current !== undefined && marker === '' && named === undefined) {
      current.lines.push(line.trimEnd())
      continue
    }
    if (current === undefined && line.trim() === '') continue
    if (named?.kind === 'prompt') {
      items.push({ kind: 'prompt', lines: [named.rest, ...lines.slice(n + 1)] })
      break
    }
    if (named !== undefined && (current === undefined || named.rest === '')) fallback = named.kind
    items.push({ kind: named?.kind ?? fallback, lines: [named?.rest ?? body] })
  }
  return items.map(i => ({ kind: i.kind, text: i.lines.join('\n').trim() })).filter(p => p.text !== '')
}

// Text the park tool refuses (session-board/DOT-151): nothing to park, or a placeholder. Worktree subagents parked empty
// "placeholder" todos on the person's board as filler while they waited. Small on purpose: no word with a letter or a
// digit in it ("…", "---", ""), or only placeholder words ("placeholder", "TODO", "tbd."). Not a word count: a short
// item is often real ("review micro-compaction"). Ceiling: a placeholder said in other words ("waiting on the build")
// passes, and a real item made only of these words ("todo: test") is refused; refusing a subagent's call (register.tsx)
// is the main guard.
const PLACEHOLDER_WORDS = new Set(['placeholder', 'todo', 'tbd', 'tba', 'fixme', 'wip', 'filler', 'xxx', 'n/a', 'test'])
export const isPlaceholder = (text: string): boolean => {
  const words = text.toLowerCase().split(/\s+/).map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(w => w !== '')
  return words.every(w => PLACEHOLDER_WORDS.has(w))
}

// What `board ask` said on stderr (board.py cmd_ask, settle_label), as toast lines: every notice, since one
// asking can close several older rows of its label or clash with several. A row closed as asked again, and a
// settled one an asking did not reopen, name the way back.
const NOTICE = /^board: notice: (?:clash: (Q\d+) is already open as "(.*)"|reasked: (Q\d+) #(\d+) "(.*)" -> #(\d+)|settled: (Q\d+) #(\d+) "(.*)" was (\w+); not reopened)$/gm
export const askNotices = (stderr: string): string[] => [...stderr.matchAll(NOTICE)].map(m => (m[1] !== undefined
  ? `${m[1]} asked again while an older ${m[1]} (${m[2]}) is still open; answer by key words, or drop one`
  : m[3] !== undefined
    ? `closed ${m[3]} #${m[4]} (${m[5]}) as asked again in #${m[6]}; \`board reopen ${m[4]}\` puts it back`
    : `${m[7]} #${m[8]} (${m[9]}) was ${m[10]}, so listing it again did not reopen it; \`board reopen ${m[8]}\` puts it back`))

// A flag's value in one command, `--flag v` or `--flag=v`, quoted or not: the last one, as argparse keeps it.
// Ceiling: argparse also takes an abbreviated flag (`--lab Relayed`), which this does not read; nothing writes one.
const flagValue = (command: string, flag: string): string | undefined =>
  [...command.matchAll(new RegExp(String.raw`--${flag}(?:=|\s+)['"]?(\w+)`, 'g'))].at(-1)?.[1]

// `relay decide … --from Q<n>` (or `--from=Q<n>`) answers that question too, every one of them in a command
// that records several (`relay decide … && relay decide …`, or one per line): reading only the first left the
// others open on the board, where a later "your picks" swept them up. Quoted text is blanked first so a
// `--from Q1` inside `--why "…"` is not read, unless the quotes hold only a Q label, `Relayed` or an `Agent`
// label (`"Agent: claude"`: the word alone, or the word, a colon and one name; `--why "Agent: as --from Q9
// said"` is prose and is blanked); a backslash-newline
// continues a line, a newline ends a command as `;` does. A label recorded twice is answered once: a second
// `board answer Q1` would close an older open Q1 too. A `--label Relayed` decision answers nothing:
// it records another session's account of the person's answer, context until the person confirms it here.
const decides = (command: string): Array<{ from: string | undefined; label: string | undefined }> => {
  const unquoted = command.replace(/\\\n/g, ' ').replace(/"[^"]*"|'[^']*'/g, m => (/^["'](?:Q\d+|Relayed|Agent(?::\s*[^\s"']+)?)["']$/.test(m) ? m : '""'))
  return [...unquoted.matchAll(/(?:^|[\s;&|/(`])relay\s+decide\b[^;&|\n]*/g)]
    .map(m => ({ from: /^Q\d+/.exec(flagValue(m[0], 'from') ?? '')?.[0], label: flagValue(m[0], 'label') }))
}
export const decidedFrom = (command: string): string[] =>
  [...new Set(decides(command).flatMap(d => (d.label === 'Relayed' || d.from === undefined ? [] : [d.from])))]

// The labels an `--label Agent` decision answers (the default label, and User, are the person's): the agent's
// own close, which the judge log keeps apart from the person's corrections (session-board/DOT-201).
export const agentDecidedFrom = (command: string): string[] =>
  [...new Set(decides(command).flatMap(d => (d.label === 'Agent' && d.from !== undefined ? [d.from] : [])))]
