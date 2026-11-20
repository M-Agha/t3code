// Fork (Parked): the strip both composers use. FORK.md, "Parked items".
import { describe, expect, it } from "vite-plus/test";

import { pastesOnlyParkedReferences, withoutParkedReferences } from "./parkedReferences.ts";

const chip = (id: number) => `[Item ${id}](t3-context://v1/parked/parked_${id})`;

describe("parked references", () => {
  it("drops each parked chip with one space beside it, and leaves every other character", () => {
    expect(withoutParkedReferences(`Do ${chip(7)} now`)).toBe("Do now");
    expect(withoutParkedReferences(`Do ${chip(7)}`)).toBe("Do");
    expect(withoutParkedReferences(`${chip(7)} ${chip(8)}x`)).toBe("x");
    // Trailing whitespace the user wrote stays.
    expect(withoutParkedReferences(`Do ${chip(7)}  `)).toBe("Do  ");
    expect(withoutParkedReferences(`[log](t3-context://v1/terminal/ctx_t) ${chip(7)}`)).toBe(
      "[log](t3-context://v1/terminal/ctx_t)",
    );
  });

  it("says a paste of chips alone pastes nothing; anything else beside them pastes", () => {
    expect(pastesOnlyParkedReferences(` ${chip(7)} ${chip(8)} `)).toBe(true);
    expect(pastesOnlyParkedReferences(`${chip(7)} now`)).toBe(false);
    expect(pastesOnlyParkedReferences("  ")).toBe(false);
  });
});
