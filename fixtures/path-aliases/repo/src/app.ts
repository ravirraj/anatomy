import { formatPrice } from "@/util/format";

export function banner(cents: number): string {
  return formatPrice(cents) + " today";
}
