// Fork-only: claude.ai artifact links, read the same way by the server's Artifacts rows and the web's
// Link dialog.

// Both forms the Artifact tool documents: `artifact/{id}` and `code/artifact/{uuid}`.
const ARTIFACT_URL_SOURCE =
  "https://claude\\.ai/(?:artifact/([A-Za-z0-9]+)|code/artifact/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))";
const ARTIFACT_URL = new RegExp(ARTIFACT_URL_SOURCE, "g");
const ARTIFACT_URL_EXACT = new RegExp(`^${ARTIFACT_URL_SOURCE}$`);

export interface ArtifactLink {
  /** The id in the URL: the short id, or the uuid of a `code/artifact/` link. */
  readonly id: string;
  readonly url: string;
}

/** A pasted or stored artifact link, its `?query` and `#hash` left out; null for anything else. */
export const parseArtifactLink = (text: string): ArtifactLink | null => {
  const url = text.trim().replace(/[?#][\s\S]*$/, "");
  const match = ARTIFACT_URL_EXACT.exec(url);
  const id = match?.[1] ?? match?.[2];
  return id === undefined ? null : { id, url };
};

/** The artifact links in a reply's text, once per id, in order; the id's characters end each link. */
export const artifactLinksIn = (text: string): ReadonlyArray<ArtifactLink> => {
  const links = new Map<string, string>();
  for (const match of text.matchAll(ARTIFACT_URL)) {
    const id = match[1] ?? match[2];
    if (id !== undefined && !links.has(id)) links.set(id, match[0]);
  }
  return [...links].map(([id, url]) => ({ id, url }));
};
