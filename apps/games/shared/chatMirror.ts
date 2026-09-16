// ═══════════════════════════════════════════════════════════════════════════
// 🧩 小游戏共用 · 写进聊天记录（→ 记忆宫殿自动整理）
//   记忆宫殿从角色的私聊记录里整理记忆，所以游戏内容存成普通聊天消息就会被收进去。
//   每条都带 metadata.source = 游戏 id，以后想筛出来或隐藏都方便。
// ═══════════════════════════════════════════════════════════════════════════

import { DB } from '../../../utils/db';

export type MirrorRole = 'user' | 'assistant' | 'system';

export function createChatMirror(charId: string | null | undefined, source: string, enabled = true) {
  let queue: Promise<void> = Promise.resolve();
  return (role: MirrorRole, text: string) => {
    const content = (text || '').trim();
    if (!enabled || !charId || !content) return;
    queue = queue.then(async () => {
      try {
        await DB.saveMessage({ charId, role, type: role === 'system' ? 'system' : 'text', content, metadata: { source } } as never);
      } catch (e) { console.warn(`[${source}] 写入聊天记录失败`, e); }
    });
  };
}
