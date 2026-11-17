// Fork-only shim: judge.ts, a verbatim copy, imports `Question` from session-kit's types/index.d.ts.
// The same shape: a board question row. The server builds these from its open-question rows.
export type Question = {
  id: number;
  label: string;
  keys?: string;
  text: string;
  turn: string;
  at: string;
  state: string;
};
