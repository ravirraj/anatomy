// A bare specifier with no "./" prefix can still mean a file of this
// repository when tsconfig sets baseUrl: this one resolves to lib/format.ts.
import { formatName } from "lib/format";

export function greeting(first: string, last: string): string {
  return "Hello " + formatName(first, last);
}
