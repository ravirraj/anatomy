import type { Role } from "../../roles.ts";
import { toolConventions, toolRole } from "./conventions.ts";
import type { FrameworkAdapter, ViewFile } from "./types.ts";

// React has two conventions a file can be read by. A hook's name starts with
// "use" — React's own rule, which its lint enforces. A component renders JSX,
// which is syntax rather than a naming habit, so a .tsx file of helpers isn't
// claimed as one. Both facts reach the adapter on the view: the path and the
// builder's jsx flag, which is the same scan of the syntax tree.
const HOOK_NAME = /^use([A-Z0-9]|-[a-z0-9])/;

export function reactRole(file: ViewFile): Role | null {
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  if (HOOK_NAME.test(name)) return "hook";
  if (file.flags.jsx) return "component";
  return null;
}

export const reactAdapter: FrameworkAdapter = {
  name: "React",
  detect: (project) => project.dependencies.has("react"),
  excludeDirectory: () => null,
  reachedBy: toolConventions,
  // Tests render JSX too; the runner's pattern says what they are first.
  roleOf: (file) => toolRole(file.path) ?? reactRole(file),
};
