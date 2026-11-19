import "~/index.css";

import {
  EnvironmentId,
  ThreadId,
  type ThreadArtifact,
  type ThreadDecisionsSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  snapshot: null as ThreadDecisionsSnapshot | null,
  command: vi.fn(),
}));
vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({ data: state.snapshot, error: null })) as never,
}));
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: (() => true) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => state.command) as never,
}));

import { act, render } from "../../../test/render";
import { ThreadArtifactsPanel } from "./ThreadArtifacts";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

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

const setup = (artifacts: ReadonlyArray<ThreadArtifact>) => {
  state.snapshot = {
    threadId: threadRef.threadId,
    questions: [],
    decidedWithoutAsking: [],
    openCount: 0,
    parked: [],
    parkedOpenCount: 0,
    artifacts,
    artifactCount: artifacts.length,
  };
  state.command.mockReset().mockResolvedValue({ _tag: "Success" });
};

const panel = () => <ThreadArtifactsPanel threadRef={threadRef} />;

// A row's actions are always in the DOM and focusable; hover or keyboard focus shows them.
const actionsOpacity = (button: { element: () => Element }) =>
  getComputedStyle(button.element().parentElement!).opacity;

const BOARD = artifact("Board1", {
  title: "Tracker redesign",
  description: "Four directions",
  type: { kind: "typed", url: "https://claude.ai/artifact/QKN21svewxgyPb6SYRqWnd", name: "Design" },
});
const REVIEW = artifact("Q3shipReview", {
  title: "Q3 shipping review",
  mentionedOnly: true,
  linkedByUser: true,
});
const CANVAS = artifact("Canvas1", { title: "Spending canvas", mentionedOnly: true });
const GONE = artifact("Gone1", {
  title: "Type test: Whiteboard",
  type: {
    kind: "typed",
    url: "https://claude.ai/artifact/PLsEyfjXbDUM1iasW7rjLR",
    name: "Whiteboard",
  },
  notFoundAt: "2026-01-02T00:00:00.000Z",
});

it("lists published, linked and not found artifacts with their types and counts", async () => {
  setup([REVIEW, BOARD, GONE, CANVAS]);
  await using screen = await render(panel());
  const groups = ["Published here", "Linked", "Not found"].map((name) =>
    screen.getByRole("region", { name: new RegExp(`^${name}`) }),
  );
  await expect.element(groups[0]!.getByRole("img", { name: "Design" })).toBeVisible();
  await expect.element(groups[0]!.getByText("Design · Four directions")).toBeVisible();
  await expect.element(groups[1]!.getByText("Type unknown · linked by you")).toBeVisible();
  await expect.element(groups[1]!.getByText("Type unknown · mentioned in a reply")).toBeVisible();
  await expect
    .element(groups[2]!.getByRole("img", { name: "Whiteboard, not found" }))
    .toBeVisible();
  await expect
    .element(
      groups[2]!.getByText(
        "Whiteboard · the last read reported it not found: deleted, or not shared with you",
      ),
    )
    .toBeVisible();
  await expect.element(screen.getByText("1 published · 2 linked · 1 not found")).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: /Tracker redesign/ }))
    .toHaveAttribute("href", "https://claude.ai/artifact/Board1");
});

it("offers Unlink only on an artifact the user linked, from hover or the keyboard", async () => {
  setup([REVIEW, BOARD]);
  await using screen = await render(panel());
  const actions = screen.getByRole("button", { name: "Actions for Tracker redesign" });
  expect(actionsOpacity(actions)).toBe("0");
  await userEvent.hover(screen.getByRole("link", { name: /Tracker redesign/ }));
  await expect.poll(() => actionsOpacity(actions)).toBe("1");
  await actions.click();
  await expect.element(page.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  expect(page.getByRole("menuitem", { name: "Unlink from thread" }).query()).toBeNull();
  await userEvent.keyboard("{Escape}");

  // The row's actions show for keyboard focus too: Open in browser, Copy link, then "…".
  const review = screen.getByRole("link", { name: /Q3 shipping review/ });
  await act(() => (review.element() as HTMLElement).focus());
  await userEvent.tab();
  await expect
    .element(screen.getByRole("button", { name: "Open in browser: Q3 shipping review" }))
    .toHaveFocus();
  await userEvent.tab();
  await userEvent.tab();
  // "…" has no tooltip, whose opening would show the actions by itself.
  const more = screen.getByRole("button", { name: "Actions for Q3 shipping review" });
  await expect.element(more).toHaveFocus();
  await expect.poll(() => actionsOpacity(more)).toBe("1");
  await userEvent.keyboard("{Enter}");
  await page.getByRole("menuitem", { name: "Unlink from thread" }).click();
  expect(state.command).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, id: "Q3shipReview" },
  });
});

it("links an artifact from the empty state, its link read before it is sent", async () => {
  setup([]);
  await using screen = await render(panel());
  await expect.element(screen.getByText("No artifacts")).toBeVisible();
  await screen.getByRole("button", { name: "Link artifact" }).click();
  const url = page.getByRole("textbox", { name: "Link" });
  await expect.element(url).toHaveFocus();
  await url.fill("https://example.com/artifact/x");
  await expect.element(page.getByText(/^Use a claude\.ai artifact link/)).toBeVisible();
  await expect
    .element(page.getByRole("dialog").getByRole("button", { name: "Link", exact: true }))
    .toBeDisabled();

  await url.fill("https://claude.ai/artifact/Q3shipReview?tab=1#top");
  await expect
    .element(
      page.getByText(/claude\.ai artifact Q3shipReview · type unknown until Claude reads it/),
    )
    .toBeVisible();
  await page.getByRole("textbox", { name: /Title/ }).fill("Q3 shipping review");
  await page.getByRole("dialog").getByRole("button", { name: "Link", exact: true }).click();
  expect(state.command).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      url: "https://claude.ai/artifact/Q3shipReview",
      title: "Q3 shipping review",
    },
  });
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

it("shows the server's refusal in the dialog and returns focus to Link once closed", async () => {
  setup([BOARD]);
  await using screen = await render(panel());
  const trigger = screen.getByRole("button", { name: "Link", exact: true });
  await trigger.click();
  state.command.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("This thread was not found.")),
  });
  await page.getByRole("textbox", { name: "Link" }).fill("https://claude.ai/artifact/Q3shipReview");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("This thread was not found.")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
});

it("names a page, a markdown page and a type no thread has named, and counts only groups with rows", async () => {
  setup([
    artifact("Plan1", { title: "Plan", type: { kind: "page", format: "html" } }),
    artifact("Notes1", { title: "Notes", type: { kind: "page", format: "markdown" } }),
    artifact("Odd1", {
      title: "Odd",
      type: { kind: "typed", url: "https://claude.ai/artifact/OddType1", name: null },
    }),
  ]);
  await using screen = await render(panel());
  await expect.element(screen.getByRole("img", { name: "Page", exact: true })).toBeVisible();
  await expect.element(screen.getByRole("img", { name: "Markdown page" })).toBeVisible();
  await expect.element(screen.getByRole("img", { name: "Typed artifact" })).toBeVisible();
  await expect.element(screen.getByText("3 published", { exact: true })).toBeVisible();
});
