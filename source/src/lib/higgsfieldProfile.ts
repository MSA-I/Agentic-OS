import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import {
  DEFAULT_HERMES_PROFILE,
  hermesProfileConfigPath,
  isValidHermesProfile,
  listHermesProfileNames,
  resolveHermesProfile,
} from "@/lib/hermesProfile";

export interface HiggsfieldProfileResolution {
  profile: string;
  registered: boolean;
}

export async function isHiggsfieldRegistered(profile: string): Promise<boolean> {
  try {
    const data = yaml.load(await readFile(hermesProfileConfigPath(profile), "utf8")) as {
      mcp_servers?: Record<string, unknown>;
    };
    return Boolean(data?.mcp_servers?.higgsfield);
  } catch {
    return false;
  }
}

export async function resolveHiggsfieldProfile(): Promise<HiggsfieldProfileResolution> {
  const explicit = process.env.HIGGS_PROFILE?.trim();
  if (explicit && isValidHermesProfile(explicit)) {
    return { profile: explicit, registered: await isHiggsfieldRegistered(explicit) };
  }

  const active = await resolveHermesProfile();
  if (await isHiggsfieldRegistered(active)) return { profile: active, registered: true };

  const profiles = (await listHermesProfileNames())
    .filter((profile) => profile !== active && profile !== DEFAULT_HERMES_PROFILE)
    .sort((a, b) => a.localeCompare(b));
  if (active !== DEFAULT_HERMES_PROFILE) profiles.unshift(DEFAULT_HERMES_PROFILE);

  for (const profile of profiles) {
    if (await isHiggsfieldRegistered(profile)) return { profile, registered: true };
  }

  return { profile: active, registered: false };
}
