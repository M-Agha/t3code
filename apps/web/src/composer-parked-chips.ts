// Fork (Parked): the editor's undo gate deletes parked chips it refuses (FORK.md, "Parked items").
// Kept out of `ComposerPromptEditorTiptap.tsx` so the upstream file carries only the calls.
import type { EditorView } from "@tiptap/pm/view";

/** Marks the gate's deletion, which `onUpdate` counts as part of the undo that caused it. */
export const PARKED_CHIPS_REMOVED = "composerParkedChipsRemoved";

/**
 * Deletes the parked chips `keep` refuses, with a space beside each, kept out of undo history (as
 * the editor's `replaceSkillChips` is), so the selection maps through the deletion. True if any went.
 */
export const removeParkedChips = (
  view: EditorView,
  keep: (contextId: string, label: string) => boolean,
): boolean => {
  const { doc } = view.state;
  const ranges: Array<{ from: number; to: number }> = [];
  doc.descendants((node, pos) => {
    if (
      node.type.name !== "composer-context-reference" ||
      node.attrs.kind !== "parked" ||
      keep(String(node.attrs.contextId), String(node.attrs.label))
    ) {
      return;
    }
    const to = pos + node.nodeSize;
    // One space beside it goes too, as `removeInlineContextReference` takes one.
    if (doc.textBetween(to, Math.min(to + 1, doc.resolve(to).end()), "") === " ") {
      ranges.push({ from: pos, to: to + 1 });
    } else if (pos > doc.resolve(pos).start() && doc.textBetween(pos - 1, pos, "") === " ") {
      ranges.push({ from: pos - 1, to });
    } else {
      ranges.push({ from: pos, to });
    }
  });
  if (ranges.length === 0) return false;
  const transaction = view.state.tr
    .setMeta("addToHistory", false)
    .setMeta(PARKED_CHIPS_REMOVED, true);
  // Two chips one space apart can claim that space both (`[a] [b]x`); mapped through what went
  // before, the second range shrinks instead of reaching past its chip into the text.
  for (const { from, to } of ranges) {
    transaction.delete(transaction.mapping.map(from), transaction.mapping.map(to));
  }
  view.dispatch(transaction);
  return true;
};
