import { getInstallAgentAvailability } from "@/lib/agentInstall/availability";
import { isLoopbackRequest } from "@/lib/setupRequestSecurity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only: it answers which agent could plan an install, and never starts one.
// A GET therefore stays out of the mutation inventory, and the loopback boundary
// is the same one GET /api/setup uses.
export async function GET(request: Request) {
  if (!isLoopbackRequest(request)) {
    return Response.json(
      { error: "Agent availability is available only through this app on localhost." },
      { status: 403, headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  }

  try {
    return Response.json(await getInstallAgentAvailability(), {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch {
    return Response.json(
      { error: "Agent availability is temporarily unavailable." },
      { status: 500, headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  }
}
