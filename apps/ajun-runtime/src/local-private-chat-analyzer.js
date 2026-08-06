const DEFAULT_MODEL = process.env.WECHAT_LOCAL_MODEL
  || '/Users/pengaro/.cache/huggingface/hub/models--mlx-community--Qwen3.5-9B-MLX-4bit/snapshots/938d8919941c6e7efd3c7150eff7fe9d12afa631';
const DEFAULT_BASE_URL = process.env.WECHAT_LOCAL_MODEL_BASE_URL
  || process.env.OLLAMA_BASE_URL
  || 'http://127.0.0.1:18081';
const MAX_TOTAL_CHARS = 120_000;
const MAX_CHUNK_CHARS = 20_000;

export class LocalPrivateChatAnalyzer {
  constructor({ model = DEFAULT_MODEL, baseUrl = DEFAULT_BASE_URL, apiStyle, fetchImpl = fetch, now = () => new Date() } = {}) {
    this.model = model;
    this.baseUrl = normalizeLoopbackUrl(baseUrl);
    this.apiStyle = apiStyle || (new URL(this.baseUrl).port === '11434' ? 'ollama' : 'openai');
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async health() {
    try {
      const endpoint = this.apiStyle === 'ollama' ? '/api/tags' : '/health';
      const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, { signal:AbortSignal.timeout(3_000) });
      if (!response.ok) return unavailable('本机分析模型服务未就绪。', this.model);
      const payload = await response.json();
      const models = Array.isArray(payload?.models) ? payload.models : [];
      const ready = this.apiStyle === 'ollama'
        ? models.some((item) => [item?.name, item?.model].includes(this.model))
        : ['healthy', 'ok'].includes(payload?.status) && [payload?.loaded_model, payload?.loaded_models?.text_generation?.model].includes(this.model);
      return ready
        ? { status:'ready', model:this.model, safeMessage:'本机微信分析模型已就绪。' }
        : unavailable(`本机尚未安装 ${this.model} 模型。`, this.model);
    } catch {
      return unavailable('本机分析模型服务未启动。', this.model);
    }
  }

  async analyze(messages) {
    const normalized = normalizeMessages(messages);
    const chunks = chunkMessages(normalized);
    if (!chunks.length) return emptyAnalysis(this.model, this.now());
    const partials = [];
    for (const chunk of chunks) partials.push(await this.generate(buildChunkPrompt(chunk)));
    const final = partials.length === 1
      ? partials[0]
      : await this.generate(buildReducePrompt(partials));
    return sanitizeAnalysis(final, normalized, this.model, this.now());
  }

  async generate(prompt) {
    const ollama = this.apiStyle === 'ollama';
    const response = await this.fetchImpl(`${this.baseUrl}${ollama ? '/api/generate' : '/v1/chat/completions'}`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify(ollama
        ? { model:this.model, prompt, stream:false, format:'json', think:false, options:{ num_ctx:32_768 } }
        : {
            model:this.model,
            messages:[{ role:'user', content:prompt }],
            stream:false,
            temperature:0,
            max_tokens:512,
            enable_thinking:false
          }),
      signal:AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw analyzerError('local_model_failed', '本机模型分析失败，未把聊天内容发往云端。');
    const payload = await response.json();
    const result = ollama ? payload?.response : payload?.choices?.[0]?.message?.content;
    try { return JSON.parse(String(result || '{}')); }
    catch { throw analyzerError('local_model_invalid_result', '本机模型返回格式无效，未保存结果。'); }
  }
}

export function chunkMessages(messages, { maxTotalChars = MAX_TOTAL_CHARS, maxChunkChars = MAX_CHUNK_CHARS } = {}) {
  const kept = [];
  let total = 0;
  for (const message of [...messages].reverse()) {
    const line = `${message.time} ${message.speaker}: ${message.content}`;
    if (total + line.length > maxTotalChars) break;
    kept.push(line);
    total += line.length;
  }
  kept.reverse();
  const chunks = [];
  let current = '';
  for (const line of kept) {
    if (current && current.length + line.length + 1 > maxChunkChars) {
      chunks.push(current);
      current = '';
    }
    current += `${current ? '\n' : ''}${line.slice(0, maxChunkChars)}`;
  }
  if (current) chunks.push(current);
  return chunks;
}

function normalizeMessages(messages) {
  const speakerMap = new Map();
  return (Array.isArray(messages) ? messages : []).slice(-200).map((item) => {
    const sender = String(item?.sender || '未知');
    if (!speakerMap.has(sender)) speakerMap.set(sender, `发言者${speakerMap.size + 1}`);
    return {
      time:String(item?.time || '').slice(0, 32),
      speaker:speakerMap.get(sender),
      content:String(item?.content || '').replace(/[\r\n]+/g, ' ').slice(0, 8_000),
    };
  });
}

function buildChunkPrompt(chunk) {
  return `你在用户本机离线处理微信聊天。不得复述原句，不得输出姓名、微信号或发送者标识。只输出 JSON，字段为 summary、topics、decisions、todos、risks、replySuggestions；后五项必须是字符串数组。\n聊天：\n${chunk}`;
}

function buildReducePrompt(partials) {
  return `合并以下本机阶段摘要。不得添加原句或身份信息。只输出 JSON，字段为 summary、topics、decisions、todos、risks、replySuggestions；后五项必须是字符串数组。\n${JSON.stringify(partials)}`;
}

function sanitizeAnalysis(value, messages, model, now) {
  const clean = (input) => {
    let text = String(input || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 2_000);
    text = redactRawOverlaps(text, messages);
    return text;
  };
  const list = (input) => (Array.isArray(input) ? input : []).slice(0, 20).map(clean).filter(Boolean);
  return {
    schemaVersion:'agent.army/wechat-chat-analysis/v1',
    createdAt:now.toISOString(),
    model,
    containsRawChat:false,
    containsSenderIdentifiers:false,
    summary:clean(value?.summary),
    topics:list(value?.topics),
    decisions:list(value?.decisions),
    todos:list(value?.todos),
    risks:list(value?.risks),
    replySuggestions:list(value?.replySuggestions),
  };
}

function redactRawOverlaps(value, messages) {
  const marker = '[已省略原句]';
  let text = value;
  for (const message of messages) {
    const raw = String(message?.content || '');
    if (raw.length < 8) continue;
    let offset = 0;
    while (offset <= text.length - 8) {
      const rawOffset = raw.indexOf(text.slice(offset, offset + 8));
      if (rawOffset < 0) {
        offset += 1;
        continue;
      }
      let overlap = 8;
      while (offset + overlap < text.length
        && rawOffset + overlap < raw.length
        && text[offset + overlap] === raw[rawOffset + overlap]) overlap += 1;
      text = `${text.slice(0, offset)}${marker}${text.slice(offset + overlap)}`;
      offset += marker.length;
    }
  }
  return text;
}

function emptyAnalysis(model, now) {
  return sanitizeAnalysis({ summary:'范围内没有可分析的消息。' }, [], model, now);
}

function unavailable(safeMessage, model = DEFAULT_MODEL) {
  return { status:'unavailable', model, safeMessage };
}

function normalizeLoopbackUrl(value) {
  const parsed = new URL(value);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw analyzerError('local_model_not_loopback', '微信私聊分析只允许连接本机模型。');
  }
  return parsed.origin;
}

function analyzerError(code, message) {
  return Object.assign(new Error(message), { code, category:'manual', retryable:false });
}
