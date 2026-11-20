// Fork (Parked): `useParkedDraft`, the composer's side of Parked (ThreadDecisions.tsx): which drafts
// lock an item (In draft), and the undo gate's item check while a queued message is edited.
// FORK.md, "Parked items".
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ThreadParkedItem } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import { queuedRunEditDraftId, useComposerDraftStore } from "~/composerDraftStore";
import { parkedContextRecord, parkedContextReference } from "~/lib/composerContextRecords";
import { formatInlineContextReference } from "~/lib/composerContextReferences";
import { render } from "../../../test/render";
import { useParkedDraft } from "./ThreadDecisions";

const threadRef = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("thread-parked-draft"));
const queuedEdit = queuedRunEditDraftId(threadRef, "run-1");
const record = (id: number) => parkedContextRecord({ id, text: `item ${id}` }, threadRef.threadId);

/** The draft store emptied for one test, and again once it ends. */
const freshDrafts = () => {
  const reset = () =>
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  reset();
  return { [Symbol.dispose]: reset };
};

/** Puts item `id`'s chip, text and record, in `target`'s draft. */
const holdChip = (target: typeof threadRef | typeof queuedEdit, id: number) => {
  const store = useComposerDraftStore.getState();
  store.setPrompt(target, `${formatInlineContextReference(parkedContextReference(record(id)))} `);
  store.addParkedContexts(target, [record(id)]);
};

// Sent by the queued message being edited: not Open, so outside an edit no undo brings its chip back.
const sent: ThreadParkedItem = {
  id: 2,
  kind: "prompt",
  text: "item 2",
  state: "sent",
  parkedBy: "user",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  resolvedAt: "2026-01-01T00:00:00.000Z",
};

/**
 * Shows what the hook answers: the items In draft, and, once asked (the composer asks on an undo, not
 * while rendering), whether an undo may bring back item 2's chip.
 */
function Probe(props: {
  readonly editingQueuedRun: boolean;
  readonly item?: ThreadParkedItem | undefined;
}) {
  const [restores, setRestores] = useState<boolean | null>(null);
  const parked = useParkedDraft({
    composerRef: { current: null },
    threadRef,
    draftTarget: props.editingQueuedRun ? queuedEdit : threadRef,
    threadDraftTarget: threadRef,
    editingQueuedRun: props.editingQueuedRun,
    parked: [props.item ?? sent],
  });
  return (
    <>
      <output
        data-in-draft={[...parked.actions.inDraft].toSorted().join(",")}
        data-restores={String(restores)}
      />
      <button type="button" onClick={() => setRestores(parked.chipRestorable(record(2)))}>
        Undo
      </button>
    </>
  );
}

// R3 (Opus r4, C3, C4): the thread's draft keeps its chips while a queued message is edited, and the
// edit's chips would go out with that message: both lock their items, whichever the composer shows.
it("reads In draft from the thread's draft and from an open queued message's edit", async () => {
  using _drafts = freshDrafts();
  holdChip(threadRef, 1);
  holdChip(queuedEdit, 2);
  await using screen = await render(<Probe editingQueuedRun />, { router: false });
  const output = () => screen.container.querySelector("output");
  expect(output()?.dataset.inDraft).toBe("1,2");
  await screen.rerender(<Probe editingQueuedRun={false} />);
  expect(output()?.dataset.inDraft).toBe("1");
});

// Opus r4, C3: a queued message's edit holds the chips that message carries, their items Sent by it;
// an undo there brings one back as it was.
it("lets an undo in a queued message's edit bring back the chip that message carries", async () => {
  using _drafts = freshDrafts();
  await using screen = await render(<Probe editingQueuedRun />, { router: false });
  const restores = () => screen.container.querySelector("output")?.dataset.restores;
  await screen.getByRole("button", { name: "Undo" }).click();
  await vi.waitFor(() => expect(restores()).toBe("true"));
  await screen.rerender(<Probe editingQueuedRun={false} />);
  await screen.getByRole("button", { name: "Undo" }).click();
  await vi.waitFor(() => expect(restores()).toBe("false"));
});

// Opus r6, C1: only while the item is still Sent with the chip's words. Reopened and then marked Done
// or edited, it no longer stands as that message carried it, and the edit's Save would send old words.
it("leaves out a queued message's chip once its item is no longer Sent with those words", async () => {
  using _drafts = freshDrafts();
  for (const item of [
    { ...sent, state: "done" as const },
    { ...sent, state: "open" as const, text: "item 2 edited" },
  ]) {
    await using screen = await render(<Probe editingQueuedRun item={item} />, { router: false });
    await screen.getByRole("button", { name: "Undo" }).click();
    await vi.waitFor(() =>
      expect(screen.container.querySelector("output")?.dataset.restores).toBe("false"),
    );
  }
});
