// The first segment names a real folder of this repository, so this is a
// broken local path, not a package: it is unresolved, not external.
import { gone } from "lib/missing";

export function use(): string {
  return gone();
}
