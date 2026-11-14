import { button } from "./index.ts";

const token = process.env.ACME_TOKEN;

export function main(): string {
  return button(process.env.ACME_LABEL ?? "go") + String(token);
}
