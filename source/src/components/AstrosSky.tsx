"use client";

export interface SkyTopic {
  topic: string;
  heat: number;
  category: string;
}

const CATEGORY_COLOR: Record<string, string> = {
  Models: "#4DEEFF",
  Agents: "#50F2A8",
  Tools: "#B18CFF",
  SEO: "#C8F25A",
  Drama: "#FF6D8A",
  Money: "#FFD86B",
};

const TOPIC_POSITIONS = [
  [16, 34],
  [29, 57],
  [42, 29],
  [55, 53],
  [68, 26],
  [80, 48],
  [35, 74],
  [66, 71],
] as const;

const STATIC_STARS = Array.from({ length: 68 }, (_, index) => ({
  cx: 3 + ((index * 37) % 94),
  cy: 4 + ((index * 53) % 88),
  radius: index % 9 === 0 ? 0.42 : index % 4 === 0 ? 0.28 : 0.16,
  opacity: 0.2 + (index % 5) * 0.12,
}));

interface AstrosSkyProps {
  topics: SkyTopic[];
  sweeping: boolean;
  activeIndex: number | null;
  onSelect: (index: number) => void;
}

export default function AstrosSky({ topics, sweeping, activeIndex, onSelect }: AstrosSkyProps) {
  const positionedTopics = topics.map((topic, index) => {
    const [x, y] = TOPIC_POSITIONS[index % TOPIC_POSITIONS.length];
    return { topic, index, x, y };
  });

  return (
    <div
      className="absolute inset-0 z-[3] overflow-hidden"
      aria-label={sweeping ? "Astros sweep in progress" : "Astros topic constellation"}
    >
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" aria-hidden="true">
        {STATIC_STARS.map((star, index) => (
          <circle
            key={index}
            cx={star.cx}
            cy={star.cy}
            r={star.radius}
            fill="#F5F5F5"
            opacity={star.opacity}
          />
        ))}
        {positionedTopics.slice(1).map((node, index) => {
          const previous = positionedTopics[index];
          return (
            <line
              key={`${previous.index}-${node.index}`}
              x1={previous.x}
              y1={previous.y}
              x2={node.x}
              y2={node.y}
              stroke="#6868F4"
              strokeWidth="0.22"
              strokeDasharray="1.2 1.8"
              opacity="0.7"
            />
          );
        })}
      </svg>

      {/* Keep the original Hermes actor in place, now as a static brand marker. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/astros/face.png"
        alt=""
        className="pointer-events-none absolute right-[5%] top-[8%] h-[62%] max-w-[42%] object-contain opacity-25"
      />

      {positionedTopics.map(({ topic, index, x, y }) => {
        const active = activeIndex === index;
        const color = CATEGORY_COLOR[topic.category] ?? "#B18CFF";
        return (
          <button
            key={`${topic.topic}-${index}`}
            type="button"
            onClick={() => onSelect(index)}
            aria-pressed={active}
            aria-label={`${topic.topic}, ${topic.heat}% heat, ${topic.category}`}
            className="absolute -translate-x-1/2 -translate-y-1/2 rounded-md border px-2 py-1 text-left font-mono text-[10px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF4E45]"
            style={{
              left: `${x}%`,
              top: `${y}%`,
              borderColor: active ? "#FF4E45" : color,
              backgroundColor: active ? "#F5F5F5" : "#101630",
              color: active ? "#101630" : "#F5F5F5",
            }}
          >
            <span className="block max-w-28 truncate">{topic.topic}</span>
            <span className="block opacity-70">{topic.heat}% · {topic.category}</span>
          </button>
        );
      })}
    </div>
  );
}
