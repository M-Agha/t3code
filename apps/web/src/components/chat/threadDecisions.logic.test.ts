import {
  MessageId,
  ThreadId,
  type ThreadDecisionQuestion,
  type ThreadParkedItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isParkedBusy,
  latestReplyOpenQuestions,
  openQuestionsByReply,
  parkedFocusAfter,
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
