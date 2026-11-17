// Fork-only shim: judge.ts, a verbatim copy, imports `lastTurn` from session-kit's board-file.ts, which
// re-exports it from reply.ts. Only that re-export is needed here.
export { lastTurn } from "./reply.ts";
