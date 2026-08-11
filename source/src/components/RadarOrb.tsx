"use client";

interface RadarOrbProps {
  image: string;
  sweeping?: boolean;
}

export default function RadarOrb({ image, sweeping = false }: RadarOrbProps) {
  return (
    <div
      className="absolute inset-0 overflow-hidden rounded-full border border-current"
      aria-label={sweeping ? "Oracle sweep in progress" : "Oracle ready"}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image} alt="" className="h-full w-full object-cover" />
    </div>
  );
}
