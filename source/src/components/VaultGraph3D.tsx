"use client";

import StaticMemoryGraph from "./StaticMemoryGraph";

interface VaultGraphProps {
  onOpenNote: (relPath: string) => void;
}

export default function VaultGraph3D({ onOpenNote }: VaultGraphProps) {
  return <StaticMemoryGraph variant="graph" onOpenNote={onOpenNote} />;
}
