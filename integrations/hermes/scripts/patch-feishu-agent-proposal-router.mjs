#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const defaultAdapter = path.join(process.env.HERMES_HOME || path.join(process.env.HOME || '', '.hermes', 'hermes-agent'), 'plugins/platforms/feishu/adapter.py');

export function applyPatch(source) {
  if (source.includes('def _route_ajun_agent_proposal_event(')) return source;
  let result = insert(source, '_XIAOD_HTTP_URL_RE = re.compile(r"https?://[^\\s<>\\u3002\\uff0c\\uff01\\uff1f]+", re.IGNORECASE)\n', `${proposalPattern}\n`);
  result = insert(result, '            if await self._route_xiaod_retry_query(event):\n                return\n            await self.handle_message(event)\n', '            if await self._route_xiaod_retry_query(event):\n                return\n            if await self._route_ajun_agent_proposal_event(event):\n                return\n            await self.handle_message(event)\n');
  result = insert(result, '    async def _route_xiaod_status_query(self, event: MessageEvent) -> bool:\n', `${proposalRouter}\n\n    async def _route_xiaod_status_query(self, event: MessageEvent) -> bool:\n`);
  result = insert(result, '        if await self._route_xiaod_retry_query(event):\n            return\n        if event.message_type == MessageType.TEXT', '        if await self._route_xiaod_retry_query(event):\n            return\n        if await self._route_ajun_agent_proposal_event(event):\n            return\n        if event.message_type == MessageType.TEXT');
  return result;
}

function insert(source, marker, replacement) {
  if (!source.includes(marker)) throw new Error(`Hermes 当前 Feishu 适配器结构不匹配，找不到补丁锚点：${marker.slice(0, 72)}`);
  return source.replace(marker, replacement);
}

const proposalPattern = `_AJUN_AGENT_PROPOSAL_RE = re.compile(\n    r"(?:创建|新建|招募|招)\\s*(?:一个\\s*)?(?:agent|智能体|岗位)",\n    re.IGNORECASE,\n)`;
const proposalRouter = `    async def _route_ajun_agent_proposal_event(self, event: MessageEvent) -> bool:
        """Route Feishu natural-language Agent creation to the local A君 proposal gate.

        This intentionally bypasses the LLM. A user message can create only a
        draft proposal; Paperclip approval and a restricted test remain gates.
        """
        ingress_url = os.getenv("AJUN_AGENT_PROPOSAL_INGRESS_URL", "").strip()
        if not ingress_url or event.message_type != MessageType.TEXT:
            return False
        if not ingress_url.startswith("http://127.0.0.1:"):
            logger.error("[Feishu] Refusing non-local A君 proposal ingress URL")
            return False
        if not _AJUN_AGENT_PROPOSAL_RE.search(event.text or ""):
            return False
        if getattr(event, "_ajun_agent_proposal_routed", False):
            return True
        setattr(event, "_ajun_agent_proposal_routed", True)
        payload = json.dumps({
            "sourceEventRef": f"feishu:{event.message_id or ''}",
            "requestedOutcome": (event.text or "").strip(),
        }, ensure_ascii=False).encode("utf-8")

        def _post_to_ajun() -> tuple[int, dict]:
            request = Request(ingress_url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
            with urlopen(request, timeout=8) as response:
                return int(response.status), json.loads(response.read().decode("utf-8"))

        chat_id = getattr(event.source, "chat_id", "") if event.source else ""
        try:
            status, body = await self._run_blocking(_post_to_ajun)
            proposal = body.get("proposal") if isinstance(body, dict) else None
            proposal_id = proposal.get("proposalId") if isinstance(proposal, dict) else None
            proposal_status = proposal.get("status") if isinstance(proposal, dict) else None
            if status in {200, 201, 202} and proposal_id:
                if proposal_status == "pending_approval":
                    message = f"已生成 Agent 草案「{proposal_id}」并提交 Paperclip 审核；通过受限测试前不会上线。"
                else:
                    message = f"已找到 Agent 草案「{proposal_id}」，当前状态：{proposal_status or 'draft'}。"
                if chat_id:
                    await self.send(chat_id, message, reply_to=event.message_id)
                return True
        except (HTTPError, URLError, OSError, ValueError, json.JSONDecodeError) as exc:
            logger.warning("[Feishu] A君 proposal ingress failed: %s", exc)
        if chat_id:
            await self.send(chat_id, "创建官暂时无法登记草案；未创建或上线任何 Agent，请稍后重试。", reply_to=event.message_id)
        return True`;

async function main() {
  const filePath = process.argv[2] || defaultAdapter;
  const original = await fs.readFile(filePath, 'utf8');
  const patched = applyPatch(original);
  if (patched === original) return console.log(`Hermes 创建官飞书路由已存在：${filePath}`);
  await fs.writeFile(filePath, patched);
  console.log(`已安装 Hermes 创建官飞书路由：${filePath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
