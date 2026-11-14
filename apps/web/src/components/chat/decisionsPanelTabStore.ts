import { create } from "zustand";

export type DecisionsPanelTab = "questions" | "decisions" | "parked";

// One tab for every thread's panel, so the command palette and `/park` can open a given one.
export const useDecisionsPanelTab = create<{
  readonly tab: DecisionsPanelTab;
  readonly setTab: (tab: DecisionsPanelTab) => void;
}>()((set) => ({ tab: "questions", setTab: (tab) => set({ tab }) }));
