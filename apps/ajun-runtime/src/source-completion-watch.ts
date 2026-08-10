export async function registerSourceCompletionWatch(result: any, watcher: any) {
  const task = result?.task || result?.mission || result;
  const taskId = String(task?.taskId || '').trim();
  const channel = String(task?.source?.channel || '').trim();
  const chatRef = String(task?.source?.chatRef || '').trim();
  if (channel !== 'feishu' || !taskId || !chatRef) return { required:false, registered:false };
  if (!watcher?.watch) return { required:true, registered:false, errorCode:'completion_watch_unavailable' };
  try {
    await watcher.watch({ taskId, chatId:chatRef });
    return { required:true, registered:true, taskId };
  } catch {
    return { required:true, registered:false, taskId, errorCode:'completion_watch_registration_failed' };
  }
}
