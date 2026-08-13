import { NextResponse } from "next/server";
import { getPaperclipConfig, probePaperclipCompany } from "@/lib/paperclipConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [config, probe] = await Promise.all([getPaperclipConfig(), probePaperclipCompany()]);
  return NextResponse.json({
    configured: Boolean(config.companyId),
    companyId: config.companyId || null,
    companyUrl: config.companyUrl,
    uiBase: config.uiBase,
    reachable: probe.serverReachable,
    companyReachable: probe.companyReachable,
    status: probe.status,
  }, { headers: { "Cache-Control": "no-store" } });
}
