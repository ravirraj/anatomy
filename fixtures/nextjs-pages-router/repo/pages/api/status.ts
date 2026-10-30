// A pages/api handler decides its method at runtime by reading the request,
// so no route is recovered for it — it is listed as omitted, not invented.
export default function handler(_req: unknown, res: { json(body: unknown): void }) {
  return res.json({ ok: true });
}
