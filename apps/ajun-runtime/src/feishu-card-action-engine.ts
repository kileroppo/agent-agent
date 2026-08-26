export type FeishuCardActionPayload = {
  action: {
    tag: string;
    value: Record<string, any>;
  };
  open_message_id?: string;
  user_id?: string;
  token?: string;
};

export type CardActionResult = {
  success: boolean;
  message: string;
  updatedSummary?: string;
  data?: any;
};

export type ActionHandler = (context: {
  actionType: string;
  value: Record<string, any>;
  userId: string;
  messageId: string;
}) => Promise<CardActionResult> | CardActionResult;

export class FeishuCardActionEngine {
  private handlers = new Map<string, ActionHandler>();

  registerHandler(actionType: string, handler: ActionHandler) {
    if (!actionType || typeof handler !== 'function') return;
    this.handlers.set(actionType, handler);
  }

  async handleAction(payload: FeishuCardActionPayload): Promise<{
    toast: { type: 'info' | 'success' | 'error'; content: string };
    card: Record<string, any>;
  }> {
    const actionTag = payload?.action?.tag || 'button';
    const actionValue = payload?.action?.value || {};
    const actionType = String(actionValue.actionType || actionValue.type || actionTag);
    const userId = String(payload?.user_id || 'unknown_user');
    const messageId = String(payload?.open_message_id || 'unknown_msg');

    const handler = this.handlers.get(actionType);
    if (!handler) {
      return {
        toast: { type: 'error', content: `未知的操作类型: ${actionType}` },
        card: this.createResultCard({
          title: '操作失败',
          statusText: `⚠️ 未识别的操作指令 [${actionType}]`,
          timestamp: new Date().toISOString(),
        }),
      };
    }

    try {
      const result = await handler({ actionType, value: actionValue, userId, messageId });
      const toastType = result.success ? 'success' : 'error';

      return {
        toast: { type: toastType, content: result.message },
        card: this.createResultCard({
          title: result.success ? '操作已生效' : '操作未成功',
          statusText: result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
          details: result.updatedSummary,
          timestamp: new Date().toISOString(),
        }),
      };
    } catch (err: any) {
      return {
        toast: { type: 'error', content: `执行异常: ${err?.message || '未知错误'}` },
        card: this.createResultCard({
          title: '执行异常',
          statusText: `❌ 处理发生内部异常: ${err?.message || '未知错误'}`,
          timestamp: new Date().toISOString(),
        }),
      };
    }
  }

  createResultCard({
    title,
    statusText,
    details,
    timestamp,
  }: {
    title: string;
    statusText: string;
    details?: string;
    timestamp: string;
  }): Record<string, any> {
    const formattedTime = timestamp.slice(11, 19);
    const contentLines = [
      `**状态更新**（${formattedTime}）：`,
      statusText,
      ...(details ? ['', `**说明**：${details}`] : []),
      '',
      '*(此卡片交互已完结，无法再次点击)*',
    ];

    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: title },
        template: statusText.includes('✅') ? 'green' : 'red',
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: contentLines.join('\n'),
          },
        },
      ],
    };
  }
}
