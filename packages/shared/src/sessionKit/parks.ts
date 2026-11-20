// Fork-only `/park` composer command on top of the verbatim session-kit parser in ./reply.ts.
import type { ThreadParkedKind, ThreadParkedKindWord } from "@t3tools/contracts";

import { isPlaceholder, KIND_LABEL, type Park, parkKind, readParks } from "./reply.ts";

export { isPlaceholder, KIND_LABEL, parkKind };

/**
 * The kind each word an input may carry names: session-kit's `parkKind` table for the five words the
 * contract allows, total so no word goes unread (parks.test.ts holds the two equal).
 */
export const PARK_KIND_OF_WORD: Record<ThreadParkedKindWord, ThreadParkedKind> = {
  agent: "agent",
  me: "me",
  prompt: "agent",
  todo: "me",
  later: "me",
};

/**
 * The older word for a kind, the one a server says on the wire and a client parks in, so a peer from
 * before the rename (whose decoders know only the older words) still reads and takes them.
 */
export const OLDER_KIND_WORD = { agent: "prompt", me: "todo" } as const satisfies Record<
  ThreadParkedKind,
  ThreadParkedKindWord
>;

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
