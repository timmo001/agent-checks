import { docsConfig } from "@timmo001/docs-kit/blume";
import { defineConfig } from "blume";

export default defineConfig(
  docsConfig({
    title: "Agent Checks",
    description:
      "CI, lint and pull request review status for Herdr workspaces, with an Omarchy panel to read and act on it.",
    site: "agent-checks.timmo.dev",
    github: { owner: "timmo001", repo: "agent-checks" },
    navigation: {
      sidebar: ["/", "/install", "/status", "/panel", "/cli", "/configuration"],
    },
  }),
);
