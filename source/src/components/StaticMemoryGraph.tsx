"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Network, Sparkles } from "lucide-react";

interface RawNode {
  id: string;
  title: string;
  group: string;
  degree: number;
  mtime?: number;
}

interface RawLink {
  source: string;
  target: string;
}

interface GraphPayload {
  nodes: RawNode[];
  links: RawLink[];
}

interface PositionedNode extends RawNode {
  x: number;
  y: number;
  color: string;
}

interface StaticMemoryGraphProps {
  onOpenNote: (relPath: string) => void;
  variant: "galaxy" | "graph";
}

interface ViewState {
  scale: number;
  rotation: number;
  offsetY: number;
}

interface DragState {
  kind: "view" | "node";
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startRotation: number;
  startOffsetY: number;
  nodeId?: string;
  nodeOffsetX: number;
  nodeOffsetY: number;
  viewWidth: number;
  viewHeight: number;
}

const GROUP_COLORS: Record<string, string> = {
  "00 Inbox": "#FF8C85",
  "01 Daily": "#EDFF45",
  "02 Projects": "#8EA6FF",
  "03 Areas": "#4FC8AE",
  "04 Resources": "#B6B5EA",
  "05 Memories": "#FF7A73",
  "06 Archive": "#A9AFC3",
  "Agentic OS": "#FFFFFF",
  Omi: "#F1B36B",
  Wiki: "#D9D9E8",
  root: "#F6F5F3",
};

function hashText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function colorFor(group: string) {
  if (GROUP_COLORS[group]) return GROUP_COLORS[group];
  const palette = ["#FFFFFF", "#D9D9E8", "#A9A8DD", "#FF8C85", "#4FC8AE", "#EDFF45"];
  return palette[hashText(group) % palette.length];
}

function positionFor(node: RawNode, index: number, total: number, variant: "galaxy" | "graph") {
  const seed = hashText(node.id || node.title);
  const turns = variant === "galaxy" ? 5.5 : 3.5;
  const angle = (index / Math.max(1, total)) * Math.PI * 2 * turns + (seed % 101) / 101;
  const normalized = Math.sqrt((index + 1) / Math.max(1, total));
  const radiusX = 72 + normalized * 390;
  const radiusY = (variant === "galaxy" ? 42 : 64) + normalized * (variant === "galaxy" ? 210 : 235);
  const jitterX = ((seed >>> 7) % 29) - 14;
  const jitterY = ((seed >>> 13) % 23) - 11;
  return {
    x: Math.max(34, Math.min(966, 500 + Math.cos(angle) * radiusX + jitterX)),
    y: Math.max(66, Math.min(574, 310 + Math.sin(angle) * radiusY + jitterY)),
  };
}

export default function StaticMemoryGraph({ onOpenNote, variant }: StaticMemoryGraphProps) {
  const [raw, setRaw] = useState<GraphPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<PositionedNode | null>(null);
  const [view, setView] = useState<ViewState>({ scale: 1, rotation: 0, offsetY: 0 });
  const [nodeOffsets, setNodeOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/memory/graph")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((payload: GraphPayload) => {
        if (!cancelled) setRaw({ nodes: payload.nodes ?? [], links: payload.links ?? [] });
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason.message);
      });
    return () => { cancelled = true; };
  }, []);

  const graph = useMemo(() => {
    if (!raw) return null;
    const visibleNodes = [...raw.nodes]
      .sort((left, right) => (right.degree ?? 0) - (left.degree ?? 0) || (right.mtime ?? 0) - (left.mtime ?? 0))
      .slice(0, 320);
    const nodes = visibleNodes.map((node, index) => ({
      ...node,
      ...positionFor(node, index, visibleNodes.length, variant),
      color: colorFor(node.group),
    }));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const links = raw.links
      .map((link) => ({ source: byId.get(link.source), target: byId.get(link.target) }))
      .filter((link): link is { source: PositionedNode; target: PositionedNode } => Boolean(link.source && link.target))
      .slice(0, 900);
    const groups = Array.from(
      raw.nodes.reduce((counts, node) => {
        counts.set(node.group, (counts.get(node.group) ?? 0) + 1);
        return counts;
      }, new Map<string, number>()),
    ).sort((left, right) => right[1] - left[1]);
    return { nodes, links, groups };
  }, [raw, variant]);

  useEffect(() => {
    if (!raw) return;
    const svg = svgRef.current;
    if (!svg) return;

    const zoomGraph = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY > 0 ? 0.9 : 1.1;
      setView((current) => ({
        ...current,
        scale: Math.max(0.55, Math.min(2.6, current.scale * factor)),
      }));
    };

    svg.addEventListener("wheel", zoomGraph, { passive: false });
    return () => svg.removeEventListener("wheel", zoomGraph);
  }, [raw]);

  if (error) {
    return (
      <div className="absolute inset-0 grid place-items-center p-6 text-center">
        <div className="text-sm text-[var(--fg-dim)]">Graph failed: <code>{error}</code></div>
      </div>
    );
  }

  if (!raw || !graph) {
    return (
      <div className="absolute inset-0 grid place-items-center p-6 text-center" aria-live="polite">
        <div>
          <Network size={20} className="mx-auto mb-2 text-[var(--fg-dim)]" />
          <div className="text-[12px] text-[var(--fg-dim)]">Building knowledge graph…</div>
        </div>
      </div>
    );
  }

  const title = variant === "galaxy" ? "Memory Galaxy" : "Knowledge Graph · Interactive";
  const itemName = variant === "galaxy" ? "stars" : "notes";
  const Icon = variant === "galaxy" ? Sparkles : Network;
  const graphTransform = `translate(500 ${310 + view.offsetY}) rotate(${view.rotation}) scale(${view.scale}) translate(-500 -310)`;

  const beginViewDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.target instanceof Element && event.target.closest("[role='button']")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    suppressClickRef.current = false;
    dragRef.current = {
      kind: "view",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startRotation: view.rotation,
      startOffsetY: view.offsetY,
      nodeOffsetX: 0,
      nodeOffsetY: 0,
      viewWidth: Math.max(1, rect.width),
      viewHeight: Math.max(1, rect.height),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const beginNodeDrag = (event: ReactPointerEvent<SVGGElement>, node: PositionedNode) => {
    event.preventDefault();
    event.stopPropagation();
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const offset = nodeOffsets[node.id] ?? { x: 0, y: 0 };
    suppressClickRef.current = false;
    dragRef.current = {
      kind: "node",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startRotation: view.rotation,
      startOffsetY: view.offsetY,
      nodeId: node.id,
      nodeOffsetX: offset.x,
      nodeOffsetY: offset.y,
      viewWidth: Math.max(1, rect.width),
      viewHeight: Math.max(1, rect.height),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startClientX;
    const deltaY = event.clientY - drag.startClientY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 4) suppressClickRef.current = true;

    if (drag.kind === "view") {
      setView((current) => ({
        ...current,
        rotation: drag.startRotation + deltaX * 0.22,
        offsetY: Math.max(-110, Math.min(110, drag.startOffsetY + deltaY * 0.3)),
      }));
      return;
    }

    if (!drag.nodeId) return;
    const viewDeltaX = (deltaX * 1000) / drag.viewWidth / view.scale;
    const viewDeltaY = (deltaY * 620) / drag.viewHeight / view.scale;
    setNodeOffsets((current) => ({
      ...current,
      [drag.nodeId!]: {
        x: drag.nodeOffsetX + viewDeltaX,
        y: drag.nodeOffsetY + viewDeltaY,
      },
    }));
  };

  const endDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch {}
  };

  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{
        backgroundColor: variant === "galaxy" ? "#10101A" : "#101630",
        backgroundImage: `url("/textures/agent-os/${variant === "galaxy" ? "contours" : "weave"}.webp")`,
        backgroundPosition: "center",
        backgroundSize: "cover",
        backgroundBlendMode: "soft-light",
      }}
    >
      <svg
        ref={svgRef}
        className="absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing"
        viewBox="0 0 1000 620"
        preserveAspectRatio="xMidYMid meet"
        aria-label={`${title}: ${raw.nodes.length} ${itemName}, ${raw.links.length} links`}
        data-memory-graph={variant}
        style={{ touchAction: "none" }}
        onPointerDown={beginViewDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(event) => {
          if (event.target instanceof Element && event.target.closest("[role='button']")) return;
          setView((current) => ({ ...current, rotation: current.rotation + 45 }));
        }}
      >
        <g transform={graphTransform}>
          <g opacity="0.42" aria-hidden="true" pointerEvents="none">
            {graph.links.map((link, index) => {
              const sourceOffset = nodeOffsets[link.source.id] ?? { x: 0, y: 0 };
              const targetOffset = nodeOffsets[link.target.id] ?? { x: 0, y: 0 };
              return (
                <line
                  key={`${link.source.id}-${link.target.id}-${index}`}
                  x1={link.source.x + sourceOffset.x}
                  y1={link.source.y + sourceOffset.y}
                  x2={link.target.x + targetOffset.x}
                  y2={link.target.y + targetOffset.y}
                  stroke="#A9AFC3"
                  strokeWidth="0.8"
                />
              );
            })}
          </g>
          {graph.nodes.map((node, index) => {
          const radius = Math.min(9, 3.2 + Math.sqrt(Math.max(0, node.degree ?? 0)) * 0.8);
          const showLabel = index < 14;
          const offset = nodeOffsets[node.id] ?? { x: 0, y: 0 };
          const x = node.x + offset.x;
          const y = node.y + offset.y;
          return (
            <g
              key={node.id}
              role="button"
              tabIndex={0}
              aria-label={`${node.title}, ${node.group}, ${node.degree ?? 0} links`}
              onPointerDown={(event) => beginNodeDrag(event, node)}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                onOpenNote(node.id);
              }}
              onMouseEnter={() => setHovered(node)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(node)}
              onBlur={() => setHovered(null)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpenNote(node.id);
                }
              }}
              className="cursor-pointer outline-none"
            >
              <circle cx={x} cy={y} r={radius + 5} fill="transparent" />
              <circle
                cx={x}
                cy={y}
                r={radius}
                fill={node.color}
                stroke={hovered?.id === node.id ? "#FF4E45" : "#101630"}
                strokeWidth={hovered?.id === node.id ? 3 : 1}
              />
              {showLabel && (
                <text
                  x={x}
                  y={y + radius + 16}
                  fill="#FFFFFF"
                  fontSize="11"
                  textAnchor="middle"
                  fontFamily="var(--font-geist-sans), sans-serif"
                >
                  {node.title.length > 24 ? `${node.title.slice(0, 23)}…` : node.title}
                </text>
              )}
            </g>
          );
          })}
        </g>
      </svg>

      <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-md border border-white/15 bg-[#101630] px-3 py-2">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-white">
          <Icon size={11} /> {title}
        </div>
        <div className="mt-0.5 text-[11px] text-[#D9D9E8]">
          <span className="metric text-white">{raw.nodes.length}</span> {itemName} · {" "}
          <span className="metric text-white">{raw.links.length}</span> links
        </div>
        <div className="mt-2 text-[10px] text-[#D9D9E8]">Drag to rotate · scroll to zoom · drag nodes · select to open</div>
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex max-w-[60%] flex-wrap gap-1.5">
        {graph.groups.slice(0, 10).map(([group, count]) => (
          <div key={group} className="flex items-center gap-1.5 rounded-md border border-white/15 bg-[#101630] px-2 py-1">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: colorFor(group) }} />
            <span className="text-[10px] text-[#D9D9E8]">{group}</span>
            <span className="metric text-[10px] text-white">{count}</span>
          </div>
        ))}
      </div>

      {hovered && (
        <div className="pointer-events-none absolute bottom-3 right-3 z-10 max-w-[300px] rounded-md border border-white/15 bg-[#101630] px-3 py-1.5">
          <div className="flex items-center gap-1.5 truncate text-[12px] text-white">
            <Icon size={11} /> {hovered.title}
          </div>
          <div className="truncate text-[10px] text-[#D9D9E8]">{hovered.group} · {hovered.degree ?? 0} links</div>
        </div>
      )}
    </div>
  );
}
