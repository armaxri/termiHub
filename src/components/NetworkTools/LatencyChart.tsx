interface LatencyChartProps {
  /** Array of latency values (ms). Null entries represent timeouts/drops. */
  points: (number | null)[];
  height?: number;
}

const CHART_HEIGHT = 80;
const MIN_RANGE_MS = 10;

/** Simple SVG sparkline chart for real-time latency visualization. */
export function LatencyChart({ points, height = CHART_HEIGHT }: LatencyChartProps) {
  if (points.length === 0) return null;

  const validPoints = points.filter((p): p is number => p != null);
  const maxVal = Math.max(...validPoints, MIN_RANGE_MS);
  const minVal = Math.min(...validPoints, 0);
  const range = maxVal - minVal || 1;

  const width = 100; // viewBox percentage
  const n = points.length;

  // Build polyline points string for valid segments
  const segments: { x: number; y: number }[][] = [];
  let currentSegment: { x: number; y: number }[] = [];

  points.forEach((val, i) => {
    const x = (i / Math.max(n - 1, 1)) * width;
    if (val != null) {
      const y = height - ((val - minVal) / range) * (height - 8) - 4;
      currentSegment.push({ x, y });
    } else {
      if (currentSegment.length > 0) {
        segments.push(currentSegment);
        currentSegment = [];
      }
    }
  });
  if (currentSegment.length > 0) segments.push(currentSegment);

  const toPoints = (seg: { x: number; y: number }[]) =>
    seg.map(({ x, y }) => `${x},${y}`).join(" ");

  // Drop markers (red dots at timeout positions)
  const dropMarkers = points
    .map((val, i) => ({
      val,
      x: (i / Math.max(n - 1, 1)) * width,
    }))
    .filter(({ val }) => val == null);

  return (
    <svg
      className="latency-chart"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height }}
    >
      {/* Zero line */}
      <line
        x1="0"
        y1={height - 4}
        x2={width}
        y2={height - 4}
        stroke="var(--border-primary)"
        strokeWidth="0.5"
      />

      {/* Latency line segments */}
      {segments.map((seg, i) =>
        seg.length === 1 ? (
          <circle key={i} cx={seg[0].x} cy={seg[0].y} r="1.5" fill="var(--accent-color)" />
        ) : (
          <polyline
            key={i}
            points={toPoints(seg)}
            fill="none"
            stroke="var(--accent-color)"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )
      )}

      {/* Drop markers */}
      {dropMarkers.map(({ x }, i) => (
        <line
          key={i}
          x1={x}
          y1="0"
          x2={x}
          y2={height}
          stroke="var(--color-error, #f44747)"
          strokeWidth="1"
          strokeDasharray="2,2"
          opacity="0.6"
        />
      ))}

      {/* Max label */}
      <text
        x="1"
        y="8"
        fontSize="5"
        fill="var(--text-secondary)"
        style={{ fontFamily: "monospace" }}
      >
        {maxVal.toFixed(0)}ms
      </text>
    </svg>
  );
}
