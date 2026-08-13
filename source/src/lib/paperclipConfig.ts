import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_API = "http://127.0.0.1:3100/api";

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readEnvValue(text: string, key: string): string {
  let value = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1 || line.slice(0, index).trim() !== key) continue;
    value = unquote(line.slice(index + 1));
  }
  return value;
}

async function dynamicEnv(): Promise<string> {
  try { return await readFile(path.join(process.cwd(), ".env.local"), "utf8"); }
  catch { return ""; }
}

function safeApiBase(value: string): string {
  try {
    const url = new URL(value || DEFAULT_API);
    if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_API;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return DEFAULT_API;
  }
}

function uiBaseFor(apiBase: string): string {
  const url = new URL(apiBase);
  url.pathname = url.pathname.replace(/\/api\/?$/, "") || "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export interface PaperclipConfig {
  apiBase: string;
  uiBase: string;
  companyId: string;
  companyUrl: string | null;
}

export async function getPaperclipConfig(): Promise<PaperclipConfig> {
  const file = await dynamicEnv();
  const apiBase = safeApiBase(readEnvValue(file, "PAPERCLIP_API") || process.env.PAPERCLIP_API || DEFAULT_API);
  const rawCompany = readEnvValue(file, "PAPERCLIP_COMPANY") || process.env.PAPERCLIP_COMPANY || "";
  const companyId = /^[A-Za-z0-9_.-]{1,128}$/.test(rawCompany.trim()) ? rawCompany.trim() : "";
  const uiBase = uiBaseFor(apiBase);
  return {
    apiBase,
    uiBase,
    companyId,
    companyUrl: companyId ? `${uiBase}/${encodeURIComponent(companyId)}` : null,
  };
}

export async function probePaperclipCompany(): Promise<{
  serverReachable: boolean;
  companyReachable: boolean;
  status: number | null;
}> {
  const config = await getPaperclipConfig();
  const url = config.companyId
    ? `${config.apiBase}/companies/${encodeURIComponent(config.companyId)}`
    : config.uiBase;
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(3500) });
    return {
      serverReachable: true,
      companyReachable: Boolean(config.companyId && response.ok),
      status: response.status,
    };
  } catch {
    return { serverReachable: false, companyReachable: false, status: null };
  }
}
