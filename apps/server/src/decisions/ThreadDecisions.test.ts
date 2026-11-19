import {
  EventId,
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  ProviderInstanceId,
  RunId,
  THREAD_ARTIFACTS_LIMIT,
  TextGenerationError,
  type ThreadDecisionsError,
  THREAD_DECIDED_WITHOUT_ASKING_LIMIT,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as DecisionJudge from "./DecisionJudge.ts";
import ForkMigration0006 from "../persistence/ForkMigrations/006_ThreadArtifactTypes.ts";
import * as ThreadDecisions from "./ThreadDecisions.ts";

const threadId = ThreadId.make("thread-decisions");

// The decision judge over a fake text generator: `answer` stands in for the model, given the prompt.
const judgeLayer = (answer: (prompt: string) => Effect.Effect<string, TextGenerationError>) =>
  DecisionJudge.layer.pipe(
    Layer.provide(
      Layer.mock(TextGeneration.TextGeneration)({
        generateTranscriptionPostProcessing: (input) =>
          answer(input.prompt).pipe(Effect.map((transcription) => ({ transcription }))),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(NodeServices.layer),
  );

// A model that cannot be reached: every message is closed by the rules, as before the judge.
const offline = () =>
  Effect.fail(
    new TextGenerationError({
      operation: "generateTranscriptionPostProcessing",
      detail: "offline",
    }),
  );

// Fork migration 005 records the judge taking over at the clock's time, TestClock's 1970 here, so every
// message these tests write is judged unless a test moves it (`judgeFrom`).
const decisionsWith = (answer: (prompt: string) => Effect.Effect<string, TextGenerationError>) =>
  ThreadDecisions.layer.pipe(
    Layer.provide(judgeLayer(answer)),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const withDecisions = decisionsWith(offline);

const REPLY = [
  "Migrated.",
  "",
  "**Decided without asking**",
  "- Kept the old index.",
  "",
  "Q4, follow continuation: Resume the run? My pick is yes: it stopped cleanly.",
  "Q5, table name: Rename it? My pick is no: nothing reads it yet.",
].join("\n");

const seed = Effect.fn("seed")(function* (deletedAt: string | null = null, id = threadId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, deleted_at, payload_json
    ) VALUES (${id}, 'project', 'Thread', 'codex', 'full-access', 'default',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${deletedAt}, '{}')
  `;
});

const run = Effect.fn("run")(function* (runId: string, ordinal: number, status: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_projection_runs (
      run_id, thread_id, ordinal, provider, status, requested_at, payload_json
    ) VALUES (${runId}, ${threadId}, ${ordinal}, 'codex', ${status}, '2026-01-01T00:00:00.000Z', '{}')
    ON CONFLICT (run_id) DO UPDATE SET status = excluded.status
  `;
});

// Every message and card a minute after the one before, so they sort as text in the order written.
let minute = 0;
const nextAt = () => {
  minute += 1;
  return DateTime.formatIso(DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 0, minute)));
};

const message = Effect.fn("message")(function* (
  messageId: string,
  runId: string,
  role: "user" | "assistant",
  text: string,
  extra: Record<string, unknown> = {},
  streaming = false,
) {
  const sql = yield* SqlClient.SqlClient;
  const at = nextAt();
  const payload = { text, createdBy: role === "user" ? "user" : "agent", ...extra };
  yield* sql`
    INSERT INTO orchestration_v2_projection_messages (
      message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
    ) VALUES (${messageId}, ${threadId}, ${runId}, NULL, ${role}, ${streaming ? 1 : 0}, ${at}, ${at},
      ${JSON.stringify(payload)})
  `;
});

const question = Effect.fn("question")(function* (label: string) {
  const decisions = yield* ThreadDecisions.ThreadDecisions;
  return (yield* decisions.snapshot(threadId)).questions.find((q) => q.label === label);
});

const states = Effect.fn("states")(function* () {
  const decisions = yield* ThreadDecisions.ThreadDecisions;
  const snapshot = yield* decisions.snapshot(threadId);
  return Object.fromEntries(snapshot.questions.map((q) => [q.label, q.state]));
});

it.effect("tracks a thread's questions from its replies and the user's answers", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const decisions = yield* ThreadDecisions.ThreadDecisions;
    yield* seed();
    yield* run("r1", 1, "completed");
    yield* message("u1", "r1", "user", "Migrate it.");
    // Not the run's reply: a later assistant message is.
    yield* message("a1", "r1", "assistant", "Checking.\n\nQ9, narration: Skip? My pick is no: x.");
    yield* message("a2", "r1", "assistant", REPLY);

    assert.isTrue(yield* decisions.sync(threadId));
    const snapshot = yield* decisions.snapshot(threadId);
    assert.deepEqual(
      snapshot.questions.map((q) => [q.label, q.keyWords, q.pick, q.sourceMessageId]),
      [
        ["Q4", "follow continuation", "yes", "a2"],
        ["Q5", "table name", "no", "a2"],
      ],
    );
    assert.deepEqual(
      snapshot.decidedWithoutAsking.map((item) => item.text),
      ["Kept the old index."],
    );

    yield* run("r2", 2, "running");
    yield* message("u2", "r2", "user", "What does the log say?");
    assert.isFalse(yield* decisions.sync(threadId));
    yield* message("u3", "r2", "user", "Q4: yes", { senderThreadId: "another-agent" });
    // An agent's t3_thread_send is role user, created by the agent.
    yield* message("u3b", "r2", "user", "Q4: yes", { createdBy: "agent", creationSource: "mcp" });
    assert.isFalse(yield* decisions.sync(threadId));
    yield* message("u4", "r2", "user", "Q4: yes");
    yield* message("u5", "r2", "user", "Q5: not a decision");
    assert.isTrue(yield* decisions.sync(threadId));
    assert.deepEqual(yield* states(), { Q4: "answered", Q5: "dropped" });
    const q4 = (yield* decisions.snapshot(threadId)).questions.find((q) => q.label === "Q4");
    assert.deepEqual([q4?.answerText, q4?.answerMessageId], ["Q4: yes", "u4"]);

    // r2 is still running: its reply is read once the run ends, and once it stops streaming.
    yield* message(
      "a3",
      "r2",
      "assistant",
      "Q4, follow continuation: Resume now? My pick is yes: ok.",
      {},
      true,
    );
    assert.isFalse(yield* decisions.sync(threadId));
    // A completed turn is first persisted as waiting.
    yield* run("r2", 2, "waiting");
    assert.isFalse(yield* decisions.sync(threadId));
    yield* sql`UPDATE orchestration_v2_projection_messages SET streaming = 0 WHERE message_id = 'a3'`;
    assert.isTrue(yield* decisions.sync(threadId));
    const reasked = yield* question("Q4");
    assert.deepEqual(
      [reasked?.state, reasked?.question, reasked?.sourceMessageId, reasked?.answerText],
      ["open", "Resume now?", "a3", null],
    );

    yield* decisions.reopen({ threadId, label: "Q5" });
    assert.deepEqual(yield* states(), { Q4: "open", Q5: "open" });
    // The watermark keeps the old "Q5: not a decision" from closing it again.
    assert.isFalse(yield* decisions.sync(threadId));
    const refused = yield* Effect.flip(decisions.reopen({ threadId, label: "Q5" }));
    assert.include(refused.message, "not a resolved question");

    // The snapshot carries a preview of a long answer.
    yield* message("u6", "r2", "user", `Q4: yes, ${"x".repeat(400)}`);
    assert.isTrue(yield* decisions.sync(threadId));
    const long = (yield* question("Q4"))?.answerText ?? "";
    assert.deepEqual([long.length, long.at(-1)], [300, "…"]);

    // An unshaped line about a known label changes nothing: an agent echoing an answered label as it acts on
    // the answer ("Q7: nothing to change." right after the user's "Q7: yes", 2026-11-17) must not reopen it.
    const answered = yield* question("Q4");
    assert.equal(answered?.state, "answered");
    yield* run("r3", 3, "completed");
    yield* message("a4", "r3", "assistant", "Done.\n\nQ4: nothing to change, the log is in.");
    yield* decisions.sync(threadId);
    const status = yield* question("Q4");
    assert.deepEqual(
      [status?.state, status?.question, status?.sourceMessageId, status?.answerText],
      ["answered", answered?.question, answered?.sourceMessageId, answered?.answerText],
    );

    // Only the newest choices made without asking reach the snapshot.
    const bullets = Array.from({ length: 60 }, (_, n) => `- Choice ${n}.`);
    yield* run("r4", 4, "completed");
    yield* message("a5", "r4", "assistant", ["**Decided without asking**", ...bullets].join("\n"));
    assert.isTrue(yield* decisions.sync(threadId));
    const decided = (yield* decisions.snapshot(threadId)).decidedWithoutAsking;
    assert.deepEqual(
      [decided.length, decided[0]?.text],
      [THREAD_DECIDED_WITHOUT_ASKING_LIMIT, "Choice 0."],
    );
  }).pipe(Effect.provide(withDecisions)),
);

it.effect("serves each question its own part of the message that answered it", () =>
  Effect.gen(function* () {
    const decisions = yield* ThreadDecisions.ThreadDecisions;
    yield* seed();
    yield* run("r1", 1, "completed");
    yield* message("a1", "r1", "assistant", REPLY);
    yield* run("r2", 2, "completed");
    yield* message("u1", "r2", "user", "Why the index? q4: Yes Q5: No,\nkeep the name");
    yield* decisions.sync(threadId);
    assert.deepEqual(
      (yield* decisions.snapshot(threadId)).questions.map((q) => [q.label, q.answerText]),
      [
        ["Q4", "q4: Yes"],
        ["Q5", "Q5: No,\nkeep the name"],
      ],
    );
  }).pipe(Effect.provide(withDecisions)),
);

it.effect("marks a choice vetoed once the user sends its Veto line, and publishes it", () =>
  Effect.gen(function* () {
    const decisions = yield* ThreadDecisions.ThreadDecisions;
    const vetoed = Effect.fn("vetoed")(function* () {
      const snapshot = yield* decisions.snapshot(threadId);
      return snapshot.decidedWithoutAsking.map((item) => [item.text, item.vetoed]);
    });
    yield* seed();
    yield* run("r1", 1, "completed");
    yield* message("a1", "r1", "assistant", REPLY);
    assert.isTrue(yield* decisions.sync(threadId));
    assert.deepEqual(yield* vetoed(), [["Kept the old index.", false]]);

    // Not a line of its own, or not typed by the user: no veto.
    yield* run("r2", 2, "completed");
    yield* message("u1", "r2", "user", "Why not Veto: Kept the old index.?");
    yield* message("u2", "r2", "user", "Veto: Kept the old index.", { createdBy: "agent" });
    yield* decisions.sync(threadId);
    assert.deepEqual(yield* vetoed(), [["Kept the old index.", false]]);

    // Closes no question, yet changes the snapshot, so subscribers get it. Lines are read trimmed, as
    // the panel reads its draft.
    yield* message("u3", "r2", "user", "Also rename it.\n  Veto: Kept the old index. ");
    assert.isTrue(yield* decisions.sync(threadId));
    assert.deepEqual(yield* vetoed(), [["Kept the old index.", true]]);
  }).pipe(Effect.provide(withDecisions)),
);

// Shapes copied from a Claude thread's projected Artifact tool calls; ids and paths shortened.
const artifactItem = Effect.fn("artifactItem")(function* (
  itemId: string,
  updatedAt: string,
  input: Record<string, unknown>,
  output: unknown,
  { status = "completed", toolName = "Artifact", driver = "claudeAgent", thread = threadId } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const payload = {
    id: itemId,
    threadId: thread,
    runId: "r1",
    nodeId: `node:${itemId}`,
    nativeItemRef: { driver, nativeId: itemId, strength: "strong" },
    parentItemId: null,
    ordinal: 1,
    status,
    title: null,
    startedAt: updatedAt,
    completedAt: status === "completed" ? updatedAt : null,
    updatedAt,
    type: "dynamic_tool",
    toolName,
    input,
    output,
  };
  yield* sql`
    INSERT INTO orchestration_v2_projection_turn_items (
      turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json
    ) VALUES (${itemId}, ${thread}, 'r1', 1, 'dynamic_tool', ${status}, ${updatedAt},
      ${JSON.stringify(payload)})
    ON CONFLICT (turn_item_id) DO UPDATE SET
      status = excluded.status, updated_at = excluded.updated_at,
      payload_json = excluded.payload_json
  `;
});

const PLAN_URL = "https://claude.ai/artifact/RMhcQqa7QJj15KA5R3kCxN";
const PLAN_UUID = "c53f3af9-93a3-4286-9581-8bf18386d46f";
const DRAFT_UUID = "1b2c3d4e-0000-4000-8000-000000000001";
const DRAFT_URL = `https://claude.ai/code/artifact/${DRAFT_UUID}`;
const publishOutput = (url: string, title: string, updated: boolean, artifactId = PLAN_UUID) => ({
  url,
  path: "/tmp/scratchpad/t3-decisions-plan.html",
  artifact_id: artifactId,
  title,
  updated,
  owned: true,
  audience: "owner",
  seq: 1,
  version: "1794495821-88bf",
  contract: "0.0.0",
  liveSubscription: "publish_context",
});

it.effect("collects a thread's artifacts from Artifact tool calls and reply links", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const decisions = yield* ThreadDecisions.ThreadDecisions;
    const artifacts = Effect.fn("artifacts")(function* () {
      const snapshot = yield* decisions.snapshot(threadId);
      return {
        count: snapshot.artifactCount,
        rows: snapshot.artifacts.map((a) => [
          a.id,
          a.url,
          a.title,
          a.description,
          a.mentionedOnly,
          a.updatedAt,
        ]),
      };
    });
    yield* seed();
    yield* run("r1", 1, "completed");
    // A thread whose decisions synced before artifacts existed still reads its links from the start.
    yield* sql`
      INSERT INTO fork_thread_decision_sync (thread_id, after_created_at, after_message_id)
      VALUES (${threadId}, '9999', 'm')
    `;
    yield* artifactItem(
      "publish",
      "2026-01-01T00:01:00.000Z",
      {
        file_path: "/tmp/scratchpad/t3-decisions-plan.html",
        icon: "map",
        description: "Plan for making end-of-reply questions native.",
      },
      publishOutput(PLAN_URL, "T3 Decisions Plan", false),
    );
    yield* artifactItem(
      "quickstart",
      "2026-01-01T00:02:00.000Z",
      { action: "quickstart", intent: "other" },
      {
        quickstart: {
          intent: "other",
          types: [{ title: "Data", type_url: "https://claude.ai/artifact/GZLZthZ2sQjn7T16skfdeF" }],
        },
      },
    );
    yield* artifactItem(
      "malformed",
      "2026-01-01T00:03:00.000Z",
      {},
      '{"url": "https://claude.ai/ar',
    );
    yield* artifactItem(
      "elsewhere",
      "2026-01-01T00:04:00.000Z",
      {},
      {
        url: "https://example.com/artifact/Elsewhere1",
      },
    );
    yield* message("u1", "r1", "user", "Is https://claude.ai/artifact/UserLink1 the one?");
    yield* artifactItem(
      "codex",
      "2026-01-01T00:05:00.000Z",
      {},
      publishOutput("https://claude.ai/artifact/Codex1", "Not Claude's", false),
      { driver: "codex" },
    );
    yield* message(
      "a1",
      "r1",
      "assistant",
      [
        `Published [the plan](${PLAN_URL}), also https://claude.ai/code/artifact/${PLAN_UUID}.`,
        "The mock-up is https://claude.ai/artifact/MockUp2?tab=2#top, the draft",
        `(${DRAFT_URL}). Not https://claude.ai/code/artifact/66a57730-… either.`,
      ].join(" "),
    );

    const [linked] = yield* sql<{ readonly at: string }>`
      SELECT created_at AS at FROM orchestration_v2_projection_messages WHERE message_id = 'a1'
    `;
    assert.isDefined(linked);
    assert.isTrue(yield* decisions.sync(threadId));
    assert.deepEqual(yield* artifacts(), {
      count: 3,
      rows: [
        [DRAFT_UUID, DRAFT_URL, null, null, true, linked.at],
        ["MockUp2", "https://claude.ai/artifact/MockUp2", null, null, true, linked.at],
        [
          "RMhcQqa7QJj15KA5R3kCxN",
          PLAN_URL,
          "T3 Decisions Plan",
          "Plan for making end-of-reply questions native.",
          false,
          "2026-01-01T00:01:00.000Z",
        ],
      ],
    });
    assert.isFalse(yield* decisions.sync(threadId));
    // A later link moves a mentioned artifact's time, not when it was first seen.
    yield* message("a1b", "r1", "assistant", `The draft again: ${DRAFT_URL}`);
    const [relinked] = yield* sql<{ readonly at: string }>`
      SELECT created_at AS at FROM orchestration_v2_projection_messages WHERE message_id = 'a1b'
    `;
    assert.isTrue(yield* decisions.sync(threadId));
    assert.deepEqual((yield* artifacts()).rows[0], [
      DRAFT_UUID,
      DRAFT_URL,
      null,
      null,
      true,
      relinked?.at,
    ]);

    // A republish stores its output as JSON text and leaves out the description.
    yield* artifactItem(
      "republish",
      "2026-01-03T00:00:00.000Z",
      { file_path: "/tmp/scratchpad/t3-decisions-plan.html" },
      JSON.stringify(publishOutput(PLAN_URL, "T3 Decisions Plan v2", true)),
    );
    assert.isTrue(yield* decisions.sync(threadId));
    // A publish of a linked artifact gives it a title; it arrives running, without output.
    // Its uuid is the draft's, so the draft's `code/artifact/` row folds into it.
    yield* artifactItem("late", "2026-01-03T00:01:00.000Z", {}, null, { status: "running" });
    assert.isFalse(yield* decisions.sync(threadId));
    yield* artifactItem(
      "late",
      "2026-01-03T00:02:00.000Z",
      { description: `Eight screens.${"x".repeat(1200)}` },
      publishOutput(
        "https://claude.ai/artifact/MockUp2",
        `Spending Canvas${"x".repeat(300)}`,
        false,
        DRAFT_UUID,
      ),
    );
    assert.isTrue(yield* decisions.sync(threadId));
    // Provider text is capped as it is stored.
    assert.deepEqual((yield* artifacts()).rows, [
      [
        "MockUp2",
        "https://claude.ai/artifact/MockUp2",
        `Spending Canvas${"x".repeat(185)}`,
        `Eight screens.${"x".repeat(986)}`,
        false,
        "2026-01-03T00:02:00.000Z",
      ],
      [
        "RMhcQqa7QJj15KA5R3kCxN",
        PLAN_URL,
        "T3 Decisions Plan v2",
        "Plan for making end-of-reply questions native.",
        false,
        "2026-01-03T00:00:00.000Z",
      ],
    ]);
    const firstSeen = yield* sql<{
      readonly id: string;
      readonly uuid: string;
      readonly at: string;
    }>`
      SELECT link_id AS id, artifact_id AS uuid, first_seen_at AS at
      FROM fork_thread_artifacts ORDER BY id
    `;
    assert.deepEqual(firstSeen, [
      { id: "MockUp2", uuid: DRAFT_UUID, at: linked.at },
      { id: "RMhcQqa7QJj15KA5R3kCxN", uuid: PLAN_UUID, at: "2026-01-01T00:01:00.000Z" },
    ]);

    // A link to a published artifact changes nothing; a streaming reply is read once it ends.
    const many = Array.from({ length: 55 }, (_, n) => `https://claude.ai/artifact/Many${n}`);
    yield* message("a2", "r1", "assistant", `Again: ${PLAN_URL}`);
    yield* message("a3", "r1", "assistant", many.join(" "), {}, true);
    assert.isFalse(yield* decisions.sync(threadId));
    yield* sql`UPDATE orchestration_v2_projection_messages SET streaming = 0 WHERE message_id = 'a3'`;
    assert.isTrue(yield* decisions.sync(threadId));
    const limited = yield* decisions.snapshot(threadId);
    assert.deepEqual(
      [limited.artifactCount, limited.artifacts.length],
      [57, THREAD_ARTIFACTS_LIMIT],
    );

    // Any tool call moves the watermark, so a thread without Artifact calls reads each item once.
    yield* artifactItem(
      "bash",
      "2026-01-04T00:00:00.000Z",
      {},
      { url: PLAN_URL },
      {
        toolName: "Bash",
      },
    );
    assert.isFalse(yield* decisions.sync(threadId));
    const [watermark] = yield* sql<{ readonly itemId: string }>`
      SELECT after_item_id AS "itemId" FROM fork_thread_artifact_sync
    `;
    assert.deepEqual(watermark, { itemId: "bash" });
  }).pipe(Effect.provide(withDecisions)),
);

it.effect("publishes a decisions change when reading artifacts fails", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const decisions = yield* ThreadDecisions.ThreadDecisions;
    yield* seed();
    yield* run("r1", 1, "completed");
    yield* message("a1", "r1", "assistant", REPLY);
    yield* sql`DROP TABLE fork_thread_artifact_sync`;
    assert.isTrue(yield* decisions.sync(threadId));
    assert.deepEqual(Object.keys(yield* states()), ["Q4", "Q5"]);
  }).pipe(Effect.provide(withDecisions)),
);

// claude.ai's answer to a read of a deleted artifact, as T3 stored the failed call (2026-11-19).
const NOT_FOUND_OUTPUT =
  "Error: artifact not found — it may have been deleted, or it has not been shared with you. If it was shared with you by email, accept the invitation in a browser first, and check that Claude Code is signed in to the invited account";
const DESIGN_TYPE = "https://claude.ai/artifact/QKN21svewxgyPb6SYRqWnd";
const ODD_TYPE = "https://claude.ai/artifact/OddType1";
const createOutput = (url: string, title: string, typeUrl: string) => ({
  created_from_type: true,
  url,
  version: "1795115338-5d3e",
  owned: true,
  title,
  type: { url: typeUrl, release: "1795108001-df11" },
  own_files: [],
  type_files: ["SKILL.md"],
});
const readOutput = (url: string, type?: { url: string; title: string }) => ({
  file_read: {
    url,
    title: "Board",
    path: "project/canvas.json",
    ...(type === undefined ? {} : { from_type: true, type }),
  },
});

/** Each artifact row by its id: what the panel groups and labels it by. */
const artifactsById = Effect.fn("artifactsById")(function* (thread = threadId) {
  const decisions = yield* ThreadDecisions.ThreadDecisions;
  const snapshot = yield* decisions.snapshot(thread);
  return Object.fromEntries(
    snapshot.artifacts.map((a) => [
      a.id,
      {
        url: a.url,
        title: a.title,
        mentionedOnly: a.mentionedOnly,
        linkedByUser: a.linkedByUser,
        type: a.type,
        notFoundAt: a.notFoundAt,
      },
    ]),
  );
});
const typeOf = Effect.fn("typeOf")(function* (id: string) {
  return (yield* artifactsById())[id]?.type;
});

it.effect(
  "names an artifact's type: a name any thread learned, then a core type's, else none",
  () =>
    Effect.gen(function* () {
      const decisions = yield* ThreadDecisions.ThreadDecisions;
      const other = ThreadId.make("thread-other");
      yield* seed();
      yield* seed(null, other);
      yield* artifactItem(
        "create-design",
        "2026-01-01T00:01:00.000Z",
        { type_url: DESIGN_TYPE, title: "Board" },
        createOutput("https://claude.ai/artifact/Board1", "Board", DESIGN_TYPE),
      );
      // A create whose output leaves out `type` is typed by what it asked for.
      yield* artifactItem(
        "create-odd",
        "2026-01-01T00:02:00.000Z",
        { action: "publish", type_url: ODD_TYPE, title: "Odd" },
        { created_from_type: true, url: "https://claude.ai/artifact/Odd1", title: "Odd" },
      );
      yield* artifactItem(
        "page",
        "2026-01-01T00:03:00.000Z",
        { file_path: "/tmp/scratchpad/t3-decisions-plan.html" },
        publishOutput(PLAN_URL, "T3 Decisions Plan", false),
      );
      yield* artifactItem(
        "markdown",
        "2026-01-01T00:04:00.000Z",
        { file_path: "/tmp/scratchpad/notes.MD" },
        {
          ...publishOutput("https://claude.ai/artifact/Notes1", "Notes", false, DRAFT_UUID),
          path: "/tmp/scratchpad/notes.MD",
        },
      );
      // Other calls name no artifact: a failed list, a list of the person's artifacts, a quickstart.
      yield* artifactItem(
        "failed-list",
        "2026-01-01T00:05:00.000Z",
        { action: "list", scope: "types", limit: 5 },
        'Error: list with `scope: "types"` takes only `type_query` — remove limit.',
        { status: "failed" },
      );
      yield* artifactItem(
        "list-mine",
        "2026-01-01T00:06:00.000Z",
        { action: "list", limit: 5 },
        { artifacts: [{ url: "https://claude.ai/artifact/Mine1", title: "Mine" }], total: 1 },
      );
      assert.isTrue(yield* decisions.sync(threadId));
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(yield* artifactsById()).map(([id, row]) => [id, row.type]),
        ),
        {
          Board1: { kind: "typed", url: DESIGN_TYPE, name: "Design" },
          Odd1: { kind: "typed", url: ODD_TYPE, name: null },
          RMhcQqa7QJj15KA5R3kCxN: { kind: "page", format: "html" },
          Notes1: { kind: "page", format: "markdown" },
        },
      );

      // Another thread lists the types: the names reach rows written before, here.
      yield* artifactItem(
        "types",
        "2026-01-02T00:00:00.000Z",
        { action: "list", scope: "types" },
        {
          artifact_types: [
            { title: "Odd Type", type_url: ODD_TYPE, description: "x", tier: "core" },
            { title: "Design (renamed)", type_url: DESIGN_TYPE, description: "x", tier: "core" },
            { title: "Nameless", type_url: "https://example.com/type" },
          ],
          docs_unfillable: false,
        },
        { thread: other },
      );
      assert.isTrue(yield* decisions.sync(other));
      assert.deepEqual(yield* artifactsById(other), {});
      assert.deepEqual(yield* typeOf("Odd1"), { kind: "typed", url: ODD_TYPE, name: "Odd Type" });
      assert.deepEqual(yield* typeOf("Board1"), {
        kind: "typed",
        url: DESIGN_TYPE,
        name: "Design (renamed)",
      });
      // A read names its type too, and the later name wins.
      yield* artifactItem(
        "read",
        "2026-01-03T00:00:00.000Z",
        { action: "read", url: "https://claude.ai/artifact/Odd1", path: "project/canvas.json" },
        readOutput("https://claude.ai/artifact/Odd1", { url: ODD_TYPE, title: "Odd Type v2" }),
      );
      assert.isTrue(yield* decisions.sync(threadId));
      assert.deepEqual(yield* typeOf("Odd1"), {
        kind: "typed",
        url: ODD_TYPE,
        name: "Odd Type v2",
      });
    }).pipe(Effect.provide(withDecisions)),
);

it.effect(
  "marks an artifact not found from claude.ai's answer, until a later read or publish",
  () =>
    Effect.gen(function* () {
      const decisions = yield* ThreadDecisions.ThreadDecisions;
      const notFound = Effect.fn("notFound")(function* () {
        const rows = yield* artifactsById();
        return Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, row.notFoundAt]));
      });
      yield* seed();
      yield* run("r1", 1, "completed");
      yield* artifactItem(
        "publish",
        "2026-01-01T00:01:00.000Z",
        {},
        publishOutput(PLAN_URL, "T3 Decisions Plan", false),
      );
      yield* message("a1", "r1", "assistant", "The mock-up: https://claude.ai/artifact/MockUp2");
      assert.isTrue(yield* decisions.sync(threadId));

      // The read named the published artifact by its `code/artifact/` link: its uuid finds the row.
      yield* artifactItem(
        "read-plan",
        "2026-01-03T00:00:00.000Z",
        { action: "read", url: `https://claude.ai/code/artifact/${PLAN_UUID}` },
        NOT_FOUND_OUTPUT,
        { status: "failed" },
      );
      // Any other failure says nothing about the artifact; a link no row lists gets none.
      yield* artifactItem(
        "delete-mockup",
        "2026-01-03T00:01:00.000Z",
        { action: "delete", url: "https://claude.ai/artifact/MockUp2" },
        "Error: Deleting an Artifact needs the user's confirmation, and no one can answer it in this session, so nothing was deleted.",
        { status: "failed" },
      );
      yield* artifactItem(
        "read-gone",
        "2026-01-03T00:02:00.000Z",
        { action: "read", url: "https://claude.ai/artifact/Gone1" },
        NOT_FOUND_OUTPUT,
        { status: "failed" },
      );
      assert.isTrue(yield* decisions.sync(threadId));
      assert.deepEqual(yield* notFound(), {
        MockUp2: null,
        RMhcQqa7QJj15KA5R3kCxN: "2026-01-03T00:00:00.000Z",
      });

      // A read that finds it clears it, whichever link form it used.
      yield* artifactItem(
        "read-mockup-missing",
        "2026-01-04T00:00:00.000Z",
        { action: "read", url: "https://claude.ai/artifact/MockUp2" },
        NOT_FOUND_OUTPUT,
        { status: "failed" },
      );
      assert.isTrue(yield* decisions.sync(threadId));
      assert.equal((yield* notFound()).MockUp2, "2026-01-04T00:00:00.000Z");
      yield* artifactItem(
        "read-mockup",
        "2026-01-04T00:01:00.000Z",
        { action: "read", url: "https://claude.ai/artifact/MockUp2?tab=2" },
        readOutput("https://claude.ai/artifact/MockUp2"),
      );
      // And a publish of it clears it.
      yield* artifactItem(
        "republish",
        "2026-01-04T00:02:00.000Z",
        {},
        publishOutput(PLAN_URL, "T3 Decisions Plan", true),
      );
      assert.isTrue(yield* decisions.sync(threadId));
      assert.deepEqual(yield* notFound(), { MockUp2: null, RMhcQqa7QJj15KA5R3kCxN: null });
      assert.equal((yield* decisions.snapshot(threadId)).artifactCount, 2);
    }).pipe(Effect.provide(withDecisions)),
);

it.effect("links an artifact by hand and unlinks only what the user linked", () =>
  Effect.gen(function* () {
    const decisions = yield* ThreadDecisions.ThreadDecisions;
    const failure = (effect: Effect.Effect<void, ThreadDecisionsError>) =>
      Effect.flip(effect).pipe(Effect.map((error) => error.message));
    yield* seed();
    yield* artifactItem(
      "publish",
      "2026-01-01T00:01:00.000Z",
      {},
      publishOutput(PLAN_URL, "T3 Decisions Plan", false),
    );
    assert.isTrue(yield* decisions.sync(threadId));

    yield* decisions.linkArtifact({
      threadId,
      url: "https://claude.ai/artifact/Q3shipReview?tab=1#top",
      title: "Q3 shipping review",
    });
    const manual = {
      url: "https://claude.ai/artifact/Q3shipReview",
      title: "Q3 shipping review",
      mentionedOnly: true,
      linkedByUser: true,
      type: null,
      notFoundAt: null,
    };
    assert.deepEqual((yield* artifactsById()).Q3shipReview, manual);
    // A second link of a listed artifact reuses its row, by either link form, and keeps its title.
    yield* decisions.linkArtifact({ threadId, url: "https://claude.ai/artifact/Q3shipReview" });
    yield* decisions.linkArtifact({
      threadId,
      url: `https://claude.ai/code/artifact/${PLAN_UUID}`,
      title: "Another name",
    });
    const rows = yield* artifactsById();
    assert.deepEqual(Object.keys(rows).toSorted(), ["Q3shipReview", "RMhcQqa7QJj15KA5R3kCxN"]);
    assert.deepEqual(rows.Q3shipReview, manual);
    assert.include(rows.RMhcQqa7QJj15KA5R3kCxN, {
      title: "T3 Decisions Plan",
      linkedByUser: false,
      mentionedOnly: false,
    });

    assert.equal(
      yield* failure(decisions.linkArtifact({ threadId, url: "https://example.com/artifact/x" })),
      ThreadDecisions.NOT_AN_ARTIFACT_LINK,
    );
    assert.equal(
      yield* failure(decisions.unlinkArtifact({ threadId, id: "RMhcQqa7QJj15KA5R3kCxN" })),
      "Only an artifact you linked can be unlinked from this thread.",
    );
    yield* decisions.unlinkArtifact({ threadId, id: "Q3shipReview" });
    assert.deepEqual(Object.keys(yield* artifactsById()), ["RMhcQqa7QJj15KA5R3kCxN"]);

    // A `code/artifact/` link the user added folds into the publish that names its uuid.
    yield* decisions.linkArtifact({ threadId, url: DRAFT_URL });
    yield* artifactItem(
      "publish-draft",
      "2026-01-05T00:00:00.000Z",
      {},
      publishOutput("https://claude.ai/artifact/MockUp2", "Spending Canvas", false, DRAFT_UUID),
    );
    assert.isTrue(yield* decisions.sync(threadId));
    assert.deepEqual(Object.keys(yield* artifactsById()).toSorted(), [
      "MockUp2",
      "RMhcQqa7QJj15KA5R3kCxN",
    ]);
    assert.include((yield* artifactsById()).MockUp2, { linkedByUser: false, mentionedOnly: false });

    const deleted = ThreadId.make("thread-deleted");
    yield* seed("2026-01-02T00:00:00.000Z", deleted);
    assert.equal(
      yield* failure(decisions.linkArtifact({ threadId: deleted, url: PLAN_URL })),
      "This thread was not found.",
    );
  }).pipe(Effect.provide(withDecisions)),
);

it.effect(
  "keeps the user's title and a known type, adopts a linked mention, and hides a type's own link",
  () =>
    Effect.gen(function* () {
      const decisions = yield* ThreadDecisions.ThreadDecisions;
      const design = "https://claude.ai/artifact/QKN21svewxgyPb6SYRqWnd";
      yield* seed();
      // A reply naming the Design type's own link is not an artifact; the other link is a mention.
      yield* message(
        "a1",
        "r1",
        "assistant",
        `Made from ${design}: https://claude.ai/artifact/Mentioned9`,
      );
      assert.isTrue(yield* decisions.sync(threadId));
      assert.deepEqual(Object.keys(yield* artifactsById()), ["Mentioned9"]);
      assert.equal((yield* decisions.snapshot(threadId)).artifactCount, 1);

      // Linking a mentioned artifact makes it the user's: their title, and Unlink.
      yield* decisions.linkArtifact({
        threadId,
        url: "https://claude.ai/artifact/Mentioned9",
        title: "My name",
      });
      assert.include((yield* artifactsById()).Mentioned9, { title: "My name", linkedByUser: true });
      yield* decisions.unlinkArtifact({ threadId, id: "Mentioned9" });
      assert.deepEqual(Object.keys(yield* artifactsById()), []);

      // A title the user gave a code/artifact link survives the fold-in when the publish names none.
      yield* decisions.linkArtifact({ threadId, url: DRAFT_URL, title: "Kept title" });
      const { title: _untitled, ...untitled } = publishOutput(
        "https://claude.ai/artifact/MockUp3",
        "",
        false,
        DRAFT_UUID,
      );
      yield* artifactItem("publish-untitled", "2026-01-06T00:00:00.000Z", {}, untitled);
      assert.isTrue(yield* decisions.sync(threadId));
      assert.include((yield* artifactsById()).MockUp3, {
        title: "Kept title",
        linkedByUser: false,
      });

      // A type, once a publish names it, stays when a later publish names none.
      const typed = {
        ...publishOutput("https://claude.ai/artifact/Typed1", "Canvas", false, "typed-uuid"),
        type: { url: design, release: "r" },
      };
      yield* artifactItem("publish-typed", "2026-01-07T00:00:00.000Z", {}, typed);
      yield* artifactItem(
        "publish-typed-again",
        "2026-01-08T00:00:00.000Z",
        {},
        publishOutput("https://claude.ai/artifact/Typed1", "Canvas", true, "typed-uuid"),
      );
      assert.isTrue(yield* decisions.sync(threadId));
      assert.deepEqual((yield* artifactsById()).Typed1?.type, {
        kind: "typed",
        url: design,
        name: "Design",
      });
    }).pipe(Effect.provide(withDecisions)),
);

it.effect("reads every Artifact call again after fork migration 006, filling types and names", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const decisions = yield* ThreadDecisions.ThreadDecisions;
    yield* seed();
    yield* artifactItem(
      "types",
      "2026-01-01T00:00:00.000Z",
      { action: "list", scope: "types" },
      { artifact_types: [{ title: "Odd Type", type_url: ODD_TYPE }] },
    );
    yield* artifactItem(
      "create",
      "2026-01-01T00:01:00.000Z",
      { type_url: ODD_TYPE, title: "Odd" },
      createOutput("https://claude.ai/artifact/Odd1", "Odd", ODD_TYPE),
    );
    // As a build before 006 left it: the row without its type, the position past both calls.
    yield* sql`
      INSERT INTO fork_thread_artifacts (
        thread_id, link_id, url, title, source, first_seen_at, updated_at
      ) VALUES (${threadId}, 'Odd1', 'https://claude.ai/artifact/Odd1', 'Odd', 'tool',
        '2026-01-01T00:01:00.000Z', '2026-01-01T00:01:00.000Z')
    `;
    yield* sql`
      INSERT INTO fork_thread_artifact_sync (
        thread_id, after_message_created_at, after_message_id, after_item_updated_at, after_item_id
      ) VALUES (${threadId}, '', '', '2026-01-01T00:01:00.000Z', 'create')
    `;
    assert.isFalse(yield* decisions.sync(threadId));
    assert.isNull(yield* typeOf("Odd1"));

    yield* ForkMigration0006;
    assert.isTrue(yield* decisions.sync(threadId));
    assert.deepEqual(yield* typeOf("Odd1"), { kind: "typed", url: ODD_TYPE, name: "Odd Type" });
    // The replay rewrote the row in place: one row, first seen when it was.
    const [row] = yield* sql<{ readonly firstSeenAt: string; readonly count: number }>`
      SELECT first_seen_at AS "firstSeenAt", COUNT(*) AS count FROM fork_thread_artifacts
    `;
    assert.deepEqual(row, { firstSeenAt: "2026-01-01T00:01:00.000Z", count: 1 });
  }).pipe(Effect.provide(withDecisions)),
);

it.effect("parks, edits and resolves a thread's items", () =>
  Effect.gen(function* () {
    const decisions = yield* ThreadDecisions.ThreadDecisions;
    yield* seed();
    const parked = Effect.fn("parked")(function* () {
      const snapshot = yield* decisions.snapshot(threadId);
      return {
        open: snapshot.parkedOpenCount,
        items: snapshot.parked.map((item) => [item.text, item.kind, item.state, item.parkedBy]),
      };
    });

    yield* decisions.park({
      threadId,
      parkedBy: "user",
      items: [
        { kind: "todo", text: " fix the flaky test " },
        { kind: "later", text: "look at CI caching" },
      ],
    });
    yield* decisions.park({
      threadId,
      parkedBy: "agent",
      items: [
        { kind: "prompt", text: "Write the release notes" },
        { kind: "todo", text: "check the deploy" },
      ],
    });
    assert.deepEqual(yield* parked(), {
      open: 4,
      items: [
        ["fix the flaky test", "todo", "open", "user"],
        ["look at CI caching", "later", "open", "user"],
        ["Write the release notes", "prompt", "open", "agent"],
        ["check the deploy", "todo", "open", "agent"],
      ],
    });

    const [fix, ci, notes, deploy] = (yield* decisions.snapshot(threadId)).parked.map(
      (item) => item.id,
    );
    assert.isDefined(fix);
    assert.isDefined(ci);
    assert.isDefined(notes);
    assert.isDefined(deploy);
    yield* decisions.updateParked({ threadId, id: ci, action: "edit", text: "cache CI" });
    yield* decisions.updateParked({ threadId, id: fix, action: "done" });
    yield* decisions.updateParked({ threadId, id: ci, action: "drop" });
    yield* decisions.updateParked({ threadId, id: notes, action: "sent" });
    assert.deepEqual(yield* parked(), {
      open: 1,
      items: [
        ["check the deploy", "todo", "open", "agent"],
        // TestClock stands still, so resolved items tie and the newest id comes first.
        ["Write the release notes", "prompt", "sent", "agent"],
        ["cache CI", "later", "dropped", "user"],
        ["fix the flaky test", "todo", "done", "user"],
      ],
    });

    yield* decisions.updateParked({ threadId, id: ci, action: "reopen" });
    const reopened = (yield* decisions.snapshot(threadId)).parked.find((item) => item.id === ci);
    assert.deepEqual([reopened?.state, reopened?.resolvedAt], ["open", null]);

    const refusals = yield* Effect.forEach(
      [
        decisions.updateParked({ threadId, id: notes, action: "edit", text: "too late" }),
        decisions.updateParked({ threadId, id: deploy, action: "reopen" }),
        decisions.updateParked({ threadId: ThreadId.make("other"), id: deploy, action: "done" }),
        decisions.updateParked({ threadId, id: deploy, action: "edit", text: "TBD" }),
        decisions.park({ threadId, parkedBy: "agent", items: [{ kind: "todo", text: "…" }] }),
        decisions.park({
          threadId: ThreadId.make("thread-missing"),
          parkedBy: "user",
          items: [{ kind: "todo", text: "real" }],
        }),
      ],
      (refused) => Effect.flip(refused).pipe(Effect.map((error) => error.message)),
    );
    assert.deepEqual(refusals, [
      "This item is no longer open in this thread.",
      "This item is not resolved.",
      "This item is no longer open in this thread.",
      ThreadDecisions.PLACEHOLDER_PARK_MESSAGE,
      ThreadDecisions.PLACEHOLDER_PARK_MESSAGE,
      "This thread was not found.",
    ]);
    // A refused batch parks none of its items.
    yield* Effect.flip(
      decisions.park({
        threadId,
        parkedBy: "user",
        items: [
          { kind: "todo", text: "real work" },
          { kind: "todo", text: "placeholder" },
        ],
      }),
    );
    assert.strictEqual((yield* parked()).open, 2);
  }).pipe(Effect.provide(withDecisions)),
);

it.effect("sweeps deleted threads' rows when it starts, keeping parked items of missing ones", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const deleted = ThreadId.make("thread-deleted");
    yield* seed("2026-01-03T00:00:00.000Z", deleted);
    yield* seed();
    for (const id of [deleted, ThreadId.make("thread-missing"), threadId]) {
      yield* sql`
        INSERT INTO fork_thread_decision_questions (
          thread_id, label, label_number, text, source_message_id, asked_at, state
        ) VALUES (${id}, 'Q1', 1, 'Q1: x', 'm', '2026-01-01T00:00:00.000Z', 'open')
      `;
      yield* sql`
        INSERT INTO fork_thread_parked_items (
          thread_id, kind, text, state, parked_by, created_at, updated_at
        ) VALUES (${id}, 'todo', 'x', 'open', 'user', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO fork_thread_artifacts (
          thread_id, link_id, url, source, first_seen_at, updated_at
        ) VALUES (${id}, 'a', 'https://claude.ai/artifact/a', 'mention', 'x', 'x')
      `;
      yield* sql`
        INSERT INTO fork_thread_artifact_sync (
          thread_id, after_message_created_at, after_message_id, after_item_updated_at,
          after_item_id
        ) VALUES (${id}, '', '', '', '')
      `;
    }
    yield* Effect.provide(
      Effect.void,
      ThreadDecisions.layer.pipe(Layer.provide(judgeLayer(offline))),
    );
    const questions = yield* sql<{ readonly threadId: string }>`
      SELECT thread_id AS "threadId" FROM fork_thread_decision_questions
    `;
    assert.deepEqual(questions, [{ threadId }]);
    const parked = yield* sql<{ readonly threadId: string }>`
      SELECT thread_id AS "threadId" FROM fork_thread_parked_items ORDER BY id
    `;
    assert.deepEqual(parked, [{ threadId: "thread-missing" }, { threadId }]);
    const artifacts = yield* sql<{ readonly threadId: string }>`
      SELECT thread_id AS "threadId" FROM fork_thread_artifacts
      UNION ALL SELECT thread_id FROM fork_thread_artifact_sync
    `;
    assert.deepEqual(artifacts, [{ threadId }, { threadId }]);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

const eventAt = DateTime.makeUnsafe("2026-01-02T00:00:00.000Z");
const stored = (event: OrchestrationV2StoredEvent["event"]): OrchestrationV2StoredEvent => ({
  sequence: 1,
  commandId: null,
  event,
});
const messageEvent = (id: string, role: "user" | "assistant", streaming: boolean) =>
  stored({
    id: EventId.make(id),
    type: "message.updated",
    threadId: ThreadId.make(id),
    occurredAt: eventAt,
    payload: {
      id: MessageId.make(id),
      threadId: ThreadId.make(id),
      runId: null,
      nodeId: null,
      role,
      text: "Q1: yes",
      attachments: [],
      streaming,
      createdBy: "user",
      creationSource: "web",
      createdAt: eventAt,
      updatedAt: eventAt,
    },
  });
const runEvent = (id: string, status: OrchestrationV2Run["status"]) =>
  stored({
    id: EventId.make(id),
    type: "run.updated",
    threadId: ThreadId.make(id),
    occurredAt: eventAt,
    payload: {
      id: RunId.make(id),
      threadId: ThreadId.make(id),
      ordinal: 1,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
      providerThreadId: null,
      userMessageId: MessageId.make(id),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: eventAt,
      startedAt: eventAt,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    },
  });

// The listener over these events, with `sync` standing in for the service's.
const listen = (
  events: ReadonlyArray<OrchestrationV2StoredEvent>,
  sync: (id: ThreadId) => Effect.Effect<boolean>,
) =>
  Layer.build(
    ThreadDecisions.layerListener.pipe(
      Layer.provide(Layer.mock(ThreadDecisions.ThreadDecisions)({ sync })),
      Layer.provide(
        Layer.mock(EventSink.EventSinkV2)({
          latestSequence: () => Effect.succeed(0),
          stream: (input) =>
            Stream.fromIterable(events.filter((e) => e.event.type === input?.eventType)),
        }),
      ),
    ),
  );

it.effect("syncs a thread when a message finishes or its run ends", () => {
  const events = [
    messageEvent("user-streaming", "user", true),
    messageEvent("assistant-streaming", "assistant", true),
    messageEvent("assistant-done", "assistant", false),
    messageEvent("user-done", "user", false),
    runEvent("run-running", "running"),
    runEvent("run-waiting", "waiting"),
    runEvent("run-completed", "completed"),
  ];

  return Effect.gen(function* () {
    const synced = yield* Queue.unbounded<ThreadId>();
    yield* listen(events, (id) => Queue.offer(synced, id).pipe(Effect.as(true)));
    // Each stream is read in order, so its last syncing event comes after the ones it skips.
    const seen: string[] = [];
    while (!seen.includes("user-done") || !seen.includes("run-completed")) {
      seen.push(yield* Queue.take(synced));
    }
    // A reply can finish streaming after its run already reads as ended, so the finished assistant
    // message syncs too; a message still streaming never does.
    assert.sameMembers(seen, ["assistant-done", "user-done", "run-waiting", "run-completed"]);
  }).pipe(Effect.scoped);
});

// A judged sync can take seconds: other threads sync beside it, at most four at once.
it.effect("syncs at most four threads at once", () =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<ThreadId>();
    const gate = yield* Deferred.make<void>();
    let running = 0;
    let most = 0;
    const events = [1, 2, 3, 4, 5, 6].map((n) => runEvent(`thread-${n}`, "completed"));
    yield* listen(events, (id) =>
      Effect.sync(() => {
        running += 1;
        most = Math.max(most, running);
      }).pipe(
        Effect.andThen(Queue.offer(started, id)),
        Effect.andThen(Deferred.await(gate)),
        Effect.ensuring(Effect.sync(() => (running -= 1))),
        Effect.as(true),
      ),
    );
    for (const _ of [1, 2, 3, 4]) yield* Queue.take(started);
    // The fifth waits for a slot, however long the four take: let every other fiber run first.
    for (let turn = 0; turn < 100; turn += 1) yield* Effect.yieldNow;
    assert.strictEqual(yield* Queue.size(started), 0);
    yield* Deferred.succeed(gate, undefined);
    for (const _ of [5, 6]) yield* Queue.take(started);
    assert.strictEqual(most, 4);
  }).pipe(Effect.scoped),
);

// An AskUserQuestion card as the orchestrator projects it once answered; `answers` null is a card
// resolved without answers. Ids default to the question text, as Claude's cards use.
const card = Effect.fn("card")(function* (
  itemId: string,
  runId: string,
  questions: ReadonlyArray<{ readonly id?: string; readonly question: string }>,
  answers: Record<string, unknown> | null,
  status = "completed",
) {
  const sql = yield* SqlClient.SqlClient;
  const at = nextAt();
  const requestId = `request-${itemId}`;
  const payload = {
    id: itemId,
    threadId,
    runId,
    type: "user_input_request",
    requestId,
    status,
    updatedAt: at,
    questions: questions.map((q) => ({
      id: q.id ?? q.question,
      header: q.question.slice(0, 3),
      question: q.question,
      options: [],
      multiSelect: false,
    })),
    ...(answers === null
      ? {}
      : { questionAnswer: { requestId, answers, attachmentsByQuestionId: {} } }),
  };
  yield* sql`
    INSERT INTO orchestration_v2_projection_turn_items (
      turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json
    ) VALUES (${itemId}, ${threadId}, ${runId}, 1, 'user_input_request', ${status}, ${at},
      ${JSON.stringify(payload)})
    ON CONFLICT (turn_item_id) DO UPDATE SET
      status = excluded.status, updated_at = excluded.updated_at,
      payload_json = excluded.payload_json
  `;
  return at;
});

const asks = (...labels: ReadonlyArray<string>) =>
  labels.map((label) => `${label}, key words: Settle ${label}? My pick is yes: why.`).join("\n");

const answers = Effect.fn("answers")(function* () {
  const decisions = yield* ThreadDecisions.ThreadDecisions;
  const snapshot = yield* decisions.snapshot(threadId);
  return Object.fromEntries(
    snapshot.questions.map((q) => [q.label, [q.state, q.answerText, q.answerMessageId]]),
  );
});

it.effect("closes questions answered on AskUserQuestion cards, each card once", () =>
  Effect.gen(function* () {
    const decisions = yield* ThreadDecisions.ThreadDecisions;
    yield* seed();
    yield* run("r1", 1, "completed");
    yield* message("a1", "r1", "assistant", asks("Q1", "Q2", "Q3", "Q4"));
    assert.isTrue(yield* decisions.sync(threadId));

    yield* run("r2", 2, "completed");
    const shipped = yield* card("c1", "r2", [{ question: "Q1: Ship it now?" }], {
      "Q1: Ship it now?": "Yes, ship",
    });
    // Older cards key answers by the question's text, not its id.
    yield* card("c2", "r2", [{ id: "q-legacy", question: "Q4 Keep the old card?" }], {
      "Q4 Keep the old card?": ["Keep", " Note it "],
    });
    // Resolved without answers, an empty answer, an unusable one, and a card never answered.
    yield* card("c3", "r2", [{ question: "Q2: Update docs?" }], null);
    yield* card("c4", "r2", [{ question: "Q2: Update docs?" }], { "Q2: Update docs?": "" });
    yield* card("c5", "r2", [{ question: "Q3: Rename?" }], { "Q3: Rename?": [" "] });
    yield* card("c6", "r2", [{ question: "Q3: Rename?" }], { "Q3: Rename?": { label: "x" } });
    yield* card(
      "c7",
      "r2",
      [{ question: "Q2: Update docs?" }],
      { "Q2: Update docs?": "Yes" },
      "cancelled",
    );
    assert.isTrue(yield* decisions.sync(threadId));
    assert.deepEqual(yield* answers(), {
      Q1: ["answered", "Q1: Yes, ship", null],
      Q2: ["open", null, null],
      Q3: ["open", null, null],
      Q4: ["answered", "Q4: Keep, Note it", null],
    });
    assert.strictEqual((yield* question("Q1"))?.resolvedAt, shipped);
    // Every card is read once: nothing left to change.
    assert.isFalse(yield* decisions.sync(threadId));
  }).pipe(Effect.provide(withDecisions)),
);

it.effect(
  "gathers a question asked in parts, in the card's order, only when every part is answered",
  () =>
    Effect.gen(function* () {
      const decisions = yield* ThreadDecisions.ThreadDecisions;
      yield* seed();
      yield* run("r1", 1, "completed");
      yield* message("a1", "r1", "assistant", asks("Q28", "Q29"));
      yield* decisions.sync(threadId);
      yield* run("r2", 2, "completed");
      const parts = (label: string) =>
        [1, 2, 3].map((n) => ({ question: `${label} (${n} of 3), part ${n}: which picks?` }));
      yield* card("c1", "r2", [...parts("Q28"), ...parts("Q29")], {
        // Answers listed out of order; the reply follows the card's questions.
        [`Q28 (3 of 3), part 3: which picks?`]: "Fable alone",
        [`Q28 (1 of 3), part 1: which picks?`]: ["Artifacts design", "Evals owed"],
        [`Q28 (2 of 3), part 2: which picks?`]: ["No core folder"],
        [`Q29 (1 of 3), part 1: which picks?`]: "One",
        [`Q29 (3 of 3), part 3: which picks?`]: "Three",
      });
      assert.isTrue(yield* decisions.sync(threadId));
      assert.deepEqual(yield* answers(), {
        Q28: ["answered", "Q28: Artifacts design, Evals owed; No core folder; Fable alone", null],
        Q29: ["open", null, null],
      });
    }).pipe(Effect.provide(withDecisions)),
);

it.effect("reads a card's answer as the reply it stands for, for that question alone", () =>
  Effect.gen(function* () {
    const decisions = yield* ThreadDecisions.ThreadDecisions;
    yield* seed();
    yield* run("r1", 1, "completed");
    yield* message("a1", "r1", "assistant", asks("Q27", "Q28", "Q30", "Q31"));
    yield* decisions.sync(threadId);
    yield* run("r2", 2, "completed");
    yield* card(
      "c1",
      "r2",
      [{ question: "Q28: Which?" }, { question: "Q30: Which?" }, { question: "Q31: Which?" }],
      {
        "Q28: Which?": "Same as Q27",
        "Q30: Which?": "Not a decision",
        "Q31: Which?": "Go with your picks",
      },
    );
    assert.isTrue(yield* decisions.sync(threadId));
    // Q27, named in an option and swept by "your picks", stays open.
    assert.deepEqual(yield* answers(), {
      Q27: ["open", null, null],
      Q28: ["answered", "Q28: Same as Q27", null],
      Q30: ["dropped", "Q30: Not a decision", null],
      Q31: ["answered", "Q31: Go with your picks", null],
    });
  }).pipe(Effect.provide(withDecisions)),
);

it.effect("leaves a question asked again after the card, or reopened by hand, open", () =>
  Effect.gen(function* () {
    const decisions = yield* ThreadDecisions.ThreadDecisions;
    yield* seed();
    yield* run("r1", 1, "completed");
    yield* message("a1", "r1", "assistant", asks("Q5", "Q6"));
    yield* decisions.sync(threadId);
    yield* run("r2", 2, "completed");
    yield* card("c1", "r2", [{ question: "Q5: Go?" }, { question: "Q6: Go?" }], {
      "Q5: Go?": "Yes",
      "Q6: Go?": "Yes",
    });
    yield* run("r3", 3, "completed");
    yield* message(
      "a2",
      "r3",
      "assistant",
      "Q5, key words: Settle Q5 again? My pick is no: changed.",
    );
    assert.isTrue(yield* decisions.sync(threadId));
    assert.deepEqual(yield* answers(), {
      Q5: ["open", null, null],
      Q6: ["answered", "Q6: Yes", null],
    });
    assert.strictEqual((yield* question("Q5"))?.sourceMessageId, "a2");

    yield* decisions.reopen({ threadId, label: "Q6" });
    assert.isFalse(yield* decisions.sync(threadId));
    assert.deepEqual((yield* answers()).Q6, ["open", null, null]);
  }).pipe(Effect.provide(withDecisions)),
);

it.effect("waits to read a card answered while its run still runs", () =>
  Effect.gen(function* () {
    const decisions = yield* ThreadDecisions.ThreadDecisions;
    yield* seed();
    yield* run("r1", 1, "completed");
    yield* message("a1", "r1", "assistant", asks("Q8"));
    yield* decisions.sync(threadId);
    yield* run("r2", 2, "running");
    yield* message("u1", "r2", "user", "Keep going.");
    // The running reply asks Q8 again before the card answers it; read first, it would reopen Q8.
    yield* message("a2", "r2", "assistant", "Q8, key words: Ship it now? My pick is yes: ready.");
    yield* card("c1", "r2", [{ question: "Q8: Ship it now?" }], { "Q8: Ship it now?": "Ship" });
    assert.isFalse(yield* decisions.sync(threadId));
    assert.deepEqual((yield* answers()).Q8, ["open", null, null]);

    yield* run("r2", 2, "waiting");
    assert.isTrue(yield* decisions.sync(threadId));
    assert.deepEqual((yield* answers()).Q8, ["answered", "Q8: Ship", null]);
  }).pipe(Effect.provide(withDecisions)),
);

it.effect("leaves a question its message-mode answer already closed to that message", () =>
  Effect.gen(function* () {
    const decisions = yield* ThreadDecisions.ThreadDecisions;
    yield* seed();
    yield* run("r1", 1, "completed");
    yield* message("a1", "r1", "assistant", asks("Q9"));
    yield* decisions.sync(threadId);
    yield* run("r2", 2, "completed");
    yield* card("c1", "r2", [{ question: "Q9: Ship?" }], { "Q9: Ship?": "Yes" });
    // The orchestrator sends a message-mode card's answers on as a user message.
    yield* message("async-answer:request-c1", "r2", "user", "Q9: Ship?\nYes", {
      creationSource: "server",
    });
    assert.isTrue(yield* decisions.sync(threadId));
    assert.deepEqual((yield* answers()).Q9, [
      "answered",
      "Q9: Ship?\nYes",
      "async-answer:request-c1",
    ]);
  }).pipe(Effect.provide(withDecisions)),
);

// What the judge was asked: the message, and the open questions' labels, read back from its prompt.
const said = (prompt: string) => /Person's message:\n<<<\n([\s\S]*)\n>>>/.exec(prompt)?.[1];
const openIn = (prompt: string) =>
  [...(prompt.split("Open questions:\n")[1]?.split("\n\n")[0] ?? "").matchAll(/^(Q\d+)[,:]/gm)].map(
    (match) => match[1],
  );
// The decision judge's log lines, as [level, first message part], while `effect` ran.
const judgeLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const logs: Array<readonly [string, string]> = [];
    const logger = Logger.make(({ logLevel, message }) => {
      const [first] = Array.isArray(message) ? message : [message];
      if (String(first).startsWith("Decision judge")) logs.push([logLevel, String(first)]);
    });
    const result = yield* effect.pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
    return [result, logs] as const;
  });

const verdict = (answered: ReadonlyArray<string>, dropped: ReadonlyArray<string> = []) =>
  JSON.stringify({ answered, dropped });

it.effect("closes what the judge reads in a bare yes right after the question block", () => {
  const prompts: string[] = [];
  return Effect.gen(function* () {
    const decisions = yield* ThreadDecisions.ThreadDecisions;
    yield* seed();
    yield* run("r1", 1, "completed");
    yield* message("a1", "r1", "assistant", REPLY);
    assert.isTrue(yield* decisions.sync(threadId));
    yield* run("r2", 2, "completed");
    yield* message("u1", "r2", "user", "yes");
    const [changed, logs] = yield* judgeLogs(decisions.sync(threadId));
    assert.isTrue(changed);
    assert.deepEqual(yield* answers(), {
      Q4: ["answered", "yes", "u1"],
      Q5: ["answered", "yes", "u1"],
    });
    assert.deepEqual(logs, [["Info", "Decision judge read a message"]]);
    // The judge read the reply the message follows: a bare yes assents to its block only.
    assert.deepEqual(prompts.map(said), ["yes"]);
    assert.include(prompts[0], "The assistant's last reply:\n<<<\nMigrated.");
    // Text generators enforce no schema, so the prompt spells out the envelope their reply is read as.
    assert.isTrue(
      prompts[0]?.endsWith(
        '\n\nReply with exactly {"transcription":"<that JSON object, as a string>"}, nothing else.',
      ),
    );
  }).pipe(
    Effect.provide(
      decisionsWith((prompt) =>
        Effect.sync(() => {
          prompts.push(prompt);
          return verdict(["Q4", "Q5"]);
        }),
      ),
    ),
  );
});

it.effect("closes the label a mixed message names and the question its words answer", () =>
  Effect.gen(function* () {
    const decisions = yield* ThreadDecisions.ThreadDecisions;
    yield* seed();
    yield* run("r1", 1, "completed");
    yield* message(
      "a1",
      "r1",
      "assistant",
      [
        "Q4, follow continuation: Resume? My pick is yes: it stopped cleanly.",
        "Q5, merge branch: Merge it? My pick is yes: CI is green.",
        "Q6, table name: Rename it? My pick is no: nothing reads it.",
      ].join("\n"),
    );
    assert.isTrue(yield* decisions.sync(threadId));
    yield* run("r2", 2, "completed");
    yield* message("u1", "r2", "user", "Q4: yes, and merge it");
    assert.isTrue(yield* decisions.sync(threadId));
    // The rules read only the label: Q4 alone. The judge's reading decides.
    assert.deepEqual(yield* states(), { Q4: "answered", Q5: "answered", Q6: "open" });
  }).pipe(Effect.provide(decisionsWith(() => Effect.succeed(verdict(["Q4", "Q5"]))))),
);

// Two messages after REPLY, synced by `drive`: "yes" closes nothing by the rules, "Q4: yes" closes Q4.
const fallsBack = <E, R>(
  drive: (
    sync: Effect.Effect<boolean, ThreadDecisionsError>,
  ) => Effect.Effect<boolean, E | ThreadDecisionsError, R>,
) =>
  Effect.gen(function* () {
    const decisions = yield* ThreadDecisions.ThreadDecisions;
    yield* seed();
    yield* run("r1", 1, "completed");
    yield* message("a1", "r1", "assistant", REPLY);
    assert.isTrue(yield* decisions.sync(threadId));
    yield* run("r2", 2, "completed");
    yield* message("u1", "r2", "user", "yes");
    yield* message("u2", "r2", "user", "Q4: yes");
    const [changed, logs] = yield* judgeLogs(drive(decisions.sync(threadId)));
    assert.isTrue(changed);
    assert.deepEqual(yield* answers(), {
      Q4: ["answered", "Q4: yes", "u2"],
      Q5: ["open", null, null],
    });
    // A fallback is a warning: the rules read in the model's place.
    const fallback = ["Warn", "Decision judge gave no usable verdict; the rules decide"] as const;
    assert.deepEqual(logs, [fallback, fallback]);
  });

it.effect.each([
  { failure: "fails", answer: offline },
  { failure: "answers in prose", answer: () => Effect.succeed("Q4 is answered.") },
  {
    failure: "answers JSON of another shape",
    answer: () => Effect.succeed('{"closed":["Q4","Q5"]}'),
  },
])("falls back to the rules when the judge $failure", ({ answer }) =>
  fallsBack((sync) => sync).pipe(Effect.provide(decisionsWith(answer))),
);

it.effect("falls back to the rules when the judge does not answer within 20 s", () =>
  Effect.gen(function* () {
    const asked = yield* Queue.unbounded<void>();
    yield* fallsBack((sync) =>
      Effect.gen(function* () {
        const syncing = yield* Effect.forkChild(sync);
        // Each message waits on the judge in turn; past 20 s the rules decide.
        yield* Queue.take(asked);
        yield* TestClock.adjust("20 seconds");
        yield* Queue.take(asked);
        yield* TestClock.adjust("20 seconds");
        return yield* Fiber.join(syncing);
      }),
    ).pipe(
      Effect.provide(
        decisionsWith(() => Queue.offer(asked, undefined).pipe(Effect.andThen(Effect.never))),
      ),
    );
  }),
);

it.effect(
  "keeps only what the judge may close: a pick taken as a whole spares older questions",
  () =>
    Effect.gen(function* () {
      const decisions = yield* ThreadDecisions.ThreadDecisions;
      yield* seed();
      yield* run("r1", 1, "completed");
      yield* message("a1", "r1", "assistant", asks("Q1"));
      yield* run("r2", 2, "completed");
      yield* message("a2", "r2", "assistant", asks("Q4", "Q5"));
      yield* run("r3", 3, "completed");
      yield* message("u1", "r3", "user", "go with your picks");
      assert.isTrue(yield* decisions.sync(threadId));
      // scopeVerdict drops Q1: asked earlier, and neither the message nor the last reply names it.
      assert.deepEqual(yield* states(), { Q1: "open", Q4: "answered", Q5: "answered" });
    }).pipe(Effect.provide(decisionsWith(() => Effect.succeed(verdict(["Q1", "Q4", "Q5"]))))),
);

it.effect("asks the judge nothing for card answers, nor while no question is open", () => {
  const prompts: string[] = [];
  return Effect.gen(function* () {
    const decisions = yield* ThreadDecisions.ThreadDecisions;
    yield* seed();
    yield* run("r1", 1, "completed");
    yield* message("u1", "r1", "user", "Migrate it.");
    yield* message("a1", "r1", "assistant", asks("Q8"));
    assert.isTrue(yield* decisions.sync(threadId));
    yield* run("r2", 2, "completed");
    yield* card("c1", "r2", [{ question: "Q8: Ship?" }], { "Q8: Ship?": "Ship" });
    assert.isTrue(yield* decisions.sync(threadId));
    assert.deepEqual(yield* answers(), { Q8: ["answered", "Q8: Ship", null] });
    assert.deepEqual(prompts, []);
  }).pipe(
    Effect.provide(
      decisionsWith((prompt) =>
        Effect.sync(() => {
          prompts.push(prompt);
          return verdict(["Q8"]);
        }),
      ),
    ),
  );
});

it.effect("judges each message against the questions open when it was sent", () => {
  const prompts: string[] = [];
  return Effect.gen(function* () {
    const decisions = yield* ThreadDecisions.ThreadDecisions;
    yield* seed();
    yield* run("r1", 1, "completed");
    yield* message("a1", "r1", "assistant", asks("Q4", "Q5"));
    assert.isTrue(yield* decisions.sync(threadId));
    yield* run("r2", 2, "completed");
    yield* message("u1", "r2", "user", "yes to the first");
    yield* message("a2", "r2", "assistant", asks("Q6"));
    yield* run("r3", 3, "completed");
    yield* message("u2", "r3", "user", "Q5 and Q6: yes");
    // One sync reads the next three: u2's judge sees Q4 closed by u1 and Q6 asked after it.
    assert.isTrue(yield* decisions.sync(threadId));
    assert.deepEqual(prompts.map(openIn), [
      ["Q4", "Q5"],
      ["Q5", "Q6"],
    ]);
    assert.deepEqual(yield* answers(), {
      Q4: ["answered", "yes to the first", "u1"],
      Q5: ["answered", "Q5 and Q6: yes", "u2"],
      // Each question's own part: Q5's answer covers Q6 too.
      Q6: ["answered", "Q6: yes", "u2"],
    });
  }).pipe(
    Effect.provide(
      decisionsWith((prompt) =>
        Effect.sync(() => {
          prompts.push(prompt);
          return said(prompt) === "yes to the first" ? verdict(["Q4"]) : verdict(["Q5", "Q6"]);
        }),
      ),
    ),
  );
});

it.effect("shows a subscriber the current rows while its backlog is judged", () =>
  Effect.gen(function* () {
    const asked = yield* Queue.unbounded<void>();
    const answer = yield* Deferred.make<string>();
    yield* Effect.gen(function* () {
      const decisions = yield* ThreadDecisions.ThreadDecisions;
      yield* seed();
      yield* run("r1", 1, "completed");
      yield* message("a1", "r1", "assistant", REPLY);
      assert.isTrue(yield* decisions.sync(threadId));
      // Sent while no client watched: the subscriber's backfill judges it.
      yield* run("r2", 2, "completed");
      yield* message("u1", "r2", "user", "yes");
      const snapshots = yield* Queue.unbounded<Record<string, string>>();
      yield* decisions.subscribe(threadId).pipe(
        Stream.runForEach((snapshot) =>
          Queue.offer(
            snapshots,
            Object.fromEntries(snapshot.questions.map((q) => [q.label, q.state])),
          ),
        ),
        Effect.forkScoped,
      );
      // The judge is still thinking, and the panel already has the rows.
      yield* Queue.take(asked);
      assert.deepEqual(yield* Queue.take(snapshots), { Q4: "open", Q5: "open" });
      yield* Deferred.succeed(answer, verdict(["Q4", "Q5"]));
      assert.deepEqual(yield* Queue.take(snapshots), { Q4: "answered", Q5: "answered" });
    }).pipe(
      Effect.provide(
        decisionsWith(() =>
          Queue.offer(asked, undefined).pipe(Effect.andThen(Deferred.await(answer))),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);

// The judge took over at `at`: as if fork migration 005's first start ran then.
const judgeFrom = Effect.fn("judgeFrom")(function* (at: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE fork_decision_judge_cutoff SET judged_from = ${at}`;
});

it.effect(
  "reads messages sent before the judge took over by the rules alone, later ones judged",
  () => {
    const prompts: string[] = [];
    return Effect.gen(function* () {
      const decisions = yield* ThreadDecisions.ThreadDecisions;
      yield* seed();
      yield* run("r1", 1, "completed");
      yield* message("a1", "r1", "assistant", REPLY);
      assert.isTrue(yield* decisions.sync(threadId));
      yield* run("r2", 2, "completed");
      // The judge would close Q4 and Q5 on this bare yes; the rules close nothing on it.
      yield* message("u1", "r2", "user", "yes");
      yield* message("u2", "r2", "user", "Q4: yes");
      yield* judgeFrom(nextAt());
      yield* message("u3", "r2", "user", "yes");
      const [changed, logs] = yield* judgeLogs(decisions.sync(threadId));
      assert.isTrue(changed);
      // One call, for u3 alone, which finds Q4 already closed by u2's label.
      assert.deepEqual(prompts.map(said), ["yes"]);
      assert.deepEqual(prompts.map(openIn), [["Q5"]]);
      assert.deepEqual(logs, [["Info", "Decision judge read a message"]]);
      assert.deepEqual(yield* answers(), {
        Q4: ["answered", "Q4: yes", "u2"],
        Q5: ["answered", "yes", "u3"],
      });
    }).pipe(
      Effect.provide(
        decisionsWith((prompt) =>
          Effect.sync(() => {
            prompts.push(prompt);
            return verdict(["Q4", "Q5"]);
          }),
        ),
      ),
    );
  },
);

it.effect(
  "asks the judge nothing for a never-read thread's backlog from before it took over",
  () => {
    const prompts: string[] = [];
    return Effect.gen(function* () {
      const decisions = yield* ThreadDecisions.ThreadDecisions;
      yield* seed();
      yield* run("r1", 1, "completed");
      yield* message("a1", "r1", "assistant", REPLY);
      yield* run("r2", 2, "completed");
      yield* message("u1", "r2", "user", "yes");
      yield* message("u2", "r2", "user", "go with 2");
      yield* message("a2", "r2", "assistant", asks("Q6", "Q7"));
      yield* run("r3", 3, "completed");
      yield* message("u3", "r3", "user", "Q6: not a decision");
      yield* message("u4", "r3", "user", "merge it");
      yield* judgeFrom(nextAt());
      const snapshots = yield* Queue.unbounded<Record<string, string>>();
      const [, logs] = yield* judgeLogs(
        Effect.gen(function* () {
          yield* decisions.subscribe(threadId).pipe(
            Stream.runForEach((snapshot) =>
              Queue.offer(
                snapshots,
                Object.fromEntries(snapshot.questions.map((q) => [q.label, q.state])),
              ),
            ),
            Effect.forkScoped,
          );
          // Nothing read yet, then the whole backlog, read by the rules with no model in between.
          assert.deepEqual(yield* Queue.take(snapshots), {});
          assert.deepEqual(yield* Queue.take(snapshots), {
            Q4: "open",
            Q5: "open",
            Q6: "dropped",
            Q7: "open",
          });
        }),
      );
      assert.deepEqual(logs, []);
      assert.deepEqual(prompts, []);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        decisionsWith((prompt) =>
          Effect.sync(() => {
            prompts.push(prompt);
            return verdict(["Q4", "Q5", "Q6", "Q7"]);
          }),
        ),
      ),
    );
  },
);

// Records each prompt the judge is given; its verdict closes Q4 and Q5.
const recording = (prompts: string[]) =>
  decisionsWith((prompt) =>
    Effect.sync(() => {
      prompts.push(prompt);
      return verdict(["Q4", "Q5"]);
    }),
  );

it.effect("judges a new thread's answers: its first pass runs before any question", () => {
  const prompts: string[] = [];
  return Effect.gen(function* () {
    const decisions = yield* ThreadDecisions.ThreadDecisions;
    yield* seed();
    yield* run("r1", 1, "running");
    // The listener syncs on the person's first message; no question is open yet.
    yield* message("u0", "r1", "user", "Migrate it.");
    yield* decisions.sync(threadId);
    yield* message("a1", "r1", "assistant", REPLY);
    yield* run("r1", 1, "completed");
    assert.isTrue(yield* decisions.sync(threadId));
    yield* run("r2", 2, "completed");
    yield* message("u1", "r2", "user", "yes");
    assert.isTrue(yield* decisions.sync(threadId));
    assert.deepEqual(prompts.map(said), ["yes"]);
    assert.deepEqual(yield* states(), { Q4: "answered", Q5: "answered" });
  }).pipe(Effect.provide(recording(prompts)));
});

it.effect(
  "asks the judge nothing for a never-read thread's backlog sent after it took over",
  () => {
    const prompts: string[] = [];
    return Effect.gen(function* () {
      const decisions = yield* ThreadDecisions.ThreadDecisions;
      yield* seed();
      yield* run("r1", 1, "completed");
      yield* message("a1", "r1", "assistant", REPLY);
      yield* run("r2", 2, "completed");
      // After the cutoff (TestClock's 1970), but the fork reads this thread for the first time: an
      // imported session, or one an official build ran.
      yield* message("u1", "r2", "user", "yes");
      yield* message("u2", "r2", "user", "Q4: yes");
      const [changed, logs] = yield* judgeLogs(decisions.sync(threadId));
      assert.isTrue(changed);
      assert.deepEqual(logs, []);
      assert.deepEqual(prompts, []);
      assert.deepEqual(yield* states(), { Q4: "answered", Q5: "open" });
      // Read once, the thread's next answer is judged.
      yield* message("u3", "r2", "user", "yes");
      assert.isTrue(yield* decisions.sync(threadId));
      assert.deepEqual(prompts.map(said), ["yes"]);
      assert.deepEqual(yield* states(), { Q4: "answered", Q5: "answered" });
    }).pipe(Effect.provide(recording(prompts)));
  },
);

it.effect("warns at start when the judge's cutoff row is missing", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM fork_decision_judge_cutoff`;
    const [, logs] = yield* judgeLogs(
      Effect.provide(Effect.void, ThreadDecisions.layer.pipe(Layer.provide(judgeLayer(offline)))),
    );
    assert.deepEqual(logs, [
      ["Warn", "Decision judge cutoff is missing, so the rules alone close questions"],
    ]);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
