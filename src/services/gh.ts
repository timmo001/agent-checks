import { layer } from "@timmo001/effect-gh";
import { Effect, Layer } from "effect";
import { ClientConfig } from "../config";

export const ghLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ClientConfig;

    return layer({
      timeout: config.timeoutMs,
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
  }),
);
