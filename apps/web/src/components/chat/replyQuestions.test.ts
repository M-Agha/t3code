import { describe, expect, it } from "vite-plus/test";

import { splitReplyQuestions } from "./replyQuestions";

describe("splitReplyQuestions", () => {
  it("cuts the trailing block into questions and keeps the body", () => {
    const reply = [
      "Done.",
      "",
      "Q4, fork go-ahead: Fork it? My pick is yes: the seam exists.",
      "",
      "Q5, card buttons: Which ones? My pick is all four: each sends text: no server change.",
    ].join("\n");

    expect(splitReplyQuestions(reply)).toEqual({
      body: "Done.",
      questions: [
        {
          label: "Q4",
          keyWords: "fork go-ahead",
          question: "Fork it?",
          pick: "yes",
          reason: "the seam exists.",
          line: "Q4, fork go-ahead: Fork it? My pick is yes: the seam exists.",
        },
        {
          label: "Q5",
          keyWords: "card buttons",
          question: "Which ones?",
          pick: "all four",
          reason: "each sends text: no server change.",
          line: "Q5, card buttons: Which ones? My pick is all four: each sends text: no server change.",
        },
      ],
    });
  });

  it("leaves a reply alone when a trailing Q-line drifts from the shape", () => {
    const reply = ["Body.", "Q1, ok: Fine? My pick is yes: sure.", "Q2 without the shape"].join(
      "\n",
    );
    expect(splitReplyQuestions(reply)).toBeNull();
  });

  it("leaves a reply alone when it does not end with a Q-line", () => {
    expect(splitReplyQuestions("Q1, early: Asked? My pick is yes: why.\n\nThen prose.")).toBeNull();
    expect(splitReplyQuestions("No questions here.")).toBeNull();
  });
});
