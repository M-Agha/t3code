import {
  EnvironmentId,
  ThreadId,
  type ThreadDecisionsSnapshot,
  type ThreadParkedItem,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  snapshot: null as ThreadDecisionsSnapshot | null,
  update: vi.fn(),
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
  useAtomCommand: (() => state.update) as never,
}));

import { act, render, type Screen } from "../../../test/render";
import { useDecisionsPanelTab } from "./decisionsPanelTabStore";
import { ThreadDecisionsPanel } from "./ThreadDecisions";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const actions = { canOperate: true, send: async () => true, insert: () => {} };

const item = (id: number): ThreadParkedItem => ({
  id,
  kind: "todo",
  text: `item ${id}`,
  state: "open",
  parkedBy: "user",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  resolvedAt: null,
});

const snapshotOf = (parked: ReadonlyArray<ThreadParkedItem>): ThreadDecisionsSnapshot => ({
  threadId: threadRef.threadId,
  questions: [],
  decidedWithoutAsking: [],
  openCount: 0,
  parked,
  parkedOpenCount: parked.length,
});

const panel = () => <ThreadDecisionsPanel threadRef={threadRef} actions={actions} />;

function setup(ids: ReadonlyArray<number>) {
  state.snapshot = snapshotOf(ids.map(item));
  state.update.mockReset().mockResolvedValue({ _tag: "Success" });
  useDecisionsPanelTab.setState({ tab: "parked" });
}

// The live snapshot lands without the items the server resolved.
async function land(screen: Screen, remaining: ReadonlyArray<number>) {
  state.snapshot = snapshotOf(remaining.map(item));
  await act(() => screen.rerender(panel()));
}

it("returns focus to the Edit button after Escape in the inline editor", async () => {
  setup([1, 2]);
  await using screen = await render(panel());
  await screen.getByRole("button", { name: "Edit: item 2" }).click();
  await expect.element(screen.getByRole("textbox", { name: "Parked item text" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("button", { name: "Edit: item 2" })).toHaveFocus();
  expect(state.update).not.toHaveBeenCalled();
});

it("returns focus to the Edit button after Save in the inline editor", async () => {
  setup([1, 2]);
  await using screen = await render(panel());
  await screen.getByRole("button", { name: "Edit: item 2" }).click();
  await screen.getByRole("textbox", { name: "Parked item text" }).fill("item 2 edited");
  await screen.getByRole("button", { name: "Save", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "Edit: item 2" })).toHaveFocus();
  expect(state.update).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, id: 2, action: "edit", text: "item 2 edited" },
  });
});

it("moves focus to the next card once the snapshot drops the finished one", async () => {
  setup([1, 2, 3]);
  await using screen = await render(panel());
  await screen.getByRole("button", { name: "Mark done: item 2" }).click();
  await vi.waitFor(() => expect(state.update).toHaveBeenCalledOnce());
  await land(screen, [1, 3]);
  await expect
    .element(screen.getByRole("button", { name: "Send as a message: item 3" }))
    .toHaveFocus();
});

it("moves focus to the Parked tab when the only card is done", async () => {
  setup([1]);
  await using screen = await render(panel());
  await screen.getByRole("button", { name: "Mark done: item 1" }).click();
  await vi.waitFor(() => expect(state.update).toHaveBeenCalledOnce());
  await land(screen, []);
  await expect.element(screen.getByRole("button", { name: /^Parked/ })).toHaveFocus();
});

it("leaves focus where the user moved it before the snapshot lands", async () => {
  setup([1, 2, 3]);
  await using screen = await render(panel());
  await screen.getByRole("button", { name: "Mark done: item 1" }).click();
  await vi.waitFor(() => expect(state.update).toHaveBeenCalledOnce());
  const elsewhere = screen.getByRole("button", { name: "Edit: item 3" });
  await act(() => elsewhere.element().focus());
  await land(screen, [2, 3]);
  await expect.element(elsewhere).toHaveFocus();
});
