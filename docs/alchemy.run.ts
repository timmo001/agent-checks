/**
 * The docs site's infrastructure as an Alchemy stack: the `agent-checks-docs`
 * Worker at agent-checks.timmo.dev, serving what `blume build` leaves in
 * `dist/`. Deploy it with `mise run docs:deploy`, which builds the site first.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import { blumeWorker } from "@timmo001/docs-kit/blume/worker";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "agent-checks-docs",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const built = yield* Effect.promise(() =>
      blumeWorker(new URL("dist/", import.meta.url)),
    );

    // Blume only writes the flags from a root wrangler config, which this
    // site no longer has, so keep the Worker's nodejs_compat here
    const docs = yield* Cloudflare.Worker("Docs", {
      name: "agent-checks-docs",
      domain: "agent-checks.timmo.dev",
      ...built,
      compatibility: {
        ...built.compatibility,
        flags: [...built.compatibility.flags, "nodejs_compat"],
      },
    });

    return { url: docs.url };
  }),
);
