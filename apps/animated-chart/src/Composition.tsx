import type { CSSProperties, FC } from "react";
import {
  AbsoluteFill,
  Composition,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

type Bar = {
  label: string;
  value: number;
  color: string;
};

const bars: Bar[] = [
  { label: "Jan", value: 68, color: "#8b5cf6" },
  { label: "Feb", value: 42, color: "#ec4899" },
  { label: "Mar", value: 87, color: "#06b6d4" },
  { label: "Apr", value: 59, color: "#f59e0b" },
  { label: "May", value: 74, color: "#22c55e" },
];

const chart = {
  left: 170,
  top: 295,
  width: 1580,
  height: 510,
};

const calculateOpacity = (frame: number, start: number, end: number) =>
  interpolate(frame, [start, end], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

export const MyComposition: FC = () => {
  return (
    <Composition
      id="AnimatedBarChart"
      component={MyComponent}
      durationInFrames={180}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{}}
    />
  );
};

export const MyComponent: FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const titleOpacity = calculateOpacity(frame, 0, 24);
  const chartOpacity = calculateOpacity(frame, 14, 35);
  const chartLift = interpolate(frame, [14, 35], [32, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const average = Math.round(bars.reduce((sum, bar) => sum + bar.value, 0) / bars.length);

  return (
    <AbsoluteFill style={styles.canvas}>
      <div style={styles.glowTop} />
      <div style={styles.glowBottom} />
      <div style={styles.grid} />

      <div style={{ ...styles.header, opacity: titleOpacity }}>
        <div style={styles.eyebrow}>PERFORMANCE OVERVIEW</div>
        <h1 style={styles.title}>Monthly growth, at a glance.</h1>
        <p style={styles.subtitle}>A simple view of the last five months</p>
      </div>

      <div
        style={{
          ...styles.chartArea,
          opacity: chartOpacity,
          translate: `0px ${chartLift}px`,
        }}
      >
        <div style={styles.plot}>
          {[0, 25, 50, 75, 100].map((tick) => (
            <div key={tick} style={{ ...styles.gridLine, bottom: `${tick}%` }}>
              <span style={styles.tickLabel}>{tick}</span>
            </div>
          ))}

          <div style={styles.barsRow}>
            {bars.map((bar, index) => {
              const start = 22 + index * 8;
              const animatedValue = interpolate(frame, [start, start + 42], [0, bar.value], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.bezier(0.16, 1, 0.3, 1),
              });
              const valueOpacity = calculateOpacity(frame, start + 25, start + 42);
              const barHeight = `${animatedValue}%`;

              return (
                <div key={bar.label} style={styles.barColumn}>
                  <div style={styles.valueSlot}>
                    <span style={{ ...styles.valueLabel, opacity: valueOpacity }}>
                      {Math.round(animatedValue)}
                    </span>
                  </div>
                  <div style={styles.barTrack}>
                    <div
                      style={{
                        ...styles.bar,
                        height: barHeight,
                        background: `linear-gradient(180deg, ${bar.color} 0%, ${bar.color}b8 100%)`,
                        boxShadow: `0 18px 38px ${bar.color}38`,
                      }}
                    >
                      <div style={{ ...styles.barShine, opacity: valueOpacity }} />
                    </div>
                  </div>
                  <div style={styles.barLabel}>{bar.label}</div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={styles.footerRow}>
          <div style={styles.legend}>
            <span style={styles.legendDot} />
            <span>Growth index</span>
          </div>
          <div style={styles.average}>
            <span style={styles.averageCaption}>5-month average</span>
            <strong style={styles.averageValue}>{average}</strong>
          </div>
        </div>
      </div>

      <div
        style={{
          ...styles.progress,
          width: `${interpolate(frame, [0, 180], [0, 100], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })}%`,
        }}
      />
      <div style={{ ...styles.timestamp, opacity: calculateOpacity(frame, 50, 75) }}>
        Updated just now · {Math.round(frame / fps)}s
      </div>
    </AbsoluteFill>
  );
};

const styles: Record<string, CSSProperties> = {
  canvas: {
    background: "#0a0a12",
    color: "#f8fafc",
    fontFamily: "Arial, Helvetica, sans-serif",
    overflow: "hidden",
    padding: "96px 170px 76px",
  },
  glowTop: {
    position: "absolute",
    width: 900,
    height: 700,
    top: -430,
    right: -120,
    borderRadius: "50%",
    background: "radial-gradient(circle, rgba(139,92,246,0.20), rgba(139,92,246,0) 68%)",
  },
  glowBottom: {
    position: "absolute",
    width: 850,
    height: 550,
    bottom: -360,
    left: -160,
    borderRadius: "50%",
    background: "radial-gradient(circle, rgba(6,182,212,0.15), rgba(6,182,212,0) 68%)",
  },
  grid: {
    position: "absolute",
    inset: 0,
    opacity: 0.15,
    backgroundImage: "linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px)",
    backgroundSize: "80px 80px",
  },
  header: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 16,
  },
  eyebrow: {
    color: "#a78bfa",
    fontSize: 20,
    fontWeight: 700,
    letterSpacing: "0.22em",
  },
  title: {
    margin: 0,
    fontSize: 66,
    lineHeight: 1.08,
    letterSpacing: "-0.04em",
    fontWeight: 700,
  },
  subtitle: {
    margin: 0,
    color: "#94a3b8",
    fontSize: 28,
  },
  chartArea: {
    position: "relative",
    zIndex: 1,
    marginTop: 64,
  },
  plot: {
    position: "relative",
    height: chart.height,
    marginLeft: 72,
    borderLeft: "1px solid rgba(148,163,184,0.25)",
    borderBottom: "1px solid rgba(148,163,184,0.25)",
  },
  gridLine: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 1,
    borderTop: "1px dashed rgba(148,163,184,0.18)",
  },
  tickLabel: {
    position: "absolute",
    left: -72,
    top: -15,
    width: 48,
    color: "#64748b",
    fontSize: 18,
    textAlign: "right",
  },
  barsRow: {
    position: "absolute",
    inset: "0 64px 0 92px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "stretch",
    gap: 46,
  },
  barColumn: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    minWidth: 0,
  },
  valueSlot: {
    height: 46,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  valueLabel: {
    color: "#f8fafc",
    fontSize: 25,
    fontWeight: 700,
  },
  barTrack: {
    position: "relative",
    flex: 1,
    width: "100%",
    display: "flex",
    alignItems: "flex-end",
    background: "rgba(255,255,255,0.035)",
    borderRadius: "18px 18px 0 0",
    overflow: "hidden",
  },
  bar: {
    position: "relative",
    width: "100%",
    minHeight: 3,
    borderRadius: "18px 18px 0 0",
  },
  barShine: {
    position: "absolute",
    top: 0,
    left: "10%",
    right: "10%",
    height: 4,
    borderRadius: 4,
    background: "rgba(255,255,255,0.9)",
  },
  barLabel: {
    marginTop: 18,
    color: "#cbd5e1",
    fontSize: 24,
    fontWeight: 600,
  },
  footerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 34,
    marginLeft: 72,
  },
  legend: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    color: "#94a3b8",
    fontSize: 20,
  },
  legendDot: {
    width: 12,
    height: 12,
    borderRadius: "50%",
    background: "#8b5cf6",
    boxShadow: "0 0 18px rgba(139,92,246,0.9)",
  },
  average: {
    display: "flex",
    alignItems: "baseline",
    gap: 16,
  },
  averageCaption: {
    color: "#64748b",
    fontSize: 19,
  },
  averageValue: {
    color: "#f8fafc",
    fontSize: 36,
  },
  progress: {
    position: "absolute",
    zIndex: 2,
    left: 0,
    bottom: 0,
    height: 5,
    background: "linear-gradient(90deg, #8b5cf6, #06b6d4, #22c55e)",
  },
  timestamp: {
    position: "absolute",
    zIndex: 2,
    right: 170,
    bottom: 76,
    color: "#475569",
    fontSize: 17,
  },
};
