import {
  EventId,
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  ProviderInstanceId,
  RunId,
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
