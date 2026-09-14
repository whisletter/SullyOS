/**
 * 朋友圈 →  Memory Palace（轨道 A：沉寂归档）
 *
 * 轨道 B（momentsMemory.ts）负责「刚发布的那一刻 TA 就知道你发了什么」——便利贴，24 小时过期。
 * 这里负责「这条动态聊完了，把它连同评论区一起沉淀成长期记忆」。
 *
 * 规则一句话讲完：一条动态超过 DORMANCY_WINDOW_MS 没有任何新评论，就把
 * 「正文 + 上次归档点之后的全部评论」打包提取一次记忆。
 *
 * 几个刻意的设计选择：
 *  - 没有后台定时器。扫描挂在几个天然节点上（打开朋友圈 / 有新评论 / 队列启动），
 *    一次扫描只是一次 IndexedDB 读 + 时间戳比较，零 API 成本；只有真扫出沉寂动态
 *    才会入队、才会调 LLM。
 *  - 水位用时间戳不用条数，评论删除和楼中楼插队都不会让它错位。
 *  - 水位只在提取成功之后写。失败 → 抛异常 → 队列按退避重试 → 那批评论下次还在。
 *  - 归档做成一种 MomentAiTask，白嫖队列现成的去重（固定 ID）、持久化（IndexedDB）、
 *    崩溃续跑、指数退避、并发上限。不另起内存锁。
 */

import type { MomentPost, MomentComment } from './momentsDb';
import {
  getPostsByCharId,
  savePost,
  getMomentAiTask,
  enqueueMomentAiTask,
  createMomentAiTaskId,
} from './momentsDb';
import { ingestMomentThreadToPalace } from './memoryPalace/pipeline';
import type { LightLLMConfig } from './memoryPalace';
import type { CharacterProfile } from '../types';

// ==================== 可调参数 ====================

/**
 * 沉寂窗口：最后一次互动之后多久算「聊完了」。
 *
 * 刻意设成 18 小时而不是 24 —— 便利贴的 pinnedUntil 是 24 小时，而归档是懒触发的。
 * 如果两边都是 24 小时，一条没人评论的纯文字动态很可能便利贴已经过期消失、归档却
 * 还没轮到跑，中间出现一段「TA 彻底不记得你发过什么」的空窗。窗口比便利贴短一截，
 * 缝就补上了。改动这个值时记得同步看 momentsMemory.ts 里的 PIN_DURATION_MS。
 */
export const DORMANCY_WINDOW_MS = 18 * 60 * 60 * 1000;

/**
 * TA 自己发的、用户一次都没互动过的动态，要不要也归档。
 *
 * 默认 false。朋友圈会按频率自动生成 TA 的动态，如果全都归档，宫殿会被大量
 * 「我今天发了条朋友圈说天气不错」这种自言自语灌满，挤占真正重要记忆的召回权重。
 * 只要用户点过赞或评论过，就说明这条动态真的进入了两人的共同语境，那时才值得记。
 * 想让 TA 记得自己所有的朋友圈，把它改成 true 即可。
 */
const ARCHIVE_CHAR_POSTS_WITHOUT_USER_INTERACTION = false;

/** 单条动态正文送进提取时的长度上限（文章全文可能很长，截一刀防止吃满 LightLLM 上下文） */
const BODY_MAX_CHARS = 1200;

/** 一次扫描最多入队多少条，防止首次启用时几百条历史动态一次性涌进队列 */
const MAX_ENQUEUE_PER_SWEEP = 20;

// ==================== 沉寂判定（纯函数，可单测） ====================

/** 按时间升序排好的评论。评论在 momentsDb 里本来就是扁平数组，楼中楼靠 replyTo 指向父评论，
 *  所以「扁平化」这一步实际上只需要排序 —— 楼中楼晚来的回复时间戳天然更晚，位置自然正确。 */
export function sortedComments(post: MomentPost): MomentComment[] {
  return [...(post.comments || [])].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/** 这条动态最后一次「有动静」是什么时候：最后一条评论，没有评论就是发布时间。 */
export function getLastActivityAt(post: MomentPost): number {
  const comments = sortedComments(post);
  const lastComment = comments.length ? comments[comments.length - 1].createdAt || 0 : 0;
  return Math.max(post.createdAt || 0, lastComment);
}

/** 本轮该归档的评论：水位之后的全部。首次归档（水位为 undefined）时是全部评论。 */
export function getPendingComments(post: MomentPost): MomentComment[] {
  const mark = post.memoryArchivedUntil;
  const comments = sortedComments(post);
  if (mark === undefined) return comments;
  return comments.filter(c => (c.createdAt || 0) > mark);
}

/** 用户在这条动态上留下过痕迹吗（评论或点赞） */
function hasUserInteraction(post: MomentPost): boolean {
  if (post.author === 'user') return true;
  if ((post.likes || []).includes('user')) return true;
  return (post.comments || []).some(c => c.author === 'user');
}

/** 还有没有没归档的内容：要么从没归档过（正文还没进宫殿），要么有水位之后的新评论。 */
export function hasUnarchivedContent(post: MomentPost): boolean {
  if (post.memoryArchivedUntil === undefined) return true;
  return getPendingComments(post).length > 0;
}

/** 这条动态现在该不该归档 */
export function shouldArchive(post: MomentPost, now = Date.now()): boolean {
  // 「秘密空间」里补写的历史动态不是真实发生过的互动，不进宫殿
  if (post.isSecretMemory) return false;
  if (!ARCHIVE_CHAR_POSTS_WITHOUT_USER_INTERACTION && !hasUserInteraction(post)) return false;
  if (!hasUnarchivedContent(post)) return false;
  return now - getLastActivityAt(post) >= DORMANCY_WINDOW_MS;
}

// ==================== 正文文本组装 ====================

/**
 * 把一条动态的内容拼成一段可读文本，给记忆提取用。
 *
 * 跟 summarizeMomentForPin 是同一套「从一条动态里挑内容」的判断（有没有识图缓存、
 * 文章有没有正文），只是长度预算完全不同：便利贴每轮都要塞进 prompt 所以要浓缩，
 * 归档是一次性的、之后只存压缩后的记忆节点，所以可以给足料。
 *
 * 图片一律只读 imageDescriptions 缓存，绝不在这里触发识图 API —— 归档跑在后台，
 * 不该为了一条没人看的老动态去打视觉端点。缓存是空的就如实说「没看清」。
 */
export function buildPostBodyForArchive(post: MomentPost, maxChars = BODY_MAX_CHARS): string {
  const parts: string[] = [];
  const text = (post.text || '').trim();
  if (text) parts.push(text);

  const imageCount = post.images?.length || 0;
  if (imageCount > 0) {
    const descriptions = (post.imageDescriptions || []).map(d => (d || '').trim()).filter(Boolean);
    if (descriptions.length) {
      parts.push(
        `（配图 ${imageCount} 张，画面内容：${descriptions.map((d, i) => `第${i + 1}张 ${d}`).join('；')}）`,
      );
    } else {
      parts.push(`（配了 ${imageCount} 张图，没看清里面是什么）`);
    }
  }

  if (post.music) {
    parts.push(`（分享了一首歌：《${post.music.songName}》- ${post.music.artists}）`);
  }

  if (post.article) {
    const summary = (post.article.body || post.article.fullText || '').trim();
    parts.push(
      `（分享了一篇文章《${post.article.title}》${summary ? `，内容：${summary.slice(0, 600)}` : ''}）`,
    );
  }

  const joined = parts.join('\n').trim();
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined;
}

// ==================== 归档执行 ====================

export interface MomentArchiveContext {
  char: CharacterProfile;
  lightLLM?: LightLLMConfig | null;
  userName: string;
}

export type ArchiveOutcome =
  | 'archived'      // 成功提取并推进了水位
  | 'skipped'       // 没有待归档内容 / 不满足条件 / 动态已被删除
  | 'not_ready';    // 宫殿没开、lightLLM 或 embedding 没配好 —— 不算失败，但也不推进水位

/**
 * 归档一条动态。这是唯一会写 memoryArchivedUntil 的地方。
 *
 * 失败时直接把异常抛出去给队列，绝不 catch 之后假装成功 —— 水位一旦被错误推进，
 * 那批评论就永远扫不到了。
 */
export async function archiveMomentPost(
  postId: string,
  ctx: MomentArchiveContext,
): Promise<ArchiveOutcome> {
  // 重新读一次，不用调用方手里可能已经过期的快照（后台跑的时候用户可能又评论了）
  const posts = await getPostsByCharId(ctx.char.id);
  const post = posts.find(p => p.id === postId);
  if (!post) return 'skipped';
  if (post.isSecretMemory) return 'skipped';

  const pending = getPendingComments(post);
  const isFirstArchive = post.memoryArchivedUntil === undefined;
  if (!isFirstArchive && pending.length === 0) return 'skipped';

  const body = buildPostBodyForArchive(post);
  if (isFirstArchive && !body && pending.length === 0) return 'skipped';

  const charName = ctx.char.name || 'TA';
  const result = await ingestMomentThreadToPalace(
    ctx.char,
    {
      postId: post.id,
      postAuthorIsUser: post.author === 'user',
      postBodyText: body,
      postCreatedAt: post.createdAt,
      // 第 2 次之后正文不再参与提取，只作为 charContext 里的背景 —— 见 pipeline 里的说明
      includeBodyAsMessage: isFirstArchive,
      comments: pending.map(c => ({
        role: (c.author === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        speakerName: c.author === 'user' ? (ctx.userName || '用户') : charName,
        text: c.replyToName ? `回复${c.replyToName}：${c.content}` : c.content,
        timestamp: c.createdAt,
      })),
    },
    ctx.lightLLM,
    ctx.userName,
  );

  // 配置没就绪：不是失败，但也不能推进水位，等配好了下次扫描会重新扫到
  if (
    result.status === 'palace_disabled' ||
    result.status === 'lightllm_missing' ||
    result.status === 'embedding_missing'
  ) {
    return 'not_ready';
  }

  // extracted_none / empty_input 也算处理完了：这批内容 LLM 认为没什么可记的，
  // 水位照样推进，否则每次扫描都会重新提取同一批评论，白烧 token。
  const waterline = Math.max(
    post.memoryArchivedUntil || 0,
    pending.length ? pending[pending.length - 1].createdAt || 0 : 0,
    post.createdAt || 0,
  );

  // 再读一次最新快照后写回，避免用旧快照覆盖掉归档期间用户新写的评论/编辑的正文
  const latest = (await getPostsByCharId(ctx.char.id)).find(p => p.id === post.id);
  if (!latest) return 'skipped';
  await savePost({ ...latest, memoryArchivedUntil: waterline });

  if (result.status === 'done') {
    console.log(`🏰 [MomentArchive] 动态 ${post.id} 归档完成，水位推进到 ${new Date(waterline).toLocaleString()}`);
  }
  return 'archived';
}

// ==================== 扫描 & 入队 ====================

/** 同一个角色的扫描节流，避免连续几个触发点在同一秒里重复读 IndexedDB */
const lastSweepAt = new Map<string, number>();
const SWEEP_THROTTLE_MS = 30_000;

/**
 * 扫一遍这个角色的朋友圈，把沉寂的动态丢进任务队列。
 *
 * 零 API 成本，可以随便挂在任何触发点上：打开朋友圈、评论互动之后、队列启动时、
 * 便利贴过期时。返回本次入队条数。
 */
export async function sweepDormantMoments(
  charId: string,
  options: { now?: number; force?: boolean } = {},
): Promise<number> {
  if (!charId) return 0;
  const now = options.now ?? Date.now();

  if (!options.force) {
    const last = lastSweepAt.get(charId) || 0;
    if (now - last < SWEEP_THROTTLE_MS) return 0;
  }
  lastSweepAt.set(charId, now);

  let posts: MomentPost[];
  try {
    posts = await getPostsByCharId(charId);
  } catch (e: any) {
    console.warn('[MomentArchive] 扫描失败:', e?.message || String(e));
    return 0;
  }

  const due = posts.filter(p => shouldArchive(p, now)).slice(0, MAX_ENQUEUE_PER_SWEEP);
  let enqueued = 0;

  for (const post of due) {
    const taskId = createMomentAiTaskId('memory_archive', post.id);
    try {
      // 固定任务 ID 是队列的去重手段，但直接 put 会把正在跑的任务重置成 pending，
      // 导致同一批评论被提取两次。所以先看一眼现在是什么状态。
      const existing = await getMomentAiTask(taskId);
      if (existing) {
        const stale = existing.status === 'processing' && now - existing.updatedAt > 5 * 60_000;
        // 还在排队 / 正在跑 / 在退避等待中 → 让它自己跑完，别打扰
        if (existing.status === 'pending' || (existing.status === 'processing' && !stale)) continue;
        // failed 且重试次数已耗尽 → 不自动复活，避免坏配置下无限刷日志；
        // 用户改好配置后重新打开朋友圈，force 扫描或手动重试才会再跑
        if (existing.status === 'failed') continue;
      }
      await enqueueMomentAiTask({
        id: taskId,
        kind: 'memory_archive',
        postId: post.id,
        charId,
        status: 'pending',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        nextRunAt: now,
      });
      enqueued++;
    } catch (e: any) {
      console.warn('[MomentArchive] 入队失败:', post.id, e?.message || String(e));
    }
  }

  if (enqueued) console.log(`🏰 [MomentArchive] 扫描到 ${enqueued} 条沉寂动态，已入队`);
  return enqueued;
}

/** 清掉某个角色的扫描节流记录（比如用户手动点了「立即归档」时） */
export function resetSweepThrottle(charId?: string): void {
  if (charId) lastSweepAt.delete(charId);
  else lastSweepAt.clear();
}
