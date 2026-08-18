// 阶段一 · 探索性 Bug 条件检查 第 ⑤ 条（关键反例，边界）
//
// 已完整迁移的 adapter（用户真机上最可能的状态）命中 LEGACY_MIGRATION_MATRIX 首项
// `installed-adapter-seam-v1`（terminal: true），migrateFeishuCommanderRouter 原样 return，
// 因此**任何新补丁单元都分发不到**。本文件在未修复代码上必须 FAIL —— 失败即证明分发缺口存在，
// 并直接要求任务 4.5 与本次修复一起交付。
//
// 反例推翻条件：若本文件在未修复代码上就通过，说明分发缺口假设不成立，须回到 design.md §6 重新确认。
//
// 测试用原生 node --test，不引入 Jest / Vitest / fast-check（需求 3.9）。
//
// **Validates: Requirements 1.3, 2.3, 2.4**

import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPatch } from '../scripts/patch-feishu-agent-proposal-router.mjs';
import { migrateFeishuCommanderRouter } from '../scripts/feishu-commander-router-patches.mjs';

const SILENT_FAILURE_MARKER = 'AGENT_ARMY_FEISHU_COMMANDER_SILENT_FAILURE_EVIDENCE_V1';
const ADAPTER_SEAM_MARKER = 'AGENT_ARMY_HERMES_FEISHU_ADAPTER_SEAM_V1';

// 仓库内自造的最小 adapter 夹具（与 patch-feishu-agent-proposal-router.test.mjs 同源结构轮廓）。
// 不读取、不触达真实 ~/.hermes/hermes-agent/plugins/platforms/feishu/adapter.py。
const fixture = `_XIAOD_HTTP_URL_RE = re.compile(r"https?://[^\\s<>\\u3002\\uff0c\\uff01\\uff1f]+", re.IGNORECASE)
    def __init__(self):
        self._xiaod_latest_job_by_chat: Dict[str, tuple[str, str]] = {}
    async def connect(self):
            self._mark_connected()
            logger.info("[Feishu] Connected in %s mode (%s)", self._connection_mode, self._domain_name)
    async def _handle_message_with_guards(self, event: MessageEvent) -> None:
            if await self._route_xiaod_retry_query(event):
                return
            await self.handle_message(event)
    async def _route_xiaod_status_query(self, event: MessageEvent) -> bool:
        pass
    async def _dispatch_inbound_event(self, event: MessageEvent) -> None:
        if await self._route_xiaod_retry_query(event):
            return
        if event.message_type == MessageType.TEXT:
            pass
    async def send_exec_approval(
        self,
    ) -> SendResult:
        pass
    def _on_card_action_trigger(self, data: Any) -> Any:
        if hermes_action:
            return self._handle_approval_card_action(event=event, action_value=action_value, loop=loop)
    async def _handle_card_action_event(self, data: Any) -> None:
        event = getattr(data, "event", None)
        token = str(getattr(event, "token", "") or "")
        context = getattr(event, "context", None)
        action_tag = "button"
        action_value = {}
        synthetic_text = f"/card {action_tag}"
        if action_value:
            try:
                synthetic_text += f" {json.dumps(action_value, ensure_ascii=False)}"
            except Exception:
                pass
        synthetic_event = MessageEvent(
            text=synthetic_text,
            message_id=token or str(uuid.uuid4()),
        )
    def _handle_approval_card_action(self, *, event: Any, action_value: Dict[str, Any], loop: Any) -> Any:
        pass
    async def _resolve_approval(
        self,
    ) -> None:
        pass
`;

test('⑤已迁移 adapter 收不到新补丁：terminal 分支必须执行 post-seam 幂等升级（需求 1.3 / 2.3 / 2.4）', () => {
  const installed = applyPatch(fixture);
  assert.ok(installed.includes(ADAPTER_SEAM_MARKER), '夹具应已包含 Adapter Seam 标记，代表真机上「已完整迁移」的状态。');

  const migrated = migrateFeishuCommanderRouter(installed);

  // 命中的确实是 terminal 分支 —— 这是分发缺口的成因，不是缺陷本身。
  assert.equal(migrated.migration, 'installed-adapter-seam-v1');
  assert.equal(migrated.terminal, true);

  assert.ok(
    migrated.source.includes(SILENT_FAILURE_MARKER),
    `已迁移 adapter 收不到新补丁单元 ${SILENT_FAILURE_MARKER}。`
      + ` migrateFeishuCommanderRouter 的实际返回：migration=${migrated.migration}`
      + `、terminal=${migrated.terminal}`
      + `、source 与入参逐字符相等=${migrated.source === installed}`
      + `、含 record_commander_chain_evidence=${migrated.source.includes('record_commander_chain_evidence')}`
      + '。terminal 分支原样 return，用户真机（最可能已完整迁移）永远拿不到新补丁（design.md 探索用例 ⑤）。',
  );
  assert.ok(
    migrated.source.includes('record_commander_chain_evidence'),
    '新补丁单元的 evidence 模块导入也没有被注入。',
  );
});

test('⑤幂等：post-seam 升级重复执行后新标记恰好出现一次（需求 3.5）', () => {
  const installed = applyPatch(fixture);
  const once = migrateFeishuCommanderRouter(installed).source;
  const twice = migrateFeishuCommanderRouter(once).source;
  const thrice = migrateFeishuCommanderRouter(twice).source;

  assert.equal(twice, once, '第 2 次迁移必须与第 1 次逐字符相等。');
  assert.equal(thrice, once, '第 3 次迁移必须与第 1 次逐字符相等。');
  assert.equal(
    once.split(SILENT_FAILURE_MARKER).length - 1,
    1,
    `新标记 ${SILENT_FAILURE_MARKER} 必须恰好出现一次。`,
  );
});

test('⑤边界：未打补丁的源码继续走 baseline 分支，迁移矩阵优先级不被 4.5 改动影响（需求 3.5）', () => {
  // 非 terminal 分支的分支归属必须保持不变；这条在未修复代码上即成立，用于锁住 4.5 的改动边界。
  const migrated = migrateFeishuCommanderRouter(fixture);
  assert.equal(migrated.terminal, false);
  assert.equal(migrated.migration, 'legacy-or-unpatched');
});
