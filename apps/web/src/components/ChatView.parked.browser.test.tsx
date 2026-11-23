// Fork (Parked): the parked chip through the real composer (Opus round 1, O4): Add to draft, delete and
// undo, the chip left alone by changes from elsewhere (the lock), the undo gate's wiring, the send's
// record, a closing fence, and stash and paste leaving no chip without its record. The gate's conditions
// themselves are `parkedChipRestorable`'s (threadDecisions.logic.test.ts). FORK.md, "Parked items".
import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type OrchestrationV2Command,
  type ThreadDecisionsSnapshot,
  type ThreadParkedItem,
  WS_METHODS,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  collectComposerContextReferences,
  projectComposerContextForProvider,
} from "@t3tools/shared/composerContextReferences";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it here keeps its first transform out of the timeout.
import "~/components/ChatView";
import {
  addPreparingComposerImages,
  removePreparingComposerImages,
} from "~/components/chat/preparingComposerImages";
import { ariaItemText } from "~/components/chat/threadDecisions.logic";
import { composerTargetKey, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { usePromptStashStore } from "~/promptStashStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  answerRpc,
  answerStreamRpc,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const AT = "2026-01-01T00:00:00.000Z";
const item = (change: Partial<ThreadParkedItem> = {}): ThreadParkedItem => ({
  id: 7,
  // The server says kinds in the older word.
  kind: "prompt",
  text: "Add a doctor check",
  state: "open",
  parkedBy: "user",
  createdAt: AT,
  updatedAt: AT,
  resolvedAt: null,
  ...change,
});

/** Opens a thread with the Parked tab showing `parked`; `push` sends the server's next snapshot. */
async function openThread(name: string, ...parked: ReadonlyArray<ThreadParkedItem>) {
  const thread = threadWithHistory(name, 1);
  const environment = installFakeEnvironment([thread], { acceptCommands: true });
  const threadRef = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  const snapshotOf = (rows: ReadonlyArray<ThreadParkedItem>): ThreadDecisionsSnapshot => ({
    threadId: thread.id,
    questions: [],
    decidedWithoutAsking: [],
    openCount: 0,
    parked: rows,
    parkedOpenCount: rows.filter((row) => row.state === "open").length,
    artifacts: [],
    artifactCount: 0,
    lastTypedMessageRead: null,
  });
  const decisions = answerStreamRpc(WS_METHODS.threadDecisionsSubscribe, snapshotOf(parked));
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: AT,
  });
  // Wide enough that the right panel docks beside the chat instead of covering it as a sheet.
  await page.viewport(1400, 900);
  useRightPanelStore.getState().open(threadRef, "parked");
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  const app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();
  const draft = () => useComposerDraftStore.getState().getComposerDraft(threadRef);
  return {
    threadRef,
    draft,
    // The text's parked chips, as a send would carry them.
    chips: () =>
      collectComposerContextReferences(draft()?.prompt ?? "").filter(
        (reference) => reference.kind === "parked",
      ),
    push: (...rows: ReadonlyArray<ThreadParkedItem>) => decisions.push(snapshotOf(rows)),
    [Symbol.asyncDispose]: async () => {
      await app[Symbol.asyncDispose]();
      decisions[Symbol.dispose]();
      environment[Symbol.dispose]();
    },
  };
}

const editor = () => page.getByTestId("composer-editor");

async function addToDraft(text = "Add a doctor check") {
  await userEvent.click(page.getByRole("button", { name: `Add to draft: ${text}` }));
}

it("carries an added item's record in the send, and an undo after a delete brings it back", async () => {
  await using view = await openThread("thread-parked-send", item());
  await addToDraft();
  await vi.waitFor(() =>
    expect(view.draft()?.parkedContexts.map((record) => record.payload)).toEqual([
      { itemId: 7, threadId: view.threadRef.threadId, text: "Add a doctor check" },
    ]),
  );
  await expect.element(page.getByText(/In draft/)).toBeVisible();

  // Deleting the chip in the composer takes the item out of the draft; undo puts it back.
  await userEvent.click(editor());
  await userEvent.keyboard("{End}{Backspace}{Backspace}");
  await vi.waitFor(() => expect(view.draft()?.parkedContexts ?? []).toEqual([]));
  await expect.element(page.getByText(/In draft/)).not.toBeInTheDocument();
  await userEvent.keyboard("{ControlOrMeta>}z{/ControlOrMeta}");
  await vi.waitFor(() => expect(view.draft()?.parkedContexts).toHaveLength(1));

  await userEvent.keyboard("{End} please");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(dispatchedCommands().map((command) => command.type)).toContain("message.dispatch"),
  );
  const sent = dispatchedCommands().find(
    (command): command is Extract<OrchestrationV2Command, { type: "message.dispatch" }> =>
      command.type === "message.dispatch",
  );
  expect(sent?.text).toContain("(t3-context://v1/parked/parked_7)");
  expect(sent?.context?.records).toEqual([
    {
      version: 1,
      kind: "parked",
      contextId: "parked_7",
      label: "Add a doctor check",
      payload: { itemId: 7, threadId: view.threadRef.threadId, text: "Add a doctor check" },
    },
  ]);
});

// Astra on #7, findings 4 and 5: ChatView's own wiring, not RightPanelTabs' with counts injected.
it("counts the strip's Parked tab from the snapshot, and /park's toast takes no fixed colour", async () => {
  const parks: unknown[] = [];
  using _park = answerRpc(WS_METHODS.threadDecisionsPark, (input: never) => {
    parks.push(input);
    return Effect.void;
  });
  await using view = await openThread(
    "thread-parked-count",
    item(),
    item({ id: 8, state: "done", resolvedAt: AT }),
  );
  await expect.element(page.getByRole("button", { name: "Parked, 1", exact: true })).toBeVisible();
  view.push(item(), item({ id: 9, text: "Second" }));
  await expect.element(page.getByRole("button", { name: "Parked, 2", exact: true })).toBeVisible();

  await userEvent.click(editor());
  await userEvent.keyboard("/park me fix the flaky test");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(parks).toHaveLength(1));
  await expect.element(page.getByText("In this thread's Parked tab.")).toBeVisible();
  // Base UI marks a typed toast `data-type`, which colours its icon with the fixed success green.
  expect(document.querySelector('[data-slot="toast-icon"]')).toBeNull();
});

// 5124 review, F1: upstream stopped holding a send for compressing images except for question answers,
// so `/park` counts them itself, as upstream's /usage guard does.
it("refuses /park while an image is still compressing", async () => {
  const parks: unknown[] = [];
  using _park = answerRpc(WS_METHODS.threadDecisionsPark, (input: never) => {
    parks.push(input);
    return Effect.void;
  });
  await using view = await openThread("thread-parked-preparing");
  const key = composerTargetKey(view.threadRef);
  addPreparingComposerImages(key, [
    {
      id: "pasted",
      name: "shot.png",
      file: new File(["png"], "shot.png", { type: "image/png" }),
      hidden: false,
    },
  ]);
  using _preparing = {
    [Symbol.dispose]: () => removePreparingComposerImages(key, new Set(["pasted"])),
  };

  await userEvent.click(editor());
  await userEvent.keyboard("/park me fix the flaky test");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("Parked items take text only")).toBeVisible();
  expect(parks).toEqual([]);
});

// Opus r5, C1: the reason is beside `restoresParkedChip` (ChatComposer.tsx).
it("brings back a long item's chip on undo when its 200th character is a space", async () => {
  const text = `${"a".repeat(199)} ${"b".repeat(50)}`;
  await using view = await openThread("thread-parked-long", item({ text }));
  await addToDraft(ariaItemText(text));
  await vi.waitFor(() => expect(view.chips()).toHaveLength(1));
  await userEvent.click(editor());
  await userEvent.keyboard("{End}{Backspace}{Backspace}");
  await vi.waitFor(() => expect(view.draft()?.parkedContexts ?? []).toEqual([]));
  await userEvent.keyboard("{ControlOrMeta>}z{/ControlOrMeta}");
  await vi.waitFor(() =>
    expect(view.draft()?.parkedContexts.map((record) => record.payload.text)).toEqual([text]),
  );
  expect(view.chips()).toHaveLength(1);
});

// The Q56 guard: nothing rewrites a drafted chip (the lock replaced a sync that did). An edit or
// resolution from another client shows in the row; the chip keeps the words its sender saw until they
// remove it or send.
it("Q56: leaves a drafted chip as it is when its item changes in another client", async () => {
  await using view = await openThread("thread-parked-elsewhere", item());
  await addToDraft();
  await vi.waitFor(() => expect(view.chips()).toHaveLength(1));
  const prompt = view.draft()?.prompt;
  await view.push(
    item({ text: "Add a doctor check for the notch", updatedAt: "2026-01-01T00:01:00.000Z" }),
  );
  await expect.element(page.getByText("Add a doctor check for the notch")).toBeVisible();
  await view.push(item({ state: "done", updatedAt: "2026-01-01T00:02:00.000Z", resolvedAt: AT }));
  await expect.element(page.getByText(/Done · for the agent/)).toBeVisible();
  expect(view.draft()?.prompt).toBe(prompt);
  expect(view.draft()?.parkedContexts.map((record) => record.payload.text)).toEqual([
    "Add a doctor check",
  ]);
});

// An undo brings a deleted chip back only while its item is Open with the chip's words; else the chip
// stays out, its reference with it, so the agent is sent no unavailable marker (Sol round 2, S3), and
// the caret maps through the deletion (Opus round 3, #1).
it("leaves a deleted chip out of an undo once its item was edited", async () => {
  await using view = await openThread("thread-parked-undo", item());
  await addToDraft();
  await vi.waitFor(() => expect(view.chips()).toHaveLength(1));
  await userEvent.click(editor());
  await userEvent.keyboard("{End}tail");
  await vi.waitFor(() => expect(view.draft()?.prompt).toMatch(/\) tail$/));
  // Forward-delete the chip from the start of the line.
  await userEvent.keyboard("{Home}{Delete}");
  await vi.waitFor(() => expect(view.chips()).toEqual([]));
  await view.push(item({ text: "Notch check", updatedAt: "2026-01-01T00:01:00.000Z" }));
  await vi.waitFor(() => expect(page.getByText(/In draft/).query()).toBeNull());

  await userEvent.keyboard("{ControlOrMeta>}z{/ControlOrMeta}");
  await userEvent.keyboard("X");
  await vi.waitFor(() => expect(view.draft()?.prompt).toBe("Xtail"));
  expect(view.chips()).toEqual([]);
  expect(view.draft()?.parkedContexts ?? []).toEqual([]);
  expect(
    projectComposerContextForProvider({
      text: view.draft()?.prompt ?? "",
      records: view.draft()?.parkedContexts ?? [],
    }),
  ).not.toContain("unavailable");
});

// Opus r4, C1: a later chip of the same item replaces the record kept for a deleted one, so the gate
// holds the returning chip's label to that record's: the older chip, with older words, stays out.
it("leaves an older chip out of an undo once a newer chip of its item replaced its record", async () => {
  await using view = await openThread("thread-parked-relabel", item());
  await addToDraft();
  await vi.waitFor(() => expect(view.chips()).toHaveLength(1));
  await userEvent.click(editor());
  await userEvent.keyboard("{End}{Backspace}{Backspace}");
  await vi.waitFor(() => expect(view.chips()).toEqual([]));
  await view.push(item({ text: "Notch check", updatedAt: "2026-01-01T00:01:00.000Z" }));
  await addToDraft("Notch check");
  await vi.waitFor(() => expect(view.chips().map((chip) => chip.label)).toEqual(["Notch check"]));

  await userEvent.click(editor());
  // The first undo takes the newer chip out, the second brings the older one back: the gate refuses it.
  await userEvent.keyboard("{ControlOrMeta>}z{/ControlOrMeta}");
  await vi.waitFor(() => expect(view.chips()).toEqual([]));
  await userEvent.keyboard("{ControlOrMeta>}z{/ControlOrMeta}");
  await userEvent.keyboard("X");
  await vi.waitFor(() => expect(view.draft()?.prompt).toContain("X"));
  expect(view.chips()).toEqual([]);
  expect(view.draft()?.parkedContexts ?? []).toEqual([]);
});

// Opus r4, C2: two chips refused at once, one space apart and the second against the text, both claim
// that space; the deletion keeps every character of the text.
it("keeps the text beside two chips an undo leaves out together", async () => {
  await using view = await openThread(
    "thread-parked-two",
    item(),
    item({ id: 8, text: "Bump the runner" }),
  );
  await addToDraft();
  await addToDraft("Bump the runner");
  await vi.waitFor(() => expect(view.chips()).toHaveLength(2));
  await userEvent.click(editor());
  await userEvent.keyboard("{End}{Backspace}x");
  await vi.waitFor(() => expect(view.draft()?.prompt).toMatch(/\)x$/));
  await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}{Backspace}");
  await vi.waitFor(() => expect(view.draft()?.prompt ?? "").toBe(""));
  await vi.waitFor(() => expect(view.draft()?.parkedContexts ?? []).toEqual([]));
  await view.push(
    item({ state: "done", updatedAt: "2026-01-01T00:01:00.000Z", resolvedAt: AT }),
    item({ id: 8, text: "Bump the CI runner", updatedAt: "2026-01-01T00:01:00.000Z" }),
  );
  await expect.element(page.getByText("Bump the CI runner")).toBeVisible();

  await userEvent.keyboard("{ControlOrMeta>}z{/ControlOrMeta}");
  await vi.waitFor(() => expect(view.draft()?.prompt).toBe("x"));
  expect(view.draft()?.parkedContexts ?? []).toEqual([]);
});

// Sol round 3, S4: after a closing fence the chip goes on a line of its own, outside the block.
it("adds a chip after a closing code fence below the block, not on the fence line", async () => {
  await using view = await openThread("thread-parked-fence", item());
  const fenced = "Look:\n```ts\nconst a = 1;\n```";
  useComposerDraftStore.getState().setPrompt(view.threadRef, fenced);
  await vi.waitFor(() => expect(editor().element().querySelector("pre")).not.toBeNull());
  await addToDraft();
  await vi.waitFor(() => expect(view.chips()).toHaveLength(1));
  expect(view.draft()?.prompt).toMatch(/^Look:\n```ts\nconst a = 1;\n```\n\[Add a doctor check\]/);
  const pre = editor().element().querySelector("pre");
  expect(pre?.textContent).toBe("const a = 1;");
  expect(editor().element().textContent).toContain("Add a doctor check");
});

it("leaves no parked chip without its record after a stash restore or a paste", async () => {
  await using view = await openThread("thread-parked-stash", item());
  await addToDraft();
  await vi.waitFor(() => expect(view.chips()).toHaveLength(1));
  await userEvent.click(editor());
  await userEvent.keyboard("{End}soon");

  // Stash and restore: the stash keeps no parked record, so the chip goes with it.
  await userEvent.keyboard("{ControlOrMeta>}s{/ControlOrMeta}");
  await vi.waitFor(() => expect(usePromptStashStore.getState().entries).toHaveLength(1));
  await vi.waitFor(() => expect(view.draft()?.parkedContexts ?? []).toEqual([]));
  await userEvent.keyboard("{ControlOrMeta>}s{/ControlOrMeta}");
  await vi.waitFor(() => expect(editor().element().textContent).toContain("soon"));
  expect(view.chips()).toEqual([]);

  // A pasted chip brings no record either, and one already in the draft stays single.
  await addToDraft();
  await vi.waitFor(() => expect(view.chips()).toHaveLength(1));
  const clipboardData = new DataTransfer();
  clipboardData.setData(
    "text/plain",
    "[Add a doctor check](t3-context://v1/parked/parked_7) twice",
  );
  const editable =
    editor().element().querySelector('[contenteditable="true"]') ?? editor().element();
  editable.dispatchEvent(new ClipboardEvent("paste", { clipboardData, cancelable: true }));
  await vi.waitFor(() => expect(editor().element().textContent).toContain("twice"));
  expect(view.chips()).toHaveLength(1);
  expect(view.draft()?.parkedContexts).toHaveLength(1);

  // Paste-to-focus (upstream's `pasteTextAtEnd`, since 5319): with the composer blurred, a paste on the
  // page goes to the draft's end and drops its parked chip the same way.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  const stray = new DataTransfer();
  stray.setData("text/plain", "[Add a doctor check](t3-context://v1/parked/parked_7) stray");
  document.body.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: stray, bubbles: true, cancelable: true }),
  );
  await vi.waitFor(() => expect(view.draft()?.prompt).toContain("stray"));
  expect(view.draft()?.prompt.match(/t3-context:\/\/v1\/parked\//g)).toHaveLength(1);
  expect(view.chips()).toHaveLength(1);
  expect(view.draft()?.parkedContexts).toHaveLength(1);

  // A drop goes through the paste's insertClipboardText (upstream's handleDrop, since 5191): a drop
  // of chips alone adds nothing, and a chip dropped with text leaves only the text.
  const drop = (text: string) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", text);
    const box = editable.getBoundingClientRect();
    editable.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer,
        clientX: box.left + 4,
        clientY: box.bottom - 1,
        bubbles: true,
        cancelable: true,
      }),
    );
  };
  drop("[Add a doctor check](t3-context://v1/parked/parked_7)");
  drop("[Add a doctor check](t3-context://v1/parked/parked_7) dropped");
  await vi.waitFor(() => expect(view.draft()?.prompt).toContain("dropped"));
  expect(view.draft()?.prompt.match(/t3-context:\/\/v1\/parked\//g)).toHaveLength(1);
  expect(view.chips()).toHaveLength(1);
  expect(view.draft()?.parkedContexts).toHaveLength(1);

  // Into a fenced code block it stays verbatim, link and all: since 5332 a reference inside a closed fence
  // is literal text, never context, and marks nothing sent (the owner's Q1, 2026-11-27).
  await userEvent.click(editor());
  await userEvent.keyboard("{End}{Shift>}{Enter}{/Shift}```{Enter}");
  await vi.waitFor(() => expect(editable.querySelector("pre")).not.toBeNull());
  const fenced = new DataTransfer();
  fenced.setData("text/plain", "[Add a doctor check](t3-context://v1/parked/parked_7) fenced");
  editable.dispatchEvent(new ClipboardEvent("paste", { clipboardData: fenced, cancelable: true }));
  await vi.waitFor(() => expect(editable.querySelector("pre")?.textContent).toContain("fenced"));
  expect(editable.querySelector("pre")?.textContent).toContain(
    "[Add a doctor check](t3-context://v1/parked/parked_7) fenced",
  );
  expect(view.chips()).toHaveLength(1);
  expect(view.draft()?.parkedContexts).toHaveLength(1);
  expect(
    collectComposerContextReferences(view.draft()?.prompt ?? "").filter(
      (reference) => reference.kind === "parked",
    ),
  ).toHaveLength(1);
});

// Opus on #12 (r1 C4, r2, r3), MAIN-105 and MAIN-114: a side chat (in its parent's pane, and at its
// own URL), a delegate_task subagent and a workflow run's agent step park nowhere. The side chat is older settled, as upstream's tab test
// has it, so it loads in any place but the file's first: run alone (-t or .only), it fails falsely.
it.each([
  ["side chat in its parent's pane", "parent"],
  ["side chat opened at its own URL", "side"],
  ["subagent opened at its own URL", "subagent"],
  ["workflow step opened at its own URL", "workflowStep"],
] as const)("refuses /park in a %s, whose menu offers no /park", async (_name, route) => {
  const parent = threadWithHistory(`parked-${route}-parent`, 1);
  const child =
    route === "subagent"
      ? { ...threadWithHistory("parked-subagent", 1), delegateOf: parent.id }
      : route === "workflowStep"
        ? { ...threadWithHistory("parked-workflow-step", 1), workflowStep: true as const }
        : {
            ...threadWithHistory(`parked-side-${route}`, 1),
            sideChatOf: parent.id,
            olderSettled: true as const,
          };
  const parks: unknown[] = [];
  using _park = answerRpc(WS_METHODS.threadDecisionsPark, (input: never) => {
    parks.push(input);
    return Effect.void;
  });
  await page.viewport(1400, 900);
  using _environment = installFakeEnvironment([parent, child]);
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, onboardingCompletedAt: AT });
  if (route === "parent") {
    useRightPanelStore.getState().openThread(scopeThreadRef(ENVIRONMENT_ID, parent.id), child.id);
  } else {
    useRightPanelStore.getState().show(scopeThreadRef(ENVIRONMENT_ID, child.id));
  }
  const shown = route === "parent" ? parent : child;
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${shown.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const childEditor = page.getByRole("textbox", { name: `Message ${child.title}`, exact: true });
  await userEvent.click(childEditor);
  await userEvent.keyboard("/");
  const menuItem = (id: string) => document.querySelector(`[data-composer-item-id="${id}"]`);
  await vi.waitFor(() => expect(menuItem("slash:model")).not.toBeNull());
  expect(menuItem("slash:park")).toBeNull();

  await userEvent.keyboard("park me fix the flaky test");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(
      page.getByText(
        {
          subagent: "A subagent can't park",
          workflowStep: "A workflow step can't park",
          parent: "A side chat can't park",
          side: "A side chat can't park",
        }[route],
      ),
    )
    .toBeVisible();
  expect(parks).toEqual([]);
  if (route !== "parent") {
    // Its own panel offers Tracker (Q) but no Parked (K), which the server would refuse.
    const launcher = page.getByLabelText("Open a surface", { exact: true });
    await expect
      .element(launcher)
      .toHaveAttribute("data-surface-launcher-keys", expect.stringContaining("Q"));
    expect(launcher.element().getAttribute("data-surface-launcher-keys")).not.toContain("K");
  }
});
