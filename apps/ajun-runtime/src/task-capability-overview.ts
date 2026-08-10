import { capabilityTruthState } from './workflow/capability-truth.ts';

export function buildCapabilities({ governance, feishuChannel, worker, localAi, skillReadiness, runtimeHealth, tasks, approvals }: any) {
  const hasVerifiedTask = (...types: string[]) => tasks.some((task: any) => types.includes(task.taskType)
    && task.status === 'succeeded'
    && (task.artifactRefs || []).some((artifact: any) => artifact.validation?.exists === true && artifact.validation?.readable === true));
  const truth = ({ configured = true, live = true, verified = false, humanAccepted = false } = {}) => capabilityTruthState({
    declared:true,
    configured,
    live,
    verified,
    humanAccepted,
  });
  const capabilities: any[] = [
    { id:'task-coordination', name:'统一任务协调', status:tasks.length ? 'ready' : 'partial', detail:tasks.length ? '任务创建和路由已有真实记录；具体业务完成仍以 Workflow 验证为准。' : '任务协调已配置，但尚无真实业务记录。', truth:truth({ verified:tasks.length > 0 }) },
    { id:'agent-registry', name:'岗位注册表', status:'partial', detail:'岗位职责、任务类型和权限来自 Manifest；登记本身不代表岗位已通过业务验收。', truth:truth({ live:true, verified:false }) },
    { id:'approval-gate', name:'审批闸门', status:approvals.length ? 'ready' : 'partial', detail:approvals.length ? '审批闸门已有真实决定记录；自动能力决策与人工审批分别留痕。' : '审批闸门已配置，尚无当前真实决定证据。', truth:truth({ verified:approvals.length > 0 }) },
    { id:'content-public-web-fetch', name:'公开资料读取', status:hasVerifiedTask('report.public-material', 'research.intel-report', 'research.open-investigation') ? 'ready' : 'partial', detail:'公开网页、动态页面和 PDF 通过受控 Adapter 读取；真实可用性以研究 Workflow 产物为准。', truth:truth({ verified:hasVerifiedTask('report.public-material', 'research.intel-report', 'research.open-investigation') }) },
    { id:'authorized-content-read', name:'登录平台只读采集', status:'partial', detail:'通道已接入；每个平台、账号和数据范围仍需通过具体任务验证并完成真实只读验收。', truth:truth({ live:false, verified:false }) },
    { id:'governance', name:'Paperclip 治理投影', status:governance.status, detail:governance.status === 'ready' ? `本机 Paperclip 已连接（${governance.version || '未知版本'}）；连接不替代具体预算和审批验收。` : 'Paperclip 未连接；组织级请求必须等待治理恢复。', truth:truth({ configured:true, live:governance.status === 'ready', verified:approvals.some((item: any) => item.governanceMode === 'paperclip' && item.status !== 'pending') }) },
    { id:'feishu-channel', name:'飞书收发与员工入口', status:feishuChannel.status, detail:feishuChannel.detail, truth:truth({ live:feishuChannel.status === 'ready', verified:tasks.some((task: any) => task.source?.channel === 'feishu') }) },
    { id:'mac-worker', name:'Mac工作间安全接力', status:worker.status, detail:worker.detail, truth:truth({ live:['ready', 'local'].includes(worker.status), verified:tasks.some((task: any) => task.execution?.mode === 'mac_worker' && task.status === 'succeeded') }) },
    ...(localAi ? [{
      id:'local-ai',
      name:'本机 AI 全能力网关',
      status:localAi.status === 'healthy' ? 'ready' : localAi.status === 'degraded' ? 'partial' : 'unavailable',
      detail:String(localAi.safeMessage || '本机 AI 网关状态未知。').slice(0, 300),
      truth:capabilityTruthState({
        declared:true,
        configured:Array.isArray(localAi.capabilities) && localAi.capabilities.some((item: any) => item.configured),
        live:localAi.status === 'healthy' || localAi.status === 'degraded',
        verified:Array.isArray(localAi.capabilities) && localAi.capabilities.some((item: any) => item.e2eVerified),
        humanAccepted:false,
      }),
    }] : []),
    { id:'external-execution', name:'外部发布与写入', status:'planned', detail:'外部发布和其他写入动作尚未接入且故意关闭；登录型只读采集不等于已经开放写入。', truth:capabilityTruthState({ declared:false, configured:false, live:false, verified:false, humanAccepted:false }) },
  ];
  const presentationSkill = skillReadiness.find((item: any) => item.slug === 'open-kimi-ppt');
  if (presentationSkill) {
    const composeStatus = presentationSkill.modes?.compose?.status || presentationSkill.status;
    const exportStatus = presentationSkill.modes?.export?.status || presentationSkill.status;
    capabilities.push({
      id:'office-presentation',
      name:'小办演示文稿',
      status:composeStatus === 'ready' && exportStatus === 'ready'
        ? 'ready'
        : composeStatus === 'ready' ? 'partial' : 'unavailable',
      detail:[
        `PPTD ${composeStatus === 'ready' ? '可用' : `不可用（${composeStatus}）`}`,
        `PPTX ${exportStatus === 'ready' ? '可用' : `暂不可用（${exportStatus}）`}`,
        presentationSkill.recovery,
      ].filter(Boolean).join('；').slice(0, 500),
      truth:truth({
        configured:composeStatus === 'ready',
        live:composeStatus === 'ready',
        verified:hasVerifiedTask('office.presentation-package'),
      }),
    });
  }
  const wechatHealth = runtimeHealth['wechat-chat-retriever'];
  if (wechatHealth) capabilities.push({
    id:'wechat-private-read',
    name:'微信本机只读',
    status:wechatHealth.status === 'healthy' ? 'ready' : wechatHealth.status === 'degraded' ? 'partial' : 'unavailable',
    detail:wechatHealth.safeMessage,
    truth:truth({
      configured:true,
      live:['healthy', 'degraded'].includes(wechatHealth.status),
      verified:hasVerifiedTask('wechat.chat.retrieval'),
    }),
  });
  return Object.freeze(capabilities);
}
