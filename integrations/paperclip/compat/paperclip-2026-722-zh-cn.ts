import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    applyVersionLockedFile,
    rollbackVersionLockedFile,
} from './paperclip-2026-722-binary-rpc.ts';

export const PAPERCLIP_VERSION: any = '2026.722.0';
export const UI_ORIGINAL_SHA256: any = '2727ed6173751c5008df83e3d22c915c7b374945d0c655290c99dcc89e9001c9';
export const UI_ZH_CN_SHA256: any = '3ca1e44fc3ad2ec8c6b0ec30923cb84e2def091b78fca6f5e7c2fba456ac7142';
export const HTML_ORIGINAL_SHA256: any = '7ea7a85330bdbfcacbb1e57f738d0b59daa11ae4374c2aaa2ea396175930b429';
export const HTML_ZH_CN_SHA256: any = '65db5c31aa1b4e982a0000b7c1d74ed036918c4ac961bf828c36b50145ae7c50';
export const UI_BACKUP_SUFFIX: any = '.agent-army-paperclip-2026.722.0-zh-cn.bak';
export const HTML_BACKUP_SUFFIX: any = '.agent-army-paperclip-2026.722.0-zh-cn-html.bak';

const DEFAULT_LOCALE_ORIGINAL: any = 'const Y6="en",H4t=';
const DEFAULT_LOCALE_SWITCHABLE: any = 'const Y6=(()=>{try{return localStorage.getItem("paperclip.ui.language")==="en"?"en":"zh-CN"}catch{return"zh-CN"}})(),H4t=';
const I18N_INIT_ORIGINAL: any = 'Uh.use(oPt).init(Y4t).catch(e=>{});const J4t=';
const ZH_CN_RESOURCE_ANCHOR: any = '"./locales/zh-CN.json"';
const HTML_ROOT_ORIGINAL: any = '<html lang="en" class="dark">';
const HTML_ROOT_ZH_CN: any = '<html lang="zh-CN" class="dark">';
const HTML_SCRIPT_ORIGINAL: any = '<script type="module" crossorigin src="/assets/index-Cd3JwXvD.js"></script>';
const HTML_SCRIPT_ZH_CN: any = '<script type="module" crossorigin src="/assets/index-Cd3JwXvD.js?agent-army-zh-cn=2026.722.0-v5"></script>';

export const UI_TRANSLATIONS: any = Object.freeze({
    'Skip to Main Content':'跳到主要内容',
    'Open search':'打开搜索',
    'Collapse sidebar':'收起侧边栏',
    'Expand sidebar':'展开侧边栏',
    'Resize sidebar':'调整侧边栏宽度',
    'New Task':'新建任务',
    'Dashboard':'总览',
    'Inbox':'待办箱',
    'Work':'工作',
    'Tasks':'任务',
    'Routines':'定时任务',
    'Artifacts':'产物',
    'Skills':'技能',
    'Projects':'项目',
    'Agents':'员工',
    'Agents section actions':'员工区操作',
    'New agent':'新建员工',
    'See all agents':'查看全部员工',
    'Company':'公司',
    'Org':'组织',
    'Timeline':'时间线',
    'Costs':'费用',
    'Activity':'动态',
    'Settings':'设置',
    'Open account menu':'打开账户菜单',
    'Board':'负责人',
    'Command Palette':'命令面板',
    'Search for a command to run...':'搜索要执行的命令…',
    'Search inbox…':'搜索待办…',
    'Search tasks':'搜索任务',
    'Search tasks...':'搜索任务…',
    'Search artifacts':'搜索产物',
    'Search artifacts...':'搜索产物…',
    'Search skills, authors, categories…':'搜索技能、作者或分类…',
    'Mine':'我的',
    'Recent':'最近',
    'Unread':'未读',
    'Blocked':'受阻',
    'Blocked ·':'受阻 ·',
    'All':'全部',
    'All types':'全部类型',
    'All routines':'全部定时任务',
    'All skills':'全部技能',
    'All categories':'全部分类',
    'Active':'启用中',
    'Paused':'已暂停',
    'Error':'错误',
    'Done':'已完成',
    'Cancelled':'已取消',
    'Backlog':'待排期',
    'In Review':'审核中',
    'Pending':'待处理',
    'Open':'未设上限',
    'approved':'已批准',
    'rejected':'已拒绝',
    'failed':'失败',
    'idle':'空闲',
    'paused':'已暂停',
    'error':'错误',
    'in progress':'进行中',
    'completed':'已完成',
    'issue created':'已创建任务',
    'just now':'刚刚',
    'Earlier':'更早',
    'Other results':'其他结果',
    'Filter':'筛选',
    'Sort':'排序',
    'Group':'分组',
    'Columns':'显示列',
    'Select':'选择',
    'Source':'来源',
    'View mode':'查看方式',
    'List view':'列表视图',
    'Board view':'看板视图',
    'Org chart view':'组织图视图',
    'Disable parent-child nesting':'关闭父子任务折叠',
    'Enable parent-child nesting':'开启父子任务折叠',
    'Mark all as read':'全部标为已读',
    'Mark as read':'标为已读',
    'Archive':'归档',
    'Leave':'移除',
    'On':'开启',
    'Off':'关闭',
    'Never':'从不',
    'No project':'无项目',
    'No pending approvals.':'没有待处理审批。',
    'Approvals':'审批',
    'Pending Approvals':'待处理审批',
    'Awaiting board review':'等待负责人审核',
    'Agents Enabled':'已启用员工',
    'Tasks In Progress':'进行中的任务',
    'Month Spend':'本月费用',
    'Unlimited budget':'预算不设上限',
    'Run Activity':'运行情况',
    'Last 14 days':'最近 14 天',
    'Tasks by Priority':'按优先级统计任务',
    'Tasks by Status':'按状态统计任务',
    'Success Rate':'成功率',
    'Recent Activity':'最近动态',
    'Recent Tasks':'最近任务',
    'Recent Runs':'最近运行',
    'Productivity review open':'待处理的效率复核',
    'Productivity review: High churn':'效率复核：变更过于频繁',
    'Productivity review: No-comment streak':'效率复核：连续缺少进度说明',
    'Recovery needed':'需要恢复',
    'Recovery needed — open the source task to act.':'需要恢复——打开原任务进行处理。',
    'Needs next step':'缺少下一步',
    'This task needs a next step':'这个任务需要明确下一步',
    'Adapter failed':'执行适配器失败',
    'Board Approval':'负责人审批',
    'Recurring work definitions that materialize into auditable execution tasks.':'把周期性工作生成可审计的具体执行任务。',
    'Group these routines into folders to keep things tidy.':'可把这些定时任务放进文件夹，便于整理。',
    'Create your first folder':'创建第一个文件夹',
    'Dismiss folder suggestion':'关闭文件夹建议',
    'Built-in routines':'内置定时任务',
    'Refresh stale summary slots':'刷新过期摘要',
    'Review recent agent trajectories for coaching proposals':'复核员工近期工作并提出改进建议',
    'Group artifacts (currently Task)':'产物分组（当前按任务）',
    'Group artifacts':'产物分组',
    'Filter artifacts by type':'按类型筛选产物',
    'Images':'图片',
    'Videos':'视频',
    'Documents':'文档',
    'Text':'文本',
    'Files':'文件',
    'No artifact stacks yet.':'暂无产物。',
    'Skill folders':'技能文件夹',
    'Folders':'文件夹',
    'New folder':'新建文件夹',
    'My Skills':'我的技能',
    'New company folder':'新建公司文件夹',
    'No company folders yet.':'暂无公司文件夹。',
    'Expand folder':'展开文件夹',
    'Bundled':'内置',
    'System':'系统',
    'Unfiled':'未归档',
    'Resize skill folders':'调整技能文件夹宽度',
    'Skills Store':'技能商店',
    'Discover, install, fork, share':'发现、安装、派生和分享',
    'Categories':'分类',
    'Most agents':'使用员工最多',
    'Scan project workspaces for skills':'扫描项目工作区中的技能',
    'Installed':'已安装',
    'Catalog':'目录',
    'Folder path':'文件夹路径',
    'My Projects':'我的项目',
    'Org Chart':'组织图',
    'Zoom in':'放大',
    'Zoom out':'缩小',
    'Fit chart to screen':'让组织图适应屏幕',
    'Fit to screen':'适应屏幕',
    'Work Timeline':'工作时间线',
    'Runs':'运行记录',
    'Run time':'运行时长',
    'Tokens used':'Token 用量',
    'Not tracked':'未记录',
    'Timeline zoom controls':'时间线缩放控制',
    'Reset zoom':'重置缩放',
    'Today':'今天',
    '7 days':'7 天',
    '30 days':'30 天',
    'Timeline start date':'时间线开始日期',
    'Timeline end date':'时间线结束日期',
    'to':'到',
    'Inference spend, platform fees, credits, and live quota windows.':'推理费用、平台费用、抵扣和实时额度窗口。',
    'Month to Date':'本月至今',
    'Last 7 Days':'最近 7 天',
    'Last 30 Days':'最近 30 天',
    'Year to Date':'今年至今',
    'All Time':'全部时间',
    'Custom':'自定义',
    'Inference spend':'推理费用',
    'Budget':'预算',
    'No monthly cap configured':'未设置月度上限',
    'Finance net':'财务净额',
    'Finance events':'财务事件',
    'Overview':'概览',
    'Budgets':'预算',
    'Providers':'模型提供方',
    'Billers':'计费方',
    'Finance':'财务',
    'Inference ledger':'推理账本',
    'Request-scoped inference spend for the selected period.':'所选时段内按请求记录的推理费用。',
    'usage':'用量',
    'Finance ledger':'财务账本',
    'Account-level charges that do not map to a single inference request.':'无法归到单次推理请求的账户级费用。',
    'Debits':'支出',
    'Credits':'抵扣',
    'Refunds, offsets, and credit returns':'退款、冲抵和额度返还',
    'Net':'净额',
    'Debit minus credit for the selected period':'所选时段的支出减去抵扣',
    'Estimated':'估算',
    'Estimated debits that are not yet invoice-authoritative':'尚未以账单为准的预估支出',
    'By agent':'按员工',
    'What each agent consumed in the selected period.':'各员工在所选时段内的用量。',
    'By project':'按项目',
    'Run costs attributed through project-linked tasks.':'通过项目关联任务归属的运行费用。',
    'No project-attributed run costs yet.':'暂无归属到项目的运行费用。',
    'Recent financial events':'最近财务事件',
    'Top-ups, fees, credits, commitments, and other non-request charges.':'充值、费用、抵扣、承诺支出及其他非请求费用。',
    'No finance events yet. Add account-level charges once biller invoices or credits land.':'暂无财务事件；收到账单或抵扣后再添加账户级费用。',
    'Company Settings':'公司设置',
    'Company settings':'公司设置',
    'General':'常规',
    'Members':'成员',
    'Invites':'邀请',
    'Secrets':'密钥',
    'Instance settings':'实例设置',
    'Profile':'资料',
    'Environments':'环境',
    'Access':'访问权限',
    'Heartbeats':'心跳',
    'Experimental':'实验功能',
    'Plugins':'插件',
    'Adapters':'适配器',
    'breadcrumb':'面包屑导航',
    'Company name':'公司名称',
    'Description':'说明',
    'Optional company description':'可选的公司说明',
    'Appearance':'外观',
    'Logo':'标志',
    'Brand color':'品牌颜色',
    'Auto':'自动',
    'Attachment size limit':'附件大小上限',
    'Hiring':'招聘',
    'Require board approval for new hires':'新员工必须由负责人批准',
    'Company Packages':'公司软件包',
    'Danger Zone':'危险操作区',
    'Archive this company to hide it from the sidebar. This persists in the database.':'归档公司后会从侧边栏隐藏，并持久保存到数据库。',
    'Archive company':'归档公司',
    'Task title':'任务标题',
    'For':'负责人',
    'Project':'项目',
    'Add reviewer or approver':'添加复核人或审批人',
    'Add description':'添加说明',
    'Todo':'待办',
    'Priority':'优先级',
    'Upload':'上传',
    'Agent':'执行',
    'Plan':'方案',
    'Ask':'问答',
    'Create Task':'创建任务',
    'Status':'状态',
    'Assignee':'负责人',
    'Parent':'父任务',
    'Blocked by':'受阻于',
    'Blocking':'正在阻塞',
    'Sub-tasks':'子任务',
    'Reviewers':'复核人',
    'Approvers':'审批人',
    'Monitor':'监控',
    'About':'详情',
    'Instructions':'岗位说明',
    'Configuration':'配置',
    'Chat':'沟通',
    'Reply':'回复',
    'Output':'产出',
    'Save':'保存',
    'Cancel':'取消',
    'Close':'关闭',
    'Edit':'编辑',
    'Create':'创建',
    'Add':'添加',
    'Remove':'移除',
    'Delete':'删除',
});

type SourceHashes = {
    uiOriginalSha?: string;
    uiPatchedSha?: string;
    htmlOriginalSha?: string;
    htmlPatchedSha?: string;
};

export function translateUiText(value: any): any {
    const source: any = String(value ?? '');
    const match: any = source.match(/^(\s*)(.*?)(\s*)$/s);
    const core: any = match?.[2] ?? source;
    const translated: any = translateCore(core);
    return translated === core ? source : `${match?.[1] || ''}${translated}${match?.[3] || ''}`;
}

function translateCore(core: any): any {
    if (UI_TRANSLATIONS[core])
        return UI_TRANSLATIONS[core];
    let match: any;
    if ((match = core.match(/^Open (.+) company switcher$/))) return `打开${match[1]}公司切换器`;
    if ((match = core.match(/^Open actions for (.+)$/))) return `打开${match[1]}的操作菜单`;
    if ((match = core.match(/^More actions for (.+)$/))) return `打开${match[1]}的更多操作`;
    if ((match = core.match(/^Disable (.+)$/))) return `停用${match[1]}`;
    if ((match = core.match(/^Enable (.+)$/))) return `启用${match[1]}`;
    if ((match = core.match(/^Leave (.+)$/))) return `移除${match[1]}`;
    if ((match = core.match(/^Star (.+)$/))) return `收藏${match[1]}`;
    if ((match = core.match(/^updated (.+) ago$/))) return `更新于${translateRelative(match[1])}前`;
    if ((match = core.match(/^Finished (.+) ago$/))) return `${translateRelative(match[1])}前完成`;
    if ((match = core.match(/^(\d+) (agents|projects|tasks|routines|skills|runs)$/))) {
        const units: any = { agents:'名员工', projects:'个项目', tasks:'个任务', routines:'个定时任务', skills:'个技能', runs:'次运行' };
        return `${match[1]}${units[match[2]]}`;
    }
    if ((match = core.match(/^(\d+) running, (\d+) paused, (\d+) errors$/))) return `${match[1]} 运行中，${match[2]} 已暂停，${match[3]} 个错误`;
    if ((match = core.match(/^(\d+) open, (\d+) blocked$/))) return `${match[1]} 个未完成，${match[2]} 个受阻`;
    if ((match = core.match(/^worked for (\d+) seconds?$/))) return `运行了 ${match[1]} 秒`;
    if ((match = core.match(/^(\d+) blockers? need attention$/))) return `${match[1]} 个阻塞项需要处理`;
    if ((match = core.match(/^(\d+) covered by active work$/))) return `${match[1]} 个已有任务处理`;
    if ((match = core.match(/^Review productivity for (.+)$/))) return `复核 ${match[1]} 的执行效率`;
    if ((match = core.match(/^Blocked · (\d+) blockers? need attention$/))) return `受阻 · ${match[1]} 个阻塞项需要处理`;
    if ((match = core.match(/^Blocked · (\d+) blockers? need attention; (\d+) covered by active work$/))) return `受阻 · ${match[1]} 个阻塞项需要处理；${match[2]} 个已有任务处理`;
    if ((match = core.match(/^Blocked · waiting on active sub-task (.+)$/))) return `受阻 · 等待执行中的子任务 ${match[1]}`;
    if ((match = core.match(/^Inbox, (\d+) unread$/))) return `待办箱，${match[1]} 条未读`;
    if ((match = core.match(/^(\d+) total events in range$/))) return `所选时段共 ${match[1]} 条事件`;
    if ((match = core.match(/^in (\d+) · out (\d+)$/))) return `输入 ${match[1]} · 输出 ${match[2]}`;
    if ((match = core.match(/^Sort: (.+)$/))) return `排序：${UI_TRANSLATIONS[match[1]] || match[1]}`;
    if ((match = core.match(/^(.+) ago$/))) return `${translateRelative(match[1])}前`;
    return core;
}

function translateRelative(value: any): any {
    const match: any = String(value).match(/^(\d+)([mhdw])$/);
    if (!match)
        return value;
    const units: any = { m:'分钟', h:'小时', d:'天', w:'周' };
    return `${match[1]}${units[match[2]]}`;
}

export function transformUiSource(source: any): any {
    const text: any = String(source);
    if (occurrences(text, DEFAULT_LOCALE_ORIGINAL) !== 1
        || occurrences(text, I18N_INIT_ORIGINAL) !== 1
        || occurrences(text, ZH_CN_RESOURCE_ANCHOR) !== 1) {
        throw compatError('Paperclip UI简体中文资源或补丁锚点不匹配，拒绝修改未知版本。');
    }
    return text
        .replace(DEFAULT_LOCALE_ORIGINAL, DEFAULT_LOCALE_SWITCHABLE)
        .replace(I18N_INIT_ORIGINAL, `${browserTranslatorSource()}${browserLanguageToggleSource()}${I18N_INIT_ORIGINAL}`);
}

export function patchUiSource(source: any, hashes: SourceHashes = {}): any {
    const text: any = String(source);
    const originalSha: any = hashes.uiOriginalSha || UI_ORIGINAL_SHA256;
    const patchedSha: any = hashes.uiPatchedSha || UI_ZH_CN_SHA256;
    if (sha256(text) === patchedSha)
        return text;
    if (sha256(text) !== originalSha)
        throw compatError('Paperclip UI源码SHA不匹配，拒绝修改未知版本。');
    const patched: any = transformUiSource(text);
    if (sha256(patched) !== patchedSha)
        throw compatError('Paperclip UI简体中文目标SHA不匹配，拒绝写入。');
    return patched;
}

export function transformHtmlSource(source: any): any {
    const text: any = String(source);
    if (occurrences(text, HTML_ROOT_ORIGINAL) !== 1 || occurrences(text, HTML_SCRIPT_ORIGINAL) !== 1)
        throw compatError('Paperclip HTML入口补丁锚点不匹配，拒绝修改未知版本。');
    return text.replace(HTML_ROOT_ORIGINAL, HTML_ROOT_ZH_CN).replace(HTML_SCRIPT_ORIGINAL, HTML_SCRIPT_ZH_CN);
}

export function patchHtmlSource(source: any, hashes: SourceHashes = {}): any {
    const text: any = String(source);
    const originalSha: any = hashes.htmlOriginalSha || HTML_ORIGINAL_SHA256;
    const patchedSha: any = hashes.htmlPatchedSha || HTML_ZH_CN_SHA256;
    if (sha256(text) === patchedSha)
        return text;
    if (sha256(text) !== originalSha)
        throw compatError('Paperclip HTML入口SHA不匹配，拒绝修改未知版本。');
    const patched: any = transformHtmlSource(text);
    if (sha256(patched) !== patchedSha)
        throw compatError('Paperclip HTML简体中文目标SHA不匹配，拒绝写入。');
    return patched;
}

export async function resolveCompatibilityTargets({ paperclipEntry }: any = {}): Promise<any> {
    const paperclipRoot: any = await packageRootForEntry(paperclipEntry, 'paperclipai');
    const paperclipPackage: any = await readPackage(path.join(paperclipRoot, 'package.json'));
    if (paperclipPackage.version !== PAPERCLIP_VERSION)
        throw compatError(`只允许 Paperclip ${PAPERCLIP_VERSION}，当前为 ${paperclipPackage.version || 'unknown'}。`);
    const serverRoot: any = path.join(path.dirname(paperclipRoot), '@paperclipai', 'server');
    const serverPackage: any = await readPackage(path.join(serverRoot, 'package.json'));
    if (serverPackage.name !== '@paperclipai/server' || serverPackage.version !== PAPERCLIP_VERSION)
        throw compatError('Paperclip server包名或版本不匹配。');
    const uiRoot: any = path.join(serverRoot, 'ui-dist');
    const htmlFile: any = path.join(uiRoot, 'index.html');
    const html: any = await fs.readFile(htmlFile, 'utf8');
    const scripts: any = [...html.matchAll(/<script\b[^>]*\bsrc="([^"?]+\.js)(?:\?[^"?]*)?"[^>]*>/g)]
        .map((match: any): any => match[1])
        .filter((value: any): any => /^\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(value));
    if (scripts.length !== 1)
        throw compatError('Paperclip UI入口脚本不唯一，拒绝修改。');
    const uiFile: any = path.join(uiRoot, scripts[0].slice(1));
    await assertInside(uiRoot, uiFile);
    return {
        paperclipRoot,
        serverRoot,
        uiFile,
        htmlFile,
        uiBackupFile:`${uiFile}${UI_BACKUP_SUFFIX}`,
        htmlBackupFile:`${htmlFile}${HTML_BACKUP_SUFFIX}`,
    };
}

export async function applyCompatibilityPatch(options: any, hashes: SourceHashes = {}): Promise<any> {
    const targets: any = await resolveCompatibilityTargets(options);
    const effective: any = effectiveHashes(hashes);
    const currentUi: any = await fs.readFile(targets.uiFile, 'utf8');
    const currentHtml: any = await fs.readFile(targets.htmlFile, 'utf8');
    patchUiSource(currentUi, effective);
    patchHtmlSource(currentHtml, effective);
    const uiResult: any = await applyVersionLockedFile({
        file:targets.uiFile,
        backupFile:targets.uiBackupFile,
        originalSha:effective.uiOriginalSha,
        patchedSha:effective.uiPatchedSha,
        patch:(current: any): any => Buffer.from(patchUiSource(current.toString('utf8'), effective)),
    });
    try {
        const htmlResult: any = await applyVersionLockedFile({
            file:targets.htmlFile,
            backupFile:targets.htmlBackupFile,
            originalSha:effective.htmlOriginalSha,
            patchedSha:effective.htmlPatchedSha,
            patch:(current: any): any => Buffer.from(patchHtmlSource(current.toString('utf8'), effective)),
        });
        return {
            status:uiResult.changed || htmlResult.changed ? 'applied' : 'already_applied',
            changed:uiResult.changed || htmlResult.changed,
            ...targets,
        };
    }
    catch (error: any) {
        if (uiResult.changed) {
            await rollbackVersionLockedFile({
                file:targets.uiFile,
                backupFile:targets.uiBackupFile,
                originalSha:effective.uiOriginalSha,
                patchedSha:effective.uiPatchedSha,
            });
        }
        throw error;
    }
}

export async function rollbackCompatibilityPatch(options: any, hashes: SourceHashes = {}): Promise<any> {
    const targets: any = await resolveCompatibilityTargets(options);
    const effective: any = effectiveHashes(hashes);
    const htmlResult: any = await rollbackVersionLockedFile({
        file:targets.htmlFile,
        backupFile:targets.htmlBackupFile,
        originalSha:effective.htmlOriginalSha,
        patchedSha:effective.htmlPatchedSha,
    });
    const uiResult: any = await rollbackVersionLockedFile({
        file:targets.uiFile,
        backupFile:targets.uiBackupFile,
        originalSha:effective.uiOriginalSha,
        patchedSha:effective.uiPatchedSha,
    });
    return {
        status:uiResult.changed || htmlResult.changed ? 'rolled_back' : 'already_rolled_back',
        changed:uiResult.changed || htmlResult.changed,
        ...targets,
    };
}

function browserTranslatorSource(): any {
    const translations: any = JSON.stringify(UI_TRANSLATIONS);
    return `const aaZhMap=${translations};const aaZhRelative=e=>{const t=String(e).match(/^(\\d+)([mhdw])$/);return t?\`${'${t[1]}'}${'${{m:"分钟",h:"小时",d:"天",w:"周"}[t[2]]}'}\`:e};const aaZhCore=e=>{if(aaZhMap[e])return aaZhMap[e];let t;if(t=e.match(/^Open (.+) company switcher$/))return\`打开${'${t[1]}'}公司切换器\`;if(t=e.match(/^Open actions for (.+)$/))return\`打开${'${t[1]}'}的操作菜单\`;if(t=e.match(/^More actions for (.+)$/))return\`打开${'${t[1]}'}的更多操作\`;if(t=e.match(/^Disable (.+)$/))return\`停用${'${t[1]}'}\`;if(t=e.match(/^Enable (.+)$/))return\`启用${'${t[1]}'}\`;if(t=e.match(/^Leave (.+)$/))return\`移除${'${t[1]}'}\`;if(t=e.match(/^Star (.+)$/))return\`收藏${'${t[1]}'}\`;if(t=e.match(/^updated (.+) ago$/))return\`更新于${'${aaZhRelative(t[1])}'}前\`;if(t=e.match(/^Finished (.+) ago$/))return\`${'${aaZhRelative(t[1])}'}前完成\`;if(t=e.match(/^(\\d+) (agents|projects|tasks|routines|skills|runs)$/))return\`${'${t[1]}'}${'${{agents:"名员工",projects:"个项目",tasks:"个任务",routines:"个定时任务",skills:"个技能",runs:"次运行"}[t[2]]}'}\`;if(t=e.match(/^(\\d+) running, (\\d+) paused, (\\d+) errors$/))return\`${'${t[1]}'} 运行中，${'${t[2]}'} 已暂停，${'${t[3]}'} 个错误\`;if(t=e.match(/^(\\d+) open, (\\d+) blocked$/))return\`${'${t[1]}'} 个未完成，${'${t[2]}'} 个受阻\`;if(t=e.match(/^worked for (\\d+) seconds?$/))return\`运行了 ${'${t[1]}'} 秒\`;if(t=e.match(/^(\\d+) blockers? need attention$/))return\`${'${t[1]}'} 个阻塞项需要处理\`;if(t=e.match(/^(\\d+) covered by active work$/))return\`${'${t[1]}'} 个已有任务处理\`;if(t=e.match(/^Review productivity for (.+)$/))return\`复核 ${'${t[1]}'} 的执行效率\`;if(t=e.match(/^Blocked · (\\d+) blockers? need attention$/))return\`受阻 · ${'${t[1]}'} 个阻塞项需要处理\`;if(t=e.match(/^Blocked · (\\d+) blockers? need attention; (\\d+) covered by active work$/))return\`受阻 · ${'${t[1]}'} 个阻塞项需要处理；${'${t[2]}'} 个已有任务处理\`;if(t=e.match(/^Blocked · waiting on active sub-task (.+)$/))return\`受阻 · 等待执行中的子任务 ${'${t[1]}'}\`;if(t=e.match(/^Inbox, (\\d+) unread$/))return\`待办箱，${'${t[1]}'} 条未读\`;if(t=e.match(/^(\\d+) total events in range$/))return\`所选时段共 ${'${t[1]}'} 条事件\`;if(t=e.match(/^in (\\d+) · out (\\d+)$/))return\`输入 ${'${t[1]}'} · 输出 ${'${t[2]}'}\`;if(t=e.match(/^Sort: (.+)$/))return\`排序：${'${aaZhMap[t[1]]||t[1]}'}\`;if(t=e.match(/^(.+) ago$/))return\`${'${aaZhRelative(t[1])}'}前\`;return e};const aaZhText=e=>{const t=String(e??""),n=t.match(/^(\\s*)(.*?)(\\s*)$/s),r=n?n[2]:t,i=aaZhCore(r);return i===r?t:\`${'${n?.[1]||""}'}${'${i}'}${'${n?.[3]||""}'}\`};const aaZhNode=e=>{if(e.nodeType===3){const t=e.nodeValue,n=aaZhText(t);n!==t&&(e.nodeValue=n);return}if(e.nodeType!==1)return;for(const t of["aria-label","placeholder","title"]){const n=e.getAttribute(t);if(n){const r=aaZhText(n);r!==n&&e.setAttribute(t,r)}}for(const t of e.childNodes)aaZhNode(t)};const aaZhObserver=new MutationObserver(e=>{for(const t of e)t.type==="characterData"?aaZhNode(t.target):t.type==="attributes"?aaZhNode(t.target):t.addedNodes.forEach(aaZhNode)});document.documentElement.lang="zh-CN";aaZhObserver.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:["aria-label","placeholder","title"]});aaZhNode(document.documentElement);globalThis.__agentArmyPaperclipZhCn={translate:aaZhText};`;
}

function browserLanguageToggleSource(): any {
    return `const aaLanguageKey="paperclip.ui.language";const aaZhEnabled=(()=>{try{return localStorage.getItem(aaLanguageKey)!=="en"}catch{return true}})();aaZhEnabled||aaZhObserver.disconnect();document.documentElement.lang=aaZhEnabled?"zh-CN":"en";const aaSetLanguage=e=>{if(!["zh-CN","en"].includes(e))return;try{localStorage.setItem(aaLanguageKey,e)}catch{}location.reload()};const aaMountLanguageToggle=()=>{if(typeof document==="undefined"||!document.body||document.getElementById("agent-army-language-toggle"))return;const t=document.createElement("button");t.id="agent-army-language-toggle";t.type="button";t.textContent=aaZhEnabled?"EN":"中文";t.title=aaZhEnabled?"切换到 English":"Switch to Chinese";t.setAttribute("aria-label",t.title);t.style.position="fixed";t.style.top=".75rem";t.style.right=".75rem";t.style.zIndex="9999";t.style.height="2rem";t.style.minWidth="2.5rem";t.style.padding="0 .5rem";t.style.border="1px solid #71717a";t.style.borderRadius=".375rem";t.style.backgroundColor="var(--background)";t.style.color="var(--foreground)";t.style.boxShadow="0 2px 8px rgba(0,0,0,.18)";t.style.fontSize=".75rem";t.style.fontWeight="600";t.style.lineHeight="1";t.style.cursor="pointer";t.style.opacity="0";t.style.pointerEvents="none";t.style.transform="translateY(-4px)";t.style.transition="opacity .2s ease-in-out, transform .2s ease-in-out";const show=()=>{t.style.opacity="1";t.style.pointerEvents="auto";t.style.transform="translateY(0)"};const hide=()=>{if(document.activeElement!==t){t.style.opacity="0";t.style.pointerEvents="none";t.style.transform="translateY(-4px)"}};window.addEventListener("mousemove",e=>{e.clientX>=window.innerWidth-100&&e.clientY<=80?show():hide()},{passive:true});document.addEventListener("mouseleave",hide);t.addEventListener("focus",show);t.addEventListener("blur",hide);t.addEventListener("click",()=>aaSetLanguage(aaZhEnabled?"en":"zh-CN"));document.body.appendChild(t)};const aaLanguageObserver=new MutationObserver(aaMountLanguageToggle);aaLanguageObserver.observe(document.documentElement,{subtree:true,childList:true});aaMountLanguageToggle();globalThis.__agentArmyPaperclipZhCn={language:aaZhEnabled?"zh-CN":"en",setLanguage:aaSetLanguage,translate:aaZhText};`;
}

function effectiveHashes(hashes: SourceHashes): any {
    return {
        uiOriginalSha:hashes.uiOriginalSha || UI_ORIGINAL_SHA256,
        uiPatchedSha:hashes.uiPatchedSha || UI_ZH_CN_SHA256,
        htmlOriginalSha:hashes.htmlOriginalSha || HTML_ORIGINAL_SHA256,
        htmlPatchedSha:hashes.htmlPatchedSha || HTML_ZH_CN_SHA256,
    };
}

async function packageRootForEntry(entryValue: any, expectedName: any): Promise<any> {
    const entry: any = await fs.realpath(path.resolve(required(entryValue, `${expectedName}入口缺失。`)));
    let current: any = path.dirname(entry);
    for (;;) {
        const record: any = await readPackage(path.join(current, 'package.json'), { optional:true });
        if (record?.name === expectedName)
            return current;
        const parent: any = path.dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    throw compatError(`入口不属于 ${expectedName} 包。`);
}

async function assertInside(rootValue: any, fileValue: any): Promise<any> {
    const root: any = await fs.realpath(rootValue);
    const file: any = await fs.realpath(fileValue);
    if (!file.startsWith(`${root}${path.sep}`))
        throw compatError('兼容补丁目标路径逃逸Paperclip UI目录。');
}

async function readPackage(file: any, { optional = false }: any = {}): Promise<any> {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    }
    catch (error: any) {
        if (optional && error?.code === 'ENOENT')
            return null;
        throw compatError(`无法读取或解析包元数据：${path.basename(path.dirname(file))}。`);
    }
}

function occurrences(source: any, needle: any): any {
    return source.split(needle).length - 1;
}

function required(value: any, message: any): any {
    const text: any = String(value || '').trim();
    if (!text)
        throw compatError(message);
    return text;
}

function sha256(value: any): any {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function compatError(message: any): any {
    const error: any = new Error(message);
    error.name = 'PaperclipZhCnCompatError';
    return error;
}
