import { type ArtifactLink, parseArtifactLink } from "@t3tools/shared/sessionKit/artifacts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Fork-only. What one of Claude's Artifact tool calls says about artifacts, from its stored turn item.
// Shapes: the dotfiles repo's `.local/.execution/t3-native-board/notes/artifact-types/` (findings.md
// and type-test-rows.json, 2026-11-19).

/** A row's kind: made from an Artifact type, or a plain page the agent wrote. */
export type ArtifactType =
  | { readonly kind: "typed"; readonly url: string }
  | { readonly kind: "page"; readonly format: "html" | "markdown" };

export type ArtifactCall =
  /** A create or publish that succeeded: the thread published this artifact. */
  | {
      readonly kind: "published";
      readonly link: ArtifactLink;
      readonly artifactId: string | null;
      readonly title: string | null;
      /** The call's own `description` input. */
      readonly description: string | null;
      readonly type: ArtifactType;
    }
  /** A read that succeeded: the artifact is there. */
  | { readonly kind: "read"; readonly link: ArtifactLink }
  /** A call claude.ai answered with "artifact not found": deleted, or not shared with this account. */
  | { readonly kind: "notFound"; readonly link: ArtifactLink };

export interface ArtifactTypeName {
  readonly url: string;
  readonly title: string;
}

/**
 * The core types' names, for a type URL no thread has named yet (`list scope:types` on 2026-11-19).
 * Whether other accounts see the same URLs is unverified, so a name any thread learns wins.
 */
export const CORE_ARTIFACT_TYPE_NAMES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    GZLZthZ2sQjn7T16skfdeF: "Data",
    QKN21svewxgyPb6SYRqWnd: "Design",
    "5M7UeXXcx16TP3vzVFNDzd": "Design System",
    Rp9naXUCj2xozpUkyQy19W: "Docs",
    S4skLPbN9WeoFmuiTfaEFy: "Motion",
    RoVz4QPcPto4DDQBtvX1Jf: "Sheets",
    "8jTsAFQMFDb2oA8MsPJ2eL": "Slides",
    PLsEyfjXbDUM1iasW7rjLR: "Whiteboard",
  }).map(([id, title]) => [`https://claude.ai/artifact/${id}`, title]),
);

// The text a failed call's output starts with when claude.ai has no such artifact for this account.
const NOT_FOUND = "artifact not found";

// Provider data: every field may be missing or of another type, so each is read for what it is.
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const linkOf = (value: unknown): ArtifactLink | null => {
  const url = text(value);
  return url === null ? null : parseArtifactLink(url);
};

/** A `{url, title}` pair naming a type, as a read (`type`) or the types list (`type_url`) carries it. */
const typeName = (url: unknown, title: unknown): ArtifactTypeName | null => {
  const link = linkOf(url);
  const name = text(title);
  return link === null || name === null ? null : { url: link.url, title: name };
};

/** Every type name the output carries: the types list, and a read's `type` (by its several shapes). */
const typeNamesIn = (
  output: Readonly<Record<string, unknown>>,
): ReadonlyArray<ArtifactTypeName> => {
  const names: Array<ArtifactTypeName | null> = [];
  if (Array.isArray(output.artifact_types)) {
    for (const entry of output.artifact_types) {
      if (isRecord(entry)) names.push(typeName(entry.type_url, entry.title));
    }
  }
  for (const holder of [output, output.file_read, output.files_read, output.read]) {
    if (isRecord(holder) && isRecord(holder.type)) {
      names.push(typeName(holder.type.url, holder.type.title));
    }
  }
  return names.filter((name) => name !== null);
};

export interface ArtifactCallInput {
  /** The turn item's `$.status`. */
  readonly status?: unknown;
  /** `$.input`: `action` (absent means publish), `url`, `type_url`, `description`. */
  readonly input?: unknown;
  /** `$.output`: an object, its JSON text, or a failure's plain text. */
  readonly output?: unknown;
}

export const readArtifactCall = (
  input: ArtifactCallInput,
): { readonly call: ArtifactCall | null; readonly typeNames: ReadonlyArray<ArtifactTypeName> } => {
  const parsed = typeof input.output === "string" ? decodeJson(input.output) : Option.none();
  const output = Option.isSome(parsed) ? parsed.value : input.output;
  const args = isRecord(input.input) ? input.input : {};
  if (input.status === "failed") {
    // Only claude.ai's own answer for a missing artifact; any other failure says nothing about it.
    const link = linkOf(args.url);
    const notFound = typeof output === "string" && output.includes(NOT_FOUND);
    return { call: notFound && link !== null ? { kind: "notFound", link } : null, typeNames: [] };
  }
  if (input.status !== "completed" || !isRecord(output)) return { call: null, typeNames: [] };
  const typeNames = typeNamesIn(output);
  if (args.action === "read") {
    const link = linkOf(args.url);
    return { call: link === null ? null : { kind: "read", link }, typeNames };
  }
  if (args.action !== undefined && args.action !== null && args.action !== "publish") {
    return { call: null, typeNames };
  }
  const link = linkOf(output.url);
  if (link === null) return { call: null, typeNames };
  // A create names its type in the output (`type.url`), as every publish to a typed artifact does; the
  // input's `type_url` is what was asked for. A publish with neither is a page the agent wrote.
  const typeLink =
    linkOf(isRecord(output.type) ? output.type.url : undefined) ?? linkOf(args.type_url);
  const path = text(output.path);
  const type: ArtifactType =
    typeLink !== null
      ? { kind: "typed", url: typeLink.url }
      : { kind: "page", format: path?.toLowerCase().endsWith(".md") ? "markdown" : "html" };
  return {
    call: {
      kind: "published",
      link,
      artifactId: text(output.artifact_id),
      title: text(output.title),
      description: text(args.description),
      type,
    },
    typeNames,
  };
};
