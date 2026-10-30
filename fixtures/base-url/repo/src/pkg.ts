// Nothing called some-package exists anywhere in the repository, so with no
// other rule that applies it is an external package dependency.
import { level } from "some-package";

export function degrees(): number {
  return level() * 90;
}
