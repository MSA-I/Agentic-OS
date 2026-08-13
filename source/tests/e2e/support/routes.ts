import { readdirSync } from "node:fs";
import path from "node:path";

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}

export function discoverPublicRoutes(): string[] {
  const appDirectory = path.resolve(process.cwd(), "src", "app");
  return walk(appDirectory)
    .filter((file) => path.basename(file) === "page.tsx")
    .filter((file) => !file.split(path.sep).includes("api"))
    .map((file) => {
      const relativeDirectory = path.relative(appDirectory, path.dirname(file));
      if (!relativeDirectory) return "/";
      return `/${relativeDirectory.split(path.sep).join("/")}`;
    })
    .sort((left, right) => left.localeCompare(right));
}

export const PUBLIC_ROUTES = discoverPublicRoutes();

export const QA_VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "compact", width: 1024, height: 768 },
  { name: "mobile", width: 390, height: 844 },
] as const;

export const VISUAL_ROUTES = [
  { name: "mission-control", route: "/" },
  { name: "claude", route: "/claude?view=code" },
  { name: "codex", route: "/codex?panel=chat" },
  { name: "hermes", route: "/hermes?view=messages" },
  { name: "openclaw", route: "/openclaw?view=chat" },
  { name: "antigravity", route: "/antigravity?view=conversation" },
  { name: "memory", route: "/memory" },
] as const;
