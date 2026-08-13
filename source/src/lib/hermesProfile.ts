import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { hermesHome } from "@/lib/config";

export const DEFAULT_HERMES_PROFILE = "default";

export function isValidHermesProfile(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,80}$/.test(value);
}

export async function listHermesProfileNames(): Promise<string[]> {
  const profiles = [DEFAULT_HERMES_PROFILE];
  try {
    const names = await readdir(path.join(hermesHome(), "profiles"), { withFileTypes: true });
    for (const entry of names) {
      if (entry.isDirectory() && isValidHermesProfile(entry.name) && !profiles.includes(entry.name)) profiles.push(entry.name);
    }
  } catch { /* default is always available */ }
  return profiles;
}

export async function resolveHermesProfile(explicit?: string | null): Promise<string> {
  const requested = explicit?.trim();
  if (requested && isValidHermesProfile(requested)) return requested;
  try {
    const active = (await readFile(path.join(hermesHome(), "active_profile"), "utf8")).trim();
    if (active && isValidHermesProfile(active)) return active;
  } catch { /* Hermes uses the global default when the marker is absent */ }
  return DEFAULT_HERMES_PROFILE;
}

export function hermesProfileConfigPath(profile: string): string {
  return profile === DEFAULT_HERMES_PROFILE
    ? path.join(hermesHome(), "config.yaml")
    : path.join(hermesHome(), "profiles", profile, "config.yaml");
}

export function hermesProfileEnvPath(profile: string): string {
  return profile === DEFAULT_HERMES_PROFILE
    ? path.join(hermesHome(), ".env")
    : path.join(hermesHome(), "profiles", profile, ".env");
}

export function hermesProfileExists(profile: string): boolean {
  return profile === DEFAULT_HERMES_PROFILE
    || existsSync(path.join(hermesHome(), "profiles", profile));
}

export function hermesCliArgs(profile: string, args: string[]): string[] {
  return profile === DEFAULT_HERMES_PROFILE ? args : ["-p", profile, ...args];
}
