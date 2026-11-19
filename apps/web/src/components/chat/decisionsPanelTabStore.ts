import { create } from "zustand";

export type DecisionsPanelTab = "questions" | "decisions";

// One tab for every thread's Tracker, so the command palette and the question panel can open a given one.
// Not persisted: a reload starts on Questions.
export const useDecisionsPanelTab = create<{
  readonly tab: DecisionsPanelTab;
  readonly setTab: (tab: DecisionsPanelTab) => void;
}>()((set) => ({ tab: "questions", setTab: (tab) => set({ tab }) }));
