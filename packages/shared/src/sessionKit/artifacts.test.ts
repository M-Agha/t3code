import { describe, expect, it } from "vite-plus/test";

import { artifactLinksIn, parseArtifactLink } from "./artifacts.ts";

const UUID = "c53f3af9-93a3-4286-9581-8bf18386d46f";

describe("parseArtifactLink", () => {
  it.each([
    ["https://claude.ai/artifact/Q3shipReview", "Q3shipReview"],
    ["  https://claude.ai/artifact/Q3shipReview?tab=1#top \n", "Q3shipReview"],
    ["https://claude.ai/artifact/Q3shipReview#top", "Q3shipReview"],
    [`https://claude.ai/code/artifact/${UUID}`, UUID],
    [`https://claude.ai/code/artifact/${UUID}?share=1`, UUID],
  ])("reads %j", (text, id) => {
    const url =
      id === UUID ? `https://claude.ai/code/artifact/${UUID}` : `https://claude.ai/artifact/${id}`;
    expect(parseArtifactLink(text)).toEqual({ id, url });
  });

  it.each([
    "",
    "Q3shipReview",
    "claude.ai/artifact/Q3shipReview",
    "http://claude.ai/artifact/Q3shipReview",
    "https://example.com/artifact/Q3shipReview",
    "https://claude.ai/artifact/Q3-ship",
    "https://claude.ai/artifact/Q3shipReview/edit",
    "https://claude.ai/code/artifact/66a57730-1234",
    "https://claude.ai/artifact/Q3shipReview and more",
  ])("refuses %j", (text) => {
    expect(parseArtifactLink(text)).toBeNull();
  });
});

describe("artifactLinksIn", () => {
  it("lists each id once, in order, without its query", () => {
    expect(
      artifactLinksIn(
        `See https://claude.ai/artifact/MockUp2?tab=2, (https://claude.ai/code/artifact/${UUID}) and https://claude.ai/artifact/MockUp2 again.`,
      ),
    ).toEqual([
      { id: "MockUp2", url: "https://claude.ai/artifact/MockUp2" },
      { id: UUID, url: `https://claude.ai/code/artifact/${UUID}` },
    ]);
  });
});
