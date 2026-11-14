import { toolConventions, toolRole } from "./conventions.ts";
import type { FrameworkAdapter } from "./types.ts";

// Assumes no framework: applies to anything and excludes nothing beyond the
// generic rules, so every source file outside them becomes a node, and only
// the tool conventions give any of them a role. No route logic: it carries
// neither route method, and the orchestration contributes no routes for it.
export const fallbackAdapter: FrameworkAdapter = {
  name: "none",
  detect: () => true,
  excludeDirectory: () => null,
  reachedBy: toolConventions,
  roleOf: (file) => toolRole(file.path),
};
