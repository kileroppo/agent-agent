export type JitteredBackoffOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  shouldRetry?: (error: any) => boolean;
  onRetry?: (error: any, attempt: number, delayMs: number) => void;
};

export type MessageItem = {
  role: string;
  content: string;
  [key: string]: any;
};

export function isRetryableProviderError(error: any): boolean {
  if (!error) return false;
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  if ([429, 500, 502, 503, 504].includes(status)) return true;

  const code = String(error?.code || error?.errorCode || '').toUpperCase();
  if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'RATE_LIMIT_EXCEEDED'].includes(code)) return true;

  const msg = String(error?.message || '').toLowerCase();
  if (msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('quota') || msg.includes('timeout')) return true;

  return false;
}

export function computeJitteredDelay(attempt: number, baseDelayMs = 400, maxDelayMs = 5000): number {
  const expDelay = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
  // Full Jitter: 随机分布在 [0.5 * expDelay, expDelay]
  const factor = 0.5 + Math.random() * 0.5;
  return Math.floor(expDelay * factor);
}

export async function withJitteredBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: JitteredBackoffOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 400;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const sleepFn = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const shouldRetry = options.shouldRetry ?? isRetryableProviderError;

  let attempt = 1;
  while (true) {
    try {
      return await fn(attempt);
    } catch (err: any) {
      if (attempt > maxRetries || !shouldRetry(err)) {
        throw err;
      }
      const delayMs = computeJitteredDelay(attempt, baseDelayMs, maxDelayMs);
      options.onRetry?.(err, attempt, delayMs);
      await sleepFn(delayMs);
      attempt += 1;
    }
  }
}

export function estimateTokenCount(text: string, charsPerToken = 3.5): number {
  return Math.ceil(String(text || '').length / charsPerToken);
}

export function pruneMessagesForContextLimit(
  messages: MessageItem[],
  { maxEstimatedTokens = 16000, charsPerToken = 3.5 }: { maxEstimatedTokens?: number; charsPerToken?: number } = {}
): MessageItem[] {
  if (!Array.isArray(messages) || messages.length <= 3) return messages;

  const maxTotalChars = maxEstimatedTokens * charsPerToken;
  let totalChars = messages.reduce((acc, m) => acc + String(m.content || '').length, 0);
  if (totalChars <= maxTotalChars) return messages;

  // 保留第一条系统提示与最新 2 条消息
  const systemMsg = messages[0];
  const tailMessages = messages.slice(-2);
  const middleMessages = messages.slice(1, -2);

  const prunedMiddle: MessageItem[] = middleMessages.map((m) => {
    const raw = String(m.content || '');
    if (raw.length > 800) {
      return {
        ...m,
        content: `${raw.slice(0, 400)}\n\n[...已自动压缩 ${raw.length - 800} 字符历史中间输出...]\n\n${raw.slice(-400)}`,
        pruned: true,
      };
    }
    return m;
  });

  return [systemMsg, ...prunedMiddle, ...tailMessages];
}
