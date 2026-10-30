import { allUsers } from "../lib/store";

export function UserList() {
  return allUsers().join(", ");
}
