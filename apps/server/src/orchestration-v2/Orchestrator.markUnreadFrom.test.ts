// Fork (Mark unread from here): thread.mark-unread from a message's time.
// FORK.md, "Mark unread from here". The layer and thread setup follow
// Orchestrator.control-reads.test.ts's mark-unread cases.
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for read-state controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "mark-unread-from" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

/** A thread with one ended run, visited after it ended. */
const visitedThread = Effect.fn("test.visitedThread")(function* (name: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create-${name}`),
    threadId,
    projectId: ProjectId.make(`project:${name}`),
    title: "Read state",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* queueRun(threadId, `${name}-1`);
  yield* orchestrator.dispatch({
    type: "run.interrupt",
    commandId: CommandId.make(`interrupt-${name}`),
    threadId,
    runId: (yield* projections.getThreadProjection(threadId)).runs[0]!.id,
  });
  const completedAt = (yield* projections.getThreadProjection(threadId)).runs.at(-1)?.completedAt;
  assert.ok(completedAt);
  yield* TestClock.adjust("1 minute");
  yield* orchestrator.dispatch({
    type: "thread.visit",
    commandId: CommandId.make(`visit-${name}`),
    threadId,
    visitedAt: DateTime.formatIso(yield* DateTime.now),
  });
  return { threadId, completedAt };
});

const queueRun = Effect.fn("test.queueRun")(function* (threadId: ThreadId, name: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`dispatch-${name}`),
    threadId,
    messageId: MessageId.make(`dispatch-${name}`),
    text: "Run in the background",
    attachments: [],
    dispatchMode: { type: "defer_start" },
    createdBy: "agent",
    creationSource: "mcp",
  });
});

const markUnread = Effect.fn("test.markUnread")(function* (
  threadId: ThreadId,
  name: string,
  from?: DateTime.Utc | string,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return yield* orchestrator.dispatch({
    type: "thread.mark-unread",
    commandId: CommandId.make(`mark-unread-${name}`),
    threadId,
    ...(from === undefined
      ? {}
      : { from: typeof from === "string" ? from : DateTime.formatIso(from) }),
  });
});

const lessOneMs = (time: DateTime.Utc) => DateTime.subtract(time, { milliseconds: 1 });

it.effect("marks unread from a message's time, and the menu's form is unchanged", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { threadId, completedAt } = yield* visitedThread("inside");
    const visited = yield* projections.getThread(threadId);
    const from = DateTime.subtract(completedAt, { seconds: 30 });

    yield* markUnread(threadId, "inside", from);
    assert.deepEqual(yield* projections.getThread(threadId), {
      ...visited,
      lastVisitedAt: lessOneMs(from),
    });

    yield* markUnread(threadId, "inside-menu");
    assert.deepEqual(yield* projections.getThread(threadId), {
      ...visited,
      lastVisitedAt: lessOneMs(completedAt),
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("clamps a time at or after the latest run's end, or in the future", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { threadId, completedAt } = yield* visitedThread("clamp");

    yield* markUnread(threadId, "clamp-end", completedAt);
    assert.deepEqual(
      (yield* projections.getThread(threadId)).lastVisitedAt,
      lessOneMs(completedAt),
    );
    yield* markUnread(threadId, "clamp-later", DateTime.add(completedAt, { seconds: 1 }));
    assert.deepEqual(
      (yield* projections.getThread(threadId)).lastVisitedAt,
      lessOneMs(completedAt),
    );
    yield* markUnread(threadId, "clamp-future", DateTime.add(yield* DateTime.now, { days: 1 }));
    assert.deepEqual(
      (yield* projections.getThread(threadId)).lastVisitedAt,
      lessOneMs(completedAt),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "refuses while the latest run is under way, or a time that does not parse, unchanged",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:no-run");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-no-run"),
        threadId,
        projectId: ProjectId.make("project:no-run"),
        title: "Read state",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* queueRun(threadId, "no-run");
      const untouched = yield* projections.getThread(threadId);
      const noRun = yield* Effect.flip(markUnread(threadId, "no-run", yield* DateTime.now));
      assert.include(String(noRun.cause), "has no completed run");
      assert.deepEqual(yield* projections.getThread(threadId), untouched);

      // An earlier run ended, but the latest waits: refused as the thread menu's Mark unread is.
      const { threadId: laterId, completedAt } = yield* visitedThread("later-run");
      yield* queueRun(laterId, "later-run-2");
      assert.isNull((yield* projections.getThreadShell(laterId))?.latestRunCompletedAt);
      const beforeLater = yield* projections.getThread(laterId);
      const later = yield* Effect.flip(
        markUnread(laterId, "later-run", DateTime.subtract(completedAt, { seconds: 30 })),
      );
      assert.include(String(later.cause), "has no completed run");
      assert.deepEqual(yield* projections.getThread(laterId), beforeLater);

      const { threadId: visitedId } = yield* visitedThread("invalid");
      const visited = yield* projections.getThread(visitedId);
      const invalid = yield* Effect.flip(markUnread(visitedId, "invalid", "not a time"));
      assert.include(String(invalid.cause), "is not a valid timestamp");
      assert.deepEqual(yield* projections.getThread(visitedId), visited);
    }).pipe(Effect.provide(layerTest)),
);
