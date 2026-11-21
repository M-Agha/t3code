// Fork (Mark unread from here). FORK.md, "Mark unread from here".
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const requests = vi.hoisted(() => [] as unknown[]);

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async (request: unknown) => {
    requests.push(request);
    return AsyncResult.success(undefined);
  },
}));
vi.mock("../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/entities")>()),
  readEnvironmentServerConfigLoaded: () => true,
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (select: (store: unknown) => unknown) => select({ markThreadUnread: () => {} }),
}));

const { useMarkThreadUnread } = await import("./useThreadActions");

it("sends the message's time to a server that tracks visits, and none for the thread menu's form", async () => {
  const target = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
  const markThreadUnread = useMarkThreadUnread();
  await markThreadUnread(target, "2026-11-21T10:00:04.000Z");
  await markThreadUnread(target);
  expect(requests).toEqual([
    { environmentId: "env", input: { threadId: "thread", from: "2026-11-21T10:00:04.000Z" } },
    { environmentId: "env", input: { threadId: "thread" } },
  ]);
});
