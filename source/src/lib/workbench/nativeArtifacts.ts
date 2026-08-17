import "server-only";

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listProjects as listAntigravityProjects, listProjectFiles as listAntigravityFiles } from "@/lib/antigravityWorkspace";
import { listPublishable, listPublished } from "@/lib/claudeArtifacts";
import { readSession as readCodexSession } from "@/lib/codexWorkspace";
import {
  listBucketFiles as listHermesBucketFiles,
  listBuckets as listHermesBuckets,
  resolveBucketFile as resolveHermesBucketFile,
} from "@/lib/hermesWorkspace";
import { loadNativeAgentSession } from "@/lib/nativeAgentHistory";
import {
  listBucketFiles as listOpenClawBucketFiles,
  listBuckets as listOpenClawBuckets,
  resolveBucketFile as resolveOpenClawBucketFile,
} from "@/lib/openclawWorkspace";
import type { NativeArtifact, Run, WorkbenchProvider } from "./types";
import { isSensitivePath } from "@/lib/control-plane/pathSecurity";
import { sanitizeNativeArtifact } from "@/lib/control-plane/secretChannels";

function artifactId(provider: WorkbenchProvider, value: string): string {
  return `${provider}:${Buffer.from(value).toString("base64url")}`;
}

function localArtifact(
  provider: WorkbenchProvider,
  absolutePath: string,
  kind: string,
  label: string,
  metadata: Record<string, unknown>,
): NativeArtifact {
  return {
    id: artifactId(provider, absolutePath),
    kind,
    label,
    uri: pathToFileURL(absolutePath).href,
    metadata,
  };
}

async function codexArtifacts(run: Run): Promise<NativeArtifact[]> {
  if (!run.context.sessionId) return [];
  const session = await readCodexSession(run.context.sessionId);
  if (!session?.cwdExists) return [];
  return session.cwdFiles.filter((file) => !isSensitivePath(file.relPath)).slice(0, 120).map((file) => {
    const absolutePath = path.resolve(session.cwd, file.relPath);
    return localArtifact("codex", absolutePath, file.kind, file.name, {
      relPath: file.relPath,
      bytes: file.bytes,
      mtime: file.mtime,
      sessionId: session.id,
      source: "session-cwd",
    });
  });
}

async function claudeArtifacts(run: Run): Promise<NativeArtifact[]> {
  let projectId = run.context.projectId;
  let cwd = "";
  if (run.context.sessionId) {
    const loaded = await loadNativeAgentSession("claude", run.context.sessionId);
    cwd = loaded?.detail.cwd ?? loaded?.group.root ?? "";
  }

  const publishable = await listPublishable();
  const matches = publishable.filter((item) => {
    if (isSensitivePath(item.path)) return false;
    if (projectId && item.source === `Claude · ${projectId}`) return true;
    if (cwd) {
      const resolved = path.resolve(item.path);
      const root = path.resolve(cwd);
      return resolved === root || resolved.startsWith(root + path.sep);
    }
    return false;
  });
  const matchSources = new Set(matches.map((item) => path.resolve(item.path)));
  const published = (await listPublished()).filter((item) => matchSources.has(path.resolve(item.source)));

  return [
    ...matches.map((item) => localArtifact("claude", item.path, "html", item.title, {
      bytes: item.bytes,
      mtime: item.mtime,
      projectId,
      source: item.source,
      published: false,
    })),
    ...published.map((item): NativeArtifact => ({
      id: artifactId("claude", `published:${item.slug}`),
      kind: "html",
      label: item.title,
      uri: item.url,
      metadata: {
        bytes: item.bytes,
        publishedAt: item.publishedAt,
        source: item.source,
        published: true,
      },
    })),
  ];
}

async function hermesArtifacts(run: Run): Promise<NativeArtifact[]> {
  const buckets = await listHermesBuckets();
  const actorBucket = run.context.actorId && run.context.actorId !== "default"
    ? `profile-${run.context.actorId}`
    : "workspace";
  const bucket = buckets.find((candidate) => candidate.id === run.context.projectId)
    ?? buckets.find((candidate) => candidate.id === actorBucket);
  if (!bucket) return [];
  const listing = await listHermesBucketFiles(bucket.id, 120);
  if (!listing) return [];
  return listing.files.filter((file) => !isSensitivePath(file.relPath)).flatMap((file) => {
    const absolutePath = resolveHermesBucketFile(bucket.id, file.relPath);
    return absolutePath ? [localArtifact("hermes", absolutePath, file.kind, file.name, {
      relPath: file.relPath,
      bytes: file.bytes,
      mtime: file.mtime,
      bucketId: bucket.id,
      actorId: run.context.actorId,
    })] : [];
  });
}

function openClawActorBucket(actorId: string | null): string | null {
  if (!actorId || actorId === "main") return "workspace-main";
  if (actorId === "julian" || actorId === "personal") return "workspace-personal";
  if (actorId === "marketing") return "workspace-marketing";
  return null;
}

async function openClawArtifacts(run: Run): Promise<NativeArtifact[]> {
  const buckets = await listOpenClawBuckets();
  const actorBucket = openClawActorBucket(run.context.actorId);
  const bucket = buckets.find((candidate) => candidate.id === run.context.projectId)
    ?? (actorBucket ? buckets.find((candidate) => candidate.id === actorBucket) : undefined);
  if (!bucket) return [];
  const listing = await listOpenClawBucketFiles(bucket.id, 120);
  if (!listing) return [];
  return listing.files.filter((file) => !isSensitivePath(file.relPath)).flatMap((file) => {
    const absolutePath = resolveOpenClawBucketFile(bucket.id, file.relPath);
    return absolutePath ? [localArtifact("openclaw", absolutePath, file.kind, file.name, {
      relPath: file.relPath,
      bytes: file.bytes,
      mtime: file.mtime,
      bucketId: bucket.id,
      actorId: run.context.actorId,
    })] : [];
  });
}

async function antigravityArtifacts(run: Run): Promise<NativeArtifact[]> {
  const projects = await listAntigravityProjects();
  const project = projects.find((candidate) =>
    candidate.name === run.context.projectId || candidate.root === run.context.projectId
  ) ?? projects.find((candidate) => candidate.kind === "brain" && candidate.name === run.context.sessionId);
  if (!project) return [];
  const listing = await listAntigravityFiles(project.kind, project.name, 120);
  if (!listing) return [];
  return listing.files.filter((file) => !isSensitivePath(file.relPath)).flatMap((file) => {
    const absolutePath = path.resolve(listing.root, file.relPath);
    if (!existsSync(absolutePath)) return [];
    return [localArtifact("antigravity", absolutePath, file.kind, file.name, {
      relPath: file.relPath,
      bytes: file.bytes,
      mtime: file.mtime,
      projectId: project.name,
      projectKind: project.kind,
    })];
  });
}

export async function listNativeArtifacts(
  provider: WorkbenchProvider,
  run: Run,
): Promise<NativeArtifact[]> {
  let artifacts: NativeArtifact[];
  switch (provider) {
    case "codex": artifacts = await codexArtifacts(run); break;
    case "claude": artifacts = await claudeArtifacts(run); break;
    case "hermes": artifacts = await hermesArtifacts(run); break;
    case "openclaw": artifacts = await openClawArtifacts(run); break;
    case "antigravity": artifacts = await antigravityArtifacts(run); break;
  }
  return artifacts.flatMap((artifact) => {
    const safe = sanitizeNativeArtifact(artifact);
    return safe ? [safe] : [];
  });
}
