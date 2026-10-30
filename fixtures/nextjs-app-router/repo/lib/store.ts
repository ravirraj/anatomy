import { fanout } from "./extra";

const USERS = ["ada", "grace"];

export function allUsers(): string[] {
  return fanout(USERS);
}

export function user(id: string): { id: string } {
  return { id };
}
