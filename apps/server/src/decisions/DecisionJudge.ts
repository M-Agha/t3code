import type { ThreadId } from "@t3tools/contracts";
import { resolveDecisionJudgeModelSelection } from "@t3tools/shared/serverSettings";
import {
  type Closing,
  JUDGE_SYSTEM,
  type JudgedQuestion,
  judgedClosing,
  judgeInput,
} from "@t3tools/shared/sessionKit/decisions";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

// Fork-only. The model judge session-kit runs in the terminal (judge.ts, called from register.tsx's
// boardAfterPrompt): on every message a person typed while questions are open, its verdict decides and the
// rules (`closingFor`) only stand in when it fails. 20 s, not the terminal's 8: T3's path starts a provider
// CLI per call (2.3 s and 4.8 s measured with Claude Sonnet, 2026-11-17), and no hook waits on this here.
const JUDGE_TIMEOUT_MS = 20_000;

// Transcript cleanup's operation is the only one taking a whole prompt and returning one string, so the
// verdict's JSON travels in it, envelope spelled out: text generators enforce no schema, and a bare verdict
// fails their decoding. Ceiling: a schema named for transcripts; upgrade path, a fork-only operation.
const ANSWER_FIELD =
  '\n\nReply with exactly {"transcription":"<that JSON object, as a string>"}, nothing else.';

export interface JudgeRequest {
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly open: ReadonlyArray<JudgedQuestion>;
  /** The latest assistant message before the person's, when there is one. */
  readonly reply: string | undefined;
  readonly message: string;
}

export class DecisionJudge extends Context.Service<
  DecisionJudge,
  {
    /** The labels the message answers or drops by the model's reading; undefined when it gave none usable. */
    readonly judge: (request: JudgeRequest) => Effect.Effect<Closing | undefined>;
  }
>()("t3/decisions/DecisionJudge") {}

export const layer = Layer.effect(
  DecisionJudge,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
    const textGeneration = yield* TextGeneration.TextGeneration;
    const fileSystem = yield* FileSystem.FileSystem;

    const ask = Effect.fn("DecisionJudge.ask")(function* (request: JudgeRequest) {
      const settings = yield* serverSettings.getSettings;
      const modelSelection = resolveDecisionJudgeModelSelection(
        settings,
        yield* providerRegistry.getProviders,
      );
      // Providers run in a working directory; the judge must not read a checkout.
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-decision-judge-" });
      const generated = yield* textGeneration.generateTranscriptionPostProcessing({
        cwd,
        prompt: `${JUDGE_SYSTEM}\n\n${judgeInput(request.open, request.reply, request.message)}${ANSWER_FIELD}`,
        modelSelection,
      });
      return { answer: generated.transcription, modelSelection };
    });

    const judge = Effect.fn("DecisionJudge.judge")(function* (request: JudgeRequest) {
      const started = yield* Clock.currentTimeMillis;
      const outcome = yield* ask(request).pipe(
        Effect.scoped,
        Effect.timeoutOption(JUDGE_TIMEOUT_MS),
        Effect.map(
          Option.match({
            onNone: () => ({ reason: `no answer within ${JUDGE_TIMEOUT_MS} ms` }),
            onSome: (answered) => answered,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.succeed({ reason: String(Cause.squash(cause)).slice(0, 500) }),
        ),
      );
      const ms = (yield* Clock.currentTimeMillis) - started;
      const closing =
        "answer" in outcome
          ? judgedClosing(outcome.answer, request.open, request.message, request.reply)
          : undefined;
      const facts = {
        threadId: request.threadId,
        messageId: request.messageId,
        open: request.open.map((q) => q.label),
        ms,
        ...("answer" in outcome
          ? {
              model: `${outcome.modelSelection.instanceId}/${outcome.modelSelection.model}`,
              answer: outcome.answer.slice(0, 500),
            }
          : { reason: outcome.reason }),
      };
      yield* closing === undefined
        ? Effect.logWarning("Decision judge gave no usable verdict; the rules decide", facts)
        : Effect.logInfo("Decision judge read a message", {
            ...facts,
            answered: closing.answered,
            dropped: closing.dropped,
          });
      return closing;
    });

    return DecisionJudge.of({ judge });
  }),
);
