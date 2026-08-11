"use client";

import StaticMemoryGraph from "./StaticMemoryGraph";

interface MemoryGalaxyProps {
  onOpenNote: (relPath: string) => void;
}

export default function MemoryGalaxy({ onOpenNote }: MemoryGalaxyProps) {
  return <StaticMemoryGraph variant="galaxy" onOpenNote={onOpenNote} />;
}
