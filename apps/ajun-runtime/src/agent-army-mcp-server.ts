import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AgentArmyClient, AgentArmyClientError } from './agent-army-client.ts';
import { LocalAiCapabilityClient } from './local-ai-capability-client.ts';
import { AgentRegistry } from './agent-registry.ts';
import { AgentManualService } from './agent-manual-service.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { missionClientInputFromTool, missionCreateToolInputSchema, taskClientInputFromTool, taskCreateToolInputSchema, } from './contracts/agent-army-task-input.ts';
import { projectMcpToolValue } from './contracts/agent-army-adapter-projection.ts';
import { PAPERCLIP_COMPLETION_TASK_STATUSES } from './task-status-policy.ts';
const repositoryRoot: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export function createAgentArmyMcpServer({ client = new AgentArmyClient(), localAi = new LocalAiCapabilityClient(), manuals = new AgentManualService({ registry: new AgentRegistry({ agentsDir: path.join(repositoryRoot, 'agents') }) }), scope = scopeFromEnvironment() }: any = {}): any {
    const server: any = new McpServer({
        name: 'agent-army',
        version: '0.1.0'
    });
    const read: any = (name: any, config: any, handler: any): any => {
        if (toolAllowed(name, scope))
            readTool(server, name, config, handler);
    };
    const action: any = (name: any, config: any, handler: any): any => {
        if (toolAllowed(name, scope))
            actionTool(server, name, config, handler);
    };
    read('capabilities', {
        title: 'Agent军团能力真相',
        description: '列出岗位登记、可接受任务类型，以及能力从已声明到真实任务验证的分层状态。回答“你能做什么”“谁能做这件事”前先调用；不得把已登记或在线冒充已验证。',
        inputSchema: z.object({})
    }, async (): Promise<any> => scopedCapabilities(await client.capabilities(), scope));
    read('agent_manual', {
        title: 'Agent使用说明书',
        description: '用户问“这个 Agent 是什么、怎么用、输入输出、用了什么工具、注意事项、说明书”时必须调用。A君可按名称查询任一已上岗 Agent，传 all 可返回全部说明书；其他 Agent 只能查询自己的说明书。这是只读查询，禁止为说明书问题创建任务。',
        inputSchema: z.object({
            agent: z.string().min(1).max(80).optional().describe('Agent 名称、agentId，或 all。当前 Agent 查询自己时可省略。')
        })
    }, ({ agent }: any): any => manuals.get({ agent, requesterAgentIds: scope.agentIds }));
    read('status', {
        title: 'Agent军团总览',
        description: '读取员工、任务焦点、今日使用和公共能力的当前真实状态。用于“大家在干嘛”“军团是否正常”；不会创建任务。',
        inputSchema: z.object({})
    }, (): any => client.armyStatus());
    read('employee_status', {
        title: '员工状态',
        description: '按员工名称或 agentId 读取岗位边界和最近真实任务。用于“小D在干嘛”等问题；不会创建任务。',
        inputSchema: z.object({
            employee: z.string().min(1).max(80).describe('员工显示名或 agentId，例如 小D、operator、架构师')
        })
    }, ({ employee }: any): any => client.employeeStatus(employee));
    read('task_list', {
        title: '任务列表',
        description: '读取最近任务，可按状态和员工筛选。只返回脱敏任务摘要；不会创建或改变任务。',
        inputSchema: z.object({
            status: z.union([z.string(), z.array(z.string())]).optional().describe('可选状态，例如 running 或 running,waiting_approval'),
            employee: z.string().max(80).optional().describe('可选员工名称或 agentId'),
            limit: z.number().int().min(1).max(50).optional().default(10)
        })
    }, (input: any): any => client.listTasks(scopedTaskFilter(input, scope)));
    read('task_get', {
        title: '读取任务',
        description: '按任务编号读取真实阶段、审批、失败和已验证产物。用户追问“刚才那个任务”时优先使用会话中已经出现的任务编号。',
        inputSchema: z.object({
            task_id: z.string().min(8).max(100),
            chat_ref: z.string().max(240).optional().describe('当前 Hermes 会话上下文中可见的原飞书 chat id；没有时省略')
        })
    }, async ({ task_id, chat_ref }: any): Promise<any> => {
        const task: any = await client.getTask(task_id, { chatRef: chat_ref });
        assertReadableTask(task, scope);
        return task;
    });
    action('task_create', {
        title: '创建军团任务',
        description: '把用户明确要求执行的工作交给已上岗员工。状态查询、能力询问、闲聊和仅讨论方案时禁止调用。先用 capabilities 确认 task_type 和员工；高风险工作只会进入审批，不会绕过审批执行。',
        inputSchema: taskCreateToolInputSchema,
    }, (input: any): any => client.createTask(taskClientInputFromTool(input, scope)));
    action('mission_create', {
        title: '创建老板多人任务',
        description: '当用户一次明确交办多项可并行或存在依赖的工作时，建立一个总任务并分派给最多 11 名已上岗员工。系统按显式依赖图推进且同时运行不超过 4 项；单项工作仍用 task_create。',
        inputSchema: missionCreateToolInputSchema,
    }, (input: any): any => client.createMission(missionClientInputFromTool(input, scope)));
    action('task_control', {
        title: '暂停或继续任务',
        description: '请求暂停或继续一条支持控制的真实任务。该调用只创建/返回审批，不会绕过 Paperclip；随后使用 approval_resolve 由用户确认。',
        inputSchema: z.object({
            task_id: z.string().min(8).max(100),
            action: z.enum(['pause', 'resume'])
        })
    }, ({ task_id, action }: any): any => client.controlTask(task_id, action));
    action('task_feedback', {
        title: '记录任务结果评价',
        description: '负责人对刚完成的任务明确表示“有用、验收通过”或“需要改进”时必须调用。先用 task_get 核对任务编号；只能在原飞书会话写回评价，不会创建任务或执行外部动作。',
        inputSchema: z.object({
            task_id: z.string().min(8).max(100),
            sentiment: z.enum(['useful', 'needs_improvement']),
            note: z.string().max(1000).optional(),
            chat_ref: z.string().min(1).max(240).describe('当前 Hermes 会话可见的原飞书 chat id，必须与任务来源一致'),
        }),
    }, ({ task_id, sentiment, note, chat_ref }: any): any => client.recordTaskFeedback(task_id, {
        sentiment,
        note,
        chatRef: chat_ref,
    }));
    if (scope.allowedTools?.includes('local_ai_invoke') && scope.localAiCapabilities?.length)
        action('local_ai_invoke', {
            title: '调用岗位获准的本机 AI 能力',
            description: '按能力名调用 A君统一管理的本机模型。服务未运行时由控制网关按需唤醒；只能使用当前岗位 Manifest 已授权的能力。不得猜测文件路径，不得自行跨设备或绕过审批。',
            inputSchema: z.object({
                capability: z.string().min(1).max(80).describe('必须是当前岗位获准的本机能力名'),
                input: z.record(z.unknown()).describe('能力输入；文件路径必须来自当前真实指派或已验证产物'),
                options: z.record(z.unknown()).optional().default({}),
                request_id: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/).optional(),
            }),
        }, async ({ capability, input, options, request_id }: any): Promise<any> => {
            if (!scope.localAiCapabilities.includes(capability)) {
                throw new AgentArmyClientError(`当前岗位没有本机 AI 能力 ${capability}。`);
            }
            const identity: any = paperclipIdentityFromEnvironment();
            const verified: any = await client.getPaperclipAssignment(identity);
            const taskId: any = String(verified?.task?.taskId || '').trim();
            if (!taskId)
                throw new AgentArmyClientError('当前 Paperclip 指派没有关联真实 A君任务，拒绝调用本机 AI。');
            const safeOptions: Record<string, any> = { ...options, preferredNode: 'mac' };
            delete safeOptions.allowDesktopFallback;
            const spanId: any = crypto.randomUUID();
            const startedAt: any = new Date().toISOString();
            const record: any = (event: any): any => client.recordPaperclipLocalAiRunEvent({
                ...identity,
                taskId,
                event: { capabilityId: capability, spanId, startedAt, ...event },
            }).catch((): any => null);
            await record({
                eventType: 'capability_call_started',
                provider: 'local-ai',
                status: 'running',
            });
            try {
                const result: any = await localAi.invoke({
                    capability,
                    input,
                    options: safeOptions,
                    requestId: request_id,
                    approved: false,
                });
                const finishedAt: any = new Date().toISOString();
                await record({
                    eventType: 'capability_call_succeeded',
                    provider: String(result?.provider || 'local-ai').slice(0, 120),
                    status: 'success',
                    finishedAt,
                    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
                    receiptId: String(result?.requestId || '').slice(0, 160),
                });
                return result;
            }
            catch (error: any) {
                const finishedAt: any = new Date().toISOString();
                const ambiguous: any = error?.code === 'local_ai_gateway_unavailable';
                await record({
                    eventType: ambiguous ? 'capability_result_ambiguous' : 'capability_call_failed',
                    provider: 'local-ai',
                    status: ambiguous ? 'ambiguous' : 'failed',
                    finishedAt,
                    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
                    errorCode: String(error?.code || 'local_ai_failed').slice(0, 120),
                });
                throw error;
            }
        });
    read('approval_list', {
        title: '审批列表',
        description: '读取待处理或历史审批的脱敏摘要。不会自动批准。',
        inputSchema: z.object({
            status: z.enum(['pending', 'approved', 'rejected', 'expired', 'all']).optional().default('pending'),
            limit: z.number().int().min(1).max(50).optional().default(10)
        })
    }, (input: any): any => client.listApprovals(input));
    if (toolAllowed('approval_resolve', scope))
        server.registerTool('approval_resolve', {
            title: '处理军团审批',
            description: '批准或拒绝一条明确审批。批准会通过 Hermes 当前会话再次向真人确认；明确拒绝直接安全关闭。批准未确认、超时或会话离开时一律不执行。',
            inputSchema: z.object({
                approval_id: z.string().min(8).max(100),
                decision: z.enum(['approve', 'reject'])
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        }, async ({ approval_id, decision }: any, extra: any): Promise<any> => toolResult(async (): Promise<any> => {
            const pending: any = (await client.listApprovals({ status: 'pending', limit: 50 })).find((approval: any): any => approval.approvalId === approval_id);
            if (!pending)
                throw new AgentArmyClientError('这条审批不存在、已处理或已过期。');
            if (decision === 'reject')
                return client.resolveApproval(approval_id, decision);
            const verb: any = '批准并按该范围继续';
            const consent: any = await server.server.elicitInput({
                mode: 'form',
                message: `请确认是否${verb}：${pending.reason || pending.requestedScope?.title || pending.approvalId}`,
                requestedSchema: {
                    type: 'object',
                    properties: {
                        confirm: { type: 'boolean', title: '确认本次决定', description: `勾选后${verb}` }
                    }
                }
            }, { relatedRequestId: extra.requestId, timeout: 300000 });
            // Hermes currently reports an accepted elicitation with an empty content
            // object. The action is the authoritative consent signal; an explicit
            // false value still wins for clients that return the optional field.
            if (consent.action !== 'accept' || consent.content?.confirm === false) {
                throw new AgentArmyClientError('真人没有确认，本次审批未执行。');
            }
            return client.resolveApproval(approval_id, decision);
        }));
    action('private_read_grant_revoke', {
        title: '撤销微信临时读取授权',
        description: '立即撤销一条仍有效的微信临时读取授权。只能从创建该任务的原飞书会话调用；这是收紧权限，不会读取微信或创建新授权。',
        inputSchema: z.object({
            approval_id: z.string().min(8).max(100),
            chat_ref: z.string().min(1).max(240).describe('当前 Hermes 会话可见的原飞书 chat id，必须与任务来源一致')
        })
    }, ({ approval_id, chat_ref }: any): any => client.revokePrivateReadGrant(approval_id, { chatRef: chat_ref }));
    read('paperclip_assignment_get', {
        title: '读取当前 Paperclip 指派',
        description: '每次 Paperclip heartbeat 只调用一次。读取当前运行的真实指派，并在 A君任务账本建立或关联同一任务信封；返回内容已经足够完成任务，不要重复读取。普通飞书会话没有运行身份时禁止调用。',
        inputSchema: z.object({})
    }, (): any => client.getPaperclipAssignment(paperclipIdentityFromEnvironment()));
    action('agent_proposal_create_execute', {
        title: '创建并提交当前岗位草案',
        description: '仅供创建官在 Paperclip heartbeat 中使用。把当前自然语言岗位需求写成结构化 AgentProposal 并提交审核；只允许已登记能力，敏感能力会停在待建设/待专项审批，不会自动安装、试用或激活。',
        inputSchema: z.object({
            requested_outcome: z.string().min(1).max(500),
            candidate_name: z.string().min(1).max(120),
            agent_id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
            department: z.string().min(1).max(120),
            responsibilities: z.array(z.string().min(1).max(500)).min(1).max(8),
            non_responsibilities: z.array(z.string().min(1).max(500)).min(1).max(10),
            accepted_task_types: z.array(z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/).max(120)).min(1).max(8),
            desired_skills: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120)).max(8).optional(),
            requested_capabilities: z.array(z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/).max(120)).max(8).optional(),
            acceptance_title: z.string().min(1).max(500)
        })
    }, ({ requested_outcome, candidate_name, agent_id, department, responsibilities, non_responsibilities, accepted_task_types, desired_skills, requested_capabilities, acceptance_title }: any): any => client.executeAgentProposal({
        ...paperclipIdentityFromEnvironment(),
        requestedOutcome: requested_outcome,
        candidateName: candidate_name,
        agentId: agent_id,
        department,
        responsibilities,
        nonResponsibilities: non_responsibilities,
        acceptedTaskTypes: accepted_task_types,
        desiredSkills: desired_skills,
        requestedCapabilities: requested_capabilities,
        acceptanceTitle: acceptance_title
    }));
    action('paperclip_assignment_complete', {
        title: '回报当前 Paperclip 指派结果',
        description: '仅在 Paperclip heartbeat 中把当前指派的真实结果回写到同一张 Paperclip 任务和 A君任务信封。不得用它关闭别人的任务；失败或待测试必须如实选择对应状态。M5 恢复时只回显受控执行器实际消费的 consumed_revision_id，路线是否改变由执行器回执决定，不能由模型声明。架构师使用 fact_claims、architecture_judgments、candidate_proposals 分开回报事实、推理和未来方案；只有当前事实与判断所引用的 basis_refs 必须来自 groundTruth，候选方案可以提出当前不存在的能力，但必须附验证计划。',
        inputSchema: z.object({
            status: z.enum(PAPERCLIP_COMPLETION_TASK_STATUSES).default('succeeded'),
            summary: z.string().min(1).max(4000),
            evidence: z.string().max(4000).optional(),
            remaining_risks: z.string().max(2000).optional(),
            quality_review: z.object({
                status: z.enum(['passed', 'revise', 'blocked']),
                failed_criteria: z.array(z.string().min(1).max(100)).max(100).optional(),
                evidence_refs: z.array(z.string().min(1).max(240)).max(100).optional(),
                safe_summary: z.string().max(1000).optional(),
            }).optional(),
            evidence_refs: z.array(z.object({
                ref: z.string().min(1).max(500),
                claim: z.string().min(1).max(1000)
            })).max(30).optional(),
            unverified_claims: z.array(z.string().min(1).max(1000)).max(20).optional(),
            fact_claims: z.array(z.object({
                claim: z.string().min(1).max(1000),
                evidence_refs: z.array(z.string().min(1).max(500)).min(1).max(10)
            })).max(20).optional(),
            architecture_judgments: z.array(z.object({
                judgment: z.string().min(1).max(1200),
                basis_refs: z.array(z.string().min(1).max(500)).max(10).optional(),
                assumptions: z.array(z.string().min(1).max(600)).max(10).optional(),
                confidence: z.enum(['low', 'medium', 'high'])
            })).max(20).optional(),
            candidate_proposals: z.array(z.object({
                proposal: z.string().min(1).max(1200),
                problem: z.string().min(1).max(1000),
                validation_plan: z.string().min(1).max(1500),
                risks: z.array(z.string().min(1).max(600)).max(10).optional(),
                non_goals: z.array(z.string().min(1).max(600)).max(10).optional()
            })).max(10).optional(),
            current_state_unknowns: z.array(z.string().min(1).max(1000)).max(20).optional(),
            consumed_revision_id: z.string().min(1).max(240).optional()
        })
    }, ({ status, summary, evidence, remaining_risks, evidence_refs, unverified_claims, fact_claims, architecture_judgments, candidate_proposals, current_state_unknowns, consumed_revision_id, quality_review }: any): any => client.completePaperclipAssignment({
        ...paperclipIdentityFromEnvironment(),
        status,
        summary,
        evidence,
        remainingRisks: remaining_risks,
        qualityReview: quality_review ? {
            status: quality_review.status,
            failedCriteria: quality_review.failed_criteria || [],
            evidenceRefs: quality_review.evidence_refs || [],
            safeSummary: quality_review.safe_summary || null,
        } : undefined,
        evidenceRefs: evidence_refs,
        unverifiedClaims: unverified_claims,
        factClaims: fact_claims,
        architectureJudgments: architecture_judgments,
        candidateProposals: candidate_proposals,
        currentStateUnknowns: current_state_unknowns,
        consumedRevisionId: consumed_revision_id
    }));
    action('technical_repair_execute', {
        title: '执行当前受控技术修复',
        description: '仅供技术专家在 Paperclip heartbeat 中使用。读取当前指派预先批准的修复范围，委派给 A君现有隔离 Codex 修复执行器，并返回真实修改、测试与恢复检查证据。没有允许文件、测试命令或恢复检查时安全拒绝。',
        inputSchema: z.object({})
    }, (): any => client.executeTechnicalRepair(paperclipIdentityFromEnvironment()));
    action('operations_health_execute', {
        title: '执行当前确定性健康检查',
        description: '仅供运维官在 Paperclip heartbeat 中使用。检查固定登记的本机进程、端口和健康接口并写回结构化报告；不接受 URL、命令、路径或任意终端输入，不执行重启和外部写入。',
        inputSchema: z.object({})
    }, (): any => client.executeOperationsHealth(paperclipIdentityFromEnvironment()));
    action('employee_assignment_execute', {
        title: '执行当前员工指派',
        description: '仅供 A君、小R、小D和小办在 Paperclip heartbeat 中使用。按当前已核验岗位和任务类型调用各自既有受控执行器；不能指定其他任务、岗位、路径、命令或外部动作。返回 running 时再次调用本工具续查。',
        inputSchema: z.object({})
    }, (): any => client.executeEmployeeAssignment(paperclipIdentityFromEnvironment()));
    action('video_content_analyze_execute', {
        title: '执行当前受控视频拆解',
        description: '仅供小拆在 Paperclip heartbeat 中使用。普通拆解读取任务明确引用的转录产物；M5 画面分析只读取已核验 AssetPackage，并输出每条判断都带 frameRef、timestamp、evidenceKind 的 VisualAnalysisPackage。不抓取、不登录、不发布。',
        inputSchema: z.object({})
    }, (): any => client.executeContentGrowth(paperclipIdentityFromEnvironment()));
    action('content_performance_review_execute', {
        title: '执行当前受控内容表现复盘',
        description: '仅供小拆在 Paperclip heartbeat 中使用。把真实指标关联到原分析和草稿版本；没有指标时安全拒绝。',
        inputSchema: z.object({})
    }, (): any => client.executeContentGrowth(paperclipIdentityFromEnvironment()));
    action('platform_content_draft_execute', {
        title: '执行当前受控平台草稿生成',
        description: '仅供小创在 Paperclip heartbeat 中使用。必须引用确认稿和正式分析，最多生成三个平台草稿；不会发布或访问账号。返回 running 时再次调用本工具继续等待。',
        inputSchema: z.object({})
    }, (): any => client.executeContentGrowth(paperclipIdentityFromEnvironment()));
    action('video_script_package_execute', {
        title: '执行当前受控可拍脚本生成',
        description: '仅供小创在 Paperclip heartbeat 中使用。自动匹配受控参考案例并生成一版可拍脚本和内部生产包；不会生成成片、发布或访问账号。',
        inputSchema: z.object({})
    }, (): any => client.executeContentGrowth(paperclipIdentityFromEnvironment()));
    action('m5_stage_execute', {
        title: '执行当前 M5 专用内容阶段',
        description: '仅供 M5 配音、渲染、机器审核和发布审批 Routine。调用方不能提交 toolId、Case、路径、平台、账号或预算；执行器从当前 Paperclip Issue/Run/Case 和唯一阶段契约派生固定插件工具与参数。前置 Work Product 缺失时安全拒绝。',
        inputSchema: z.object({}),
    }, (): any => client.executeM5Stage(paperclipIdentityFromEnvironment()));
    return server;
}
export async function runAgentArmyMcpServer(): Promise<any> {
    const server: any = createAgentArmyMcpServer();
    const transport: any = new StdioServerTransport();
    process.on('SIGINT', async (): Promise<any> => {
        await server.close();
        process.exit(0);
    });
    await server.connect(transport);
}
function readTool(server: any, name: any, config: any, handler: any): any {
    server.registerTool(name, {
        ...config,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async (input: any): Promise<any> => toolResult((): any => handler(input)));
}
function actionTool(server: any, name: any, config: any, handler: any): any {
    server.registerTool(name, {
        ...config,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async (input: any): Promise<any> => toolResult((): any => handler(input)));
}
async function toolResult(operation: any): Promise<any> {
    try {
        const value: any = await operation();
        return projectMcpToolValue(value);
    }
    catch (error: any) {
        return {
            content: [{ type: 'text', text: String(error?.message || 'Agent Army MCP 调用失败。').slice(0, 1000) }],
            isError: true
        };
    }
}
export function scopeFromEnvironment(): any {
    const agentIds: any = environmentList('AGENT_ARMY_ALLOWED_AGENT_IDS');
    const taskTypes: any = environmentList('AGENT_ARMY_ALLOWED_TASK_TYPES');
    const restricted: any = agentIds.length > 0 || taskTypes.length > 0;
    const configuredTools: any = environmentList('AGENT_ARMY_ALLOWED_MCP_TOOLS');
    const localAiCapabilities: any = environmentList('AGENT_ARMY_ALLOWED_LOCAL_AI_CAPABILITIES');
    const paperclipHeartbeat: any = [
        process.env.PAPERCLIP_TASK_ID,
        process.env.PAPERCLIP_RUN_ID,
        process.env.PAPERCLIP_AGENT_ID
    ].every(isUuid);
    const allowedTools: any = paperclipHeartbeat
        ? configuredTools.filter((name: any): any => [
            'paperclip_assignment_get',
            'agent_manual',
            'agent_proposal_create_execute',
            'technical_repair_execute',
            'operations_health_execute',
            'employee_assignment_execute',
            'video_content_analyze_execute',
            'content_performance_review_execute',
            'platform_content_draft_execute',
            'video_script_package_execute',
            'm5_stage_execute',
            'local_ai_invoke',
            'paperclip_assignment_complete'
        ].includes(name))
        : configuredTools;
    if (paperclipHeartbeat && allowedTools.length === 0) {
        throw new AgentArmyClientError('Paperclip heartbeat 没有有效工具白名单，拒绝启动 MCP 服务。');
    }
    return {
        agentIds,
        profileId: String(process.env.AGENT_ARMY_PROFILE_ID || onlyValue(agentIds) || '').trim(),
        taskCardPolicy: taskCardPolicyFromEnvironment(),
        taskTypes,
        enforceToolAllowlist: paperclipHeartbeat,
        allowedTools,
        localAiCapabilities,
        allowMissions: restricted ? process.env.AGENT_ARMY_ALLOW_MISSIONS === 'true' : true
    };
}
function toolAllowed(name: any, scope: any): any {
    if (scope.enforceToolAllowlist === true) {
        return Array.isArray(scope.allowedTools) && scope.allowedTools.includes(name);
    }
    return !scope.allowedTools?.length || scope.allowedTools.includes(name);
}
function paperclipIdentityFromEnvironment(): any {
    const identity: Record<string, any> = {
        issueId: String(process.env.PAPERCLIP_TASK_ID || '').trim(),
        runId: String(process.env.PAPERCLIP_RUN_ID || '').trim(),
        paperclipAgentId: String(process.env.PAPERCLIP_AGENT_ID || '').trim(),
        agentArmyId: String(process.env.AGENT_ARMY_AGENT_ID || '').trim()
    };
    if (![identity.issueId, identity.runId, identity.paperclipAgentId].every(isUuid) || !identity.agentArmyId) {
        throw new AgentArmyClientError('当前不是带完整身份的 Paperclip heartbeat，不能读取或回报指派。');
    }
    return identity;
}
function isUuid(value: any): any {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}
function environmentList(name: any): any {
    return [...new Set(String(process.env[name] || '').split(',').map((item: any): any => item.trim()).filter(Boolean))];
}
function taskCardPolicyFromEnvironment(): any {
    const value: any = String(process.env.AGENT_ARMY_TASK_CARD_POLICY || '').trim();
    return ['disabled', 'routed-task', 'durable-task', 'incident-only'].includes(value) ? value : '';
}
function scopedCapabilities(value: any, scope: any): any {
    if (!scope.agentIds.length && !scope.taskTypes.length)
        return value;
    return {
        ...value,
        employees: (value?.employees || []).filter((employee: any): any => scope.agentIds.includes(employee.agentId)).map((employee: any): any => ({
            ...employee,
            acceptedTaskTypes: (employee.acceptedTaskTypes || []).filter((taskType: any): any => !scope.taskTypes.length || scope.taskTypes.includes(taskType))
        }))
    };
}
function scopedTaskFilter(input: any, scope: any): any {
    if (scope.agentIds.length === 1)
        return { ...input, employee: onlyValue(scope.agentIds) };
    return input;
}
function assertReadableTask(task: any, scope: any): any {
    if (scope.agentIds.length && !scope.agentIds.includes(task?.agentId)) {
        throw new AgentArmyClientError('当前员工身份不能读取不属于自己的任务。');
    }
}
function onlyValue(values: any): any {
    return values.length === 1 ? values[0] : undefined;
}
const invokedPath: any = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
    runAgentArmyMcpServer().catch((error: any): any => {
        console.error(`Agent Army MCP failed: ${String(error?.message || error)}`);
        process.exit(1);
    });
}
