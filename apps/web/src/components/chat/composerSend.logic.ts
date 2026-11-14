import {
  type EnvironmentId,
  THREAD_PARKED_TEXT_MAX_LENGTH,
  type ThreadContextRecord,
} from "@t3tools/contracts";
import { type ParkCommand, readParkCommand } from "@t3tools/shared/sessionKit/parks";
import { collectInlineContextIds } from "../../lib/composerContextReferences";

/** Attached threads the prompt still links to; replacing linked text leaves stale records. */
export function referencedThreadContexts(draft: {
  readonly prompt: string;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
}): ReadonlyArray<ThreadContextRecord> {
  if (draft.threadContexts.length === 0) return [];
  const referenced = new Set(collectInlineContextIds(draft.prompt));
  return draft.threadContexts.filter((record) => referenced.has(record.contextId));
}

/** Why a send waits for the user to pick a machine when no machine was chosen automatically. */
export function loadBalancingSendWarning(input: {
  readonly pending: boolean;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly candidateEnvironmentIds: ReadonlyArray<EnvironmentId>;
}) {
  if (input.pending) {
    return {
      title: "Checking machine resources",
      description: "Resource checks are still running. You can choose a machine in the composer.",
    };
  }
  const noMachineReadsEveryThread =
    input.threadContexts.length > 0 &&
    !input.candidateEnvironmentIds.some((environmentId) =>
      input.threadContexts.every((record) => record.environmentId === environmentId),
    );
  return {
    title: "Choose a machine to continue",
    description: noMachineReadsEveryThread
      ? "No machine can read every attached thread. Choose a machine in the composer or remove the threads."
      : "No eligible machine has available resources. Choose a machine in the composer to override.",
  };
}

/**
 * Why a multiple-model send cannot start: the server predates worktree bootstrap, or the
 * draft is not a new thread on a Git branch with at least one model.
 */
export function multipleModelSendBlock(input: {
  readonly selectionCount: number;
  readonly serverSupportsWorktreeBootstrap: boolean;
  readonly isLocalDraftThread: boolean;
  readonly isGitRepo: boolean;
  readonly branch: string | null;
}): "server-outdated" | "needs-new-git-thread" | null {
  if (!input.serverSupportsWorktreeBootstrap) return "server-outdated";
  if (
    !input.isLocalDraftThread ||
    !input.isGitRepo ||
    !input.branch ||
    input.selectionCount === 0
  ) {
    return "needs-new-git-thread";
  }
  return null;
}

/** Why a message sent over pending approvals did not go out, or null to stop quietly. */
export function approvalRedirectNotice(input: {
  readonly draftChanged: boolean;
  readonly declined: boolean;
  readonly approvalResponding: boolean;
  readonly approvalArrived: boolean;
}): string | null {
  if (input.draftChanged) {
    return input.declined
      ? "Approval declined. Your message changed, so it wasn't sent."
      : "Your message changed, so it wasn't sent.";
  }
  if (input.approvalResponding) {
    return "An approval is already being answered, so your message wasn't sent.";
  }
  if (input.declined && input.approvalArrived) {
    return "Another approval arrived, so your message wasn't sent.";
  }
  return null;
}

export type ComposerParkDecision =
  | { readonly kind: "pass" }
  | { readonly kind: "refuse"; readonly title: string; readonly description: string }
  | { readonly kind: "park"; readonly command: ParkCommand };

/** What sending `prompt` does with `/park`: park it, refuse it, or pass it on as a message. */
export function composerParkDecision(input: {
  readonly prompt: string;
  readonly directAnnotation: boolean;
  readonly editingQueuedRun: boolean;
  readonly parkInFlight: boolean;
  readonly hasNonPromptContent: boolean;
  readonly threadStarted: boolean;
}): ComposerParkDecision {
  if (input.directAnnotation) return { kind: "pass" };
  const command = readParkCommand(input.prompt);
  if (command === null) return { kind: "pass" };
  if (input.editingQueuedRun) {
    return {
      kind: "refuse",
      title: "A queued message can't be parked",
      description: "Save or cancel the edit, then park from the composer.",
    };
  }
  if (input.parkInFlight) {
    return {
      kind: "refuse",
      title: "Still parking",
      description: "Park again once the previous items are saved.",
    };
  }
  if (input.hasNonPromptContent) {
    return {
      kind: "refuse",
      title: "Parked items take text only",
      description: "Remove the attachments and context, then park it again.",
    };
  }
  if (!input.threadStarted) {
    return {
      kind: "refuse",
      title: "Nothing parked",
      description: "Parked items belong to a thread; send its first message, then park.",
    };
  }
  if (command.parks.length === 0 && command.placeholders > 0) {
    return {
      kind: "refuse",
      title: "Nothing parked",
      description: "The text is empty or a placeholder.",
    };
  }
  if (command.parks.some((park) => park.text.length > THREAD_PARKED_TEXT_MAX_LENGTH)) {
    return {
      kind: "refuse",
      title: "Too long to park",
      description: `A parked item holds at most ${THREAD_PARKED_TEXT_MAX_LENGTH.toLocaleString("en-US")} characters.`,
    };
  }
  return { kind: "park", command };
}
