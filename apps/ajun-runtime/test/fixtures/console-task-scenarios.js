const CREATED_AT = '2026-08-08T08:00:00.000Z';

export function buildConsoleTaskScenarioState() {
  const task = ({ sequence, status, title, ...overrides }) => ({
    schemaVersion:'agent.army/task/v1',
    taskId:`10000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    taskType:'report.public-material',
    status,
    currentStage:`fixture_${status}`,
    assigneeAgentId:'reviewer',
    requester:{ kind:'feishu-user', ref:'fixture-owner' },
    source:{ channel:'feishu', chatRef:'fixture-chat' },
    input:{ title, description:'控制台只读验收夹具。' },
    approvalRefs:[],
    artifactRefs:[],
    createdAt:CREATED_AT,
    updatedAt:`2026-08-08T08:0${sequence}:00.000Z`,
    ...overrides,
  });
  const approvalId = '20000000-0000-4000-8000-000000000001';
  const waitingApproval = task({
    sequence:4,
    status:'waiting_approval',
    title:'确认只读检查范围',
    approvalRefs:[approvalId],
  });

  return {
    tasks:[
      task({
        sequence:1,
        status:'failed',
        title:'核对平台登录状态',
        error:{
          code:'paperclip_hermes_reported_failure',
          message:'登录授权缺少可用的 Chrome 会话，本轮无法完成只读验证。',
          userMessage:'员工已如实回报任务失败，请查看结果摘要和剩余风险。',
          category:'manual',
          stage:'paperclip_hermes',
          retryable:false,
          occurredAt:'2026-08-08T08:01:00.000Z',
        },
        artifactRefs:[{
          taskId:'10000000-0000-4000-8000-000000000001',
          type:'employee_role_report',
          data:{
            agentId:'reviewer',
            summary:'登录授权缺少可用的 Chrome 会话，本轮无法完成只读验证。',
            evidence:'账号列表返回 0 个可用会话。',
            remainingRisks:'尚未验证小红书账号的真实读取能力。',
          },
          validation:{ exists:true, readable:true, nonEmpty:true, checkedAt:'2026-08-08T08:01:00.000Z' },
        }],
      }),
      task({
        sequence:2,
        status:'needs_input',
        title:'整理本周工作汇报',
        error:{ code:'source_missing', userMessage:'请补充本周工作记录或文档链接。' },
      }),
      task({
        sequence:3,
        status:'waiting_test',
        title:'核对修复后的飞书提醒',
        error:{ code:'verification_pending', userMessage:'修复结果已保留，等待隔离消息回归。' },
        artifactRefs:[{
          type:'technical_repair_evidence',
          data:{ nextAction:'在隔离会话完成一次收发检查。' },
          validation:{ exists:true, readable:true, nonEmpty:true },
        }],
      }),
      waitingApproval,
      task({
        sequence:5,
        status:'succeeded',
        title:'整理公开资料摘要',
        updatedAt:'2026-08-08T07:59:00.000Z',
        artifactRefs:[{
          type:'public_web_report',
          data:{ summary:'公开资料已整理为三条可核对结论。' },
          validation:{ exists:true, readable:true, nonEmpty:true },
        }],
      }),
    ],
    approvals:[{
      schemaVersion:'agent.army/approval/v1',
      approvalId,
      taskId:waitingApproval.taskId,
      status:'pending',
      action:'confirm-read-only-scope',
      reason:'需要确认只读检查仅覆盖指定公开页面。',
      requestedScope:{ mode:'read_only', targets:['公开页面'] },
      createdAt:'2026-08-08T08:04:00.000Z',
      updatedAt:'2026-08-08T08:04:00.000Z',
    }],
    proposals:[],
    testInstances:[],
    conversationContexts:{},
  };
}
