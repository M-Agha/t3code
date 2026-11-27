import {
  EnvironmentId,
  ThreadId,
  type ThreadDecisionsSnapshot,
  type ThreadParkedItem,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  snapshot: null as ThreadDecisionsSnapshot | null,
  // Every server command: an update (`input.id`) or a park (`input.items`).
  update: vi.fn(),
  // Add to draft: the composer takes the item's chip.
  attach: vi.fn(),
  // The items whose chips the composer's draft holds.
  inDraft: [] as ReadonlyArray<number>,
  // The composer edits a queued message.
  editingQueuedRun: false,
  // The composer answers a question the agent asked.
  answeringPendingInput: false,
}));
vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({ data: state.snapshot, error: null })) as never,
}));
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: (() => true) as never,
}));
// The markdown renderer reads the environment's atoms, which this file stubs to `true`; it is not
// what these tests are about.
vi.mock(import("../ChatMarkdown"), () => ({
  default: ((props: { readonly text: string }) => <p>{props.text}</p>) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => state.update) as never,
}));

import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { I18nProvider } from "~/i18n/I18nProvider";
import { startI18n, whenLocaleReady } from "~/i18n/runtime";
import { act, render, type Screen } from "../../../test/render";
import { toastManager } from "../ui/toast";
import { ThreadParkedPanel } from "./ThreadParked";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const actions = {
  canOperate: true,
  insert: () => true,
  sendDraft: async () => true,
  focusLine: () => {},
  removeLine: () => {},
  draft: "",
  get answeringPendingInput() {
    return state.answeringPendingInput;
  },
  get editingQueuedRun() {
    return state.editingQueuedRun;
  },
  inDraft: {},
  parked: {
    get inDraft() {
      return state.inDraft;
    },
    attach: (item: { readonly id: number; readonly text: string }) => state.attach(item),
  },
  reopen: { isPending: () => false, start: () => {} },
  dismiss: { isPending: () => false, start: () => {} },
  questionsHeld: false,
};

const item = (id: number, change: Partial<ThreadParkedItem> = {}): ThreadParkedItem => ({
  id,
  kind: "me",
  text: `item ${id}`,
  state: "open",
  parkedBy: "user",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  resolvedAt: null,
  ...change,
});

const done = (id: number): ThreadParkedItem => ({
  ...item(id),
  state: "done",
  updatedAt: "2026-01-01T00:01:00.000Z",
  resolvedAt: "2026-01-01T00:01:00.000Z",
});

const snapshotOf = (parked: ReadonlyArray<ThreadParkedItem>): ThreadDecisionsSnapshot => ({
  threadId: threadRef.threadId,
  questions: [],
  decidedWithoutAsking: [],
  openCount: 0,
  parked,
  parkedOpenCount: parked.length,
  artifacts: [],
  artifactCount: 0,
  lastTypedMessageRead: null,
  readBackCount: 0,
  readBack: null,
});

const panel = () => <ThreadParkedPanel threadRef={threadRef} actions={actions} />;

function setup(ids: ReadonlyArray<number>, items: ReadonlyArray<ThreadParkedItem> = []) {
  state.snapshot = snapshotOf([...ids.map((id) => item(id)), ...items]);
  state.update.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.attach.mockReset().mockReturnValue(true);
  state.inDraft = [];
  state.editingQueuedRun = false;
  state.answeringPendingInput = false;
}

const command = (input: Record<string, unknown>) => ({
  environmentId: threadRef.environmentId,
  input: { threadId: threadRef.threadId, ...input },
});

// Opens a row's "…" menu and picks an item from it.
async function pick(screen: Screen, text: string, action: string) {
  await screen.getByRole("button", { name: `Actions for: ${text}` }).click();
  await screen.getByRole("menuitem", { name: action }).click();
}

// The live snapshot lands without the open items the server resolved, and with those it lists as resolved.
async function land(
  screen: Screen,
  remaining: ReadonlyArray<number>,
  resolved: ReadonlyArray<number> = [],
) {
  state.snapshot = {
    ...snapshotOf(remaining.map((id) => item(id))),
    parked: [...remaining.map((id) => item(id)), ...resolved.map(done)],
  };
  await act(() => screen.rerender(panel()));
}

it("returns focus to the row's menu button after Escape in the inline editor", async () => {
  setup([1, 2]);
  await using screen = await render(panel());
  await pick(screen, "item 2", "Edit");
  await expect.element(screen.getByRole("textbox", { name: "Parked item text" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("button", { name: "Actions for: item 2" })).toHaveFocus();
  expect(state.update).not.toHaveBeenCalled();
});

it("returns focus to the row's menu button after Save in the inline editor", async () => {
  setup([1, 2]);
  await using screen = await render(panel());
  await pick(screen, "item 2", "Edit");
  await screen.getByRole("textbox", { name: "Parked item text" }).fill("item 2 edited");
  await screen.getByRole("button", { name: "Save", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "Actions for: item 2" })).toHaveFocus();
  expect(state.update).toHaveBeenCalledWith(
    command({ id: 2, action: "edit", text: "item 2 edited" }),
  );
});

it("moves focus to the next row once the snapshot drops the finished one", async () => {
  setup([1, 2, 3]);
  await using screen = await render(panel());
  await pick(screen, "item 2", "Mark done");
  await vi.waitFor(() => expect(state.update).toHaveBeenCalledOnce());
  await land(screen, [1, 3]);
  await expect.element(screen.getByRole("button", { name: "Actions for: item 3" })).toHaveFocus();
});

it("moves focus past a next row another client resolved meanwhile, to the nearest left", async () => {
  setup([1, 2, 3, 4]);
  await using screen = await render(panel());
  await pick(screen, "item 2", "Mark done");
  await vi.waitFor(() => expect(state.update).toHaveBeenCalledOnce());
  await land(screen, [1, 4], [2, 3]);
  await expect.element(screen.getByRole("button", { name: "Actions for: item 4" })).toHaveFocus();
});

it("moves focus to the surface, not the finished row's menu, when the last open row is done", async () => {
  setup([1]);
  await using screen = await render(panel());
  await pick(screen, "item 1", "Mark done");
  await vi.waitFor(() => expect(state.update).toHaveBeenCalledOnce());
  await land(screen, [], [1]);
  await expect.element(screen.getByRole("region", { name: "Parked items" })).toHaveFocus();
});

it("moves focus to the surface itself when the last open row leaves and nothing is left", async () => {
  setup([1]);
  await using screen = await render(panel());
  await pick(screen, "item 1", "Drop");
  await vi.waitFor(() => expect(state.update).toHaveBeenCalledOnce());
  await land(screen, []);
  await expect.element(screen.getByRole("region", { name: "Parked items" })).toHaveFocus();
});

it("leaves focus where the user moved it before the snapshot lands", async () => {
  setup([1, 2, 3]);
  await using screen = await render(panel());
  await pick(screen, "item 1", "Mark done");
  await vi.waitFor(() => expect(state.update).toHaveBeenCalledOnce());
  const elsewhere = screen.getByRole("button", { name: "Actions for: item 3" });
  await act(() => elsewhere.element().focus());
  await land(screen, [2, 3]);
  await expect.element(elsewhere).toHaveFocus();
});

it("groups rows as Open and Resolved, with counts, and folds Resolved", async () => {
  setup(
    [],
    [
      item(1, { kind: "agent" }),
      item(2, { kind: "me", parkedBy: "agent" }),
      item(4, { kind: "agent", state: "done", resolvedAt: "2026-01-01T00:04:00.000Z" }),
      // Sent by a message carrying its chip, or (an older row) by the old Send button.
      item(5, { kind: "agent", state: "sent", resolvedAt: "2026-01-01T00:05:00.000Z" }),
    ],
  );
  state.inDraft = [1];
  await using screen = await render(panel());
  for (const [group, rows] of [
    ["Open 2", ["item 1", "item 2"]],
    ["Resolved 2", ["item 4", "item 5"]],
  ] as const) {
    const section = screen.getByRole("region", { name: group });
    for (const row of rows) await expect.element(section.getByText(row)).toBeVisible();
  }
  await expect.element(screen.getByRole("region", { name: /In progress/ })).not.toBeInTheDocument();
  await expect.element(screen.getByText(/for the agent · by you · In draft/)).toBeVisible();
  await expect.element(screen.getByText("for me · by the agent")).toBeVisible();
  await expect.element(screen.getByText("Done · for the agent")).toBeVisible();
  await expect.element(screen.getByText("Sent · for the agent")).toBeVisible();
  // A Sent item offers Reopen.
  await pick(screen, "item 5", "Reopen");
  await vi.waitFor(() =>
    expect(state.update).toHaveBeenCalledWith(command({ id: 5, action: "reopen" })),
  );
  const fold = screen.getByRole("button", { name: "Resolved 2" });
  await fold.click();
  await expect.element(fold).toHaveAttribute("aria-expanded", "false");
  await expect.element(screen.getByText("item 4")).not.toBeInTheDocument();
});

it("adds an item's chip to the draft, In draft while the composer holds it", async () => {
  setup([], [item(1, { kind: "agent" })]);
  await using screen = await render(panel());
  await screen.getByRole("button", { name: "Add to draft: item 1" }).click();
  // The composer takes the chip; the server hears of nothing until a message carries it.
  expect(state.attach).toHaveBeenCalledWith(expect.objectContaining({ id: 1, text: "item 1" }));
  expect(state.update).not.toHaveBeenCalled();
  state.inDraft = [1];
  await act(() => screen.rerender(panel()));
  await expect.element(screen.getByText(/for the agent · by you · In draft/)).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Add to draft: item 1" }))
    .not.toBeInTheDocument();
  // The button that had focus is gone: focus goes to the row's menu, not the page.
  await expect.element(screen.getByRole("button", { name: "Actions for: item 1" })).toHaveFocus();
  // The chip deleted from the composer: Open again, and Add to draft is back.
  state.inDraft = [];
  await act(() => screen.rerender(panel()));
  await expect.element(screen.getByText(/In draft/)).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Add to draft: item 1" })).toBeVisible();
});

// The lock (Q56): while its chip is in the draft, nothing changes the item's words or state, so no chip
// ever holds words its item no longer has.
it("locks an item whose chip is in the draft, saying why, and frees it once the chip goes", async () => {
  setup([], [item(1, { kind: "agent" })]);
  state.inDraft = [1];
  await using screen = await render(panel());
  await expect.element(screen.getByText(/for the agent · by you · In draft/)).toBeVisible();
  await screen.getByRole("button", { name: "Actions for: item 1" }).click();
  for (const name of ["Edit", "Mark done", "Move to For me", "Drop"]) {
    const action = screen.getByRole("menuitem", { name, exact: true });
    // Focusable and unavailable, with the reason on screen and as its description.
    await expect.element(action).toHaveAttribute("aria-disabled", "true");
    await expect
      .element(action)
      .toHaveAccessibleDescription("remove the chip from your draft first");
    expect(action.element().textContent).toContain("remove the chip from your draft first");
    // A DOM click: the test driver itself refuses to click an aria-disabled control.
    action.element().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
  await expect
    .element(screen.getByRole("textbox", { name: "Parked item text" }))
    .not.toBeInTheDocument();
  expect(state.update).not.toHaveBeenCalled();
  // Copy text stays.
  await expect
    .element(screen.getByRole("menuitem", { name: "Copy text" }))
    .not.toHaveAttribute("aria-disabled");
  await userEvent.keyboard("{Escape}");

  // The chip deleted from the composer: every action is back.
  state.inDraft = [];
  await act(() => screen.rerender(panel()));
  await pick(screen, "item 1", "Edit");
  await expect.element(screen.getByRole("textbox", { name: "Parked item text" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await pick(screen, "item 1", "Move to For me");
  await vi.waitFor(() =>
    expect(state.update).toHaveBeenCalledWith(command({ id: 1, action: "move", kind: "me" })),
  );
});

// An editor opened before the chip went in (an undo in the composer brought it back) cannot Save.
it("holds an open editor's Save while the item's chip is in the draft", async () => {
  setup([], [item(1, { kind: "agent" })]);
  await using screen = await render(panel());
  await pick(screen, "item 1", "Edit");
  const text = screen.getByRole("textbox", { name: "Parked item text" });
  await text.fill("item 1 edited");
  state.inDraft = [1];
  await act(() => screen.rerender(panel()));
  // Cmd/Ctrl+Enter saves nothing either, and the field says why (Opus r4, C5).
  await expect.element(text).toHaveAccessibleDescription("remove the chip from your draft first");
  await userEvent.keyboard("{ControlOrMeta>}{Enter}{/ControlOrMeta}");
  const save = screen.getByRole("button", { name: "Save", exact: true });
  await expect.element(save).toHaveAttribute("aria-disabled", "true");
  await expect.element(save).toHaveAccessibleDescription("remove the chip from your draft first");
  save.element().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(state.update).not.toHaveBeenCalled();
});

// A disabled button takes no hover or focus, so its tooltip could never say why (Opus round 1, O6).
it("offers no Add to draft while the composer edits a queued message, and says why", async () => {
  setup([], [item(1, { kind: "agent" })]);
  state.editingQueuedRun = true;
  await using screen = await render(panel());
  const add = screen.getByRole("button", { name: "Add to draft: item 1" });
  await expect.element(add).toHaveAttribute("aria-disabled", "true");
  // A screen reader hears why without the tooltip, which Base UI links to nothing (Opus round 2, O1).
  await expect.element(add).toHaveAccessibleDescription("finish editing the queued message first");
  await add.hover();
  await expect
    .element(screen.getByText("Add to draft: finish editing the queued message first"))
    .toBeVisible();
  // A DOM click: the test driver itself refuses to click an aria-disabled control.
  add.element().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(state.attach).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Actions for: item 1" }).click();
  // The menu's Add to draft is blocked as the lock holds an action: the reason is its description.
  const menuItem = screen.getByRole("menuitem", { name: "Add to draft", exact: true });
  await expect.element(menuItem).toHaveAttribute("aria-disabled", "true");
  await expect
    .element(menuItem)
    .toHaveAccessibleDescription("finish editing the queued message first");
  expect(menuItem.element().textContent).toContain("finish editing the queued message first");
  menuItem.element().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(state.attach).not.toHaveBeenCalled();
});

it("offers no Add to draft while the composer answers the agent's question, and says why", async () => {
  setup([], [item(1, { kind: "agent" })]);
  state.answeringPendingInput = true;
  await using screen = await render(panel());
  const add = screen.getByRole("button", { name: "Add to draft: item 1" });
  await expect.element(add).toHaveAttribute("aria-disabled", "true");
  await expect.element(add).toHaveAccessibleDescription("answer the agent's question first");
  await add.hover();
  await expect
    .element(screen.getByText("Add to draft: answer the agent's question first"))
    .toBeVisible();
});

it("reads the older kind word a server from before the rename sends", async () => {
  setup([], [item(1, { kind: "prompt" })]);
  await using screen = await render(panel());
  await screen.getByRole("button", { name: "Add to draft: item 1" }).click();
  expect(state.attach).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
});

it("offers an item for me no draft, and moves it to the agent", async () => {
  setup([1]);
  await using screen = await render(panel());
  await expect
    .element(screen.getByRole("button", { name: "Add to draft: item 1" }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Actions for: item 1" }).click();
  await expect
    .element(screen.getByRole("menuitem", { name: "Add to draft" }))
    .not.toBeInTheDocument();
  await screen.getByRole("menuitem", { name: "Move to For the agent" }).click();
  await vi.waitFor(() =>
    expect(state.update).toHaveBeenCalledWith(command({ id: 1, action: "move", kind: "agent" })),
  );
});

it("opens the same menu on a right-click, and reopens a resolved row", async () => {
  setup([], [done(4)]);
  await using screen = await render(panel());
  await screen.getByText("item 4").click({ button: "right" });
  await screen.getByRole("menuitem", { name: "Reopen" }).click();
  await vi.waitFor(() =>
    expect(state.update).toHaveBeenCalledWith(command({ id: 4, action: "reopen" })),
  );
});

it("keeps focus on a reopened row as it moves from Resolved to Open", async () => {
  setup([1], [done(4)]);
  await using screen = await render(panel());
  await pick(screen, "item 4", "Reopen");
  await vi.waitFor(() => expect(state.update).toHaveBeenCalledOnce());
  await expect.element(screen.getByRole("button", { name: "Actions for: item 4" })).toHaveFocus();
  state.snapshot = snapshotOf([item(1), item(4, { updatedAt: "2026-01-01T00:02:00.000Z" })]);
  await act(() => screen.rerender(panel()));
  await expect.element(screen.getByRole("region", { name: "Open 2" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Actions for: item 4" })).toHaveFocus();
});

it("leaves the page's focus alone once the user moved it out of the list", async () => {
  setup([1, 2]);
  await using screen = await render(panel());
  await screen.getByRole("button", { name: "Actions for: item 2" }).click();
  await userEvent.keyboard("{Escape}");
  await screen.getByRole("textbox", { name: "Park something" }).click();
  await act(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  state.snapshot = snapshotOf([item(1), item(2, { updatedAt: "2026-01-01T00:03:00.000Z" })]);
  await act(() => screen.rerender(panel()));
  expect(document.activeElement).toBe(document.body);
});

it("parks from the add field: Enter parks, Shift+Enter is a new line, refusals show inline", async () => {
  setup([]);
  await using screen = await render(panel());
  await expect.element(screen.getByText("Nothing parked")).toBeVisible();
  const field = screen.getByRole("textbox", { name: "Park something" });
  await field.click();
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByText("Nothing to park.")).toBeVisible();
  expect(state.update).not.toHaveBeenCalled();
  await userEvent.keyboard("first line{Shift>}{Enter}{/Shift}second line");
  await expect.element(field).toHaveValue("first line\nsecond line");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(state.update).toHaveBeenCalledWith(
      // The older word, so a server from before the rename takes it too.
      command({ items: [{ kind: "prompt", text: "first line\nsecond line" }] }),
    ),
  );
  await expect.element(field).toHaveValue("");

  // For me, and the server's refusal under the field.
  state.update.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(new Error("not parked: the text is empty or a placeholder.")),
  });
  // Real radios: one is checked, and the other takes the choice.
  await expect.element(screen.getByRole("radio", { name: "For the agent" })).toBeChecked();
  await screen.getByRole("radio", { name: "For me" }).click();
  await expect.element(screen.getByRole("radio", { name: "For me" })).toBeChecked();
  await expect.element(screen.getByRole("radio", { name: "For the agent" })).not.toBeChecked();
  await field.fill("TBD");
  await screen.getByRole("button", { name: "Park", exact: true }).click();
  await vi.waitFor(() =>
    expect(state.update).toHaveBeenLastCalledWith(
      command({ items: [{ kind: "todo", text: "TBD" }] }),
    ),
  );
  await expect.element(field).toHaveValue("TBD");
  // Announced as it appears.
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("not parked: the text is empty or a placeholder.");
});

it("keeps an open editor where it was, focused and holding its text, as a send marks it Sent", async () => {
  const editedItem = item(1, { kind: "agent" });
  setup([], [editedItem, done(9)]);
  await using screen = await render(panel());
  // Resolved folded: a row moving there would be out of sight.
  await screen.getByRole("button", { name: "Resolved 1" }).click();
  await pick(screen, "item 1", "Edit");
  const editor = screen.getByRole("textbox", { name: "Parked item text" });
  await editor.fill("item 1, and its index");
  await expect.element(editor).toHaveFocus();
  // Another client's message carrying it is recorded: Sent.
  const sent = "2026-01-01T00:03:00.000Z";
  state.snapshot = snapshotOf([
    { ...editedItem, state: "sent", resolvedAt: sent, updatedAt: sent },
    done(9),
  ]);
  await act(() => screen.rerender(panel()));
  // Still in its group, the same field, focused, with what was typed.
  const open = screen.getByRole("region", { name: "Open 1" });
  await expect.element(open.getByRole("textbox", { name: "Parked item text" })).toHaveFocus();
  await expect.element(editor).toHaveValue("item 1, and its index");
  await screen.getByRole("button", { name: "Save", exact: true }).click();
  await vi.waitFor(() =>
    expect(state.update).toHaveBeenCalledWith(
      command({ id: 1, action: "edit", text: "item 1, and its index" }),
    ),
  );
});

it("keeps a row busy after a Save until the snapshot shows it", async () => {
  setup([1]);
  await using screen = await render(panel());
  await pick(screen, "item 1", "Edit");
  await screen.getByRole("button", { name: "Save", exact: true }).click();
  await vi.waitFor(() => expect(state.update).toHaveBeenCalledOnce());
  await expect
    .element(screen.getByRole("button", { name: "Actions for: item 1" }))
    .toHaveAttribute("aria-disabled", "true");
});

it("moves the For the agent / For me choice with the arrow keys, as radios do", async () => {
  setup([]);
  await using screen = await render(panel());
  const agent = screen.getByRole("radio", { name: "For the agent" });
  await act(() => agent.element().focus());
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(screen.getByRole("radio", { name: "For me" })).toBeChecked();
  await expect.element(screen.getByRole("radio", { name: "For me" })).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(agent).toBeChecked();
  const field = screen.getByRole("textbox", { name: "Park something" });
  await field.fill("Rename the table");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(state.update).toHaveBeenCalledWith(
      command({ items: [{ kind: "prompt", text: "Rename the table" }] }),
    ),
  );
});

it("keeps words typed while a park is in flight", async () => {
  setup([]);
  let finish = (_: unknown) => {};
  state.update.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
  await using screen = await render(panel());
  const field = screen.getByRole("textbox", { name: "Park something" });
  await field.fill("first thought");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(state.update).toHaveBeenCalledOnce());
  await field.fill("second thought");
  await act(() => finish({ _tag: "Success", value: undefined }));
  await expect.element(field).toHaveValue("second thought");
});

// A copy the browser refuses says so, as upstream's copy actions do, with the msg() sentence.
it("says when Copy text fails", async () => {
  setup([1]);
  const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
  try {
    await using screen = await render(panel());
    await pick(screen, "item 1", "Copy text");
    await vi.waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "Failed to copy",
          description: "Failed to copy text to the clipboard.",
        }),
      ),
    );
    expect(write).toHaveBeenCalledWith("item 1");
  } finally {
    add.mockRestore();
    write.mockRestore();
  }
});

// A status upstream's catalogs translate (Done) follows the app's language, through msg() and
// useMessages; the rest of the panel's own copy is English only (FORK.md, "Translation").
it("says a status in the app's language when upstream's catalogs translate it", async () => {
  setup([], [done(4)]);
  // Switches the app to French as its Language setting does, and back to English after.
  const speak = (language: string) =>
    act(async () => {
      __setClientSettingsForTests({
        ...DEFAULT_CLIENT_SETTINGS,
        onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
        language,
      });
      startI18n();
      await whenLocaleReady();
    });
  await speak("fr");
  try {
    await using screen = await render(<I18nProvider>{panel()}</I18nProvider>);
    await expect.element(screen.getByText("Terminé · for me")).toBeVisible();
  } finally {
    await speak("en");
  }
});
