import { runSetupAction, SetupRuntimeError } from "@/lib/setupRuntime";
import { authorizeSetupMutation } from "@/lib/setupRequestSecurity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 20_000;

class RequestBodyTooLargeError extends Error {}

async function readLimitedBody(request: Request): Promise<string> {
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* the size rejection still wins */ }
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function POST(request: Request) {
  const authorization = authorizeSetupMutation(request);
  if (!authorization.allowed) {
    return Response.json({ error: authorization.error }, { status: 403 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 415 });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return Response.json({ error: "Request body is too large." }, { status: 413 });
  }

  let body: unknown;
  try {
    const text = await readLimitedBody(request);
    body = JSON.parse(text);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json({ error: "Request body is too large." }, { status: 413 });
    }
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  try {
    return Response.json(await runSetupAction(body), {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    if (error instanceof SetupRuntimeError) {
      return Response.json(
        { error: error.message },
        { status: error.status, headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }
    return Response.json(
      { error: "Setup action failed without changing the requested configuration." },
      { status: 500, headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  }
}
