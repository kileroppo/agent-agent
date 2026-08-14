type JsonRecord = Record<string, unknown>;

export type CompletionDelivery = Readonly<{
  mode: 'dynamic_card';
  owner: 'hermes_gateway';
}>;

export type CompletionWatcher = Readonly<{
  watch(input: Readonly<{ taskId: string; chatId: string }>): Promise<unknown>;
}>;

export const HERMES_DYNAMIC_CARD_DELIVERY: CompletionDelivery = Object.freeze({
  mode:'dynamic_card',
  owner:'hermes_gateway',
});

export function normalizeCompletionDelivery(value: unknown): CompletionDelivery | null {
  const delivery = recordOf(value);
  if (delivery?.mode !== HERMES_DYNAMIC_CARD_DELIVERY.mode
    || delivery.owner !== HERMES_DYNAMIC_CARD_DELIVERY.owner) return null;
  return HERMES_DYNAMIC_CARD_DELIVERY;
}

export function dynamicCardAnchorAcknowledged(value: unknown): boolean {
  const anchor = recordOf(value);
  return Boolean(normalizeCompletionDelivery(anchor)
    && anchor?.anchorEstablished === true
    && String(anchor.deliveryId || anchor.messageId || '').trim());
}

export async function registerSourceCompletionWatch(
  result: unknown,
  watcher: CompletionWatcher | null | undefined,
  {
    completionDelivery,
    anchorAcknowledgement = null,
  }: Readonly<{ completionDelivery?: unknown; anchorAcknowledgement?: unknown }> = {},
) {
  const resultRecord = recordOf(result);
  const task = recordOf(resultRecord?.task) || recordOf(resultRecord?.mission) || resultRecord;
  const source = recordOf(task?.source);
  const context = recordOf(task?.context);
  const taskId = String(task?.taskId || '').trim();
  const channel = String(source?.channel || '').trim();
  const chatRef = String(source?.chatRef || '').trim();
  if (channel !== 'feishu' || !taskId || !chatRef) return { required:false, registered:false };
  const delivery = normalizeCompletionDelivery(
    completionDelivery
      || resultRecord?.completionDelivery
      || task?.completionDelivery
      || context?.completionDelivery,
  );
  if (delivery && dynamicCardAnchorAcknowledged(anchorAcknowledgement)) {
    const anchor = recordOf(anchorAcknowledgement) || {};
    return {
      required:false,
      registered:false,
      delegated:true,
      duplicateWatchSuppressed:true,
      taskId,
      completionDelivery:{
        ...delivery,
        anchorEstablished:true,
        ...(anchor.deliveryId
          ? { deliveryId:String(anchor.deliveryId) }
          : { messageId:String(anchor.messageId) }),
      },
    };
  }
  if (!watcher?.watch) return {
    required:true,
    registered:false,
    errorCode:'completion_watch_unavailable' as const,
  };
  try {
    await watcher.watch({ taskId, chatId:chatRef });
    return { required:true, registered:true, taskId };
  } catch {
    return {
      required:true,
      registered:false,
      taskId,
      errorCode:'completion_watch_registration_failed' as const,
    };
  }
}

function recordOf(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}
