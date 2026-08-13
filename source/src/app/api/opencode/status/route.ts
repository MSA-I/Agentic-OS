import { NextResponse } from "next/server";
import { getOpenCodeDefaultModel, getOpenCodeModels, getOpenCodeState, omniRouteProviderConfigured } from "@/lib/opencode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const models = getOpenCodeModels();
  const defaultModel = getOpenCodeDefaultModel();
  return NextResponse.json({
    ...getOpenCodeState(),
    models,
    defaultModel,
    defaultModelSetupRequired: defaultModel.startsWith("omniroute/")
      && !models.some((model) => model.id === defaultModel),
    omniRouteProviderConfigured: omniRouteProviderConfigured(),
  });
}
