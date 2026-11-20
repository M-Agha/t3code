// Fork (Parked): what the web and mobile composers do with parked chips brought in without their
// records (a paste, a stash restored). FORK.md, "Parked items".
import { collectComposerContextReferences } from "./composerContextReferences.ts";

/**
 * `text` without its parked chips: a chip without its record reaches the agent as unavailable context,
 * and a pasted record names an item of the thread and machine it was copied on. One space beside each
 * chip goes with it (the one after, else the one before), as the web's `removeInlineContextReference`
 * takes one; nothing else is trimmed, so the rest of the text stays as it was written.
 */
export const withoutParkedReferences = (text: string): string =>
  collectComposerContextReferences(text)
    .filter((occurrence) => occurrence.kind === "parked")
    .reverse()
    .reduce((result, { start, end }) => {
      if (result[end] === " ") end += 1;
      else if (result[start - 1] === " ") start -= 1;
      return `${result.slice(0, start)}${result.slice(end)}`;
    }, text);

/**
 * A paste of parked chips alone brings nothing once they are dropped, so it must not replace the
 * selection (or release the attachments a selected chip holds): Sol round 3, S5.
 */
export const pastesOnlyParkedReferences = (text: string): boolean =>
  text.trim() !== "" && withoutParkedReferences(text).trim() === "";
