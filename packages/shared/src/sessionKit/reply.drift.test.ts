// @effect-diagnostics nodeBuiltinImport:off - a plain file comparison, no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const SOURCE = NodePath.join(
  NodeOS.homedir(),
  "repos/dotfiles/.claude/mods/session-kit/hooks/reply.ts",
);
const COPY = NodePath.join(import.meta.dirname, "reply.ts");
const MARKER = "// ---- verbatim copy below ----\n";

describe("session-kit reply.ts copy", () => {
  it.skipIf(!NodeFS.existsSync(SOURCE))(
    "matches the dotfiles source byte for byte (skipped where ~/repos/dotfiles is absent)",
    () => {
      const copy = NodeFS.readFileSync(COPY, "utf8");
      const at = copy.indexOf(MARKER);
      expect(at).toBeGreaterThan(-1);
      expect(copy.slice(at + MARKER.length)).toBe(NodeFS.readFileSync(SOURCE, "utf8"));
    },
  );
});
