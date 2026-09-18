/**
 * 论坛 → Memory Palace（轨道 B：即时便利贴）
 *
 * 对齐 utils/momentsMemory.ts 的 upsertMomentPin 写法，范围按 [交接5 2.3] 收窄：
 *
 *   - isOwnedByUserSide（作者是用户任意身份或共管账号）→ 触发。这是 TA 事先不知情的
 *     新信息，需要立刻进上下文。
 *   - isCollected（用户收藏）→ 不触发。TA 不需要实时知道你收藏了什么，等沉寂后走
 *     轨道A长期归档即可。
 *   - involvesCharInteraction（角色互动过）→ 不触发。这条本身是 TA 刚回复完才成立的，
 *     TA 当然已经"知道"（因为是它自己生成的回复），再塞便利贴提醒自己刚说的话没有意义。
 *
 * 触发时机是"状态跳变那一刻"，不是统一的"发布那一刻"——但 isOwnedByUserSide 由作者
 * 账号类型决定，创建时就已经定死、之后不会再变，所以对这一条规则而言，状态跳变
 * 恒等于创建那一刻。三种创建场景都在这一刻调用一次 upsertForumPostPin：
 *   1) 用户用主号/小号手动发帖；
 *   2) 用户切到共管账号身份手动发帖（同样 isOwnedByUserSide=true，走公共feed）；
 *   3) 共管账号按4档节奏系统自动生成的"专属动态"（isOwnedByUserSide=true，只在
 *      共管账号自己主页可见，见 forumScheduler.ts）。
 *
 * 报告原文只覆盖到"帖子"这个粒度（isOwnedByUserSide 是 ForumPost 字段，不是
 * ForumComment 字段），所以这里不额外给"用户在别人帖子下面的一条散评论"单独触发
 * 便利贴——没有依据，不擅自扩大范围。
 */

import type { ForumAccount, ForumPost } from './forumDb';
import { MemoryNodeDB } from './memoryPalace';
import type { LightLLMConfig, MemoryNode } from './memoryPalace';
import { getTopicLabel, type ForumTopicTag } from './forumConstants';

const PIN_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * 便利贴 ID 必须带上 charId。原来只用 postId，多个角色各自的记忆宫殿会抢同一个 ID，
 * 后写的把先写的顶掉——一条帖子只能被一个角色记住。
 */
function makeForumPinId(charId: string, postId: string): string {
  return `forum_pin_${charId}_${postId}`;
}

/**
 * 这条帖子该不该进记忆宫殿。[用户确认] 只认用户大号和共管账号，**双方小号都不算**。
 *
 * 小号一旦进记忆，TA 就等于直接被告知"这条是用户发的"，互相猜小号的玩法当场作废；
 * TA 自己小号发的内容也不进——那属于它私下的行为，没必要变成长期记忆去污染主线。
 */
export function isPostEligibleForMemory(authorAccount: ForumAccount | null | undefined): boolean {
  if (!authorAccount) return false;
  if (authorAccount.isAlt) return false;
  return authorAccount.ownerType === 'user' || authorAccount.ownerType === 'shared';
}

/** 内容摘要，供便利贴用。没有 messageFormat.ts 里 summarizeMomentForPin 的原实现可抄，
 *  这里按论坛自己的字段做一版等价的截断+打标签。 */
export function summarizeForumPostForPin(post: ForumPost, maxChars = 300): string {
  const topicLabel = getTopicLabel(post.topicTag as ForumTopicTag);
  const kindLabel = post.postKind === 'news' ? '新闻贴' : '原创贴';
  const head = `[论坛${kindLabel}·${topicLabel}] ${post.title ? `${post.title}：` : ''}`;
  const body = (post.content || '').trim();
  const joined = `${head}${body}`;
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined;
}

/**
 * 给一条用户方发的帖子建/更新便利贴，24 小时后自然过期（跟朋友圈同一套 pinnedUntil 机制）。
 * 使用固定 ID，重复调用同一条帖子不会生成多条。
 */
export async function upsertForumPostPin(
  charId: string,
  post: ForumPost,
  now = Date.now(),
): Promise<void> {
  if (!post.isOwnedByUserSide) return; // 双重保险：调用方应已按状态跳变过滤，这里再兜底一次

  const content = summarizeForumPostForPin(post);
  if (!content.trim()) return;

  const existing = await MemoryNodeDB.getById(makeForumPinId(charId, post.id));
  const createdAt = existing?.createdAt || post.createdAt || now;
  const node: MemoryNode = {
    id: makeForumPinId(charId, post.id),
    charId,
    content,
    room: 'living_room',
    tags: ['论坛', '即时便利贴'],
    importance: 7,
    mood: 'neutral',
    embedded: false,
    createdAt,
    lastAccessedAt: now,
    accessCount: existing?.accessCount || 0,
    pinnedUntil: now + PIN_DURATION_MS,
    sourceId: post.id,
    origin: 'system',
    eventBoxId: existing?.eventBoxId ?? null,
    archived: false,
  };

  await MemoryNodeDB.save(node);
}

/** 帖子被删/被三天水线物理清扫时，同步删掉对应便利贴（如果还在）。 */
export async function deleteForumPostPin(charId: string, postId: string): Promise<void> {
  await MemoryNodeDB.delete(makeForumPinId(charId, postId));
}
