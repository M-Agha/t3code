// @effect-diagnostics nodeBuiltinImport:off - a plain file comparison, no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const SOURCE_DIR = NodePath.join(NodeOS.homedir(), "repos/dotfiles/.claude/mods/session-kit/hooks");
const MARKER = "// ---- verbatim copy below ----\n";

describe.each(["reply.ts", "judge.ts"])("session-kit %s copy", (name) => {
  const source = NodePath.join(SOURCE_DIR, name);
  it.skipIf(!NodeFS.existsSync(source))(
    "matches the dotfiles source byte for byte (skipped where ~/repos/dotfiles is absent)",
    () => {
      const copy = NodeFS.readFileSync(NodePath.join(import.meta.dirname, name), "utf8");
      const at = copy.indexOf(MARKER);
      expect(at).toBeGreaterThan(-1);
      expect(copy.slice(at + MARKER.length)).toBe(NodeFS.readFileSync(source, "utf8"));
    },
  );
});
