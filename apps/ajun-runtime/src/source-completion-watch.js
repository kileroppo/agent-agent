export const HERMES_DYNAMIC_CARD_DELIVERY = Object.freeze({
  mode:'dynamic_card',
  owner:'hermes_gateway',
});

export function normalizeCompletionDelivery(value) {
  if (value?.mode !== HERMES_DYNAMIC_CARD_DELIVERY.mode
    || value?.owner !== HERMES_DYNAMIC_CARD_DELIVERY.owner) return null;
  return HERMES_DYNAMIC_CARD_DELIVERY;
}

export function dynamicCardAnchorAcknowledged(value) {
  return Boolean(normalizeCompletionDelivery(value)
    && value?.anchorEstablished === true
    && String(value?.deliveryId || value?.messageId || '').trim());
}

export async function registerSourceCompletionWatch(result, watcher, {
  completionDelivery,
  anchorAcknowledgement = null,
} = {}) {
  const task = result?.task || result?.mission || result;
  const taskId = String(task?.taskId || '').trim();
  const channel = String(task?.source?.channel || '').trim();
  const chatRef = String(task?.source?.chatRef || '').trim();
  if (channel !== 'feishu' || !taskId || !chatRef) return { required:false, registered:false };
  const delivery = normalizeCompletionDelivery(
    completionDelivery
      || result?.completionDelivery
      || task?.completionDelivery
      || task?.context?.completionDelivery,
  );
  if (delivery && dynamicCardAnchorAcknowledged(anchorAcknowledgement)) {
    return {
      required:false,
      registered:false,
      delegated:true,
      duplicateWatchSuppressed:true,
      taskId,
      completionDelivery:{
        ...delivery,
        anchorEstablished:true,
        ...(anchorAcknowledgement.deliveryId
          ? { deliveryId:String(anchorAcknowledgement.deliveryId) }
          : { messageId:String(anchorAcknowledgement.messageId) }),
      },
    };
  }
  if (!watcher?.watch) return { required:true, registered:false, errorCode:'completion_watch_unavailable' };
  try {
    await watcher.watch({ taskId, chatId:chatRef });
    return { required:true, registered:true, taskId };
  } catch {
    return { required:true, registered:false, taskId, errorCode:'completion_watch_registration_failed' };
  }
}
