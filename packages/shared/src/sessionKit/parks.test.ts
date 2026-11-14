import { describe, expect, it } from "vite-plus/test";

import { readParkCommand } from "./parks.ts";

describe("readParkCommand", () => {
  it.each([
    ["/park fix the flaky test", [{ kind: "todo", text: "fix the flaky test" }]],
    ["/park later: look at CI caching", [{ kind: "later", text: "look at CI caching" }]],
    [
      "/park prompt Review the diff\n- line one stays",
      [{ kind: "prompt", text: "Review the diff\n- line one stays" }],
    ],
    [
      "/park later\n- tidy the README\n- todo bump the lockfile",
      [
        { kind: "later", text: "tidy the README" },
        { kind: "todo", text: "bump the lockfile" },
      ],
    ],
    ["/PARK  two lines\nof one thought", [{ kind: "todo", text: "two lines\nof one thought" }]],
  ])("parks %j", (text, parks) => {
    expect(readParkCommand(text)).toEqual({ parks, placeholders: 0 });
  });

  it.each(["/park", "/park later", "/park TODO", "/park placeholder", "/park ..."])(
    "parks nothing from %j",
    (text) => {
      expect(readParkCommand(text)?.parks).toEqual([]);
    },
  );

  it("leaves placeholders out and counts them", () => {
    expect(readParkCommand("/park\n- tbd\n- write the release notes")).toEqual({
      parks: [{ kind: "todo", text: "write the release notes" }],
      placeholders: 1,
    });
  });

  it.each(["park this", "/parking lot", "please /park x", "/side park x"])(
    "is not the command: %j",
    (text) => {
      expect(readParkCommand(text)).toBeNull();
    },
  );
});
