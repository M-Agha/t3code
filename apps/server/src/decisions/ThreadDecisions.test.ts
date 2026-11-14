import {
  EventId,
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  ProviderInstanceId,
  RunId,
  THREAD_ARTIFACTS_LIMIT,
  THREAD_DECIDED_WITHOUT_ASKING_LIMIT,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadDecisions from "./ThreadDecisions.ts";

const threadId = ThreadId.make("thread-decisions");

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

let minute = 0;
const message = Effect.fn("message")(function* (
  messageId: string,
  runId: string,
  role: "user" | "assistant",
  text: string,
  extra: Record<string, unknown> = {},
  streaming = false,
) {
  const sql = yield* SqlClient.SqlClient;
  minute += 1;
  const at = `2026-01-02T00:${String(minute).padStart(2, "0")}:00.000Z`;
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

    // A status line about a label reopens it but keeps the question it asked.
    yield* run("r3", 3, "completed");
    yield* message("a4", "r3", "assistant", "Done.\n\nQ4 is still open: the log is not in yet.");
    assert.isTrue(yield* decisions.sync(threadId));
    const status = yield* question("Q4");
    assert.deepEqual(
      [status?.state, status?.question, status?.sourceMessageId, status?.askedAt],
      ["open", "Resume now?", "a3", reasked?.askedAt],
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
  }).pipe(
    Effect.provide(ThreadDecisions.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  ),
);

// Shapes copied from a Claude thread's projected Artifact tool calls; ids and paths shortened.
const artifactItem = Effect.fn("artifactItem")(function* (
  itemId: string,
  updatedAt: string,
  input: Record<string, unknown>,
  output: unknown,
  { status = "completed", toolName = "Artifact", driver = "claudeAgent" } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const payload = {
    id: itemId,
    threadId,
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
    ) VALUES (${itemId}, ${threadId}, 'r1', 1, 'dynamic_tool', ${status}, ${updatedAt},
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
  }).pipe(
    Effect.provide(ThreadDecisions.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  ),
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
  }).pipe(
    Effect.provide(ThreadDecisions.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  ),
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
  }).pipe(
    Effect.provide(ThreadDecisions.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  ),
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
    yield* Effect.provide(Effect.void, ThreadDecisions.layer);
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

it.effect("syncs a thread when the user's message lands or its run ends", () => {
  const at = DateTime.makeUnsafe("2026-01-02T00:00:00.000Z");
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
      occurredAt: at,
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
        createdAt: at,
        updatedAt: at,
      },
    });
  const runEvent = (id: string, status: OrchestrationV2Run["status"]) =>
    stored({
      id: EventId.make(id),
      type: "run.updated",
      threadId: ThreadId.make(id),
      occurredAt: at,
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
        requestedAt: at,
        startedAt: at,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
  const events = [
    messageEvent("user-streaming", "user", true),
    messageEvent("assistant-done", "assistant", false),
    messageEvent("user-done", "user", false),
    runEvent("run-running", "running"),
    runEvent("run-waiting", "waiting"),
    runEvent("run-completed", "completed"),
  ];

  return Effect.gen(function* () {
    const synced = yield* Queue.unbounded<ThreadId>();
    yield* Layer.build(
      ThreadDecisions.layerListener.pipe(
        Layer.provide(
          Layer.mock(ThreadDecisions.ThreadDecisions)({
            sync: (id) => Queue.offer(synced, id).pipe(Effect.as(true)),
          }),
        ),
        Layer.provide(
          Layer.mock(EventSink.EventSinkV2)({
            latestSequence: () => Effect.succeed(0),
            stream: (input) =>
              Stream.fromIterable(events.filter((e) => e.event.type === input?.eventType)),
          }),
        ),
      ),
    );
    // Each stream is read in order, so its last syncing event comes after the ones it skips.
    const seen: string[] = [];
    while (!seen.includes("user-done") || !seen.includes("run-completed")) {
      seen.push(yield* Queue.take(synced));
    }
    assert.sameMembers(seen, ["user-done", "run-waiting", "run-completed"]);
  }).pipe(Effect.scoped);
});
