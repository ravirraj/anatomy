import { user } from "../../../../lib/store";

export async function GET(_req: Request, ctx: { params: { id: string } }) {
  return Response.json(user(ctx.params.id));
}

export async function DELETE(_req: Request, _ctx: unknown) {
  return new Response(null, { status: 204 });
}
