import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  MessageId,
  ThreadId,
  type ThreadDecisionQuestion,
  type ThreadDecisionsSnapshot,
  WS_METHODS,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it here keeps its first transform out of the timeout.
import "~/components/ChatView";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  answerRpc,
  answerStreamRpc,
  dispatchedCommands,
  emitThreadEvent,
  installFakeEnvironment,
  rejectPendingCommand,
  runningRun,
  threadWithHistory,
  threadWithQuestion,
  userItem,
  type FakeDriver,
  type FakeThread,
} from "../../../test/fakeEnvironment";
import { act, fakeTimers, render } from "../../../test/render";
import { toastManager } from "../ui/toast";
import type { ChatComposerHandle } from "./ChatComposer";
import { useDraftActions } from "./ThreadDecisions";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const open = (label: string, pick: string, reason: string): ThreadDecisionQuestion => ({
  label,
  keyWords: `${label} words`,
  question: `Settle ${label}?`,
  pick,
  reason,
  sourceMessageId: MessageId.make("reply"),
  askedAt: "2026-01-01T00:00:00.000Z",
  state: "open",
  answerText: null,
  answerMessageId: null,
  resolvedAt: null,
});

const snapshotFor = (
  thread: FakeThread,
  rows: Partial<Pick<ThreadDecisionsSnapshot, "questions" | "decidedWithoutAsking">> = {},
): ThreadDecisionsSnapshot => {
  const questions = rows.questions ?? [
    open("Q4", "yes", "it stopped cleanly"),
    open("Q5", "no", "nothing reads it"),
    open("Q6", "later", "not urgent"),
  ];
  return {
    threadId: thread.id,
    questions,
    decidedWithoutAsking: rows.decidedWithoutAsking ?? [],
    openCount: questions.filter((question) => question.state === "open").length,
    parked: [],
    parkedOpenCount: 0,
    artifacts: [],
    artifactCount: 0,
    lastTypedMessageRead: null,
  };
};

async function openThread(
  thread: FakeThread,
  options?: Parameters<typeof installFakeEnvironment>[1],
  rows?: Parameters<typeof snapshotFor>[1],
  others: ReadonlyArray<FakeThread> = [],
) {
  const environment = installFakeEnvironment([thread, ...others], options);
  // Every thread is answered the first thread's rows (the panel never reads a snapshot's threadId);
  // `push` sends the next snapshot, as the server's changes do.
  const decisions = answerStreamRpc(WS_METHODS.threadDecisionsSubscribe, snapshotFor(thread, rows));
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  // AppRoot brings its own router.
  const app = await render(<AppRoot router={router} />, { router: false });
  return {
    router,
    draft: () =>
      useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(ENVIRONMENT_ID, thread.id))
        ?.prompt ?? "",
    setDraft: (prompt: string) =>
      useComposerDraftStore.getState().setPrompt(scopeThreadRef(ENVIRONMENT_ID, thread.id), prompt),
    push: (snapshot: ThreadDecisionsSnapshot) => decisions.push(snapshot),
    [Symbol.asyncDispose]: async () => {
      await app[Symbol.asyncDispose]();
      decisions[Symbol.dispose]();
      environment[Symbol.dispose]();
    },
  };
}

const option = (name: string) => page.getByRole("button", { name, exact: true });
const accept = (label: string, pick: string) =>
  option(`Accept ${label}: ${pick} (adds to your message)`);
const answer = (label: string) => option(`Answer ${label} in the composer`);
const drop = (label: string) => option(`Drop ${label} as not a decision (adds to your message)`);
const yesToAll = () => option("Yes to all (adds to your message)");
const sendDraft = () => option("Send draft");
// At the default (phone) width the right panel is a modal sheet over the composer; the Tracker sits
// beside the chat from desktop widths up.
const openTracker = async () => {
  await page.viewport(1400, 900);
  await page.getByRole("button", { name: /^Open Tracker/ }).click();
  await expect.element(page.getByLabelText("Tracker view")).toBeVisible();
};
const tracker = {
  accept: (label: string, pick: string) => option(`Accept ${label}: ${pick} (adds to your draft)`),
  remove: (label: string) => option(`Remove ${label}'s line from your draft`),
  edit: (label: string) => option(`Edit ${label}'s line in the composer`),
  select: (label: string) => page.getByRole("checkbox", { name: `Select ${label}`, exact: true }),
};
const editor = () => page.getByTestId("composer-editor");
const sentTexts = () =>
  dispatchedCommands().flatMap((command) =>
    command.type === "message.dispatch" ? [command.text] : [],
  );

it("Accept adds the answer and moves on; Answer… adds the label and stays", async () => {
  await using app = await openThread(threadWithHistory("thread-decision-panel", 1));
  await expect.element(accept("Q4", "yes")).toBeVisible();
  await expect.element(page.getByText("1/3")).toBeVisible();

  await accept("Q4", "yes").click();
  await vi.waitFor(() => expect(app.draft()).toBe("Q4: yes"));
  await expect.element(accept("Q5", "no")).toBeVisible();
  await expect.element(page.getByText("2/3")).toBeVisible();

  await answer("Q5").click();
  await vi.waitFor(() => expect(app.draft()).toBe("Q4: yes\nQ5: "));
  await expect.element(answer("Q5")).toHaveAttribute("aria-pressed", "true");
  await expect.element(page.getByText("2/3")).toBeVisible();
  await expect.element(page.getByText("In draft", { exact: true })).toBeVisible();

  // Back on Q4, the option the draft chose stays selected.
  await page.getByRole("button", { name: "Previous question" }).click();
  await expect.element(accept("Q4", "yes")).toHaveAttribute("aria-pressed", "true");
});

it("selects the option the draft chose as the draft changes", async () => {
  await using app = await openThread(threadWithHistory("thread-decision-draft", 1));
  await expect.element(accept("Q4", "yes")).toHaveAttribute("aria-pressed", "false");

  app.setDraft("Q4: not a decision");
  await expect.element(drop("Q4")).toHaveAttribute("aria-pressed", "true");
  await expect.element(accept("Q4", "yes")).toHaveAttribute("aria-pressed", "false");

  app.setDraft("Go with your picks");
  await expect.element(accept("Q4", "yes")).toHaveAttribute("aria-pressed", "true");

  app.setDraft("Q4: only if the log is clean");
  await expect.element(answer("Q4")).toHaveAttribute("aria-pressed", "true");

  app.setDraft("");
  await expect.element(answer("Q4")).toHaveAttribute("aria-pressed", "false");
  await expect.element(page.getByText("In draft", { exact: true })).not.toBeInTheDocument();
});

it("gives way to the agent's own pending question", async () => {
  const thread = threadWithHistory("thread-decision-native", 1);
  const asking = threadWithQuestion("thread-decision-native", "Which file should change?");
  const [request] = asking.runtimeRequests ?? [];
  const question = asking.items.at(-1);
  if (!request || !question) throw new Error("threadWithQuestion has no question");
  await using _app = await openThread(thread);
  await expect.element(accept("Q4", "yes")).toBeVisible();

  await emitThreadEvent(thread.id, { type: "turn-item.updated", payload: question });
  await emitThreadEvent(thread.id, { type: "runtime-request.updated", payload: request });
  await expect.element(page.getByText("Which file should change?")).toBeVisible();
  await expect.element(accept("Q4", "yes")).not.toBeInTheDocument();
  expect(document.querySelector("[data-thread-decision]")).toBeNull();
});

it("opens the right panel's Tracker from the panel header", async () => {
  await using _app = await openThread(threadWithHistory("thread-decision-tracker", 1));
  await page.getByRole("button", { name: "Open Tracker", exact: true }).click();
  await expect.element(page.getByLabelText("Tracker view")).toBeVisible();
  // The panel's tab names the surface.
  await expect.element(page.getByRole("button", { name: "Tracker", exact: true })).toBeVisible();
});

const decided = (text: string, ordinal: number, vetoed = false) => ({
  messageId: MessageId.make("reply"),
  ordinal,
  text,
  createdAt: "2026-01-01T00:00:00.000Z",
  vetoed,
});

it("Yes to all adds one Accept line per pick the draft leaves open, once", async () => {
  await using app = await openThread(threadWithHistory("thread-decision-yes", 1));
  await expect.element(yesToAll()).toBeVisible();
  app.setDraft("Q5: only on main");

  await yesToAll().click();
  await vi.waitFor(() => expect(app.draft()).toBe("Q5: only on main\nQ4: yes\nQ6: later"));
  // What the lines name is in the draft now, so there is nothing left to add.
  await expect.element(yesToAll()).toBeDisabled();
  await expect.element(accept("Q4", "yes")).toHaveAttribute("aria-pressed", "true");
});

it("nothing on a question sends: no send arrows in the question panel or the Tracker", async () => {
  await using app = await openThread(threadWithHistory("thread-decision-no-arrows", 1), {
    acceptCommands: true,
  });
  await expect.element(accept("Q4", "yes")).toBeVisible();
  await openTracker();
  await expect.element(tracker.accept("Q5", "no")).toBeVisible();
  expect(page.getByRole("button", { name: /and send/i }).elements()).toHaveLength(0);

  await accept("Q4", "yes").click();
  await tracker.accept("Q5", "no").click();
  await vi.waitFor(() => expect(app.draft()).toBe("Q4: yes\nQ5: no"));
  expect(sentTexts()).toEqual([]);
});

it("Send draft shows only while the draft holds Tracker lines, and sends it through the composer", async () => {
  await using app = await openThread(threadWithHistory("thread-decision-send-draft", 1), {
    acceptCommands: true,
  });
  await openTracker();
  await expect.element(tracker.accept("Q4", "yes")).toBeVisible();
  await expect.element(sendDraft()).not.toBeInTheDocument();
  // Plain text is the composer's alone.
  app.setDraft("Also rename it");
  await expect.element(page.getByRole("region", { name: "Your draft" })).not.toBeInTheDocument();
  await page.getByRole("button", { name: /^Decisions/ }).click();
  await expect.element(page.getByRole("region", { name: "Your draft" })).not.toBeInTheDocument();
  await page.getByRole("button", { name: /^Questions/ }).click();
  app.setDraft("");

  await tracker.accept("Q4", "yes").click();
  app.setDraft(`${app.draft()}\nAlso rename it`);
  await expect.element(page.getByText("1 answer + other text")).toBeVisible();
  await sendDraft().click();
  await vi.waitFor(() => expect(sentTexts()).toEqual(["Q4: yes\nAlso rename it"]));
  await vi.waitFor(() => expect(app.draft()).toBe(""));
  await expect.element(sendDraft()).not.toBeInTheDocument();
});

it("a bare label from Answer… stays In draft but is not counted, and holds Send draft back", async () => {
  await using app = await openThread(threadWithHistory("thread-decision-bare-label", 1), {
    acceptCommands: true,
  });
  await openTracker();
  app.setDraft("Q4: yes\nQ5: ");
  await expect.element(page.getByText("1 answer · Q5 unanswered")).toBeVisible();
  await expect.element(tracker.remove("Q5")).toBeVisible();
  await expect.element(sendDraft()).toBeDisabled();

  app.setDraft("Q4: yes\nQ5: only on main");
  await expect.element(page.getByText("2 answers", { exact: true })).toBeVisible();
  await expect.element(sendDraft()).toBeEnabled();
  expect(sentTexts()).toEqual([]);
});

it("while T3's own question is answered, Edit, Remove and Send draft wait", async () => {
  const thread = threadWithHistory("thread-decision-pending-input", 1);
  const asking = threadWithQuestion("thread-decision-pending-input", "Which file should change?");
  const [request] = asking.runtimeRequests ?? [];
  const question = asking.items.at(-1);
  if (!request || !question) throw new Error("threadWithQuestion has no question");
  await using app = await openThread(thread, { acceptCommands: true });
  await openTracker();
  app.setDraft("Q4: yes");
  await expect.element(tracker.remove("Q4")).toBeEnabled();
  await expect.element(sendDraft()).toBeEnabled();

  await emitThreadEvent(thread.id, { type: "turn-item.updated", payload: question });
  await emitThreadEvent(thread.id, { type: "runtime-request.updated", payload: request });
  await expect.element(page.getByText("Which file should change?")).toBeVisible();
  await expect.element(tracker.remove("Q4")).toBeDisabled();
  await expect.element(tracker.edit("Q4")).toBeDisabled();
  await expect.element(sendDraft()).toBeDisabled();
});

it("Accept N picks adds a line per pick not in the draft, skips no-pick ones, and hides at zero", async () => {
  await using app = await openThread(
    threadWithHistory("thread-decision-accept-picks", 1),
    undefined,
    {
      questions: [
        open("Q4", "yes", "a"),
        open("Q5", "no", "b"),
        open("Q6", "", ""),
        open("Q7", "go", "c"),
      ],
    },
  );
  await openTracker();
  app.setDraft("Q5: maybe");
  const acceptPicks = page.getByRole("button", { name: /^Accept 2 picks/ });
  await expect.element(acceptPicks).toBeVisible();
  await acceptPicks.click();
  await vi.waitFor(() => expect(app.draft()).toBe("Q5: maybe\nQ4: yes\nQ7: go"));
  await expect
    .element(page.getByRole("button", { name: /^Accept \d+ picks?/ }))
    .not.toBeInTheDocument();
  // Q6 has no pick, so its row offers no Accept either.
  await expect.element(option("Answer Q6 in your draft")).toBeVisible();
  expect(page.getByRole("button", { name: /^Accept Q6/ }).elements()).toHaveLength(0);
});

it("an answered row shows its exact line; Remove takes out that line and Edit goes to it", async () => {
  await using app = await openThread(threadWithHistory("thread-decision-remove", 1));
  await openTracker();
  app.setDraft("Keep this\nQ4: yes\nQ5: not a decision");
  await expect.element(tracker.remove("Q4")).toBeVisible();
  await expect.element(page.getByText("Q4: yes", { exact: true }).last()).toBeVisible();

  await tracker.remove("Q4").click();
  await vi.waitFor(() => expect(app.draft()).toBe("Keep this\nQ5: not a decision"));
  await expect.element(tracker.accept("Q4", "yes")).toBeVisible();

  await tracker.edit("Q5").click();
  await expect.element(editor()).toHaveFocus();
});

it("a line that closes several questions is shown with Edit in composer, not Remove", async () => {
  await using app = await openThread(threadWithHistory("thread-decision-shared-line", 1));
  await openTracker();
  app.setDraft("Go with your picks");
  await expect.element(option("Edit the line that answers Q4 in the composer")).toBeVisible();
  expect(page.getByRole("button", { name: /^Remove Q/ }).elements()).toHaveLength(0);
});

it("Select mode: rows toggle, the reply's box goes mixed, drafted rows can't be picked, Add ends it", async () => {
  await using app = await openThread(threadWithHistory("thread-decision-select", 1), undefined, {
    questions: [
      open("Q4", "yes", "a"),
      open("Q5", "no", "b"),
      open("Q6", "", ""),
      { ...open("Q2", "later", "c"), sourceMessageId: MessageId.make("older") },
    ],
  });
  await openTracker();
  app.setDraft("Q2: now");
  const draftBar = page.getByRole("region", { name: "Your draft" });
  await expect.element(draftBar).toBeVisible();
  await option("Select").click();
  // Select mode shows its own preview of the draft, so the draft bar steps aside.
  await expect.element(draftBar).not.toBeInTheDocument();

  const drafted = page.getByRole("checkbox", { name: "Q2 is already in your draft" });
  await expect.element(drafted).toHaveAttribute("aria-disabled", "true");
  const latest = page.getByRole("checkbox", { name: /latest reply/ });
  await expect.element(latest).toHaveAttribute("aria-checked", "false");

  // The whole row is the toggle.
  await page.getByText("Settle Q4?", { exact: true }).last().click();
  await expect.element(tracker.select("Q4")).toHaveAttribute("aria-checked", "true");
  await expect.element(latest).toHaveAttribute("aria-checked", "mixed");
  await page.getByText("Settle Q6?", { exact: true }).last().click();
  await expect.element(tracker.select("Q6")).toHaveAttribute("aria-checked", "true");
  await expect.element(latest).toHaveAttribute("aria-checked", "mixed");

  // The preview is the whole draft after Add; Q6 has no pick, so Accept skips it.
  const preview = page.getByRole("group", { name: "Your draft after this action" });
  await expect.element(preview).toHaveTextContent("Q2: now+Adds Q4: yes");
  await expect.element(page.getByText("Skipped, no pick: Q6")).toBeVisible();
  await option("Add 1 to draft").click();
  await vi.waitFor(() => expect(app.draft()).toBe("Q2: now\nQ4: yes"));
  await expect.element(option("Select")).toBeVisible();
  await expect.element(draftBar).toBeVisible();
  expect(sentTexts()).toEqual([]);
});

it("Select mode does not carry over to another thread", async () => {
  const first = threadWithHistory("thread-decision-select-thread", 1);
  const other = threadWithHistory("thread-decision-other", 1);
  await using app = await openThread(first, undefined, undefined, [other]);
  const go = (thread: FakeThread) =>
    act(() =>
      app.router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: ENVIRONMENT_ID, threadId: thread.id },
      }),
    );
  // The Tracker open on both threads, so switching keeps the panel where it is.
  await go(other);
  await openTracker();
  await go(first);
  await openTracker();
  await option("Select").click();
  await expect.element(option("Done")).toBeVisible();

  await go(other);
  await expect.element(option("Select")).toBeVisible();
  expect(page.getByRole("button", { name: "Done", exact: true }).elements()).toHaveLength(0);
});

it("Select mode's preview shows the lines it adds, below a long draft, and takes focus", async () => {
  await using app = await openThread(threadWithHistory("thread-decision-preview", 1));
  await openTracker();
  app.setDraft(Array.from({ length: 30 }, (_, n) => `Earlier line ${n}`).join("\n"));
  await option("Select").click();
  // Tests run without the app's CSS, so the preview's height cap is given here.
  const style = document.createElement("style");
  style.textContent =
    '[aria-label="Your draft after this action"] { max-height: 60px; overflow-y: auto; }';
  document.head.append(style);
  try {
    await page.getByText("Settle Q4?", { exact: true }).last().click();
    const preview = page.getByRole("group", { name: "Your draft after this action" });
    await expect.element(preview).toHaveAttribute("tabindex", "0");
    await vi.waitFor(() => {
      const box = preview.element();
      expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
      expect(box.scrollTop + box.clientHeight).toBeGreaterThanOrEqual(box.scrollHeight - 1);
    });
  } finally {
    style.remove();
  }
});

it("answering in the Tracker keeps focus there, on the row's next control", async () => {
  await using app = await openThread(threadWithHistory("thread-decision-focus", 1), undefined, {
    decidedWithoutAsking: [decided("Kept the old index.", 0)],
  });
  await openTracker();
  await tracker.accept("Q4", "yes").click();
  await vi.waitFor(() => expect(app.draft()).toBe("Q4: yes"));
  await expect.element(tracker.edit("Q4")).toHaveFocus();
  await tracker.remove("Q4").click();
  await expect.element(tracker.accept("Q4", "yes")).toHaveFocus();
  await option("Q5 is not a decision (adds to your draft)").click();
  await expect.element(tracker.edit("Q5")).toHaveFocus();

  await option("Select").click();
  await page.getByText("Settle Q6?", { exact: true }).last().click();
  await option("Add 1 to draft").click();
  await expect.element(option("Select")).toHaveFocus();

  await page.getByRole("button", { name: /^Decisions/ }).click();
  await option("Veto: Kept the old index. (adds to your draft)").click();
  const remove = option("Remove the veto from your draft: Kept the old index.");
  await expect.element(remove).toHaveFocus();
  await remove.click();
  await expect.element(option("Veto: Kept the old index. (adds to your draft)")).toHaveFocus();
});

it("Select mode ends once nothing is left to select", async () => {
  await using app = await openThread(
    threadWithHistory("thread-decision-select-end", 1),
    undefined,
    {
      questions: [open("Q4", "yes", "a")],
    },
  );
  await openTracker();
  await option("Select").click();
  await expect.element(option("Done")).toBeVisible();
  app.setDraft("Q4: yes");
  await expect.element(option("Select")).toBeVisible();
  expect(page.getByRole("button", { name: "Done", exact: true }).elements()).toHaveLength(0);
});

it("Select mode's Not a decision adds a line per selected question, picks or not", async () => {
  await using app = await openThread(
    threadWithHistory("thread-decision-select-drop", 1),
    undefined,
    { questions: [open("Q4", "yes", "a"), open("Q6", "", "")] },
  );
  await openTracker();
  await option("Select").click();
  // Its heading is the reply's toggle; tests run without the app's CSS, so the box itself has no size.
  await page.getByText("Latest reply", { exact: true }).click();
  await expect
    .element(page.getByRole("checkbox", { name: /latest reply/ }))
    .toHaveAttribute("aria-checked", "true");
  // Without the app's CSS the composer overlaps the dock here, so the radio is clicked in place.
  const notADecision = page.getByRole("radio", { name: "Not a decision" });
  await act(() => notADecision.element().dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await expect.element(notADecision).toHaveAttribute("aria-checked", "true");
  await option("Add 2 to draft").click();
  await vi.waitFor(() => expect(app.draft()).toBe("Q4: not a decision\nQ6: not a decision"));
});

it("Veto puts its line in the draft, the row then shows it with Remove, and a sent one reads Vetoed", async () => {
  await using app = await openThread(threadWithHistory("thread-decision-veto", 1), undefined, {
    decidedWithoutAsking: [
      decided("Kept the old index.", 0),
      decided("Left answer all out.", 1, true),
    ],
  });
  await openTracker();
  const decisionsTab = page.getByRole("button", { name: "Decisions, 1 choice to review" });
  await decisionsTab.click();
  await expect.element(page.getByText("Vetoed", { exact: true })).toBeVisible();
  expect(page.getByRole("button", { name: /^Veto: Left answer all out/ }).elements()).toHaveLength(
    0,
  );

  await option("Veto: Kept the old index. (adds to your draft)").click();
  await vi.waitFor(() => expect(app.draft()).toBe("Veto: Kept the old index."));
  const remove = option("Remove the veto from your draft: Kept the old index.");
  await expect.element(remove).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Decisions", exact: true })).toBeVisible();
  await expect.element(page.getByText("1 veto", { exact: true })).toBeVisible();

  await remove.click();
  await vi.waitFor(() => expect(app.draft()).toBe(""));
  await expect.element(decisionsTab).toBeVisible();
});

it("Reopen waits for its toast's Undo; undone, it never reaches the server", async () => {
  const reopened: unknown[] = [];
  using _reopen = answerRpc(WS_METHODS.threadDecisionsReopen, (input: never) => {
    reopened.push(input);
    return Effect.void;
  });
  await using _app = await openThread(threadWithHistory("thread-decision-reopen", 1), undefined, {
    questions: [
      open("Q4", "yes", "a"),
      {
        ...open("Q3", "yes", "b"),
        state: "answered",
        answerText: "Q3: only on main",
        resolvedAt: "2026-01-01T00:01:00.000Z",
      },
    ],
  });
  await openTracker();
  await page.getByRole("button", { name: "Decisions", exact: true }).click();
  await expect.element(page.getByText("Pick was: yes")).toBeVisible();

  // The page's clock, faked from here, so the 8 s hold passes on demand.
  using _timers = fakeTimers();
  await option("Reopen Q3").click();
  await expect.element(page.getByText("Reopening Q3")).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.element(page.getByText("Reopening Q3")).not.toBeInTheDocument();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(reopened).toEqual([]);

  // Reopen again while the undone toast still fades: when that toast goes, the new hold stays held.
  await option("Reopen Q3").click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await option("Reopen Q3").click();
  await vi.waitFor(() => expect(page.getByText("Reopening Q3").elements()).toHaveLength(1), {
    timeout: 5_000,
  });
  expect(reopened).toEqual([]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.element(page.getByText("Reopening Q3")).not.toBeInTheDocument();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(reopened).toEqual([]);

  // The toast's ✕ cancels like Undo; it never sends the reopen.
  await option("Reopen Q3").click();
  await expect.element(page.getByText("Reopening Q3")).toBeVisible();
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await expect.element(page.getByText("Reopening Q3")).not.toBeInTheDocument();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(reopened).toEqual([]);

  await option("Reopen Q3").click();
  await expect.element(page.getByText("Reopening Q3")).toBeVisible();
  // A pointer resting on the toast (on its Undo, say) holds the countdown.
  await userEvent.hover(page.getByText("Reopening Q3"));
  await vi.advanceTimersByTimeAsync(20_000);
  expect(reopened).toEqual([]);
  await userEvent.unhover(page.getByText("Reopening Q3"));
  await vi.advanceTimersByTimeAsync(7_000);
  expect(reopened).toEqual([]);
  await vi.advanceTimersByTimeAsync(1_500);
  await vi.waitFor(() => expect(reopened).toHaveLength(1), { timeout: 5_000 });
  expect(reopened[0]).toMatchObject({ label: "Q3" });
  // Sent and answered: the row waits for the snapshot that moves Q3 back to Questions.
  await vi.advanceTimersByTimeAsync(1_000);
  await expect.element(option("Reopen Q3")).toBeDisabled();
});

it("a reopen held while another surface opens keeps its Undo", async () => {
  const reopened: unknown[] = [];
  using _reopen = answerRpc(WS_METHODS.threadDecisionsReopen, (input: never) => {
    reopened.push(input);
    return Effect.void;
  });
  const thread = threadWithHistory("thread-decision-surface", 1);
  await using _app = await openThread(thread, undefined, {
    questions: [
      open("Q4", "yes", "a"),
      {
        ...open("Q3", "yes", "b"),
        state: "answered",
        answerText: "Q3: yes",
        resolvedAt: "2026-01-01T00:01:00.000Z",
      },
    ],
  });
  await openTracker();
  await page.getByRole("button", { name: "Decisions", exact: true }).click();
  using _timers = fakeTimers();
  await option("Reopen Q3").click();
  await expect.element(page.getByText("Reopening Q3")).toBeVisible();
  // Parked takes the panel, so the Tracker's panel unmounts with the reopen still held.
  act(() =>
    useRightPanelStore.getState().open(scopeThreadRef(ENVIRONMENT_ID, thread.id), "parked"),
  );
  await expect.element(page.getByLabelText("Tracker view")).not.toBeInTheDocument();
  expect(reopened).toEqual([]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(reopened).toEqual([]);
});

it("a reopen still held when the page goes away is sent", async () => {
  const reopened: unknown[] = [];
  using _reopen = answerRpc(WS_METHODS.threadDecisionsReopen, (input: never) => {
    reopened.push(input);
    return Effect.void;
  });
  await using _app = await openThread(threadWithHistory("thread-decision-pagehide", 1), undefined, {
    questions: [
      open("Q4", "yes", "a"),
      {
        ...open("Q3", "yes", "b"),
        state: "answered",
        answerText: "Q3: yes",
        resolvedAt: "2026-01-01T00:01:00.000Z",
      },
    ],
  });
  await openTracker();
  await page.getByRole("button", { name: "Decisions", exact: true }).click();
  using _timers = fakeTimers();
  await option("Reopen Q3").click();
  await expect.element(page.getByText("Reopening Q3")).toBeVisible();
  window.dispatchEvent(new Event("pagehide"));
  await vi.waitFor(() => expect(reopened).toHaveLength(1));
  expect(reopened[0]).toMatchObject({ label: "Q3" });
});

it("a send T3 refuses leaves the draft as it was, with T3's reason alone", async () => {
  // The composer's own send is held unanswered, so T3 refuses the next one while it is in flight.
  await using app = await openThread(threadWithHistory("thread-decision-refused", 1), {
    acceptCommands: true,
    holdCommand: (command) => command.type === "message.dispatch",
  });
  await openTracker();
  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("First{Enter}");
  await vi.waitFor(() => expect(sentTexts()).toEqual(["First"]));
  app.setDraft("Q4: yes\nKeep this");

  await sendDraft().click();
  await expect.element(page.getByText("Still sending your previous message.")).toBeVisible();
  await vi.waitFor(() => expect(app.draft()).toBe("Q4: yes\nKeep this"));
  expect(page.getByText("Not sent", { exact: true }).elements()).toHaveLength(0);
  expect(sentTexts()).toHaveLength(1);
});

// No fake environment makes the composer refuse without a word, so its handle is faked here.
it.each([
  ["blocked", false, true],
  ["refused", false, false],
  // A send that throws is T3's to report; nothing goes unhandled.
  ["sent", true, false],
] as const)(
  "Send draft reports false when the composer's send is %s (throws: %s), and says Not sent only if nothing else did",
  async (outcome, throws, toasted) => {
    // Recorded, not shown: a toast left on screen would leak into the next test.
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const sendingRef: { current: Promise<void> | null } = { current: null };
    const composer = {
      submit: () => {
        if (throws) sendingRef.current = Promise.reject(new Error("socket closed"));
        return outcome;
      },
    } as Partial<ChatComposerHandle> as ChatComposerHandle;
    const results: Array<Promise<boolean>> = [];
    function Harness() {
      const { sendDraft } = useDraftActions({
        composerRef: { current: composer },
        promptRef: { current: "Keep this" },
        sendingRef,
        draftTarget: scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("thread-decision-blocked")),
      });
      return (
        <button type="button" onClick={() => results.push(sendDraft())}>
          Send draft
        </button>
      );
    }
    await using _app = await render(<Harness />, { router: false });
    await page.getByRole("button", { name: "Send draft" }).click();
    await expect(results[0]).resolves.toBe(false);
    expect(add.mock.calls.some(([toast]) => toast.title === "Not sent")).toBe(toasted);
    add.mockRestore();
  },
);

it("Remove edits the stored draft, not the composer's text when that is another answer", async () => {
  const draftTarget = scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("thread-decision-store-draft"));
  useComposerDraftStore.getState().setPrompt(draftTarget, "Keep this\nQ4: yes");
  // The composer shows the answer to T3's own pending question.
  const promptRef = { current: "Pending answer" };
  const composer = {
    resetCursorState: () => {},
  } as Partial<ChatComposerHandle> as ChatComposerHandle;
  function Harness() {
    const { removeLine } = useDraftActions({
      composerRef: { current: composer },
      promptRef,
      sendingRef: { current: null },
      draftTarget,
    });
    return (
      <button type="button" onClick={() => removeLine("Q4: yes")}>
        Remove
      </button>
    );
  }
  await using _app = await render(<Harness />, { router: false });
  await page.getByRole("button", { name: "Remove" }).click();
  expect(useComposerDraftStore.getState().getComposerDraft(draftTarget)?.prompt).toBe("Keep this");
});

it("a send the server rejects leaves the draft as it was", async () => {
  await using app = await openThread(threadWithHistory("thread-decision-rejected", 1), {
    acceptCommands: true,
    holdCommand: (command) => command.type === "message.dispatch",
  });
  await openTracker();
  app.setDraft("Q4: yes\nKeep this");
  await sendDraft().click();
  await vi.waitFor(() => expect(sentTexts()).toEqual(["Q4: yes\nKeep this"]));

  // T3 reports the failure and puts the draft back.
  await rejectPendingCommand("The provider is unavailable.");
  await vi.waitFor(() => expect(app.draft()).toBe("Q4: yes\nKeep this"));
  expect(page.getByText("Not sent", { exact: true }).elements()).toHaveLength(0);
});

const dismissCard = (label: string) =>
  option(`Dismiss ${label} without answering (tells the agent nothing)`);
const sentMessages = () =>
  dispatchedCommands().flatMap((command) => (command.type === "message.dispatch" ? [command] : []));

it("the question card's whole row is its one collapse control, with the chevron inside it", async () => {
  await using _app = await openThread(threadWithHistory("thread-decision-one-toggle", 1));
  await expect.element(accept("Q4", "yes")).toBeVisible();
  const card = document.querySelector<HTMLElement>("[data-thread-decision]")!;
  // One element says whether the card is open; the chevron is drawn, not a control.
  expect(card.querySelectorAll("[aria-expanded]")).toHaveLength(1);
  await page.getByRole("button", { name: "Hide Q4", exact: true }).click();
  await expect.element(accept("Q4", "yes")).not.toBeInTheDocument();
  await expect.element(page.getByText("Settle Q4?")).toBeVisible();
  expect(card.querySelectorAll("[aria-expanded]")).toHaveLength(1);
  // The controls above the trigger still answer their own clicks.
  await page.getByRole("button", { name: "Next question" }).click();
  await expect.element(page.getByText("2/3")).toBeVisible();
  await page.getByRole("button", { name: "Show Q5", exact: true }).click();
  await expect.element(accept("Q5", "no")).toBeVisible();
});

it("Dismiss on the card closes the question at once, sends nothing, and Undo reopens it", async () => {
  const dismissed: unknown[] = [];
  const reopened: unknown[] = [];
  using _dismiss = answerRpc(WS_METHODS.threadDecisionsDismiss, (input: never) => {
    dismissed.push(input);
    return Effect.void;
  });
  using _reopen = answerRpc(WS_METHODS.threadDecisionsReopen, (input: never) => {
    reopened.push(input);
    return Effect.void;
  });
  const thread = threadWithHistory("thread-decision-dismiss-card", 1);
  await using app = await openThread(thread, { acceptCommands: true });
  await dismissCard("Q4").click();
  await vi.waitFor(() =>
    expect(dismissed).toEqual([{ threadId: thread.id, label: "Q4", sourceMessageId: "reply" }]),
  );
  await expect.element(page.getByText("Dismissed Q4")).toBeVisible();
  expect(app.draft()).toBe("");
  expect(sentTexts()).toEqual([]);
  // At once, with no hold for an Undo: Undo is a Reopen of its own.
  expect(reopened).toEqual([]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await vi.waitFor(() =>
    expect(reopened).toEqual([{ threadId: thread.id, label: "Q4", sourceMessageId: "reply" }]),
  );
  await expect.element(page.getByText("Dismissed Q4")).not.toBeInTheDocument();
});

it("Dismiss on a Tracker row closes it without a message, and it lists under Dismissed", async () => {
  const dismissed: unknown[] = [];
  using _dismiss = answerRpc(WS_METHODS.threadDecisionsDismiss, (input: never) => {
    dismissed.push(input);
    return Effect.void;
  });
  const thread = threadWithHistory("thread-decision-dismiss-row", 1);
  await using app = await openThread(thread, { acceptCommands: true });
  await openTracker();
  await option("Dismiss Q5 without answering (tells the agent nothing)").click();
  await vi.waitFor(() =>
    expect(dismissed).toEqual([{ threadId: thread.id, label: "Q5", sourceMessageId: "reply" }]),
  );
  // The row leaves with the snapshot; focus moves on to the next row's first answer.
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Accept Q6: later (adds to your draft)",
    ),
  );
  expect(app.draft()).toBe("");
  expect(sentTexts()).toEqual([]);

  const after = snapshotFor(thread);
  await app.push({
    ...after,
    questions: after.questions.map((question) =>
      question.label === "Q5"
        ? { ...question, state: "dismissed" as const, resolvedAt: "2026-01-01T00:02:00.000Z" }
        : question,
    ),
    openCount: 2,
  });
  await expect.element(tracker.accept("Q5", "no")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Decisions", exact: true }).click();
  const section = page.getByRole("region", { name: "Dismissed", exact: true });
  await expect.element(section.getByText("Settle Q5?")).toBeVisible();
  await expect.element(section.getByRole("button", { name: "Reopen Q5" })).toBeEnabled();
  await expect.element(page.getByText("1 dismissed")).toBeVisible();
});

it("a sent message hides the open questions until the judge has read it", async () => {
  const thread = threadWithHistory("thread-decision-hold-judged", 1);
  await using app = await openThread(thread, { acceptCommands: true });
  await openTracker();
  await expect.element(accept("Q4", "yes")).toBeVisible();
  await expect.element(tracker.accept("Q5", "no")).toBeVisible();

  await userEvent.click(editor());
  await userEvent.keyboard("Q4: only on main{Enter}");
  await vi.waitFor(() => expect(sentTexts()).toEqual(["Q4: only on main"]));
  await expect.element(accept("Q4", "yes")).not.toBeInTheDocument();
  expect(document.querySelector("[data-thread-decision]")).toBeNull();
  await expect.element(page.getByText("Reading your message")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Questions", exact: true })).toBeVisible();

  // The judge read it and closed Q4: the rest come back.
  const [sent] = sentMessages();
  const after = snapshotFor(thread);
  await app.push({
    ...after,
    questions: after.questions.map((question) =>
      question.label === "Q4" ? { ...question, state: "answered" as const } : question,
    ),
    openCount: 2,
    lastTypedMessageRead: sent!.messageId,
  });
  await expect.element(accept("Q5", "no")).toBeVisible();
  await expect.element(tracker.accept("Q6", "later")).toBeVisible();
  await expect.element(page.getByText("Reading your message")).not.toBeInTheDocument();
});

it("a sent message's questions come back when its run ends, though the judge never read it", async () => {
  const thread = threadWithHistory("thread-decision-hold-run", 1);
  await using _app = await openThread(thread, { acceptCommands: true });
  await expect.element(accept("Q4", "yes")).toBeVisible();
  await userEvent.click(editor());
  await userEvent.keyboard("Tell me more{Enter}");
  await vi.waitFor(() => expect(sentTexts()).toEqual(["Tell me more"]));
  await expect.element(accept("Q4", "yes")).not.toBeInTheDocument();

  const [sent] = sentMessages();
  const running = runningRun(thread.id, "thread-decision-hold-run-run-1", 2, sent!.messageId);
  await emitThreadEvent(thread.id, { type: "run.updated", payload: running });
  await emitThreadEvent(thread.id, {
    type: "turn-item.updated",
    payload: userItem(thread.id, running.id, sent!.messageId, 2, "Tell me more"),
  });
  // The server has the message and its run still runs: still held.
  await expect.element(page.getByText("Tell me more")).toBeVisible();
  expect(document.querySelector("[data-thread-decision]")).toBeNull();

  await emitThreadEvent(thread.id, {
    type: "run.updated",
    payload: { ...running, status: "completed", completedAt: running.requestedAt },
  });
  await expect.element(accept("Q4", "yes")).toBeVisible();
});

it("the card's Dismiss waits while the draft answers its question, and hands focus on", async () => {
  using _dismiss = answerRpc(WS_METHODS.threadDecisionsDismiss, () => Effect.void);
  const thread = threadWithHistory("thread-decision-dismiss-focus", 1);
  await using app = await openThread(thread, { acceptCommands: true });
  await answer("Q4").click();
  await vi.waitFor(() => expect(app.draft()).toBe("Q4: "));
  await expect.element(dismissCard("Q4")).toBeDisabled();
  app.setDraft("");
  await expect.element(dismissCard("Q4")).toBeEnabled();

  // The card moves on to the next question, and focus stays on its row.
  await dismissCard("Q4").click();
  await expect.element(accept("Q5", "no")).toBeVisible();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Hide Q5");
});

it("Undo says it is reopening until the reopen is done", async () => {
  let release = () => {};
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  using _dismiss = answerRpc(WS_METHODS.threadDecisionsDismiss, () => Effect.void);
  using _reopen = answerRpc(WS_METHODS.threadDecisionsReopen, () => Effect.promise(() => done));
  const thread = threadWithHistory("thread-decision-undo-pending", 1);
  await using _app = await openThread(thread, { acceptCommands: true });
  await dismissCard("Q4").click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.element(page.getByText("Reopening Q4…")).toBeVisible();
  await expect.element(page.getByText("It goes back to Questions.")).toBeVisible();
  await expect.element(page.getByText(/^Nothing was sent/)).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  release();
  await expect.element(page.getByText("Reopening Q4…")).not.toBeInTheDocument();
});

it("a send's hold keeps the card's question and collapse", async () => {
  const thread = threadWithHistory("thread-decision-hold-keeps-view", 1);
  await using app = await openThread(thread, { acceptCommands: true });
  await page.getByRole("button", { name: "Next question" }).click();
  await page.getByRole("button", { name: "Hide Q5", exact: true }).click();
  await expect.element(accept("Q5", "no")).not.toBeInTheDocument();

  await userEvent.click(editor());
  await userEvent.keyboard("Tell me more{Enter}");
  await vi.waitFor(() => expect(sentTexts()).toEqual(["Tell me more"]));
  await vi.waitFor(() => expect(document.querySelector("[data-thread-decision]")).toBeNull());

  const [sent] = sentMessages();
  await app.push({ ...snapshotFor(thread), lastTypedMessageRead: sent!.messageId });
  await expect.element(page.getByRole("button", { name: "Show Q5", exact: true })).toBeVisible();
  await expect.element(page.getByText("2/3")).toBeVisible();
});

it("dismissing the card's last question hands focus to the composer", async () => {
  using _dismiss = answerRpc(WS_METHODS.threadDecisionsDismiss, () => Effect.void);
  const thread = threadWithHistory("thread-decision-dismiss-last", 1);
  await using _app = await openThread(
    thread,
    { acceptCommands: true },
    { questions: [open("Q4", "yes", "it stopped cleanly")] },
  );
  await dismissCard("Q4").click();
  await vi.waitFor(() => expect(editor().element().contains(document.activeElement)).toBe(true));
});

it("dismissing the Tracker's last open question hands focus to the composer", async () => {
  using _dismiss = answerRpc(WS_METHODS.threadDecisionsDismiss, () => Effect.void);
  const thread = threadWithHistory("thread-decision-dismiss-last-row", 1);
  await using _app = await openThread(
    thread,
    { acceptCommands: true },
    { questions: [open("Q4", "yes", "it stopped cleanly")] },
  );
  await openTracker();
  // The row's, which reads "Dismiss"; the card's is its ✕, with the same name.
  await page.getByText("Dismiss", { exact: true }).click();
  await vi.waitFor(() => expect(editor().element().contains(document.activeElement)).toBe(true));
});
