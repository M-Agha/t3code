import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Fork-only, as 001. When the decision judge took over: a person's message sent from then on is judged,
// one sent before was answered under the label rules and is read by them alone (owner's Q38). One row,
// written by the first start that runs this, so a restart or a re-run never moves it. Same ISO form as
// the projections' created_at, which it is compared with as text.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_decision_judge_cutoff (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      judged_from TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO fork_decision_judge_cutoff (id, judged_from) VALUES (1, ${now})
    ON CONFLICT (id) DO NOTHING
  `;
});
