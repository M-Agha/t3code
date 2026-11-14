import { describe, expect, it } from "vite-plus/test";

import {
  closingFor,
  decidedWithoutAsking,
  readReplyDecisions,
  splitQuestion,
  type OpenQuestion,
} from "./decisions.ts";

const REPLY = [
  "Done the migration.",
  "",
  "**Decided without asking**",
  "- Kept the old index: dropping it needs a rebuild.",
  "- Named the table `fork_x`,",
  "  matching the fork prefix.",
  "",
  "Q4, follow continuation: Resume the run? My pick is yes: the log shows it stopped cleanly.",
  "",
  "Q5, table name: Rename it? My pick is no: nothing reads it yet.",
].join("\n");

describe("readReplyDecisions", () => {
  it("reads the trailing Q-block and the decided-without-asking bullets before it", () => {
    const read = readReplyDecisions(REPLY);
    expect(read.questions.map((q) => q.label)).toEqual(["Q4", "Q5"]);
    expect(read.decidedWithoutAsking).toEqual([
      "Kept the old index: dropping it needs a rebuild.",
      "Named the table `fork_x`, matching the fork prefix.",
    ]);
  });

  it.each([
    "Q6, Q7 and Q15 are still open.",
    "Q4 (remove the 19, keep the rest), Q6 (the index) and Q8 (the docs) are still open.",
  ])("does not read %s as asking its first label", (status) => {
    const read = readReplyDecisions(
      `Q17, next project: Which one? My pick is #2: daily use.\n\n${status}`,
    );
    expect(read.questions.map((q) => q.label)).toEqual(["Q17"]);
  });

  it("reads an inline decided-without-asking line after the block", () => {
    expect(
      decidedWithoutAsking("Q1, a: b? My pick is c: d.\n\n**Decided without asking:** used pnpm"),
    ).toEqual(["used pnpm"]);
  });
});

describe("splitQuestion", () => {
  it.each([
    [
      "Q4, follow continuation: Resume the run? My pick is yes: the log shows it stopped cleanly.",
      {
        keyWords: "follow continuation",
        question: "Resume the run?",
        pick: "yes",
        reason: "the log shows it stopped cleanly.",
      },
    ],
    [
      "**Q2, db path:** Move it? My pick is **keep**: nothing else reads it.",
      { keyWords: "db path", question: "Move it?", pick: "keep", reason: "nothing else reads it." },
    ],
    ["Q3: Should I push?", { keyWords: "", question: "Should I push?", pick: "", reason: "" }],
  ])("splits %s", (text, parts) => {
    expect(splitQuestion(text)).toEqual(parts);
  });
});

describe("closingFor", () => {
  const open: OpenQuestion[] = [
    { label: "Q3", sourceMessageId: "m1", askedAt: "2026-01-01T00:00:00.000Z" },
    { label: "Q4", sourceMessageId: "m2", askedAt: "2026-01-02T00:00:00.000Z" },
    { label: "Q5", sourceMessageId: "m2", askedAt: "2026-01-02T00:00:00.000Z" },
  ];

  it.each([
    ["a clarification without a label closes nothing", "What does the log say?", [], []],
    ["a label answers it", "Q4: yes", ["Q4"], []],
    ["lower case labels count", "yes to q4", ["Q4"], []],
    ["not a decision drops it", "Q4: not a decision", [], ["Q4"]],
    ["a label nobody asked closes nothing", "Q9: yes", [], []],
    ["your picks settles the newest asking reply only", "go with your picks", ["Q4", "Q5"], []],
    [
      "a dropped label leaves the picks for the rest",
      "go with your picks, but Q5 is not a decision",
      ["Q4"],
      ["Q5"],
    ],
    ["a bare not a decision drops the newest reply's rest", "not a decision", [], ["Q4", "Q5"]],
  ])("%s", (_name, message, answered, dropped) => {
    expect(closingFor(message, open)).toEqual({ answered, dropped });
  });
});
