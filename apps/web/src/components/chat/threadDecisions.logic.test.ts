import {
  MessageId,
  ThreadId,
  type ThreadArtifact,
  type ThreadDecisionQuestion,
  type ThreadParkedItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parkedContextRecord, parkedContextReference } from "../../lib/composerContextRecords";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { buildDocJson } from "../../composer-rich-text-doc";

import {
  acceptsPick,
  answerLines,
  artifactGroups,
  asDraftLine,
  choicesToReview,
  draftLineOf,
  draftSummary,
  endsAtClosingFence,
  groupSelection,
  isParkedBusy,
  latestReplyOpenQuestions,
  lineEnd,
  nextUndrafted,
  openQuestionsByReply,
  parkedChipRestorable,
  parkedFocusAfter,
  parkedGroups,
  parkedIdsInDraft,
  parkedStatus,
  parkedTime,
  questionsClosedByDraft,
  unfinishedLabels,
  withoutLine,
} from "./threadDecisions.logic";

const question = (
  label: string,
  source: string,
  state: ThreadDecisionQuestion["state"],
): ThreadDecisionQuestion => ({
  label,
  keyWords: "",
  question: `${label}?`,
  pick: "",
  reason: "",
  sourceMessageId: MessageId.make(source),
  askedAt: source === "newer" ? "2026-01-02T00:00:00.000Z" : "2026-01-01T00:00:00.000Z",
  state,
  answerText: null,
  answerMessageId: null,
  resolvedAt: null,
});

const snapshot = {
  threadId: ThreadId.make("thread"),
  questions: [
    question("Q4", "newer", "open"),
    question("Q5", "newer", "answered"),
    question("Q2", "older", "open"),
  ],
  decidedWithoutAsking: [],
  openCount: 2,
  parked: [],
  parkedOpenCount: 0,
  artifacts: [],
  artifactCount: 0,
};

describe("thread decisions grouping", () => {
  it("shows the open questions of the reply that asked the newest open one in the strip", () => {
    expect(latestReplyOpenQuestions(snapshot).map((q) => q.label)).toEqual(["Q4"]);
    const newerSettled = {
      ...snapshot,
      questions: snapshot.questions.map((q) =>
        q.label === "Q4" ? { ...q, state: "dropped" as const } : q,
      ),
    };
    expect(latestReplyOpenQuestions(newerSettled).map((q) => q.label)).toEqual(["Q2"]);
  });

  it("groups every open question by the reply that asked it, newest first", () => {
    expect(
      openQuestionsByReply(snapshot).map((group) => [
        group.messageId,
        group.items.map((q) => q.label),
      ]),
    ).toEqual([
      ["newer", ["Q4"]],
      ["older", ["Q2"]],
    ]);
  });
});

describe("answers added to the composer", () => {
  it("puts each answer on its own line", () => {
    expect(asDraftLine("", "Q4: yes")).toBe("Q4: yes");
    expect(asDraftLine("Q2: no", "Q4: yes")).toBe("\nQ4: yes");
    expect(asDraftLine("Q2: no\n", "Q4: yes")).toBe("Q4: yes");
  });

  it("marks the open questions the draft already closes, and no resolved ones", () => {
    expect(questionsClosedByDraft("", snapshot)).toEqual({});
    expect(questionsClosedByDraft("Q2: yes\nQ4: not a decision\nQ5: no", snapshot)).toEqual({
      Q2: "answer",
      Q4: "drop",
    });
  });

  it("names the option the draft chose for each question", () => {
    const picked = {
      ...snapshot,
      questions: [
        { ...question("Q4", "newer", "open"), pick: "yes" },
        { ...question("Q6", "newer", "open"), pick: "no" },
        question("Q7", "newer", "open"),
      ],
    };
    // The Accept line as the button adds it, and stray spaces around it.
    expect(questionsClosedByDraft("Q4: yes\n  Q6: no ", picked)).toEqual({
      Q4: "accept",
      Q6: "accept",
    });
    // Another answer, or the pick inside a longer line, is the user's own answer.
    expect(questionsClosedByDraft("Q4: no\nQ6: no, but rename it", picked)).toEqual({
      Q4: "answer",
      Q6: "answer",
    });
    // Answer… adds the bare label; without a pick nothing reads as Accept.
    expect(questionsClosedByDraft("Q4: \nQ7: ", picked)).toEqual({ Q4: "answer", Q7: "answer" });
    // "Go with your picks" names no label, so what it sweeps is accepted; a named one keeps its own.
    expect(questionsClosedByDraft("Q6: not a decision. Go with your picks", picked)).toEqual({
      Q6: "drop",
      Q4: "accept",
      Q7: "accept",
    });
  });

  it("writes one line per question the draft leaves open, skipping no-pick ones for Accept, once", () => {
    const reply = [
      { ...question("Q3", "newer", "open"), pick: "yes" },
      { ...question("Q4", "newer", "open"), pick: "no" },
      question("Q5", "newer", "open"),
      { ...question("Q6", "newer", "open"), pick: "later" },
    ];
    const picked = { ...snapshot, questions: reply, openCount: reply.length };
    // Q5 has no pick to accept; Q6 is answered in the draft already.
    const draft = "Q6: not yet";
    const lines = answerLines(reply, "accept", questionsClosedByDraft(draft, picked));
    expect(lines).toEqual(["Q3: yes", "Q4: no"]);
    // Once the lines are in the draft, they close what they name, so there is nothing to add again.
    const withLines = `${draft}${asDraftLine(draft, lines.join("\n"))}`;
    expect(withLines).toBe("Q6: not yet\nQ3: yes\nQ4: no");
    expect(questionsClosedByDraft(withLines, picked)).toEqual({
      Q3: "accept",
      Q4: "accept",
      Q6: "answer",
    });
    expect(answerLines(reply, "accept", questionsClosedByDraft(withLines, picked))).toEqual([]);
    // Not a decision needs no pick.
    expect(answerLines(reply, "drop", questionsClosedByDraft(withLines, picked))).toEqual([
      "Q5: not a decision",
    ]);
  });

  it("finds the draft line that closes a question, and whether it is that question's alone", () => {
    const reply = [
      { ...question("Q3", "newer", "open"), pick: "yes" },
      { ...question("Q4", "newer", "open"), pick: "no" },
    ];
    const [q3, q4] = reply as [ThreadDecisionQuestion, ThreadDecisionQuestion];
    expect(draftLineOf("Also check it.\n  Q3: yes ", q3, reply)).toEqual({
      line: "Q3: yes",
      own: true,
    });
    // A typed lowercase label is still the question's own line.
    expect(draftLineOf("q3: no", q3, reply)).toEqual({ line: "q3: no", own: true });
    expect(draftLineOf("Q3 and Q4: yes", q4, reply)).toEqual({
      line: "Q3 and Q4: yes",
      own: false,
    });
    // Its own line wins over a sweep before it.
    expect(draftLineOf("Go with your picks\nQ4: maybe", q4, reply)).toEqual({
      line: "Q4: maybe",
      own: true,
    });
    expect(draftLineOf("Go with your picks", q4, reply)).toEqual({
      line: "Go with your picks",
      own: false,
    });
    expect(draftLineOf("Also check it.", q4, reply)).toBeNull();
  });

  it("removes exactly one line, and finds where a line ends", () => {
    expect(withoutLine("Q3: yes\nQ4: no\nQ3: yes", "Q3: yes")).toBe("Q4: no\nQ3: yes");
    expect(withoutLine("Q3: yes\n  Veto: x  \nmore", "Veto: x")).toBe("Q3: yes\nmore");
    expect(withoutLine("Q3: yes", "Q3: ye")).toBe("Q3: yes");
    expect(lineEnd("Q3: yes\n Q4: no \nmore", "Q4: no")).toBe(15);
    expect(lineEnd("Q3: yes", "Q4: no")).toBeNull();
  });

  it("says what the draft holds", () => {
    const open = [
      { ...question("Q3", "newer", "open"), pick: "yes" },
      { ...question("Q4", "newer", "open"), pick: "no" },
      { ...question("Q5", "newer", "open"), pick: "later" },
    ];
    const summary = (draft: string) =>
      draftSummary(draft, open, questionsClosedByDraft(draft, { ...snapshot, questions: open }));
    expect(summary("Q3: yes\nAlso check the remote list.")).toBe("1 answer + other text");
    expect(summary("Q3: yes\nQ4: no\nVeto: x")).toBe("2 answers · 1 veto");
    expect(summary("Veto: x\nVeto: y\nhi")).toBe("2 vetoes + other text");
    expect(summary("Rename it.")).toBe("text");
    // Answer…'s bare label waits for an answer: named, not counted.
    expect(summary("Q3: yes\nq5:\nQ4: ")).toBe("1 answer · Q5, Q4 unanswered");
  });

  it("finds the open questions whose line is only their label", () => {
    const open = [question("Q4", "newer", "open"), question("Q5", "newer", "open")];
    expect(unfinishedLabels("Q4: \nq5:\nQ9:\nQ4:", open)).toEqual(["Q4", "Q5"]);
    expect(unfinishedLabels("Q4: yes\nQ5: no", open)).toEqual([]);
    // An answer begun on the line after the label is an answer.
    expect(unfinishedLabels("Q4:\nUse PostgreSQL instead", open)).toEqual([]);
    expect(unfinishedLabels("Q4:\nQ5: no", open)).toEqual(["Q4"]);
  });

  it("moves to the next question the draft does not close, wrapping, or nowhere", () => {
    const labels = ["Q4", "Q5", "Q6"];
    expect(nextUndrafted(labels, "Q4", {})).toBe("Q5");
    expect(nextUndrafted(labels, "Q4", { Q5: "accept" })).toBe("Q6");
    expect(nextUndrafted(labels, "Q6", {})).toBe("Q4");
    expect(nextUndrafted(labels, "Q5", { Q4: "drop", Q6: "answer" })).toBeUndefined();
    expect(nextUndrafted(["Q4"], "Q4", {})).toBeUndefined();
  });
});

describe("decisions", () => {
  it("tells an answer that took the pick from one that departed from it", () => {
    const q4 = { ...question("Q4", "newer", "answered"), pick: "yes" };
    expect(acceptsPick("Q4: yes", q4)).toBe(true);
    expect(acceptsPick("Go with your picks", q4)).toBe(true);
    expect(acceptsPick("Q2: no\n Q4: yes", q4)).toBe(true);
    expect(acceptsPick("Why?\nQ4: Yes", q4)).toBe(true);
    expect(acceptsPick("Q4: yes, but later", q4)).toBe(false);
    expect(acceptsPick("Q4: no", q4)).toBe(false);
    // Its own part of a message naming several, without trailing punctuation.
    expect(acceptsPick("Why? q4: Yes Q6: No", q4)).toBe(true);
    expect(acceptsPick("Why? q6: Yes Q4: No", q4)).toBe(false);
    expect(acceptsPick("Q4: yes.", q4)).toBe(true);
    expect(acceptsPick("Q4: yes\nAlso rename it", q4)).toBe(true);
    // Unlabelled answers the judge closed it with: only a blanket accept or the pick itself took it.
    expect(acceptsPick("Use PostgreSQL instead", q4)).toBe(false);
    expect(acceptsPick("Yes.", q4)).toBe(true);
    expect(acceptsPick("No", q4)).toBe(false);
  });

  it("counts the newest reply's choices that are neither vetoed nor in the draft", () => {
    const item = (messageId: string, ordinal: number, vetoed = false) => ({
      messageId: MessageId.make(messageId),
      ordinal,
      text: `choice ${messageId} ${ordinal}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      vetoed,
    });
    const decided = {
      ...snapshot,
      // Newest first, as the snapshot sends them.
      decidedWithoutAsking: [
        item("newer", 0),
        item("newer", 1),
        item("newer", 2, true),
        item("older", 0),
      ],
    };
    expect(choicesToReview(decided, "")).toBe(2);
    expect(choicesToReview(decided, "Veto: choice newer 1")).toBe(1);
    // Another reply's veto, or a line that only contains it, changes nothing.
    expect(choicesToReview(decided, "Veto: choice older 0\nNo Veto: choice newer 0")).toBe(2);
    expect(choicesToReview(snapshot, "")).toBe(0);
  });

  it("checks a reply's box when all it can select is selected, and marks it mixed for some", () => {
    expect(groupSelection(["Q3", "Q4"], new Set(["Q3", "Q4", "Q9"]))).toBe(true);
    expect(groupSelection(["Q3", "Q4"], new Set(["Q4"]))).toBe("mixed");
    expect(groupSelection(["Q3", "Q4"], new Set(["Q9"]))).toBe(false);
    expect(groupSelection([], new Set())).toBe(false);
  });
});

describe("parked items", () => {
  const item: ThreadParkedItem = {
    id: 7,
    kind: "agent",
    text: "x",
    state: "open",
    parkedBy: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: null,
  };
  const at = (minute: number) => `2026-01-01T00:0${minute}:00.000Z`;
  const threadId = ThreadId.make("thread");

  it("groups items as Open and Resolved", () => {
    const items: ThreadParkedItem[] = [
      { ...item, id: 1 },
      { ...item, id: 3, state: "done" },
      { ...item, id: 4, state: "sent" },
      { ...item, id: 5, state: "dropped" },
    ];
    const groups = parkedGroups(items);
    expect([groups.open, groups.resolved].map((g) => g.map((i) => i.id))).toEqual([[1], [3, 4, 5]]);
  });

  it("keeps a row being edited in the group it was in, where it stood", () => {
    const items: ThreadParkedItem[] = [
      { ...item, id: 1, createdAt: at(1) },
      { ...item, id: 3, createdAt: at(3) },
      // Sent from another client while edited: the snapshot lists it with the resolved.
      { ...item, id: 2, state: "sent", createdAt: at(2) },
    ];
    const groups = parkedGroups(items, { id: 2, group: "open" });
    expect(groups.open.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(groups.resolved).toEqual([]);
    expect(parkedGroups(items).resolved.map((i) => i.id)).toEqual([2]);
  });

  it("reads In draft from the chips the draft's text still holds", () => {
    const chip = (id: number) => parkedContextRecord({ id, text: `item ${id}` }, threadId);
    const reference = (id: number) =>
      formatInlineContextReference(parkedContextReference(chip(id)));
    expect(
      parkedIdsInDraft({
        prompt: `Do ${reference(1)} and ${reference(2)} `,
        parkedContexts: [chip(1), chip(2), chip(3)],
      }),
    ).toEqual([1, 2]);
    // A chip deleted from the text leaves its record behind until the composer prunes it.
    expect(parkedIdsInDraft({ prompt: "Do nothing", parkedContexts: [chip(1)] })).toEqual([]);
    expect(parkedIdsInDraft(undefined)).toEqual([]);
  });

  // The lock (Q56): nothing rewrites a drafted chip, so an undo brings one back only as it was.
  it("lets an undo bring back a chip only while its item is open for the agent, same words", () => {
    const open = { ...item, id: 1, text: "item 1", kind: "agent" as const };
    const record = parkedContextRecord({ id: 1, text: "item 1" }, threadId);
    expect(parkedChipRestorable(record, [open], false)).toBe(true);
    for (const items of [
      [{ ...open, text: "item 1 edited" }],
      [{ ...open, kind: "me" as const }],
      [{ ...open, state: "done" as const }],
      [{ ...open, state: "sent" as const }],
      [{ ...open, id: 2 }],
      [],
    ]) {
      expect(parkedChipRestorable(record, items, false)).toBe(false);
    }
  });

  // Sol round 3, S4, read with the composer's own document builder.
  it("puts a chip after a closing code fence on a line of its own", () => {
    const fenced = "Look:\n```ts\nconst a = 1;\n```";
    expect(endsAtClosingFence(fenced)).toBe(true);
    expect(endsAtClosingFence(`${fenced}\nthen`)).toBe(false);
    // Unclosed: the chip would sit in the block whatever joins it; nothing to close here.
    expect(endsAtClosingFence("```ts\nconst a = 1;")).toBe(false);
    expect(endsAtClosingFence("plain")).toBe(false);
    const chip = formatInlineContextReference(
      parkedContextReference(parkedContextRecord({ id: 1, text: "item 1" }, threadId)),
    );
    const blocks = buildDocJson(`${fenced}\n${chip} `, () => null, { styling: true }).content;
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "codeBlock", "paragraph"]);
    expect(JSON.stringify(blocks.at(-1))).toContain('"kind":"parked"');
    // What a space would have done: the fence line no longer closes, and the reference is code.
    const joined = buildDocJson(`${fenced} ${chip} `, () => null, { styling: true }).content;
    expect(joined.map((block) => block.type)).toEqual(["paragraph", "codeBlock"]);
  });

  it.each([
    [{}, false, null],
    [{}, true, "draft"],
    [{ state: "done" }, false, "done"],
    [{ state: "dropped" }, false, "dropped"],
    // A message carrying its chip was recorded, or (an older row) the old Send button sent it.
    [{ state: "sent" }, false, "sent"],
  ] as const)("says where %j stands (in draft: %j): %j", (change, inDraft, status) => {
    expect(parkedStatus({ ...item, ...change }, inDraft)).toBe(status);
  });

  it("shows when it was parked, or resolved", () => {
    expect(parkedTime(item)).toBe(at(0));
    expect(parkedTime({ ...item, state: "sent", resolvedAt: at(3) })).toBe(at(3));
  });

  it("keeps an item busy until the snapshot shows the action's result", () => {
    const busy = new Map([[item.id, item.updatedAt]]);
    expect(isParkedBusy(busy, item)).toBe(true);
    expect(isParkedBusy(busy, { ...item, updatedAt: "2026-01-01T00:00:01.000Z" })).toBe(false);
    expect(isParkedBusy(new Map(), item)).toBe(false);
  });

  it("moves focus to the next open item, else the one before, else nowhere", () => {
    expect(parkedFocusAfter([1, 2, 3], 2)).toBe(3);
    expect(parkedFocusAfter([1, 2, 3], 3)).toBe(2);
    expect(parkedFocusAfter([2], 2)).toBeNull();
  });
});

describe("artifacts", () => {
  const artifact = (id: string, fields: Partial<ThreadArtifact> = {}): ThreadArtifact => ({
    id,
    url: `https://claude.ai/artifact/${id}`,
    title: null,
    description: null,
    mentionedOnly: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    linkedByUser: false,
    type: null,
    notFoundAt: null,
    ...fields,
  });

  it("groups published, linked and not found, a missing one under Not found whatever its source", () => {
    const published = artifact("Plan1", { type: { kind: "page", format: "html" } });
    const mentioned = artifact("Canvas1", { mentionedOnly: true });
    const linked = artifact("Review1", { mentionedOnly: true, linkedByUser: true });
    const gone = artifact("Board1", { notFoundAt: "2026-01-02T00:00:00.000Z" });
    const goneLink = artifact("Old1", {
      mentionedOnly: true,
      notFoundAt: "2026-01-02T00:00:00.000Z",
    });
    const groups = artifactGroups([published, mentioned, gone, linked, goneLink]);
    expect(groups).toEqual({
      published: [published],
      linked: [mentioned, linked],
      notFound: [gone, goneLink],
    });
  });
});
