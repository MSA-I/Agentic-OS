import { resolveModel, mapleUp, MAPLE_LABEL } from "@/lib/localModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/local/model — the model the Local agent will actually use right now
// (follows whatever's pinned warm in Ollama). Drives the live UI label.
// ?engine=maple reports the Maple-Preview toggle engine instead (up = server on :8124).
export async function GET(req: Request) {
  const engine = new URL(req.url).searchParams.get("engine");
  if (engine === "maple") {
    const up = await mapleUp();
    return Response.json({ model: MAPLE_LABEL, warm: up, up }, { headers: { "cache-control": "no-store" } });
  }
  const { model, warm } = await resolveModel();
  return Response.json({ model, warm }, { headers: { "cache-control": "no-store" } });
}
