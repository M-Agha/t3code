// Fork (Parked): Sol round 2, S5. A parked record has the unknown-kind shape (fields under `payload`), so
// the generic branch called it unsupported; the sheet shows the item's words.
import type { ComposerContextRecord } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { Pass } = vi.hoisted(() => ({
  Pass: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native", () => ({ Pressable: Pass, ScrollView: Pass, View: Pass }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("./ui/AppText", () => ({ AppText: Pass }));
vi.mock("./ui/Sheet", () => ({ Sheet: Pass }));
vi.mock("./ui/Button", () => ({ Button: () => null }));
vi.mock("./ui/Dialog", () => ({}));
vi.mock("./ui/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("./ui/VideoPreviewModal", () => ({ VideoPreviewModal: () => null }));
vi.mock("./ComposerContextAttachment", () => ({ ComposerContextAttachment: () => null }));
vi.mock("../native/useOpenPullRequest", () => ({ useOpenPullRequest: () => () => {} }));
vi.mock("../features/files/SourceFileSurface", () => ({ SourceFileSurface: () => null }));
vi.mock("../features/review/reviewDiffRendering", () => ({ REVIEW_MONO_FONT_FAMILY: "mono" }));
vi.mock("../features/review/ReviewCommentCard", () => ({
  ReviewCommentCard: () => null,
  useReviewCommentColors: () => ({}),
}));
vi.mock("../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeId: "default", themeAppearance: "light" }),
}));
vi.mock("../features/terminal/terminalTheme", () => ({
  getMobileTerminalTheme: () => ({ background: "#000", foreground: "#fff" }),
}));
vi.mock("../lib/composerImages", () => ({
  composerAttachmentInlineUri: () => undefined,
  isFileBackedComposerAttachment: () => false,
}));

import { ComposerContextSheet } from "./ComposerContextSheet";

const render = (record: ComposerContextRecord) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<ComposerContextSheet label="x" record={record} onClose={() => {}} />));
  const text = container.textContent;
  act(() => root.unmount());
  return text;
};

it("shows a parked item's words, and calls only a truly unknown kind unsupported", () => {
  const base = { version: 1 as const, contextId: "parked_7" as never, label: "Add a check" };
  const parked = render({
    ...base,
    kind: "parked",
    payload: {
      itemId: 7,
      threadId: "thread-1" as never,
      text: "Add a doctor check\nfor the notch",
    },
  });
  expect(parked).toContain("Add a doctor check\nfor the notch");
  expect(parked).not.toContain("not supported");
  expect(render({ ...base, kind: "future-kind" as never, payload: { x: 1 } })).toContain(
    "not supported",
  );
});
