import { describe, expect, it } from "vite-plus/test";

import {
  answerPart,
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
    { label: "Q6", sourceMessageId: "m1", askedAt: "2026-01-01T00:00:00.000Z" },
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
    [
      "one answer per line closes each label, across replies",
      "Q4: yes\nQ5: not a decision\nQ6: no",
      ["Q4", "Q6"],
      ["Q5"],
    ],
    ["a bare not a decision drops the newest reply's rest", "not a decision", [], ["Q4", "Q5"]],
  ])("%s", (_name, message, answered, dropped) => {
    expect(closingFor(message, open)).toEqual({ answered, dropped });
  });
});

describe("answerPart", () => {
  it("cuts a message into each label's answer, up to the next label it names", () => {
    const message = "Why is it here? q5: Yes Q6: No, keep it\nand rename it";
    expect(answerPart(message, "Q5")).toBe("q5: Yes");
    expect(answerPart(message, "Q6")).toBe("Q6: No, keep it\nand rename it");
  });

  it("keeps labels joined by and or commas together, and a range as one", () => {
    expect(answerPart("Q3 and Q4: yes. Q5: no", "Q3")).toBe("Q3 and Q4: yes.");
    expect(answerPart("Q3, Q4: yes. Q5: no", "Q4")).toBe("Q4: yes.");
    expect(answerPart("Q3-Q5: not a decision", "Q4")).toBe("Q3-Q5: not a decision");
  });

  it("runs on past a label cited inside the answer", () => {
    expect(answerPart("Q28: Same as Q27, but smaller. Q29: no", "Q28")).toBe(
      "Q28: Same as Q27, but smaller.",
    );
  });

  it("starts where a label opens its answer, not where another answer cites it, and never joins lines", () => {
    const message = "Q3: Same as Q4\nQ4: yes\nQ5: no";
    expect(answerPart(message, "Q3")).toBe("Q3: Same as Q4");
    expect(answerPart(message, "Q4")).toBe("Q4: yes");
    expect(answerPart(message, "Q5")).toBe("Q5: no");
  });

  it("is the whole message when the label is not named", () => {
    expect(answerPart("  Go with your picks  ", "Q4")).toBe("Go with your picks");
  });
});
