// Verbatim copy of ~/repos/dotfiles/.claude/mods/session-kit/hooks/judge.ts at dotfiles main d43460a7 (blob 21b2a6c0).
// Fork-only: refresh by copying the source again below the marker; drift.test.ts compares them.
// Its imports resolve to fork shims: ./board-file.ts and ../types/index.d.ts. Fork logic built on it lives in
// ./decisions.ts, never in this file.
// ---- verbatim copy below ----
// The model's two judgements: which questions an agent's reply asks, and which of the open questions the
// person's message answers or drops. English patterns misread both: a closing line that referred back to Q4
// became a second open Q4, and a reminder after the question block hid the Q7 above it (2026-10-14). A model
// read 22 or 23 of 25 sample messages right. Kept free of `$`: the prompts and the parsing are tested alone.
// The calls, and why the model is Sonnet, are in register.tsx.

import type { Question } from '../types/index.d.ts'
import { lastTurn } from './board-file.ts'
import { labelMentions } from './reply.ts'

// The judge's prompt is the one measured on those 25 messages; its rules on a numbered item and on an asked
// opinion came later, from two misses, and are unmeasured. A refusal rule (a rejection that asks for other
// options, or a put-off, answers nothing) was measured on 368 real and 120 written messages, 3 runs each
// (2026-10-20, session-board/DOT-199): it kept "no to all of those, come back with alternatives" open in every
// run, but closed a real statement wrongly in a run this prompt read right (w314) and read written statements
// of fact ("Legal needs 30 days of logs") as refusals (115 of 120 against 116, two runs of three), so it is
// not here. The finder's prompt was measured with it, and has been rewritten since (below).
export const JUDGE_SYSTEM = `You judge whether a person's chat message answers decision questions an assistant asked them earlier.

You are given the open questions (each with a label such as Q4, a few key words, the question and the assistant's pick), the assistant's last reply when it is known, then the person's message.

Each open question is marked as asked in the last asking reply (the newest reply that asked any), or asked earlier and still open.

A question is ANSWERED when the message settles it:
- it names the question's label or its key words together with a choice (yes, no, agreed, or a different pick), or
- it accepts the picks as a whole ("go with your picks", "yes to all your picks", "agreed on all"): that answers the questions asked in the last asking reply, never one asked earlier, which only its label or key words answer, or
- it chooses an item of a numbered list in the assistant's last reply by the item's number ("5. Let's do that", "go with 2"): that answers the question the item is about, or
- it is a bare assent ("yes", "ok", "agreed") and the assistant's last reply ended with the question block, so there is nothing else to assent to; it answers that block's questions. If that reply ended with a proposal or a question that is not Q-labelled, the assent is for that and answers nothing here.

A question is DROPPED when the message says it is "not a decision" or should not have been asked, for that question or for all of them.

Nothing is answered or dropped when the message: refuses the picks without choosing ("don't go with your picks", "let me think"); asks about a question; asks the assistant for its view or opinion on a question ("What do you think?"), even beside an option of its own, which leaves that question open; defers them ("I'll read the questions later"); is a numbered list of the person's own (steps or tasks, not a choice among the assistant's items); mentions a label in passing while talking about something else; names a label that is not among the open questions; or is about something else.

Output only JSON of the shape {"answered":["Q4"],"dropped":[]}, labels taken from the open questions. No prose.`

// A line that opens with a label asks its question wherever it stands: the person's rule mentions
// an earlier question only inside a sentence, so a "Still open:" list of labelled lines is the question asked
// again, and a blanket "yes to all" to that reply must reach it (2026-10-17, Q78/Q67/Q65/Q70 stayed open).
// Replies also lead with the key words in bold ("- **Multi-line /board, Q65:**"), so that opens a line too.
// The key words are taken as the line gives them, since the person answers by those. Measured over 12 replies,
// 3 runs each, against the prompt before it: this one gave what each reply asks in every run, where the old
// one missed the labels under every "Still open:" list.
export const FIND_SYSTEM = `You read one reply an assistant wrote to a person. The assistant's rule: decisions it needs from the person go in one block at the end of the reply, one line each, labelled Q1, Q2, ... (the question, its pick, its reason); an earlier question is mentioned only inside a sentence, never by starting a line with its label.

List the decision questions this reply ASKS: every line that starts with a label and states a decision still waiting on the person, wherever it stands. That is each line of the block at the end, and as much a line under a heading such as "Still open", or one an earlier reply asked first. The label starts the line after any bullet or bold ("- **Q6, gate fix:** ..."), or right after the key words in a bold lead-in ("- **Gate fix, Q6:** ..."). A label inside a sentence ("Q4 is still open", "as Q4 decided") asks nothing, and neither does a line reporting a question settled (answered, decided, recorded, dropped). Each line gives its key words after the label ("Q6, gate fix: ...") or, in a bold lead-in, before it ("**Gate fix, Q6:**"): use those words exactly. A line with none ("Q6: ...") gets two or three of your own, never the label. Output only JSON: [{"label":"Q6","keywords":"gate fix","text":"the question as one sentence"}], or [] when the reply asks none. No prose.`

// What the judge is given: the open questions, each marked by whether the last asking reply asked it, the
// assistant's last reply when known, and the message. Without the reply a bare "yes" cannot be told from an
// assent to something else, and "5. Let's do that" names an item of a list the reply may hold far above its
// Q block: cut to its last 1500 characters, the judge missed one (Q38, 2026-10-15), and 88 of the 162 Q-asking
// replies in this repo's transcripts that day were longer than that. 12000 holds the longest of them (5420)
// twice over and bounds a runaway one; past it the reply's start goes, as the block is at its end.
const REPLY_CHARS = 12_000

// A reply's last `n` characters, never starting on the second half of a surrogate pair (an emoji cut in two).
const tail = (s: string, n: number): string => {
  const t = s.slice(-n)
  return /^[\udc00-\udfff]/.test(t) ? t.slice(1) : t
}

const REPLY_OPEN = "\n\nThe assistant's last reply:\n<<<\n"
const MESSAGE_OPEN = "\n\nPerson's message:\n<<<\n"
const BLOCK_CLOSE = '\n>>>'

export const judgePrompt = (open: readonly Question[], reply: string | undefined, message: string): string => {
  const last = lastTurn(open)
  const questions = open.map(q => `${q.label}${q.keys ? `, ${q.keys}` : ''}: ${q.text} (${q.turn === last ? 'asked in the last asking reply' : 'asked earlier, still open'})`).join('\n')
  const context = reply === undefined ? '' : `${REPLY_OPEN}${tail(reply, REPLY_CHARS)}${BLOCK_CLOSE}`
  return `Open questions:\n${questions}${context}${MESSAGE_OPEN}${message}${BLOCK_CLOSE}`
}

// The message and the reply's tail back out of a judge prompt, for the replay tool: the judge log keeps the prompt
// as sent and not the two again (judge-log.ts). The message block is last, so its opening is searched from the end,
// and the reply's from the start, where only the questions precede it. Undefined for text in another shape.
export const splitPrompt = (input: string): { message: string; reply: string | undefined } | undefined => {
  const m = input.lastIndexOf(MESSAGE_OPEN)
  if (m === -1 || !input.endsWith(BLOCK_CLOSE)) return undefined
  const head = input.slice(0, m)
  const r = head.indexOf(REPLY_OPEN)
  if (r !== -1 && !head.endsWith(BLOCK_CLOSE)) return undefined
  return {
    message: input.slice(m + MESSAGE_OPEN.length, -BLOCK_CLOSE.length),
    reply: r === -1 ? undefined : head.slice(r + REPLY_OPEN.length, -BLOCK_CLOSE.length),
  }
}

// The reply's end: the rule puts the block last, and a long reply's body costs tokens and says nothing.
export const findPrompt = (reply: string): string => `The reply:\n<<<\n${tail(reply, 4000)}\n>>>`

// The first JSON value between `open` and the last `close`: the model may wrap it in a code fence.
const jsonIn = (text: string, open: string, close: string): unknown => {
  const start = text.indexOf(open)
  const end = text.lastIndexOf(close)
  if (start === -1 || end < start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])

export type Verdict = { answered: string[]; dropped: string[] }

// The judge's answer, its labels kept only when open (the model never invents one), or undefined when it
// is not the asked JSON: the caller then falls back to the patterns.
export const parseVerdict = (text: string, openLabels: readonly string[]): Verdict | undefined => {
  const v = jsonIn(text, '{', '}')
  if (typeof v !== 'object' || v === null || !('answered' in v) || !('dropped' in v)) return undefined
  const known = (labels: string[]) => [...new Set(labels.filter(l => openLabels.includes(l)))]
  const dropped = known(strings(v.dropped))
  return { answered: known(strings(v.answered)).filter(l => !dropped.includes(l)), dropped }
}

// A blanket acceptance answers the questions the last asking reply asked, never older ones still open: the
// person read that block. The prompt says so, and this holds the model to it, as closes() (board-file.ts)
// holds the patterns: a question from an earlier reply stays in the verdict only when the message names it,
// by its label or every one of its key words (any order, any case), or the last reply names its label. The
// person answers that reply as a whole ("go for both", 2026-10-17) when its last line recalls an older
// question inside a sentence ("Q60 (...) is also still open"), and the judge reads that right. Re-run over
// the judge's saved verdicts on 368 real messages, 3 runs: 2 more right in every run (w174 "Yes to both",
// w181 "go for both"), the wrong closes unchanged (2, 2, 1 cases); none of the 120 written cases has a reply
// naming an older open label, so they could not move. Labels are read in the reply as in the message, by the
// patterns' reading (reply.ts labelMentions: Q6 is not Q60, nor Q60 Q6), so a range ("Q35 to Q37") names every
// label in it, Q36 included (session-board/DOT-204). Re-run over the same saved verdicts of main's prompt, 3 runs,
// through this and the scopeVerdict before ranges were read (2026-10-20): on the 368 real messages 3 verdicts
// differ, all w160, whose last reply says "Q35 to Q37 (the auto-run) are still open": Q36 is kept in every run, a
// miss recovered, and no wrong close is added (6 wrong labels in the 1104 verdicts either way; 1028 wholly right
// either way, as w160 still misses Q34). None of the 100 earlier and 120 written messages moves. Key words
// answer only here, through the judge's reading, never through the pattern fallback, which reads labels alone
// (session-board/DOT-152). This can only take a label out of the model's verdict, never put one in, so a
// common key word ("merge") costs nothing.
// Ceiling: an older question answered by paraphrase alone stays open; the toast shows what closed.
const word = (w: string) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
const labelsIn = (text: string | undefined): string[] => (text === undefined ? [] : labelMentions(text).flatMap(m => m.labels))

export const scopeVerdict = (v: Verdict | undefined, open: readonly Question[], message: string, reply?: string): Verdict | undefined => {
  if (v === undefined) return undefined
  const last = lastTurn(open)
  const [inMessage, inReply] = [labelsIn(message), labelsIn(reply)]
  const named = (q: Question) => {
    const keys = (q.keys ?? '').split(/\W+/).filter(Boolean)
    return inMessage.includes(q.label) || (keys.length > 0 && keys.every(k => word(k).test(message)))
  }
  const recalled = (q: Question) => inReply.includes(q.label)
  // the question a label closes is the newest open one under it (closes())
  const inScope = (label: string) => {
    const q = open.filter(x => x.label === label).at(-1)
    return q !== undefined && (q.turn === last || named(q) || recalled(q))
  }
  return { answered: v.answered.filter(inScope), dropped: v.dropped.filter(inScope) }
}

export type Found = { label: string; keys: string; text: string }

// One listed question, or undefined when it lacks a Q label or a text. The label given as its key words names
// nothing, as the prompt says, and is dropped: the model gave it for 10 lines of 13 in 3 of 6 runs, and as
// key words it would make `board ask` match any row of that label.
const found = (v: unknown): Found | undefined => {
  if (typeof v !== 'object' || v === null || !('label' in v) || !('text' in v)) return undefined
  if (typeof v.label !== 'string' || !/^Q\d+$/.test(v.label) || typeof v.text !== 'string' || v.text.trim() === '') return undefined
  const given = 'keywords' in v && typeof v.keywords === 'string' ? v.keywords.trim() : ''
  return { label: v.label, keys: given === v.label ? '' : given, text: v.text.trim() }
}

// The questions a reply asks, or undefined when the answer is not the asked JSON list.
export const parseFound = (text: string): Found[] | undefined => {
  const v = jsonIn(text, '[', ']')
  if (!Array.isArray(v)) return undefined
  return v.flatMap(item => found(item) ?? [])
}

// The agent's own word that the person's message was no decision, in the phrasing the nudge asks for:
// "None of it was a decision", "That was not a decision". Not any "no decision": "no decisions recorded
// yet" is no dismissal.
export const saysNoDecision = (reply: string): boolean =>
  /\b(?:none of (?:it|this|that|them) (?:was|were|is|are) a decision|(?:it|this|that) (?:was|is) not a decision)\b/i.test(reply)
