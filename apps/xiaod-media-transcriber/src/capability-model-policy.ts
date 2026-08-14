import fs from 'node:fs/promises';
import path from 'node:path';

export const LOCAL_ASR_SELECTION = Object.freeze({
  provider:'local',
  model:'mlx-community/whisper-large-v3-turbo',
});

export const STEPFUN_ASR_SELECTION = Object.freeze({
  provider:'stepfun',
  model:'stepaudio-2.5-asr',
});

type AsrSelection = typeof LOCAL_ASR_SELECTION | typeof STEPFUN_ASR_SELECTION;

export class CapabilityModelPolicyReader {
  private readonly filePath: string;

  constructor({ filePath }: Readonly<{ filePath: string }>) {
    this.filePath = path.resolve(filePath);
  }

  async asrSelection(): Promise<AsrSelection> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      return normalizeAsrSelection(parsed?.capabilities?.asr);
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT' || error instanceof SyntaxError) return LOCAL_ASR_SELECTION;
      throw error;
    }
  }

  async snapshot() {
    const selection = await this.asrSelection();
    return {
      source:'agent-army-model-policy',
      asr:{ ...selection },
    };
  }
}

export function normalizeAsrSelection(value: unknown): AsrSelection {
  const candidate = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const provider = String(candidate.provider || '').trim();
  const model = String(candidate.model || '').trim();
  if (provider === STEPFUN_ASR_SELECTION.provider && model === STEPFUN_ASR_SELECTION.model) {
    return STEPFUN_ASR_SELECTION;
  }
  if (provider === LOCAL_ASR_SELECTION.provider && model === LOCAL_ASR_SELECTION.model) {
    return LOCAL_ASR_SELECTION;
  }
  return LOCAL_ASR_SELECTION;
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code || '') : '';
}
