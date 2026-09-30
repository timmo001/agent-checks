import { createHash } from "node:crypto";
import type { RuntimeConfig } from "./config";
import { attention, type Status } from "./services/github";

// Machine-readable companion to the display token. Herdr caps token values at 80 characters.
export function state(status: Status | null, error: string | null) {
  if (error) return "v1 unavailable";

  if (!status) return null;

  const failures = status.runs.filter((run) => attention(run.conclusion));

  if (failures.length)
    return `v1 failure ${status.sha} ${createHash("sha256")
      .update(
        failures
          .map((run) => `${run.id}:${run.run_attempt}`)
          .sort()
          .join(","),
      )
      .digest("hex")
      .slice(0, 8)}`;

  if (status.runs.some((run) => run.status !== "completed"))
    return `v1 running ${status.sha}`;

  if (
    status.runs.some((run) => run.conclusion === "success") &&
    status.runs.every(
      (run) =>
        run.conclusion === "success" ||
        run.conclusion === "neutral" ||
        run.conclusion === "skipped",
    )
  )
    return `v1 success ${status.sha}`;

  return `v1 idle ${status.sha}`;
}

export function indicator(
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
