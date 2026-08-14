import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const STEPFUN_ASR_MODEL = 'stepaudio-2.5-asr';
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const MAX_RESPONSE_CHARACTERS = 5 * 1024 * 1024;
const HERMES_CREDENTIAL_SCRIPT = [
  'import json',
  'from hermes_cli.runtime_provider import resolve_runtime_provider',
  'runtime = resolve_runtime_provider(requested="custom:sstefun", target_model="stepaudio-2.5-asr")',
  'print(json.dumps({"apiKey": runtime.get("api_key", "")}))',
].join('\n');

type CredentialProvider = Readonly<{ resolve(): Promise<Readonly<{ apiKey: string }>> }>;

export class StepFunAsrClient {
  private readonly baseUrl: string;
  private readonly credentialProvider: CredentialProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor({
    baseUrl = 'https://api.stepfun.com/step_plan/v1',
    credentialProvider = new HermesStepFunCredentialProvider(),
    fetchImpl = fetch,
    timeoutMs = 120_000,
  }: Readonly<{
    baseUrl?: string;
    credentialProvider?: CredentialProvider;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }> = {}) {
    this.baseUrl = officialStepPlanBaseUrl(baseUrl);
    this.credentialProvider = credentialProvider;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async transcribe(audioPath: string) {
    const status = await fs.stat(audioPath);
    if (!status.isFile() || status.size <= 0) throw coded('stepfun_asr_input_invalid', 'StepFun ASR 输入必须是非空普通文件。');
    if (status.size >= MAX_AUDIO_BYTES) throw coded('stepfun_asr_input_too_large', 'StepFun ASR 输入不能达到或超过 100MB。');
    const audio = await fs.readFile(audioPath);
    const { apiKey } = await this.credentialProvider.resolve();
    if (!apiKey) throw coded('stepfun_asr_credential_unavailable', 'StepFun ASR 凭据未配置，Provider 未调用。');
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/audio/asr/sse`, {
        method:'POST',
        headers:{
          accept:'text/event-stream',
          authorization:`Bearer ${apiKey}`,
          'content-type':'application/json',
        },
        body:JSON.stringify({
          audio:{
            data:audio.toString('base64'),
            input:{
              transcription:{
                model:STEPFUN_ASR_MODEL,
                language:'zh',
                enable_itn:true,
              },
              format:{ type:'wav' },
            },
          },
        }),
        signal:AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw coded('stepfun_asr_ambiguous', 'StepFun ASR 请求结果不确定，禁止自动重试或改投其他服务商。');
    }
    let responseText: string;
    try {
      responseText = await response.text();
    } catch {
      throw coded('stepfun_asr_ambiguous', 'StepFun ASR 响应中断，禁止自动重试或改投其他服务商。');
    }
    if (responseText.length > MAX_RESPONSE_CHARACTERS) throw coded('stepfun_asr_ambiguous', 'StepFun ASR 响应超过安全上限，调用结果无法确认。');
    if (!response.ok) throw coded(response.status >= 500 ? 'stepfun_asr_ambiguous' : 'stepfun_asr_failed', `StepFun ASR 请求失败（HTTP ${response.status}）。`);
    let parsed;
    try {
      parsed = parseStepFunAsrSse(responseText);
    } catch (error: any) {
      if (error?.code === 'stepfun_asr_failed') throw coded('stepfun_asr_ambiguous', error.message);
      throw error;
    }
    if (!parsed.text) throw coded('stepfun_asr_empty', 'StepFun ASR 没有返回有效文字。');
    return {
      text:parsed.text,
      timed:null,
      language:'zh',
      segments:[],
      qualitySignals:null,
      usage:parsed.usage,
    };
  }
}

export class HermesStepFunCredentialProvider implements CredentialProvider {
  private readonly hermesHome: string;
  private readonly python: string;

  constructor({
    hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes', 'profiles', 'xiaod'),
    python = process.env.XIAOD_HERMES_PYTHON || path.join(os.homedir(), '.hermes', 'hermes-agent', 'venv', 'bin', 'python'),
  }: Readonly<{ hermesHome?: string; python?: string }> = {}) {
    this.hermesHome = path.resolve(hermesHome);
    this.python = path.resolve(python);
  }

  async resolve() {
    try {
      const result = await execFile(this.python, ['-c', HERMES_CREDENTIAL_SCRIPT], {
        env:{ ...process.env, HERMES_HOME:this.hermesHome, NO_COLOR:'1' },
        timeout:10_000,
        maxBuffer:64 * 1024,
      });
      const parsed = JSON.parse(String(result.stdout || '{}'));
      const apiKey = String(parsed?.apiKey || '').trim();
      if (!apiKey) throw new Error('missing');
      return { apiKey };
    } catch {
      throw coded('stepfun_asr_credential_unavailable', 'StepFun ASR 凭据未配置，Provider 未调用。');
    }
  }
}

export function parseStepFunAsrSse(input: string) {
  let text = '';
  let usage: Record<string, unknown> | null = null;
  for (const block of String(input || '').split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    let event: Record<string, any>;
    try { event = JSON.parse(data); } catch { continue; }
    if (event.type === 'error') throw coded('stepfun_asr_failed', String(event.message || 'StepFun ASR 返回错误。').slice(0, 240));
    if (event.type === 'transcript.text.delta') text += String(event.delta || '');
    if (event.type === 'transcript.text.done') {
      text = String(event.text || text).trim();
      usage = event.usage && typeof event.usage === 'object' ? structuredClone(event.usage) : null;
    }
  }
  return { text:text.trim(), usage };
}

function officialStepPlanBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.stepfun.com' || parsed.pathname.replace(/\/+$/, '') !== '/step_plan/v1') {
    throw new Error('StepFun ASR 只允许官方 Step Plan 地址。');
  }
  return `${parsed.origin}/step_plan/v1`;
}

function coded(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
