// Fork (Parked): the row's layout on a touch screen, with the app's stylesheet (ThreadParked.browser.
// test.tsx renders unstyled, so its hover-revealed actions stay clickable there).
import { EnvironmentId, ThreadId, type ThreadDecisionsSnapshot } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({ snapshot: null as ThreadDecisionsSnapshot | null }));
vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({ data: state.snapshot, error: null })) as never,
}));
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: (() => true) as never,
}));
vi.mock(import("../ChatMarkdown"), () => ({
  default: ((props: { readonly text: string }) => <p>{props.text}</p>) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => vi.fn()) as never,
}));

import "~/index.css";

import { render } from "../../../test/render";
import { ThreadParkedPanel } from "./ThreadParked";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const actions = {
  canOperate: true,
  insert: () => true,
  sendDraft: async () => true,
  focusLine: () => {},
  removeLine: () => {},
  draft: "",
  answeringPendingInput: false,
  editingQueuedRun: false,
  inDraft: {},
  parked: { inDraft: [], attach: () => true },
  reopen: { isPending: () => false, start: () => {} },
};

// On a touch screen the actions always show (Sol round 1, S7): beside the row's time, never over it.
it("keeps a touch screen's always-shown actions off the row's time", async () => {
  state.snapshot = {
    threadId: threadRef.threadId,
    questions: [],
    decidedWithoutAsking: [],
    openCount: 0,
    parked: [
      {
        id: 1,
        kind: "agent",
        text: "a short one",
        state: "open",
        parkedBy: "user",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        resolvedAt: null,
      },
    ],
    parkedOpenCount: 1,
    artifacts: [],
    artifactCount: 0,
  };
  const session = cdp();
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  try {
    // Proves the emulation reaches CSS's pointer media query, which the strip's classes read.
    expect(window.matchMedia("(pointer: coarse)").matches).toBe(true);
    await using screen = await render(
      <ThreadParkedPanel threadRef={threadRef} actions={actions} />,
    );
    const row = screen.container.querySelector<HTMLElement>('[data-thread-parked="1"]')!;
    const time = row.querySelector<HTMLElement>("span.tabular-nums")!;
    const menu = screen.getByRole("button", { name: "Actions for: a short one" }).element();
    const strip = menu.parentElement!;
    expect(getComputedStyle(strip).opacity).toBe("1");
    expect(time.textContent).not.toBe("");
    const stripBox = strip.getBoundingClientRect();
    const timeBox = time.getBoundingClientRect();
    // No overlap: either beside it or wholly above or below.
    const overlaps =
      timeBox.left < stripBox.right &&
      stripBox.left < timeBox.right &&
      timeBox.top < stripBox.bottom &&
      stripBox.top < timeBox.bottom;
    expect(overlaps, JSON.stringify({ timeBox, stripBox })).toBe(false);
  } finally {
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
});
