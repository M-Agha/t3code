import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  MessageId,
  type ThreadDecisionQuestion,
  type ThreadDecisionsSnapshot,
  WS_METHODS,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

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
  threadWithHistory,
  threadWithQuestion,
  type FakeDriver,
  type FakeThread,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

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
const yesToAll = () => option("Yes to all (adds to your message)");
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

it("nothing in the question panel sends: no send arrows", async () => {
  await using app = await openThread(threadWithHistory("thread-decision-no-arrows", 1), {
    acceptCommands: true,
  });
  await expect.element(accept("Q4", "yes")).toBeVisible();
  expect(page.getByRole("button", { name: /and send/i }).elements()).toHaveLength(0);
  await accept("Q4", "yes").click();
  await vi.waitFor(() => expect(app.draft()).toBe("Q4: yes"));
  expect(sentTexts()).toEqual([]);
});
