import "~/index.css";

import { ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { parkedContextRecord } from "~/lib/composerContextRecords";
import { render } from "../../test/render";
import { ParkedContextChip } from "./ParkedContextChip";
import { SharedTooltipProvider } from "./ui/shared-tooltip";

// Fork (Parked). FORK.md, "Parked items".
it("shows the words the agent receives in the shared tooltip, line breaks kept", async () => {
  const record = parkedContextRecord(
    { id: 1, text: "Rename the flag\nthen ship" },
    ThreadId.make("thread-1"),
  );
  await using screen = await render(
    <SharedTooltipProvider>
      <ParkedContextChip record={record} />
    </SharedTooltipProvider>,
  );
  await userEvent.hover(screen.getByLabelText(`Parked item, ${record.label}`));
  // The chip's own label holds the same words on one line, so the popup is found by its slot.
  const popup = await vi.waitFor(() => {
    const element = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
    expect(element).not.toBeNull();
    return element!;
  });
  await expect.element(page.elementLocator(popup)).toBeVisible();
  expect(popup.textContent).toBe("Rename the flag\nthen ship");
  expect(popup).toHaveClass("whitespace-pre-wrap");
});
