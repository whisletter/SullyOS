/**
 * 论坛 → 记忆宫殿 · 接线层
 *
 * 轨道 A（长期归档）和轨道 B（即时便利贴）两个模块早就写完了，但全项目没有任何地方
 * 调用它们——论坛上发生的一切都进不了 TA 的记忆。这个文件就是补上那条线。
 *
 * 只负责"谁该记、记给谁"，摘要怎么写、怎么落库还是交给原来那两个模块。
 *
 * 谁该记 [用户确认]：只有用户大号和共管账号发的帖子进记忆，**双方小号都不进**。
 * 记给谁：
 *   - 共管账号的帖 → 只记给绑定的那个角色（那本来就是你和它共用的号）
 *   - 用户大号的帖 → 记给所有角色。论坛是公开的，谁都刷得到，没道理只有一个角色知道。
 */

import * as db from './forumDb';
import type { ForumPost } from './forumDb';
import { isPostEligibleForMemory, upsertForumPostPin } from './forumMemory';

export interface MemoryBridgeChar {
  id?: string;
  name?: string;
}

/**
 * 一条帖子刚发出来时调用，写即时便利贴（24 小时自然过期）。
 * 不调用任何模型，纯本地截断摘要，所以可以在发帖路径上直接同步跑。
 *
 * 失败不抛：发帖本身已经成功了，记忆写不进去不该让用户看到一个发帖失败的提示。
 *
 * @returns 实际写了几条便利贴
 */
export async function pinForumPostIfEligible(
  post: ForumPost,
  characters: MemoryBridgeChar[],
): Promise<number> {
  try {
    const author = await db.getForumAccount(post.authorAccountId);
    if (!isPostEligibleForMemory(author)) return 0;

    // 共管账号：只记给它绑定的那个角色
    if (author!.ownerType === 'shared') {
      if (!author!.charId) return 0;
      await upsertForumPostPin(author!.charId, post);
      return 1;
    }

    // 用户大号：所有角色都刷得到这条帖
    let count = 0;
    for (const char of characters || []) {
      if (!char.id) continue;
      await upsertForumPostPin(char.id, post);
      count++;
    }
    return count;
  } catch (e: any) {
    console.warn('[ForumMemoryBridge] 便利贴写入失败:', e?.message || String(e));
    return 0;
  }
}
