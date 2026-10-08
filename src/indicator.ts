import type { RuntimeConfig } from "./config";
import { type LintState, failing } from "./lint";
import { attention, type Status } from "./services/github";

export function ciIndicator(
  status: Status | null,
  config: Pick<
    RuntimeConfig["Service"],
    "showSuccess" | "showIdle" | "showPrevious" | "indicatorTemplates"
  >,
) {
  if (!status) return null;

  const previous =
    config.showPrevious && status.runs.length === 0 ? status.previous : null;

  const runs = previous?.runs ?? status.runs;
  const failures = runs.filter((run) => attention(run.conclusion));
  const inProgress = runs.some((run) => run.status !== "completed");

  const success =
    (config.showSuccess || previous !== null) &&
    runs.some((run) => run.conclusion === "success") &&
    runs.every(
      (run) =>
        run.status === "completed" &&
        (run.conclusion === "success" ||
          run.conclusion === "neutral" ||
          run.conclusion === "skipped"),
    );

  let value = failures.length
    ? config.indicatorTemplates.failure.replaceAll(
        "{count}",
        String(failures.length),
      )
    : inProgress
      ? config.indicatorTemplates.inProgress
      : success
        ? config.indicatorTemplates.success
        : null;

  if (previous && value)
    value = config.indicatorTemplates.previous
      .replaceAll("{count}", String(previous.commitsBehind))
      .replaceAll(
        "{distance}",
        `${previous.commitsBehind} ${previous.commitsBehind === 1 ? "commit" : "commits"} ago`,
      )
      .replaceAll("{status}", value);

  if (config.showIdle && status.runs.length === 0 && !value)
    return config.indicatorTemplates.idle;

  return value;
}

export function lintIndicator(
  lint: LintState | null,
  templates: RuntimeConfig["Service"]["lint"]["templates"],
) {
  if (lint?.running) return templates.running;

  switch (lint?.result?.status) {
    case "clean":
      return templates.clean;
    case "failed":
      return templates.failure.replaceAll(
        "{count}",
        String(failing(lint.result.checks).length),
      );
    case "timedOut":
      return templates.timedOut;
    case "error":
      return templates.unavailable;
    default:
      return null;
  }
}
