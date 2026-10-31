import { leftPad } from "left-pad";
import { shared } from "shared-lib";

export function pad(value: string): string {
  return leftPad(value, 8) + shared;
}
