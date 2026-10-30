// Both names come through the barrel, one by `export *`, one named.
import { area, three } from "./index";

export function report(): number {
  return area(three());
}
