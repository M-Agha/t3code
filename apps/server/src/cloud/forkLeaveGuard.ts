// Fork-only (FORK.md, "Background service", "Leaving the fork"). A fork version reads as Stable, so
// `t3 update` and a client's server update would pin upstream's newer Stable, which runs on the fork's
// database; the next fork build would then be refused as a downgrade. Leaving takes an explicit opt-in.

export const FORK_LEAVE_ENV = "T3CODE_LEAVE_FORK";

const isForkVersion = (version: string) => /^[^-+]+-fork\./.test(version);

/** Why `ownVersion` may not pin `targetVersion`, or undefined when it may. */
export const forkLeaveRefusal = (
  ownVersion: string,
  targetVersion: string,
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined =>
  isForkVersion(ownVersion) && !isForkVersion(targetVersion) && environment[FORK_LEAVE_ENV] !== "1"
    ? `t3@${ownVersion} is a fork build and t3@${targetVersion} is not: switching to it leaves the fork, and the next fork build would be refused as a downgrade. Set ${FORK_LEAVE_ENV}=1 to switch anyway.`
    : undefined;
