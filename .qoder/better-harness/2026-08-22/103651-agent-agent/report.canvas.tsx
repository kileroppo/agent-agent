import { useState } from "react";

const SCORE = 72;
const DIMENSIONS = [
  { label: "规则清晰度", value: 88 },
  { label: "领域建模", value: 92 },
  { label: "跨Harness一致性", value: 55 },
  { label: "自动生成质量", value: 35 },
  { label: "安全对齐", value: 78 },
  { label: "CI门禁覆盖", value: 70 },
  { label: "参考集就绪", value: 0 },
];

const STRENGTHS = [
  { id: "S1", title: "四层入口职责清晰", detail: "AGENTS.md → CLAUDE.md → CONTEXT.md → README.md 优先级明确，冲突时按此排序" },
  { id: "S2", title: "领域语言精确度极高", detail: "CONTEXT.md 25+ 概念各配 Avoid 反模式，防止语义漂移" },
  { id: "S3", title: "Manifest Schema 治理深度", detail: "20+ 必填字段含 autonomyBudgetPolicy 和 dynamicCapabilityPolicy" },
  { id: "S4", title: "能力真相五层模型", detail: "已声明→已配置→运行可达→任务实证→人工验收，禁止前层冒充后层" },
  { id: "S5", title: "文档治理闭环", detail: "6态流转 + 4道硬门禁 + 唯一事实来源表 + 交接文档闭环" },
  { id: "S6", title: "安全边界硬约束", detail: "secret/token 不得进入代码、文档、Prompt、日志或测试快照" },
  { id: "S7", title: "诊断入口分层设计", detail: "每项标注 truthLayerCeiling，退出码区分三种判定结果" },
];

const ISSUES = [
  { id: "I1", severity: "high", title: "SKILL.md 与实际代码严重不符", detail: "import风格/测试框架/文件后缀三项全错。声称 mixed require+import，实际 TypeScript+ESM；建议 Mocha/Jest，实际 node --test", effort: "low" },
  { id: "I2", severity: "medium", title: "Instincts 基于 6 commits 置信度虚高", detail: "484行，confidence 0.85-0.95，但样本仅 6 commits；部分条目与 SKILL.md 重复", effort: "low" },
  { id: "I3", severity: "medium", title: "Reference Set 全部为零", detail: "7项参考集全部 missing，无法检测 harness 自身回归", effort: "medium" },
  { id: "I4", severity: "high", title: "Codex 安全模式与项目原则矛盾", detail: "sandbox_mode=danger-full-access + approval_policy=never 违反 AGENTS.md 安全规则", effort: "low" },
  { id: "I5", severity: "medium", title: "跨 Harness 配置不对等", detail: "Claude 有 114行操作手册+133行领域语言；Codex 只有 28行指针", effort: "medium" },
  { id: "I6", severity: "high", title: "Hermes 补丁存活性无自动检测", detail: "升级覆盖 adapter.py 后 Gateway 照常启动，飞书链路静默失败", effort: "medium" },
  { id: "I7", severity: "high", title: "双白名单无单一真相", detail: "军团侧允许、网关侧拒绝；同步是单向一次性拷贝，无漂移检测", effort: "medium" },
  { id: "I8", severity: "medium", title: "CI 缺少 test:affected 和脚本校验", detail: "CI 只跑 check+test:core，缺少按变更触达的包级回归和 scripts 测试", effort: "low" },
  { id: "I9", severity: "low", title: "Workflow commands 未利用领域知识", detail: "3个 command 各 36-42 行通用 scaffold，未注入 schema/模板/ADR 约束", effort: "low" },
  { id: "I10", severity: "medium", title: "478行 bugfix spec 暴露诊断覆盖不足", detail: "4轮证伪才定位根因；诊断最初只覆盖1条路径，漏掉原生会话/MCP/白名单", effort: "medium" },
];

const TOPOLOGY = [
  { harness: "Claude Code", rules: "AGENTS.md + CLAUDE.md + CONTEXT.md", skills: "1 SKILL + 3 Commands + Instincts", extra: "identity.json + ecc-tools.json" },
  { harness: "Codex", rules: ".codex/AGENTS.md", skills: "1 SKILL (mirror)", extra: "config.toml + 3 agent TOMLs" },
  { harness: "Kiro", rules: "—", skills: "—", extra: ".kiro/specs/ (bugfix design)" },
  { harness: "Serena", rules: "—", skills: "—", extra: "project.yml + memories/" },
];

const ACTIONS = [
  { order: 1, label: "重生成/标记 SKILL.md 过时", effort: "low", rationale: "最高风险误导源" },
  { order: 2, label: "对齐 Codex 安全配置", effort: "low", rationale: "直接违反安全原则" },
  { order: 3, label: "同步 CONTEXT.md 到 Codex", effort: "medium", rationale: "消除跨 harness 行为不一致" },
  { order: 4, label: "Hermes 补丁在位校验", effort: "medium", rationale: "消除升级后静默失败" },
  { order: 5, label: "白名单单一真相", effort: "medium", rationale: "消除不可归因静默失败" },
  { order: 6, label: "扩展 CI 覆盖", effort: "low", rationale: "减少本地验证盲区" },
];

const UNIQUE_PRACTICES = [
  "能力真相五层模型", "CONTEXT.md Avoid 反模式", "Agent Manifest JSON Schema",
  "autonomyBudgetPolicy", "dynamicCapabilityPolicy", "文档6态流转+4道硬门禁",
  "truthLayerCeiling 诊断分层", "不可变release双端口分离", "复用优先写入协作规则",
];

const sevColor = (s: string) => s === "high" ? "#ef4444" : s === "medium" ? "#f59e0b" : "#6b7280";
const effortBg = (e: string) => e === "low" ? "rgba(34,197,94,0.15)" : "rgba(245,158,11,0.15)";

function ScoreRing({ score, size = 120 }: { score: number; size?: number }) {
  const r = (size - 12) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (score / 100) * c;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#1e293b" strokeWidth={8} />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={score >= 80 ? "#22c55e" : score >= 60 ? "#f59e0b" : "#ef4444"} strokeWidth={8} strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round" transform={`rotate(-90 ${size/2} ${size/2})`} />
      <text x={size/2} y={size/2 + 6} textAnchor="middle" fill="#f1f5f9" fontSize={28} fontWeight={700}>{score}</text>
    </svg>
  );
}

function BarChart({ data }: { data: typeof DIMENSIONS }) {
  const maxW = 180;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {data.map((d) => (
        <div key={d.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 110, fontSize: 11, color: "#94a3b8", textAlign: "right", flexShrink: 0 }}>{d.label}</span>
          <div style={{ width: maxW, height: 14, background: "#1e293b", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: `${d.value}%`, height: "100%", background: d.value >= 80 ? "#22c55e" : d.value >= 50 ? "#f59e0b" : "#ef4444", borderRadius: 3, transition: "width 0.6s ease" }} />
          </div>
          <span style={{ width: 28, fontSize: 11, color: "#e2e8f0", fontWeight: 600 }}>{d.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function HarnessReport() {
  const [tab, setTab] = useState<"overview" | "issues" | "actions">("overview");

  return (
    <div style={{ minHeight: "100vh", background: "#0b1120", color: "#e2e8f0", fontFamily: "'Inter', system-ui, sans-serif", padding: 24 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 24, borderBottom: "1px solid #1e293b", paddingBottom: 20 }}>
        <ScoreRing score={SCORE} />
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#f1f5f9" }}>Agent军团 Harness 分析</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#64748b" }}>agent-agent · 2026-08-22 · 综合评分 {SCORE}/100</p>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            {UNIQUE_PRACTICES.slice(0, 4).map((p) => (
              <span key={p} style={{ fontSize: 10, padding: "2px 8px", background: "rgba(99,102,241,0.15)", color: "#818cf8", borderRadius: 10 }}>{p}</span>
            ))}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20 }}>
        {(["overview", "issues", "actions"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{ padding: "6px 16px", fontSize: 12, fontWeight: tab === t ? 600 : 400, background: tab === t ? "#1e293b" : "transparent", color: tab === t ? "#f1f5f9" : "#64748b", border: "1px solid " + (tab === t ? "#334155" : "transparent"), borderRadius: 6, cursor: "pointer", textTransform: "capitalize" }}>{t === "overview" ? "总览" : t === "issues" ? `问题 (${ISSUES.length})` : `行动 (${ACTIONS.length})`}</button>
        ))}
      </div>

      {/* Overview Tab */}
      {tab === "overview" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {/* Score Breakdown */}
          <div style={{ background: "#111827", borderRadius: 10, padding: 16, border: "1px solid #1e293b" }}>
            <h3 style={{ margin: "0 0 12px", fontSize: 13, color: "#94a3b8", fontWeight: 600 }}>维度评分</h3>
            <BarChart data={DIMENSIONS} />
          </div>

          {/* Topology */}
          <div style={{ background: "#111827", borderRadius: 10, padding: 16, border: "1px solid #1e293b" }}>
            <h3 style={{ margin: "0 0 12px", fontSize: 13, color: "#94a3b8", fontWeight: 600 }}>Harness 拓扑</h3>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #1e293b" }}>
                  {["Harness", "规则文件", "Skills", "独有配置"].map((h) => (
                    <th key={h} style={{ padding: "4px 6px", textAlign: "left", color: "#64748b", fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {TOPOLOGY.map((row) => (
                  <tr key={row.harness} style={{ borderBottom: "1px solid #0f172a" }}>
                    <td style={{ padding: "4px 6px", color: "#818cf8", fontWeight: 500 }}>{row.harness}</td>
                    <td style={{ padding: "4px 6px", color: "#cbd5e1" }}>{row.rules}</td>
                    <td style={{ padding: "4px 6px", color: "#cbd5e1" }}>{row.skills}</td>
                    <td style={{ padding: "4px 6px", color: "#94a3b8" }}>{row.extra}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Strengths */}
          <div style={{ gridColumn: "1 / -1", background: "#111827", borderRadius: 10, padding: 16, border: "1px solid #1e293b" }}>
            <h3 style={{ margin: "0 0 12px", fontSize: 13, color: "#94a3b8", fontWeight: 600 }}>核心优势 ({STRENGTHS.length})</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {STRENGTHS.map((s) => (
                <div key={s.id} style={{ padding: 10, background: "#0f172a", borderRadius: 8, borderLeft: "3px solid #22c55e" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    <span style={{ fontSize: 10, color: "#22c55e", fontWeight: 700 }}>{s.id}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "#f1f5f9" }}>{s.title}</span>
                  </div>
                  <p style={{ margin: 0, fontSize: 11, color: "#94a3b8", lineHeight: 1.5 }}>{s.detail}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Unique Practices */}
          <div style={{ gridColumn: "1 / -1", background: "#111827", borderRadius: 10, padding: 16, border: "1px solid #1e293b" }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 13, color: "#94a3b8", fontWeight: 600 }}>项目独有实践</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {UNIQUE_PRACTICES.map((p) => (
                <span key={p} style={{ fontSize: 11, padding: "4px 10px", background: "rgba(99,102,241,0.12)", color: "#a5b4fc", borderRadius: 12, border: "1px solid rgba(99,102,241,0.2)" }}>{p}</span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Issues Tab */}
      {tab === "issues" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {ISSUES.map((issue) => (
            <div key={issue.id} style={{ background: "#111827", borderRadius: 10, padding: 14, border: "1px solid #1e293b", borderLeft: `3px solid ${sevColor(issue.severity)}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: sevColor(issue.severity), background: `${sevColor(issue.severity)}18`, padding: "2px 6px", borderRadius: 4 }}>{issue.severity.toUpperCase()}</span>
                <span style={{ fontSize: 10, color: "#64748b" }}>{issue.id}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#f1f5f9" }}>{issue.title}</span>
                <span style={{ marginLeft: "auto", fontSize: 10, padding: "2px 8px", background: effortBg(issue.effort), color: issue.effort === "low" ? "#22c55e" : "#f59e0b", borderRadius: 8 }}>{issue.effort} effort</span>
              </div>
              <p style={{ margin: 0, fontSize: 11, color: "#94a3b8", lineHeight: 1.6 }}>{issue.detail}</p>
            </div>
          ))}
        </div>
      )}

      {/* Actions Tab */}
      {tab === "actions" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {ACTIONS.map((a) => (
            <div key={a.order} style={{ background: "#111827", borderRadius: 10, padding: 14, border: "1px solid #1e293b", display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#1e293b", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: "#818cf8", flexShrink: 0 }}>{a.order}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#f1f5f9", marginBottom: 2 }}>{a.label}</div>
                <div style={{ fontSize: 11, color: "#94a3b8" }}>{a.rationale}</div>
              </div>
              <span style={{ fontSize: 10, padding: "2px 8px", background: effortBg(a.effort), color: a.effort === "low" ? "#22c55e" : "#f59e0b", borderRadius: 8, flexShrink: 0 }}>{a.effort}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
