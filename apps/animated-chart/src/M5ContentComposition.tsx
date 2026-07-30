import type { CSSProperties, FC } from "react";
import {
  AbsoluteFill,
  Audio,
  Composition,
  Easing,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

type Scene = {
  id: string;
  startFrame: number;
  durationInFrames: number;
  headline: string;
  body: string;
  imageSrc?: string;
  evidenceRef?: string;
};

type Caption = {
  startFrame: number;
  endFrame: number;
  text: string;
};

export type M5ContentProps = {
  platform: "master" | "douyin" | "xiaohongshu";
  title: string;
  subtitle: string;
  voiceoverSrc?: string;
  coverSrc?: string;
  scenes: Scene[];
  captions: Caption[];
  sourceLabel: string;
};

const fps = 30;
const durationInFrames = 45 * fps;

const defaultScenes: Scene[] = [
  {
    id: "hook",
    startFrame: 0,
    durationInFrames: 180,
    headline: "Agent 真能自己干活吗？",
    body: "关键不是多写几段 Prompt，而是每一步都有真实工具结果和失败去向。",
    evidenceRef: "M5 / execution-loop",
  },
  {
    id: "loop",
    startFrame: 180,
    durationInFrames: 570,
    headline: "目标 → 执行 → 观察 → 纠错",
    body: "Paperclip 管流程、预算和审批；Hermes 负责岗位执行；发布器独占真实外发。",
    evidenceRef: "M5 / Paperclip Case",
  },
  {
    id: "gate",
    startFrame: 750,
    durationInFrames: 450,
    headline: "高权限不等于无限权限",
    body: "验证码、风控、违规、预算超限和重复内容都会让整条活动立即暂停。",
    evidenceRef: "M5 / CampaignGrant",
  },
  {
    id: "close",
    startFrame: 1200,
    durationInFrames: 150,
    headline: "看结果，不看它说自己会",
    body: "连续7天可恢复运行，才算一条真正能经营的内容流水线。",
    evidenceRef: "M5 / acceptance",
  },
];

const defaultCaptions: Caption[] = defaultScenes.map((scene) => ({
  startFrame: scene.startFrame,
  endFrame: scene.startFrame + scene.durationInFrames,
  text: scene.body,
}));

const defaults: M5ContentProps = {
  platform: "master",
  title: "AI Agent 实战",
  subtitle: "从会聊天到能交付",
  scenes: defaultScenes,
  captions: defaultCaptions,
  sourceLabel: "Agent军团 · M5",
};

export const M5ContentCompositions: FC = () => (
  <>
    <Composition
      id="M5Master"
      component={M5ContentVideo}
      durationInFrames={durationInFrames}
      fps={fps}
      width={1080}
      height={1920}
      defaultProps={defaults}
    />
    <Composition
      id="M5Douyin"
      component={M5ContentVideo}
      durationInFrames={durationInFrames}
      fps={fps}
      width={1080}
      height={1920}
      defaultProps={{ ...defaults, platform: "douyin" }}
    />
    <Composition
      id="M5Xiaohongshu"
      component={M5ContentVideo}
      durationInFrames={durationInFrames}
      fps={fps}
      width={1080}
      height={1920}
      defaultProps={{ ...defaults, platform: "xiaohongshu" }}
    />
  </>
);

export const M5ContentVideo: FC<M5ContentProps> = ({
  platform,
  title,
  subtitle,
  voiceoverSrc,
  coverSrc,
  scenes,
  captions,
  sourceLabel,
}) => {
  const frame = useCurrentFrame();
  const { fps: videoFps, durationInFrames: videoDuration } = useVideoConfig();
  const intro = spring({ frame, fps: videoFps, config: { damping: 18, stiffness: 130 } });
  const activeCaption = captions.find((caption) => frame >= caption.startFrame && frame < caption.endFrame);
  const progress = interpolate(frame, [0, videoDuration - 1], [0, 100], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={styles.canvas}>
      {voiceoverSrc ? <Audio src={staticFile(voiceoverSrc)} /> : null}
      <div style={styles.glowTop} />
      <div style={styles.glowBottom} />
      <div style={styles.grid} />

      {scenes.map((scene, index) => (
        <Sequence key={scene.id} from={scene.startFrame} durationInFrames={scene.durationInFrames}>
          <SceneCard scene={scene} index={index} coverSrc={index === 0 ? coverSrc : undefined} platform={platform} />
        </Sequence>
      ))}

      <div style={{ ...styles.brand, opacity: intro }}>
        <span style={styles.brandDot} />
        {sourceLabel}
      </div>
      <div style={{ ...styles.series, opacity: intro }}>
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>

      {activeCaption ? <Caption text={activeCaption.text} startFrame={activeCaption.startFrame} /> : null}
      <div style={styles.progressTrack}>
        <div style={{ ...styles.progress, width: `${progress}%` }} />
      </div>
      <div style={styles.aiLabel}>AI 辅助素材 · 来源账本随成片交付</div>
    </AbsoluteFill>
  );
};

const SceneCard: FC<{ scene: Scene; index: number; coverSrc?: string; platform: M5ContentProps["platform"] }> = ({
  scene,
  index,
  coverSrc,
  platform,
}) => {
  const localFrame = useCurrentFrame();
  const { fps: videoFps } = useVideoConfig();
  const enter = spring({ frame: localFrame, fps: videoFps, config: { damping: 20, stiffness: 115 } });
  const exit = interpolate(localFrame, [scene.durationInFrames - 18, scene.durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.quad),
  });
  const translateY = interpolate(enter, [0, 1], [70, 0]);
  const scale = interpolate(enter, [0, 1], [0.97, 1]);
  const imageSrc = scene.imageSrc || coverSrc;

  return (
    <AbsoluteFill style={{ ...styles.scene, opacity: exit }}>
      {imageSrc ? (
        <div style={styles.imageFrame}>
          <Img src={staticFile(imageSrc)} style={styles.image} />
          <div style={styles.imageShade} />
        </div>
      ) : (
        <div style={styles.evidencePanel}>
          <div style={styles.evidenceRail} />
          <span style={styles.stepNumber}>{String(index + 1).padStart(2, "0")}</span>
          <span style={styles.evidenceType}>{platform === "xiaohongshu" ? "可收藏证据卡" : "实战证据"}</span>
        </div>
      )}
      <div
        style={{
          ...styles.sceneCopy,
          opacity: enter,
          transform: `translateY(${translateY}px) scale(${scale})`,
        }}
      >
        <p style={styles.kicker}>{scene.evidenceRef || "REAL OBSERVATION"}</p>
        <h1 style={styles.headline}>{scene.headline}</h1>
        <p style={styles.body}>{scene.body}</p>
      </div>
    </AbsoluteFill>
  );
};

const Caption: FC<{ text: string; startFrame: number }> = ({ text, startFrame }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame - startFrame, [0, 5], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div style={{ ...styles.captionSafeArea, opacity }}>
      <div style={styles.caption}>{text}</div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  canvas: {
    background: "#08110f",
    color: "#f4fbf8",
    fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
    overflow: "hidden",
  },
  grid: {
    position: "absolute",
    inset: 0,
    opacity: 0.16,
    backgroundImage:
      "linear-gradient(rgba(124,255,198,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(124,255,198,.08) 1px, transparent 1px)",
    backgroundSize: "72px 72px",
  },
  glowTop: {
    position: "absolute",
    width: 1200,
    height: 900,
    top: -570,
    right: -380,
    borderRadius: "50%",
    background: "radial-gradient(circle, rgba(37,184,135,.33), rgba(37,184,135,0) 70%)",
  },
  glowBottom: {
    position: "absolute",
    width: 1050,
    height: 850,
    bottom: -520,
    left: -410,
    borderRadius: "50%",
    background: "radial-gradient(circle, rgba(64,125,255,.20), rgba(64,125,255,0) 70%)",
  },
  brand: {
    position: "absolute",
    top: 92,
    left: 72,
    display: "flex",
    alignItems: "center",
    gap: 14,
    fontSize: 25,
    fontWeight: 720,
    letterSpacing: "0.05em",
  },
  brandDot: { width: 18, height: 18, borderRadius: "50%", background: "#55e6ad", boxShadow: "0 0 28px rgba(85,230,173,.75)" },
  series: { position: "absolute", top: 90, right: 72, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5, fontSize: 22 },
  scene: { padding: "215px 72px 360px", justifyContent: "space-between" },
  imageFrame: { position: "absolute", inset: "205px 46px 520px", overflow: "hidden", borderRadius: 42, border: "1px solid rgba(255,255,255,.14)" },
  image: { width: "100%", height: "100%", objectFit: "cover" },
  imageShade: { position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(8,17,15,.05), rgba(8,17,15,.82))" },
  evidencePanel: {
    position: "absolute",
    inset: "230px 72px 760px",
    borderRadius: 44,
    background: "linear-gradient(145deg, rgba(22,56,47,.9), rgba(11,25,22,.72))",
    border: "1px solid rgba(124,255,198,.16)",
    boxShadow: "0 36px 90px rgba(0,0,0,.34)",
  },
  evidenceRail: { position: "absolute", left: 54, top: 54, bottom: 54, width: 8, borderRadius: 8, background: "#55e6ad" },
  stepNumber: { position: "absolute", right: 50, bottom: 20, fontSize: 210, fontWeight: 850, color: "rgba(255,255,255,.055)" },
  evidenceType: { position: "absolute", left: 94, top: 54, fontSize: 26, color: "#8af2c8", letterSpacing: "0.14em" },
  sceneCopy: { position: "relative", zIndex: 2, marginTop: "auto", padding: "0 12px 46px" },
  kicker: { margin: "0 0 24px", color: "#7de5bd", fontSize: 24, fontWeight: 720, letterSpacing: "0.08em" },
  headline: { margin: 0, maxWidth: 920, fontSize: 88, lineHeight: 1.08, letterSpacing: "-0.045em", fontWeight: 850 },
  body: { margin: "30px 0 0", maxWidth: 900, fontSize: 38, lineHeight: 1.5, color: "#c4d7d0" },
  captionSafeArea: { position: "absolute", left: 60, right: 60, bottom: 175, display: "flex", justifyContent: "center" },
  caption: {
    maxWidth: 960,
    padding: "17px 28px 20px",
    borderRadius: 18,
    background: "rgba(0,0,0,.78)",
    boxShadow: "0 10px 40px rgba(0,0,0,.25)",
    fontSize: 37,
    lineHeight: 1.42,
    fontWeight: 720,
    textAlign: "center",
    whiteSpace: "pre-wrap",
  },
  progressTrack: { position: "absolute", left: 60, right: 60, bottom: 105, height: 8, borderRadius: 8, background: "rgba(255,255,255,.12)", overflow: "hidden" },
  progress: { height: "100%", borderRadius: 8, background: "linear-gradient(90deg, #55e6ad, #4aa0ff)" },
  aiLabel: { position: "absolute", left: 60, bottom: 55, fontSize: 20, color: "rgba(230,245,239,.58)", letterSpacing: "0.04em" },
};
