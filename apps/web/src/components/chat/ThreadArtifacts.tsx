/* oxlint-disable t3code/no-untranslated-copy -- Fork-only English copy: upstream's translation catalogs have no entries for it, so wrapping it would change nothing on screen. FORK.md, "Translation". */
import type { ScopedThreadRef, ThreadArtifact } from "@t3tools/contracts";
import { ArrowUpRightIcon, ShapesIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { RelativeTime } from "~/components/RelativeTime";
import { readLocalApi } from "~/localApi";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { EmptyState, useThreadDecisions } from "./ThreadDecisions";

function ArtifactRow(props: {
  readonly artifact: ThreadArtifact;
  readonly onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly onOpenInBrowser: () => void;
}) {
  const { artifact } = props;
  const title = artifact.title ?? artifact.id;
  return (
    <li className="flex items-start gap-1 rounded-md hover:bg-accent/50">
      <button
        type="button"
        className="min-w-0 flex-1 rounded-md px-1.5 py-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={props.onOpen}
        onAuxClick={props.onOpen}
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{title}</span>
          {artifact.mentionedOnly ? (
            <span className="shrink-0 text-2xs text-muted-foreground">mentioned</span>
          ) : null}
          <span className="ms-auto shrink-0 text-2xs text-muted-foreground">
            <RelativeTime timestamp={artifact.updatedAt} />
          </span>
        </span>
        {artifact.description === null ? null : (
          <span className="block truncate text-xs text-muted-foreground">
            {artifact.description}
          </span>
        )}
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              className="mt-1"
              aria-label={`Open in browser: ${title}`}
              onClick={props.onOpenInBrowser}
            />
          }
        >
          <ArrowUpRightIcon />
        </TooltipTrigger>
        <TooltipPopup side="top">Open in browser</TooltipPopup>
      </Tooltip>
    </li>
  );
}

/** The artifacts this thread published or linked to: its own right-panel surface, beside the Tracker. */
export function ThreadArtifactsPanel(props: { readonly threadRef: ScopedThreadRef }) {
  const snapshot = useThreadDecisions(props.threadRef);
  const openLink = useOpenLink(props.threadRef);
  const artifacts = snapshot?.artifacts ?? [];
  if (artifacts.length === 0) {
    return (
      <EmptyState
        icon={ShapesIcon}
        title="No artifacts"
        description="Pages an agent publishes to claude.ai, or links to in a reply, appear here."
      />
    );
  }
  const report = (error: unknown) => {
    console.error(error);
    toastManager.add({ type: "error", title: "Unable to open artifact" });
  };
  const open = (artifact: ThreadArtifact, event: MouseEvent<HTMLButtonElement>) => {
    if (event.button > 1) return;
    void openLink(artifact.url, {
      event: { metaKey: event.metaKey, ctrlKey: event.ctrlKey, button: event.button },
    }).catch(report);
  };
  const openInBrowser = (artifact: ThreadArtifact) => {
    const api = readLocalApi();
    if (!api) return report(new Error("Link opening is unavailable."));
    void api.shell.openExternal(artifact.url).catch(report);
  };
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="px-3 pb-3">
        <ul className="flex flex-col gap-0.5 pt-3">
          {artifacts.map((artifact) => (
            <ArtifactRow
              key={artifact.id}
              artifact={artifact}
              onOpen={(event) => open(artifact, event)}
              onOpenInBrowser={() => openInBrowser(artifact)}
            />
          ))}
        </ul>
        {(snapshot?.artifactCount ?? 0) > artifacts.length ? (
          <p className="px-1 pt-2 text-xs text-muted-foreground">Older artifacts are not shown.</p>
        ) : null}
      </div>
    </ScrollArea>
  );
}
