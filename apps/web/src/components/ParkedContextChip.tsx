/* oxlint-disable t3code/no-untranslated-copy -- Fork-only English copy: upstream's translation catalogs have no entries for it, so wrapping it would change nothing on screen. FORK.md, "Translation". */
import type { ParkedContextRecord } from "@t3tools/contracts";
import { ArchiveIcon } from "lucide-react";

import { ContextChip, ContextChipLabel } from "./ContextChip";
import { SharedTooltipTrigger } from "./ui/shared-tooltip";

/**
 * Fork (Parked): a parked item attached with Add to draft, in the composer and in sent messages. The
 * tooltip holds the words the agent receives, which the label may cut short. FORK.md, "Parked items".
 */
export function ParkedContextChip(props: {
  readonly record: Pick<ParkedContextRecord, "label" | "payload">;
  readonly copyMarkdown?: string;
}) {
  return (
    <SharedTooltipTrigger
      render={
        <ContextChip
          kind="parked"
          tabIndex={0}
          aria-label={`Parked item, ${props.record.label}`}
          data-markdown-copy={props.copyMarkdown}
        >
          <ArchiveIcon />
          <ContextChipLabel>{props.record.label}</ContextChipLabel>
        </ContextChip>
      }
      label={props.record.payload.text}
      className="max-w-80 whitespace-pre-wrap"
    />
  );
}
