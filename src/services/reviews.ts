import { Context, Effect, Layer, Schema } from "effect";
import { GitHub, type Target } from "./github";
import { Process } from "./process";

export class ReviewsError extends Schema.TaggedError<ReviewsError>()(
  "ReviewsError",
  {
    message: Schema.String,
  },
) {}

export const ReviewThread = Schema.Struct({
  id: Schema.String,
  location: Schema.String,
  url: Schema.String,
  comments: Schema.Array(
    Schema.Struct({
      author: Schema.String,
      body: Schema.String,
      url: Schema.String,
    }),
  ),
});

export type ReviewThread = typeof ReviewThread.Type;

/**
 * Review state of a branch's open pull request: open threads first, then
 * outstanding bot review requests, otherwise clear.
 */
export const Reviews = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  state: Schema.Literals(["open", "requested", "clear"]),
  threads: Schema.Array(ReviewThread),
  botRequests: Schema.Array(Schema.String),
});

export type Reviews = typeof Reviews.Type;

const Login = Schema.NullOr(Schema.Struct({ login: Schema.String }));

// The parts of `dot pr reviews --json` used here.
const Output = Schema.fromJsonString(
  Schema.Struct({
    pullRequests: Schema.Array(
      Schema.Struct({
        number: Schema.Int,
        title: Schema.String,
        url: Schema.String,
        botRequests: Schema.Array(Schema.String),
        threads: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            isResolved: Schema.Boolean,
            isOutdated: Schema.Boolean,
            path: Schema.String,
            line: Schema.NullOr(Schema.Int),
            originalLine: Schema.NullOr(Schema.Int),
            comments: Schema.Struct({
              nodes: Schema.Array(
                Schema.Struct({
                  body: Schema.optionalKey(Schema.String),
                  url: Schema.String,
                  author: Login,
                  isMinimized: Schema.Boolean,
                }),
              ),
            }),
          }),
        ),
      }),
    ),
  }),
);

export class PullRequestReviews extends Context.Service<
  PullRequestReviews,
  {
    /** Null when the target's branch has no open pull request. */
    readonly forTarget: (
      target: Target,
    ) => Effect.Effect<Reviews | null, ReviewsError>;
  }
>()("agent-checks/PullRequestReviews") {
  static readonly layer = Layer.effect(
    PullRequestReviews,
    Effect.gen(function* () {
      const process = yield* Process;
      const github = yield* GitHub;

      const forTarget = Effect.fn("PullRequestReviews.forTarget")(
        function* (target: Target) {
          const number = yield* github.pullRequest(target);

          if (number === null) return null;

          const output = yield* process.run(
            "dot",
            [
              "pr",
              "reviews",
              String(number),
              "--repo",
              target.repository,
              "--json",
            ],
            target.root,
          );

          if (output.code !== 0)
            return yield* new ReviewsError({
              message: output.stderr || `dot pr reviews exited ${output.code}`,
            });

          const pr = (yield* Schema.decodeEffect(Output)(output.stdout))
            .pullRequests[0];

          if (!pr) return null;

          // Matches isOpenThread in dot: neither resolved nor minimized.
          const threads = pr.threads.flatMap((thread) => {
            const [first] = thread.comments.nodes;

            if (thread.isResolved || first?.isMinimized) return [];

            return [
              {
                id: thread.id,
                location: `${thread.path}:${thread.line ?? thread.originalLine ?? "?"}${thread.isOutdated ? " (outdated)" : ""}`,
                url: first?.url ?? pr.url,
                comments: thread.comments.nodes.map((comment) => ({
                  author: comment.author?.login ?? "ghost",
                  body: comment.body ?? "",
                  url: comment.url,
                })),
              },
            ];
          });

          return {
            number: pr.number,
            title: pr.title,
            url: pr.url,
            state: threads.length
              ? ("open" as const)
              : pr.botRequests.length
                ? ("requested" as const)
                : ("clear" as const),
            threads,
            botRequests: pr.botRequests,
          };
        },
        (effect) =>
          effect.pipe(
            Effect.mapError((cause) =>
              cause instanceof ReviewsError
                ? cause
                : new ReviewsError({ message: String(cause) }),
            ),
          ),
      );

      return PullRequestReviews.of({ forTarget });
    }),
  );
}
