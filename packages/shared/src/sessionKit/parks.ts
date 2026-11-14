// Fork-only `/park` composer command on top of the verbatim session-kit parser in ./reply.ts.
import { isPlaceholder, type Park, readParks } from "./reply.ts";

export { isPlaceholder };

export interface ParkCommand {
  /** The items to park, placeholders left out. */
  readonly parks: ReadonlyArray<Park>;
  /** How many items were left out as empty or placeholder text. */
  readonly placeholders: number;
}

const PARK_COMMAND = /^\/park(?:\s+([\s\S]*))?$/i;

/** `/park <text>` as the items it parks; null when the text is not the command. */
export const readParkCommand = (text: string): ParkCommand | null => {
  const match = PARK_COMMAND.exec(text.trim());
  if (match === null) return null;
  const read = readParks(match[1] ?? "");
  const parks = read.filter((park) => !isPlaceholder(park.text));
  return { parks, placeholders: read.length - parks.length };
};
