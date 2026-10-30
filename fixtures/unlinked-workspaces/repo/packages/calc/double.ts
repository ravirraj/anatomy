// Within one package, ordinary relative imports remain what they are.
import { shared } from "./shared";

export function double(n: number): number {
  return shared() * n;
}
