import { allUsers } from "../../../lib/store";

export async function GET() {
  return Response.json(allUsers());
}
