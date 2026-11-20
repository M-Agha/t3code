import { describe, expect, it } from "vite-plus/test";

import { OLDER_KIND_WORD, PARK_KIND_OF_WORD, parkKind, readParkCommand } from "./parks.ts";

describe("readParkCommand", () => {
  it.each([
    ["/park fix the flaky test", [{ kind: "me", text: "fix the flaky test" }]],
    ["/park me look at CI caching", [{ kind: "me", text: "look at CI caching" }]],
    [
      "/park agent Review the diff\n- line one stays",
      [{ kind: "agent", text: "Review the diff\n- line one stays" }],
    ],
    // The kinds before 2026-11 stay words for them: prompt is the agent's, todo and later the person's.
    ["/park later: look at CI caching", [{ kind: "me", text: "look at CI caching" }]],
    [
      "/park prompt Review the diff\n- line one stays",
      [{ kind: "agent", text: "Review the diff\n- line one stays" }],
    ],
    [
      "/park later\n- tidy the README\n- todo bump the lockfile",
      [
        { kind: "me", text: "tidy the README" },
        { kind: "me", text: "bump the lockfile" },
      ],
    ],
    // A bare `me` or `agent` names a kind only on the first line; after it, the colon is needed.
    ["/park remind\nme to call bob", [{ kind: "me", text: "remind\nme to call bob" }]],
    [
      "/park tidy the README\n- agent: write the notes",
      [
        { kind: "me", text: "tidy the README" },
        { kind: "agent", text: "write the notes" },
      ],
    ],
    ["/PARK  two lines\nof one thought", [{ kind: "me", text: "two lines\nof one thought" }]],
  ])("parks %j", (text, parks) => {
    expect(readParkCommand(text)).toEqual({ parks, placeholders: 0 });
  });

  it.each(["/park", "/park me", "/park later", "/park TODO", "/park placeholder", "/park ..."])(
    "parks nothing from %j",
    (text) => {
      expect(readParkCommand(text)?.parks).toEqual([]);
    },
  );

  it("leaves placeholders out and counts them", () => {
    expect(readParkCommand("/park\n- tbd\n- write the release notes")).toEqual({
      parks: [{ kind: "me", text: "write the release notes" }],
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

describe("kind words", () => {
  it("reads each word an input may carry as session-kit's parkKind does", () => {
    for (const [word, kind] of Object.entries(PARK_KIND_OF_WORD)) expect(parkKind(word)).toBe(kind);
  });

  it("says each kind in an older word that reads back as the same kind", () => {
    for (const [kind, word] of Object.entries(OLDER_KIND_WORD)) expect(parkKind(word)).toBe(kind);
  });
});
