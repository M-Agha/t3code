import {
  MessageId,
  ThreadId,
  type ThreadDecisionQuestion,
  type ThreadParkedItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  asDraftLine,
  isParkedBusy,
  latestReplyOpenQuestions,
  nextUndrafted,
  openQuestionsByReply,
  parkedFocusAfter,
  questionsClosedByDraft,
  yesToAllLine,
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

  it("says yes to the picks the draft leaves open, once", () => {
    const reply = [
      { ...question("Q3", "newer", "open"), pick: "yes" },
      { ...question("Q4", "newer", "open"), pick: "no" },
      question("Q5", "newer", "open"),
      { ...question("Q6", "newer", "open"), pick: "later" },
    ];
    const picked = { ...snapshot, questions: reply, openCount: reply.length };
    // Q5 has no pick to say yes to; Q6 is answered in the draft already.
    const draft = "Q6: not yet";
    const line = yesToAllLine(reply, questionsClosedByDraft(draft, picked));
    expect(line).toBe("Yes to your picks: Q3, Q4");
    // Once the line is in the draft, it closes what it names, so there is nothing to add again.
    const withLine = `${draft}${asDraftLine(draft, line ?? "")}`;
    expect(withLine).toBe("Q6: not yet\nYes to your picks: Q3, Q4");
    // Q5 had no pick, so the line leaves it open; what it names reads as Accept.
    expect(questionsClosedByDraft(withLine, picked)).toEqual({
      Q3: "accept",
      Q4: "accept",
      Q6: "answer",
    });
    expect(yesToAllLine(reply, questionsClosedByDraft(withLine, picked))).toBeNull();
    expect(yesToAllLine([question("Q5", "newer", "open")], {})).toBeNull();
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

describe("parked items", () => {
  const item: ThreadParkedItem = {
    id: 7,
    kind: "todo",
    text: "x",
    state: "open",
    parkedBy: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: null,
  };

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
