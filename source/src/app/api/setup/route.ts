import { getSetupState } from "@/lib/setupRuntime";
import { isLoopbackRequest, setupCapabilityCookie } from "@/lib/setupRequestSecurity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isLoopbackRequest(request)) {
    return Response.json(
      { error: "Setup diagnostics are available only through this app on localhost." },
      { status: 403, headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  }

  try {
    const state = await getSetupState();
    return Response.json(state, {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Set-Cookie": setupCapabilityCookie(),
      },
    });
  } catch {
    return Response.json(
      { error: "Setup diagnostics are temporarily unavailable." },
      { status: 500, headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  }
}
