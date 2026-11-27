/* oxlint-disable t3code/no-untranslated-copy -- Fork-only English copy: upstream's translation catalogs have no entries for it, so wrapping it would change nothing on screen. FORK.md, "Translation". */
import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { serverEnvironment } from "~/state/server";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, ThreadArtifact } from "@t3tools/contracts";
import { parseArtifactLink } from "@t3tools/shared/sessionKit/artifacts";
import {
  ArrowUpRightIcon,
  ChartColumnIcon,
  CircleSlashIcon,
  ClapperboardIcon,
  FileTextIcon,
  LayoutDashboardIcon,
  Link2Icon,
  LinkIcon,
  type LucideProps,
  MoreHorizontalIcon,
  PaletteIcon,
  PenToolIcon,
  PlusIcon,
  PresentationIcon,
  ScrollTextIcon,
  ShapesIcon,
  SheetIcon,
} from "lucide-react";
import { msg } from "gt-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { m } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { useAtomCommand } from "~/state/use-atom-command";
import { PULL_REQUEST_ROW_CLASS, PullRequestRowLines } from "../pullRequest/PullRequestListRow";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { artifactGroups, rowFocusAfter } from "./threadDecisions.logic";
import { useThreadDecisions } from "./ThreadDecisions";

/** What a row calls the artifact: its type's name, a plain page, or neither until a publish says. */
const artifactTypeLabel = (type: ThreadArtifact["type"]) => {
  if (type === null) return "Type unknown";
  if (type.kind === "page") return type.format === "markdown" ? "Markdown page" : "Page";
  return type.name ?? "Typed artifact";
};

/** The words after the type on a row's second line; null leaves the type alone. */
const artifactDetail = (artifact: ThreadArtifact) => {
  if (artifact.notFoundAt !== null) {
    return "the last read reported it not found: deleted, or not shared with you";
  }
  if (artifact.description !== null) return artifact.description;
  if (artifact.linkedByUser) return "linked by you";
  return artifact.mentionedOnly ? "mentioned in a reply" : null;
};

/** The footer's counts, leaving out a group with none. */
const artifactCounts = (groups: ReturnType<typeof artifactGroups>) =>
  (
    [
      [groups.published.length, "published"],
      [groups.linked.length, "linked"],
      [groups.notFound.length, "not found"],
    ] as const
  )
    .filter(([count]) => count !== 0)
    .map(([count, words]) => `${count} ${words}`)
    .join(" · ");

/**
 * A row's glyph: not found, type unknown, a page, or the core type's own icon (the names the server's
 * artifactCalls.ts knows); any other type shows the generic shape.
 */
// The core types by type URL, so a type renamed on claude.ai keeps its icon; a name picks one only for a
// type outside the core set.
const CORE_TYPES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    GZLZthZ2sQjn7T16skfdeF: "Data",
    QKN21svewxgyPb6SYRqWnd: "Design",
    "5M7UeXXcx16TP3vzVFNDzd": "Design System",
    Rp9naXUCj2xozpUkyQy19W: "Docs",
    S4skLPbN9WeoFmuiTfaEFy: "Motion",
    RoVz4QPcPto4DDQBtvX1Jf: "Sheets",
    "8jTsAFQMFDb2oA8MsPJ2eL": "Slides",
    PLsEyfjXbDUM1iasW7rjLR: "Whiteboard",
  }).map(([id, name]) => [`https://claude.ai/artifact/${id}`, name]),
);

function ArtifactGlyph(props: { readonly artifact: ThreadArtifact } & LucideProps) {
  const { artifact, ...glyph } = props;
  const type = artifact.type;
  if (artifact.notFoundAt !== null) return <CircleSlashIcon {...glyph} />;
  if (type === null) return <Link2Icon {...glyph} />;
  if (type.kind === "page") return <FileTextIcon {...glyph} />;
  switch (CORE_TYPES.get(type.url) ?? type.name) {
    case "Data":
      return <ChartColumnIcon {...glyph} />;
    case "Design":
      return <LayoutDashboardIcon {...glyph} />;
    case "Design System":
      return <PaletteIcon {...glyph} />;
    case "Docs":
      return <ScrollTextIcon {...glyph} />;
    case "Motion":
      return <ClapperboardIcon {...glyph} />;
    case "Sheets":
      return <SheetIcon {...glyph} />;
    case "Slides":
      return <PresentationIcon {...glyph} />;
    case "Whiteboard":
      return <PenToolIcon {...glyph} />;
    default:
      return <ShapesIcon {...glyph} />;
  }
}

interface ArtifactRowActions {
  readonly open: (artifact: ThreadArtifact, event: MouseEvent<HTMLElement>) => void;
  readonly openInBrowser: (artifact: ThreadArtifact) => void;
  readonly copyLink: (artifact: ThreadArtifact) => void;
  /** Null when this client may not change the thread. */
  readonly unlink: ((artifact: ThreadArtifact) => void) | null;
}

/** One artifact, built like the pull-request panel's rows: the row opens it, actions on hover and focus. */
function ArtifactRow(props: {
  readonly artifact: ThreadArtifact;
  readonly actions: ArtifactRowActions;
}) {
  const { artifact, actions } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const menuAnchor = menuPosition
    ? { getBoundingClientRect: () => new DOMRect(menuPosition.x, menuPosition.y, 0, 0) }
    : undefined;
  const title = artifact.title ?? artifact.id;
  const typeLabel = artifactTypeLabel(artifact.type);
  const detail = artifactDetail(artifact);
  const notFound = artifact.notFoundAt !== null;
  return (
    <li
      data-thread-artifact={artifact.id}
      className={cn(PULL_REQUEST_ROW_CLASS, "relative pl-2 hover:bg-accent/60")}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenuPosition({ x: event.clientX, y: event.clientY });
        setMenuOpen(true);
      }}
    >
      <ArtifactGlyph
        artifact={artifact}
        role="img"
        aria-label={notFound ? `${typeLabel}, not found` : typeLabel}
        className="size-4 shrink-0 self-start mt-0.5 text-muted-foreground"
      />
      <a
        href={artifact.url}
        className="flex min-w-0 flex-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={(event) => actions.open(artifact, event)}
        onAuxClick={(event) => actions.open(artifact, event)}
      >
        <PullRequestRowLines
          number={null}
          title={<span className={cn(notFound && "text-muted-foreground")}>{title}</span>}
          meta={
            <span className="min-w-0 truncate">
              <span
                className={cn(artifact.type !== null && !notFound && "font-medium text-foreground")}
              >
                {typeLabel}
              </span>
              {detail === null ? null : ` · ${detail}`}
            </span>
          }
          updatedAt={artifact.notFoundAt ?? artifact.updatedAt}
        />
      </a>
      <span
        className={cn(
          "absolute right-0 bottom-0.5 flex items-center gap-0.5 rounded-r-md bg-background pr-1 pl-5",
          "[mask-image:linear-gradient(to_right,transparent,black_1rem)]",
          // Hidden controls would intercept taps on the row on touch screens.
          "pointer-events-none opacity-0 group-hover/pr-row:pointer-events-auto group-hover/pr-row:opacity-100",
          "has-[[data-popup-open]]:pointer-events-auto has-[[data-popup-open]]:opacity-100",
          "has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100",
          // No hover on touch: the actions stay shown, or Unlink would hide behind a long press.
          "pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
        )}
      >
        <span aria-hidden className="absolute inset-0 bg-accent/60" />
        <SharedTooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-micro"
              className="relative"
              aria-label={`Open in browser: ${title}`}
              onClick={() => actions.openInBrowser(artifact)}
            />
          }
          label="Open in browser"
        >
          <ArrowUpRightIcon className="size-3.5" />
        </SharedTooltipTrigger>
        <SharedTooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-micro"
              className="relative"
              aria-label={`Copy link: ${title}`}
              onClick={() => actions.copyLink(artifact)}
            />
          }
          label="Copy link"
        >
          <LinkIcon className="size-3.5" />
        </SharedTooltipTrigger>
        <Menu
          open={menuOpen}
          onOpenChange={(open) => {
            setMenuOpen(open);
            if (!open) setMenuPosition(null);
          }}
        >
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-micro"
                aria-label={`Actions for ${title}`}
                className="relative"
              >
                <MoreHorizontalIcon className="size-3.5" />
              </Button>
            }
          />
          <MenuPopup
            anchor={menuAnchor}
            align={menuPosition ? "start" : "end"}
            side="bottom"
            sideOffset={menuPosition ? 0 : 4}
          >
            <MenuItem onClick={(event) => actions.open(artifact, event)}>
              <ArrowUpRightIcon className="size-3.5" />
              Open
            </MenuItem>
            <MenuItem onClick={() => actions.copyLink(artifact)}>
              <LinkIcon className="size-3.5" />
              Copy link
            </MenuItem>
            {artifact.linkedByUser && actions.unlink !== null ? (
              <>
                <MenuSeparator />
                <MenuItem onClick={() => actions.unlink?.(artifact)}>
                  <PullRequestGlyph.unlink className="size-3.5" />
                  Unlink from thread
                </MenuItem>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
      </span>
    </li>
  );
}

function ArtifactGroup(props: {
  readonly title: string;
  readonly artifacts: ReadonlyArray<ThreadArtifact>;
  readonly actions: ArtifactRowActions;
}) {
  const id = useId();
  if (props.artifacts.length === 0) return null;
  return (
    <section aria-labelledby={id}>
      <h3
        id={id}
        className="flex items-center gap-1 px-2 pt-2.5 pb-1 text-2xs font-medium text-muted-foreground"
      >
        {props.title}
        <span className="font-normal tabular-nums">{props.artifacts.length}</span>
      </h3>
      <ul className="flex flex-col">
        {props.artifacts.map((artifact) => (
          <ArtifactRow key={artifact.id} artifact={artifact} actions={props.actions} />
        ))}
      </ul>
    </section>
  );
}

/** Adds an artifact by its claude.ai link, built like T3's Link pull request dialog. */
function LinkArtifactDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Null when it linked; else what to say under the fields. */
  readonly onLink: (input: { url: string; title?: string }) => Promise<string | null>;
  /** Where focus goes on close: the Link button on screen then, which may not be the one that opened it. */
  readonly finalFocus: RefObject<HTMLButtonElement | null>;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [openSeen, setOpenSeen] = useState(props.open);
  if (openSeen !== props.open) {
    setOpenSeen(props.open);
    if (props.open) {
      setUrl("");
      setTitle("");
      setDirty(false);
      setSubmitError(null);
    }
  }
  const link = parseArtifactLink(url);
  const validation = !dirty
    ? null
    : url.trim() === ""
      ? "Paste a claude.ai artifact link."
      : link === null
        ? "Use a claude.ai artifact link: https://claude.ai/artifact/… or https://claude.ai/code/artifact/…."
        : null;
  const submit = async () => {
    setDirty(true);
    if (link === null || pending) return;
    setSubmitError(null);
    setPending(true);
    const trimmedTitle = title.trim();
    const error = await props.onLink(
      trimmedTitle === "" ? { url: link.url } : { url: link.url, title: trimmedTitle },
    );
    setPending(false);
    if (error !== null) {
      setSubmitError(error);
      return;
    }
    props.onOpenChange(false);
  };
  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void submit();
  };
  const problem = validation ?? submitError;
  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => (pending ? undefined : props.onOpenChange(next))}
    >
      <DialogPopup className="max-w-xl" initialFocus={inputRef} finalFocus={props.finalFocus}>
        <DialogHeader>
          <DialogTitle>Link an artifact</DialogTitle>
          <DialogDescription>
            Paste a claude.ai artifact link. It shows under Linked in this thread's Artifacts.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-url`}>Link</Label>
              <Input
                id={`${id}-url`}
                ref={inputRef}
                placeholder="https://claude.ai/artifact/…"
                value={url}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={validation !== null || undefined}
                aria-describedby={`${id}-url-note`}
                onChange={(event) => {
                  setDirty(true);
                  setSubmitError(null);
                  setUrl(event.target.value);
                }}
                onKeyDown={onEnter}
              />
              <div id={`${id}-url-note`}>
                {link !== null ? (
                  <p className="truncate text-muted-foreground text-xs">
                    claude.ai artifact <code>{link.id}</code> · type unknown until this thread
                    publishes it
                  </p>
                ) : null}
                {problem !== null ? <p className="text-destructive text-xs">{problem}</p> : null}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-title`}>
                Title <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id={`${id}-title`}
                value={title}
                maxLength={200}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={onEnter}
              />
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => props.onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={pending || link === null}
          >
            {pending ? "Linking..." : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The artifacts this thread published or linked to: its own right-panel surface, beside the Tracker. */
export function ThreadArtifactsPanel(props: { readonly threadRef: ScopedThreadRef }) {
  const { environmentId, threadId } = props.threadRef;
  const snapshot = useThreadDecisions(props.threadRef);
  const openLink = useOpenLink(props.threadRef);
  const canLink = useAtomValue(serverEnvironment.linkThreadArtifact.permissionAtom(environmentId));
  const canUnlink = useAtomValue(
    serverEnvironment.unlinkThreadArtifact.permissionAtom(environmentId),
  );
  // Failures show inside the dialog, so it reports none itself.
  const link = useAtomCommand(serverEnvironment.linkThreadArtifact, { reportFailure: false });
  const unlink = useAtomCommand(serverEnvironment.unlinkThreadArtifact, { reportFailure: true });
  const [linking, setLinking] = useState(false);
  const linkButtonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const artifacts = snapshot?.artifacts ?? [];
  const groups = artifactGroups(artifacts);
  // Rows in the order they show, and where focus goes once the snapshot drops the one unlinked.
  const shownIds = [...groups.published, ...groups.linked, ...groups.notFound].map((row) => row.id);
  const focusAfterRef = useRef<{
    readonly leaving: string;
    readonly order: ReadonlyArray<string>;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus off the row the snapshot removed
  useLayoutEffect(() => {
    const pending = focusAfterRef.current;
    if (pending === null || shownIds.includes(pending.leaving)) return;
    focusAfterRef.current = null;
    // Focus fell to the body with the removed row; anywhere else, the user moved it.
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    const next = rowFocusAfter(pending.order, pending.leaving, shownIds);
    // None left: the Link button the empty state shows.
    (next === null
      ? linkButtonRef.current
      : listRef.current?.querySelector<HTMLElement>(
          `[data-thread-artifact="${CSS.escape(next)}"] a`,
        )
    )?.focus();
  }, [shownIds, focusAfterRef, linkButtonRef, listRef]);

  const report = (error: unknown) => {
    console.error(error);
    toastManager.add({ type: "error", title: "Unable to open artifact" });
  };
  const actions: ArtifactRowActions = {
    open: (artifact, event) => {
      event.preventDefault();
      if (event.button > 1) return;
      void openLink(artifact.url, {
        event: { metaKey: event.metaKey, ctrlKey: event.ctrlKey, button: event.button },
      }).catch(report);
    },
    openInBrowser: (artifact) => {
      const api = readLocalApi();
      if (!api) return report(new Error("Link opening is unavailable."));
      void api.shell.openExternal(artifact.url).catch(report);
    },
    copyLink: (artifact) =>
      void writeTextToClipboard(artifact.url, {
        target: "link",
        unavailableMessage: msg("Clipboard API is unavailable while copying link."),
        failureMessage: msg("Failed to copy link to the clipboard."),
      }),
    unlink: canUnlink
      ? (artifact) => {
          focusAfterRef.current = { leaving: artifact.id, order: shownIds };
          void unlink({ environmentId, input: { threadId, id: artifact.id } }).then((result) => {
            if (result._tag !== "Success" && focusAfterRef.current?.leaving === artifact.id) {
              focusAfterRef.current = null;
            }
          });
        }
      : null,
  };
  const onLink = async (input: { url: string; title?: string }) => {
    const result = await link({ environmentId, input: { threadId, ...input } });
    if (result._tag === "Success") return null;
    return (
      thrownErrorMessage(squashAtomCommandFailure(result), m) ?? "Could not link the artifact."
    );
  };
  const emptyState = (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <ShapesIcon aria-hidden className="size-6 text-muted-foreground/60" />
      <p className="text-sm font-medium">No artifacts</p>
      <p className="max-w-60 text-xs text-muted-foreground">
        Artifacts this thread publishes or links land here. Link one yourself from its claude.ai
        link.
      </p>
      {canLink ? (
        <Button ref={linkButtonRef} size="sm" variant="outline" onClick={() => setLinking(true)}>
          <PlusIcon className="size-3.5" />
          Link artifact
        </Button>
      ) : null}
    </div>
  );
  const list = (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div ref={listRef} className="p-1.5">
          <ArtifactGroup title="Published here" artifacts={groups.published} actions={actions} />
          <ArtifactGroup title="Linked" artifacts={groups.linked} actions={actions} />
          <ArtifactGroup title="Not found" artifacts={groups.notFound} actions={actions} />
          {(snapshot?.artifactCount ?? 0) > artifacts.length ? (
            <p className="px-2 pt-2 text-xs text-muted-foreground">
              Older artifacts are not shown.
            </p>
          ) : null}
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between border-t border-border/60 px-2 py-1.5 text-2xs text-muted-foreground">
        <span>{artifactCounts(groups)}</span>
        {canLink ? (
          <Button ref={linkButtonRef} size="xs" variant="ghost" onClick={() => setLinking(true)}>
            <PlusIcon className="size-3.5" />
            Link
          </Button>
        ) : null}
      </footer>
    </div>
  );
  // One dialog at one place: an artifact arriving while it is open swaps the empty state for the list
  // without remounting it, and focus goes back to whichever Link button is there when it closes.
  const dialog = (
    <LinkArtifactDialog
      open={linking}
      onOpenChange={setLinking}
      onLink={onLink}
      finalFocus={linkButtonRef}
    />
  );
  return (
    <>
      {artifacts.length === 0 ? emptyState : list}
      {dialog}
    </>
  );
}
