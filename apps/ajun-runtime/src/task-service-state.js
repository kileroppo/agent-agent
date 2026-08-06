export function isTerminalTask(task) {
  return ['succeeded', 'failed', 'cancelled', 'waiting_test'].includes(task?.status);
}
