import type { EventBus, EventHandler } from "@jeek/contracts";

/** 模块之间只通过事件总线广播变化，不持有彼此引用 */
export function createEventBus(): EventBus {
  const handlers = new Map<string, Set<EventHandler>>();

  return {
    on(type: string, handler: EventHandler): () => void {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
      return () => handlers.get(type)?.delete(handler);
    },
    off(type: string, handler: EventHandler): void {
      handlers.get(type)?.delete(handler);
    },
    emit(type: string, payload?: unknown): void {
      // 复制一份：订阅者在回调里取消订阅不会影响本次派发
      for (const handler of [...(handlers.get(type) ?? [])]) {
        try {
          handler(payload ?? null);
        } catch {
          // 单个订阅者出错不阻断其他订阅者；错误由该模块自行记录
        }
      }
    },
  };
}
