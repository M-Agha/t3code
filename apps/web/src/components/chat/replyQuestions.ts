// Fork-only: the decision block an assistant reply ends with, in the shape this fork's owner asks their
// agents for: `Q<n>, <key words>: <question> My pick is <pick>: <reason>`, one per line, last in the reply.
// The block is cut only when every trailing Q-line has that whole shape, so a reply that drifts from it
// stays plain markdown and never loses text.

export interface ReplyQuestion {
  readonly label: string;
  readonly keyWords: string;
  readonly question: string;
  readonly pick: string;
  readonly reason: string;
  readonly line: string;
}

export interface SplitReply {
  readonly body: string;
  readonly questions: ReadonlyArray<ReplyQuestion>;
}

// The question ends at the first "My pick is"; the pick ends at the first ": " after it.
const QUESTION_LINE = /^(Q\d+), ([^:]+?): (.+?) My pick is (.+?): (.+)$/;
// Any line that leads with a label: the start of a block, whole-shape or not.
const LABEL_LINE = /^\s*(?:[-*]\s+|\d+\.\s+)?(?:\*\*)?Q\d+\b/;

const parseQuestionLine = (line: string): ReplyQuestion | null => {
  const match = QUESTION_LINE.exec(line.trim());
  if (!match) return null;
  const [, label, keyWords, question, pick, reason] = match;
  if (!label || !keyWords || !question || !pick || !reason) return null;
  return { label, keyWords, question, pick, reason, line: line.trim() };
};

export const splitReplyQuestions = (text: string): SplitReply | null => {
  const lines = text.trimEnd().split("\n");
  let start = lines.length;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") continue;
    if (!LABEL_LINE.test(line)) break;
    start = index;
  }
  if (start === lines.length) return null;
  const questions: ReplyQuestion[] = [];
  for (const line of lines.slice(start)) {
    if (line.trim() === "") continue;
    const question = parseQuestionLine(line);
    if (!question) return null;
    questions.push(question);
  }
  return { body: lines.slice(0, start).join("\n").trimEnd(), questions };
};
