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
import * as Stream from "effect/Stream";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it here keeps its first transform out of the timeout.
import "~/components/ChatView";
import { useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  answerRpc,
  dispatchedCommands,
  emitThreadEvent,
  installFakeEnvironment,
  rejectPendingCommand,
  threadWithHistory,
  threadWithQuestion,
  type FakeDriver,
  type FakeThread,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { toastManager } from "../ui/toast";
import type { ChatComposerHandle } from "./ChatComposer";
import { useInsertAndSend } from "./ThreadDecisions";

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

const snapshotFor = (thread: FakeThread): ThreadDecisionsSnapshot => ({
  threadId: thread.id,
  questions: [
    open("Q4", "yes", "it stopped cleanly"),
    open("Q5", "no", "nothing reads it"),
    open("Q6", "later", "not urgent"),
  ],
  decidedWithoutAsking: [],
  openCount: 3,
  parked: [],
  parkedOpenCount: 0,
  artifacts: [],
  artifactCount: 0,
});

async function openThread(
  thread: FakeThread,
  options?: Parameters<typeof installFakeEnvironment>[1],
) {
  const environment = installFakeEnvironment([thread], options);
  const decisions = answerRpc(WS_METHODS.threadDecisionsSubscribe, () =>
    Stream.concat(Stream.make(snapshotFor(thread)), Stream.never),
  );
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
    draft: () =>
      useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(ENVIRONMENT_ID, thread.id))
        ?.prompt ?? "",
    setDraft: (prompt: string) =>
      useComposerDraftStore.getState().setPrompt(scopeThreadRef(ENVIRONMENT_ID, thread.id), prompt),
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
const acceptAndSend = (label: string) => option(`Accept ${label} and send`);
const yesToAll = () => option("Yes to all (adds to your message)");
const yesToAllAndSend = () => option("Yes to all and send");
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

it("Accept and send sends the draft with the Accept line; Accept alone only adds it", async () => {
  await using app = await openThread(threadWithHistory("thread-decision-send", 1), {
    acceptCommands: true,
  });
  await expect.element(accept("Q4", "yes")).toBeVisible();
  app.setDraft("Also rename it");
  await expect.element(acceptAndSend("Q4")).toBeEnabled();

  await acceptAndSend("Q4").click();
  await vi.waitFor(() => expect(sentTexts()).toEqual(["Also rename it\nQ4: yes"]));
  await vi.waitFor(() => expect(app.draft()).toBe(""));

  await accept("Q4", "yes").click();
  await vi.waitFor(() => expect(app.draft()).toBe("Q4: yes"));
  expect(sentTexts()).toHaveLength(1);
});

it("Yes to all adds one line naming the picks the draft leaves open, once", async () => {
  await using app = await openThread(threadWithHistory("thread-decision-yes", 1));
  await expect.element(yesToAll()).toBeVisible();
  app.setDraft("Q5: only on main");

  await yesToAll().click();
  await vi.waitFor(() => expect(app.draft()).toBe("Q5: only on main\nYes to your picks: Q4, Q6"));
  // What the line names is in the draft now, so there is nothing left to add.
  await expect.element(yesToAll()).toBeDisabled();
  await expect.element(accept("Q4", "yes")).toHaveAttribute("aria-pressed", "true");
  expect(app.draft().split("Yes to your picks")).toHaveLength(2);
});

it("Yes to all and send sends the line with the draft", async () => {
  await using app = await openThread(threadWithHistory("thread-decision-yes-send", 1), {
    acceptCommands: true,
  });
  await expect.element(yesToAllAndSend()).toBeEnabled();
  await yesToAllAndSend().click();
  await vi.waitFor(() => expect(sentTexts()).toEqual(["Yes to your picks: Q4, Q5, Q6"]));
  await vi.waitFor(() => expect(app.draft()).toBe(""));
});

it("a send T3 refuses leaves the draft as it was, with T3's reason alone", async () => {
  // The composer's own send is held unanswered, so T3 refuses the next one while it is in flight.
  await using app = await openThread(threadWithHistory("thread-decision-refused", 1), {
    acceptCommands: true,
    holdCommand: (command) => command.type === "message.dispatch",
  });
  await expect.element(acceptAndSend("Q4")).toBeEnabled();
  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("First{Enter}");
  await vi.waitFor(() => expect(sentTexts()).toEqual(["First"]));
  app.setDraft("Keep this");

  await yesToAllAndSend().click();
  await expect.element(page.getByText("Still sending your previous message.")).toBeVisible();
  await vi.waitFor(() => expect(app.draft()).toBe("Keep this"));
  expect(page.getByText("Not sent", { exact: true }).elements()).toHaveLength(0);
  expect(sentTexts()).toHaveLength(1);
});

// No fake environment makes the composer refuse without a word, so its handle is faked here.
it.each([
  ["blocked", false, true],
  ["refused", false, false],
  // A send that throws is T3's to report; the line still comes out, and nothing goes unhandled.
  ["sent", true, false],
] as const)(
  "puts the draft back when the composer's send is %s (throws: %s), and says Not sent only if nothing else did",
  async (outcome, throws, toasted) => {
    // Recorded, not shown: a toast left on screen would leak into the next test.
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const promptRef = { current: "Keep this" };
    const sendingRef: { current: Promise<void> | null } = { current: null };
    const composer = {
      submit: () => {
        if (throws) sendingRef.current = Promise.reject(new Error("socket closed"));
        return outcome;
      },
      resetCursorState: () => {},
    } as Partial<ChatComposerHandle> as ChatComposerHandle;
    const results: Array<Promise<boolean>> = [];
    function Harness() {
      const insertAndSend = useInsertAndSend({
        composerRef: { current: composer },
        promptRef,
        sendingRef,
        draftTarget: scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("thread-decision-blocked")),
        insert: (text) => {
          promptRef.current = `${promptRef.current}\n${text}`;
          return true;
        },
      });
      return (
        <button type="button" onClick={() => results.push(insertAndSend("Q4: yes"))}>
          Accept and send
        </button>
      );
    }
    await using _app = await render(<Harness />, { router: false });
    await page.getByRole("button", { name: "Accept and send" }).click();
    await expect(results[0]).resolves.toBe(false);
    expect(promptRef.current).toBe("Keep this");
    expect(add.mock.calls.some(([toast]) => toast.title === "Not sent")).toBe(toasted);
    add.mockRestore();
  },
);

it("a send the server rejects leaves the draft as it was", async () => {
  await using app = await openThread(threadWithHistory("thread-decision-rejected", 1), {
    acceptCommands: true,
    holdCommand: (command) => command.type === "message.dispatch",
  });
  app.setDraft("Keep this");
  await expect.element(acceptAndSend("Q4")).toBeEnabled();
  await acceptAndSend("Q4").click();
  await vi.waitFor(() => expect(sentTexts()).toEqual(["Keep this\nQ4: yes"]));

  // T3 reports the failure and puts the draft back; the panel then takes its line out again.
  await rejectPendingCommand("The provider is unavailable.");
  await vi.waitFor(() => expect(app.draft()).toBe("Keep this"));
  expect(page.getByText("Not sent", { exact: true }).elements()).toHaveLength(0);
});

it("Accept and send on an empty draft in an interrupted thread sends rather than resumes", async () => {
  const history = threadWithHistory("thread-decision-resumable", 1);
  const interrupted = {
    ...history,
    runs: [{ ...history.runs[0]!, status: "interrupted" as const }],
  };
  await using app = await openThread(interrupted, { acceptCommands: true });
  await expect.element(acceptAndSend("Q4")).toBeEnabled();
  await acceptAndSend("Q4").click();
  await vi.waitFor(() => expect(sentTexts()).toEqual(["Q4: yes"]));
  expect(dispatchedCommands()).not.toContainEqual(
    expect.objectContaining({ manualContinuationOfRunId: expect.anything() }),
  );
  await vi.waitFor(() => expect(app.draft()).toBe(""));
});

it("Accept and send only sends once the draft holds the Accept line", async () => {
  await using app = await openThread(threadWithHistory("thread-decision-held", 1), {
    acceptCommands: true,
  });
  app.setDraft("Q4: yes");
  await expect.element(editor()).toHaveTextContent("Q4: yes");
  await expect.element(acceptAndSend("Q4")).toBeEnabled();
  await acceptAndSend("Q4").click();
  await vi.waitFor(() => expect(sentTexts()).toEqual(["Q4: yes"]));
  await vi.waitFor(() => expect(app.draft()).toBe(""));
});

it("Yes to all and send only sends once the draft holds the line", async () => {
  await using app = await openThread(threadWithHistory("thread-decision-held-yes", 1), {
    acceptCommands: true,
  });
  await yesToAll().click();
  await vi.waitFor(() => expect(app.draft()).toBe("Yes to your picks: Q4, Q5, Q6"));
  await expect.element(yesToAllAndSend()).toBeEnabled();
  await yesToAllAndSend().click();
  await vi.waitFor(() => expect(sentTexts()).toEqual(["Yes to your picks: Q4, Q5, Q6"]));
  await vi.waitFor(() => expect(app.draft()).toBe(""));
});

it("disables the send buttons while their send is in flight", async () => {
  await using _app = await openThread(threadWithHistory("thread-decision-pending", 1), {
    acceptCommands: true,
    holdCommand: (command) => command.type === "message.dispatch",
  });
  await expect.element(acceptAndSend("Q4")).toBeEnabled();
  await acceptAndSend("Q4").click();
  await vi.waitFor(() => expect(sentTexts()).toEqual(["Q4: yes"]));
  await expect.element(acceptAndSend("Q4")).toBeDisabled();
  await expect.element(yesToAllAndSend()).toBeDisabled();
});
