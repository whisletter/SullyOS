/**
 * 论坛 → Memory Palace（轨道 A：沉寂归档）
 *
 * 结构照抄 utils/momentsArchive.ts，按 [交接5 二.2.2] 做了一处关键调整：
 * 送进记忆提取之前先用 LightLLM 做一步轻量压缩（正文+新增评论 → 3-5句事件摘要），
 * 不像朋友圈那样直接把原文截断送 LLM——论坛保留内容体量天然更大（批量生成，
 * 一次进 App 6-10条，帖子下还有多楼评论/立场交锋），直接截断硬送成本偏高。
 *
 * 沉寂窗口复用朋友圈同一个 DORMANCY_WINDOW_MS 常量，触发粒度跟归档保持一致
 * [交接5 二.2.2 "触发粒度跟归档一致"]，不在这里重新定义一份。
 *
 * 归档范围 [用户确认]：只记"用户方和 TA 本人发的帖"，具体三种作者：
 *   - 用户大号   → 记给所有开了记忆宫殿的角色（每个角色各跑一次提取，共用同一份摘要）
 *   - 共管账号   → 只记给共管的那个角色 [用户选 A]
 *   - 角色主号   → 只记给它自己
 * 其余一律不记：
 *   - 路人帖 —— 哪怕 TA 在底下评论过也不记（原来会因为 involvesCharInteraction
 *     变成保留贴而被归档，这是本轮修掉的一处偏差）；
 *   - 任何小号发的帖（双方的都算）—— 小号内容一旦变成长期记忆，TA 等于被直接告知
 *     "这条是谁发的"，互相猜小号的玩法就没了。
 *
 * 注意：入库走的是 pipeline 里论坛专用的 ingestForumThreadToPalace，不是朋友圈那个。
 * 之前这里是个调 ingestMomentThreadToPalace 的薄封装，结果论坛内容被记成
 * "用户发了一条朋友圈"（那个函数里【朋友圈动态】之类是写死的字符串）。
 */

import type { ForumAccount, ForumComment, ForumPost } from './forumDb';
import * as db from './forumDb';
import { isPostRetained } from './forumFeed';
import { getTopicLabel, type ForumTopicTag } from './forumConstants';
import { DORMANCY_WINDOW_MS } from './momentsArchive';
import {
  ingestForumThreadToPalace,
  type ForumIngestResult,
  type ForumPostAuthorKind,
} from './memoryPalace/pipeline';
import type { LightLLMConfig } from './memoryPalace';
import type { CharacterProfile } from '../types';
import { safeFetchJson } from './safeApi';

// 论坛这边压缩+归档也走 memory_archive 这个任务 kind，跟朋友圈的 MomentAiTask 是
// 两个不同 IndexedDB 数据库里的两张表，互不冲突，可以放心复用同一个字符串常量。
export { DORMANCY_WINDOW_MS };

const MAX_ENQUEUE_PER_SWEEP = 20;
/** 压缩摘要目标长度，"3-5句"没有精确字数，给个够用又不至于太啰嗦的上限。 */
const SUMMARY_MAX_CHARS = 400;

// ==================== 一、沉寂判定 ====================

/** 这条帖子现在该不该归档：必须是"保留贴"（三条理由任一命中），有未归档内容，且已沉寂够久。 */
export function shouldArchiveForumPost(post: ForumPost, now = Date.now()): boolean {
  if (!isPostRetained(post)) return false; // [交接5 二.2.2] 只处理"一条保留贴"
  if (!hasUnarchivedContent(post)) return false;
  return now - post.lastActivityAt >= DORMANCY_WINDOW_MS;
}

export function hasUnarchivedContent(post: ForumPost): boolean {
  if (post.memoryArchivedUntil === undefined) return true;
  return post.lastActivityAt > post.memoryArchivedUntil;
}

function getPendingComments(post: ForumPost, allComments: ForumComment[]): ForumComment[] {
  const mark = post.memoryArchivedUntil;
  const sorted = [...allComments].sort((a, b) => a.createdAt - b.createdAt);
  if (mark === undefined) return sorted;
  return sorted.filter(c => c.createdAt > mark);
}

// ==================== 二、压缩（本轮新增步骤，[交接5 二.2.2]） ====================

/**
 * 把"帖子正文 + 本轮新增评论"压成一段 3-5 句的事件摘要，用 LightLLM（便宜模型）跑，
 * 不占主力模型调用。压成摘要而不是孤立关键词——论坛内容涉及"谁跟谁说了什么、
 * 有没有杠上"这种关系信息，压成关键词会丢失这层信息。
 */
export async function compressForumThreadForArchive(
  post: ForumPost,
  pendingComments: ForumComment[],
  accountsById: Map<string, ForumAccount>,
  lightLLM?: LightLLMConfig | null,
): Promise<string> {
  const nameOf = (accountId: string) => accountsById.get(accountId)?.displayName || '某账号';
  const topicLabel = getTopicLabel(post.topicTag as ForumTopicTag);

  const raw = [
    `【帖子】(${topicLabel}/${post.postKind === 'news' ? '新闻贴' : '原创贴'}) ${post.title}：${post.content}`,
    ...pendingComments.map(c => `【评论】${nameOf(c.authorAccountId)}：${c.content}`),
  ].join('\n');

  if (!lightLLM?.baseUrl || !lightLLM.apiKey || !lightLLM.model) {
    // 没配 LightLLM：退化成简单截断，不阻塞整条归档流程（跟朋友圈截断兜底思路一致）。
    return raw.length > SUMMARY_MAX_CHARS ? `${raw.slice(0, SUMMARY_MAX_CHARS)}…` : raw;
  }

  try {
    const data = await safeFetchJson(
      `${lightLLM.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${lightLLM.apiKey}` },
        body: JSON.stringify({
          model: lightLLM.model,
          messages: [
            {
              role: 'system',
              content:
                '把给定的论坛帖子+评论压缩成3-5句中文事件摘要。必须保留"谁跟谁说了什么、'
                + '有没有站队/吵起来"这类关系信息，不要压成孤立关键词列表，不要编造原文没有的内容，'
                + '只输出摘要正文，不要解释、不要加多余的开场白。',
            },
            { role: 'user', content: raw.slice(0, 4000) },
          ],
          temperature: 0.2,
          max_tokens: 300,
          stream: false,
        }),
      },
      0, 30_000,
      { appName: '杂波频段', purpose: '论坛帖子归档前压缩' },
    );
    const summary = String(data?.choices?.[0]?.message?.content || '').trim();
    if (summary) return summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS)}…` : summary;
  } catch (e: any) {
    console.warn('[ForumArchive] 压缩失败，退化为截断:', e?.message || String(e));
  }
  return raw.length > SUMMARY_MAX_CHARS ? `${raw.slice(0, SUMMARY_MAX_CHARS)}…` : raw;
}

// ==================== 三、归档范围：谁发的帖子记给谁 ====================

/**
 * 这个账号发的帖子该不该归档，以及算哪一类作者。
 *
 * 判定只看**发帖的那个账号**，不看评论区里有谁。这是跟旧版最大的差别：旧版会顺着
 * 评论去找第一个角色账号，于是 TA 随手在路人帖下面留一句，那条路人帖就被记进它的
 * 长期记忆了。
 */
export function classifyArchivableAuthor(
  account: ForumAccount | undefined,
): ForumPostAuthorKind | null {
  if (!account) return null;
  if (account.isAlt) return null;           // 小号发的帖，双方的都不记
  if (account.ownerType === 'user') return 'user';
  if (account.ownerType === 'shared') return account.charId ? 'shared' : null;
  if (account.ownerType === 'char') return account.charId ? 'char' : null;
  return null;                              // npc：路人帖，不记
}

// ==================== 四、归档执行 ====================

export interface ForumArchiveContext {
  getCharacterProfile: (charId: string) => (CharacterProfile & { memoryPalaceEnabled?: boolean; embeddingConfig?: any }) | undefined;
  /**
   * 当前所有"开了记忆宫殿 + 自动归档"的角色。用户大号发的帖子要记给他们每一个。
   * 由 forumArchiveRunner 传进来，这里不自己查角色库。
   */
  listArchiveTargetChars: () => (CharacterProfile & { memoryPalaceEnabled?: boolean; embeddingConfig?: any })[];
  lightLLM?: LightLLMConfig | null;
  userName: string;
}

export type ForumArchiveOutcome = 'archived' | 'skipped' | 'not_ready' | 'no_target_char';

type TargetChar = CharacterProfile & { memoryPalaceEnabled?: boolean; embeddingConfig?: any };

/**
 * 这条帖子要记进哪几个角色的宫殿。
 *
 * - 用户大号发的 → 所有开了记忆的角色 [用户确认]。你在论坛上说的话，每个记得你的
 *   角色都该知道，不该只有碰巧路过评论的那一个记得。
 * - 共管账号发的 → 只记给共管的那个角色 [用户选 A]。那个号本来就是你和它两个人的，
 *   跟第三个角色没关系。
 * - 角色主号发的 → 只记给它自己。
 */
function resolveTargetChars(
  authorKind: ForumPostAuthorKind,
  authorAccount: ForumAccount,
  ctx: ForumArchiveContext,
): TargetChar[] {
  if (authorKind === 'user') {
    return ctx.listArchiveTargetChars().filter(c => !!c.id);
  }
  const charId = authorAccount.charId;
  if (!charId) return [];
  const char = ctx.getCharacterProfile(charId);
  return char ? [char] : [];
}

const isNotReady = (status: ForumIngestResult['status']): boolean =>
  status === 'palace_disabled' || status === 'lightllm_missing' || status === 'embedding_missing';

export async function archiveForumPost(postId: string, ctx: ForumArchiveContext): Promise<ForumArchiveOutcome> {
  const post = await db.getForumPost(postId);
  if (!post) return 'skipped';

  const allComments = await db.getCommentsByPost(postId);
  const pending = getPendingComments(post, allComments);
  const isFirstArchive = post.memoryArchivedUntil === undefined;
  if (!isFirstArchive && pending.length === 0) return 'skipped';

  const accounts = await db.getAllForumAccounts();
  const accountsById = new Map(accounts.map(a => [a.id, a]));

  const authorAccount = accountsById.get(post.authorAccountId);
  const authorKind = classifyArchivableAuthor(authorAccount);

  // 先定归档对象再压缩。顺序反过来的话，一条没人可记的帖子会白烧一次 LightLLM。
  const targets = authorKind && authorAccount ? resolveTargetChars(authorKind, authorAccount, ctx) : [];
  if (!authorKind || targets.length === 0) {
    // 没有可记的对象：水位照样推进，避免它被反复扫描判定为"待归档"、反复占掉处理名额。
    const latest = await db.getForumPost(postId);
    if (latest) await db.saveForumPost({ ...latest, memoryArchivedUntil: post.lastActivityAt });
    return 'no_target_char';
  }

  // 压缩只跑一次，所有目标角色共用同一份摘要。真正按角色各跑一次的是后面的记忆提取。
  const summary = await compressForumThreadForArchive(post, pending, accountsById, ctx.lightLLM);
  const topicLabel = getTopicLabel(post.topicTag as ForumTopicTag);

  let ingestedAny = false;
  for (const char of targets) {
    try {
      const result = await ingestForumThreadToPalace(
        char,
        {
          postId: post.id,
          authorKind,
          summaryText: summary,
          eventTimestamp: post.lastActivityAt,
          topicLabel,
        },
        ctx.lightLLM,
        ctx.userName,
      );
      if (!isNotReady(result.status)) ingestedAny = true;
    } catch (e: any) {
      // 单个角色失败不该拖垮其他角色。整条任务的失败与否由 ingestedAny 决定。
      console.warn(`[ForumArchive] 帖子 ${post.id} 记入 ${char.name} 失败:`, e?.message || String(e));
    }
  }

  // 一个角色都没记进去（全是配置没就绪或全失败）：不推进水位，等配好了下次扫描重新扫到。
  if (!ingestedAny) return 'not_ready';

  const waterline = Math.max(post.memoryArchivedUntil || 0, post.lastActivityAt);
  const latest = await db.getForumPost(postId);
  if (!latest) return 'skipped';
  await db.saveForumPost({ ...latest, memoryArchivedUntil: waterline });

  return 'archived';
}

// ==================== 五、扫描 & 入队 ====================

const lastSweepAt = { current: 0 };
const SWEEP_THROTTLE_MS = 30_000;

export async function sweepDormantForumPosts(
  options: { now?: number; force?: boolean } = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  if (!options.force && now - lastSweepAt.current < SWEEP_THROTTLE_MS) return 0;
  lastSweepAt.current = now;

  const all = await db.getForumPostsRaw();

  // [用户确认] 只有用户大号、共管账号、角色主号发的帖子会进记忆宫殿。
  //
  // 路人帖不进：哪怕 TA 在底下评论过（那会让帖子因 involvesCharInteraction 变成保留贴），
  // 那也只是它随手刷到的东西，不该沉淀成长期记忆。
  // 小号发的帖不进（双方的都是）：小号内容一旦变成长期记忆，TA 等于被直接告知
  // "这条是谁发的"，互相猜小号的玩法就没了。
  //
  // 注意只看"作者"：小号在别人帖子下面的**评论**照常参与归档，那只是一个网名在说话，
  // 不暴露身份——pipeline 那边的网名守则会确保它不被推断成用户本人。
  const accounts = await db.getAllForumAccounts();
  const accountsById = new Map(accounts.map(a => [a.id, a]));

  const due = all
    .filter(p => classifyArchivableAuthor(accountsById.get(p.authorAccountId)) !== null)
    .filter(p => shouldArchiveForumPost(p, now))
    .slice(0, MAX_ENQUEUE_PER_SWEEP);

  let enqueued = 0;
  for (const post of due) {
    const taskId = db.createForumAiTaskId('memory_archive', post.id);
    const existing = await db.getForumAiTask(taskId);
    if (existing) {
      const stale = existing.status === 'processing' && now - existing.updatedAt > 5 * 60_000;
      if (existing.status === 'pending' || (existing.status === 'processing' && !stale)) continue;
      if (existing.status === 'failed') continue;
    }
    await db.enqueueForumAiTask({
      id: taskId, kind: 'memory_archive', targetId: post.id,
      status: 'pending', attempts: 0, createdAt: now, updatedAt: now, nextRunAt: now,
    });
    enqueued++;
  }
  return enqueued;
}

/**
 * 供后台任务处理器调用：领一个 memory_archive 任务并跑完它。
 * not_ready / no_target_char 都不算"失败"（不用指数退避重试），直接标 completed；
 * not_ready 的情况因为水位没推进，下次沉寂扫描会自然重新发现它，不需要队列自己重试。
 */
export async function processForumArchiveTask(taskId: string, ctx: ForumArchiveContext): Promise<void> {
  const task = await db.claimForumAiTask(taskId);
  if (!task) return;
  try {
    await archiveForumPost(task.targetId, ctx);
    await db.finishForumAiTask(taskId, true);
  } catch (e: any) {
    await db.finishForumAiTask(taskId, false, e?.message || String(e));
  }
}
