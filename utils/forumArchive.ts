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
 * pipeline.ts 本身不用改：ingestForumThreadToPalace 只是新起的一个薄封装，
 * 内部直接调用现成的 ingestMomentThreadToPalace（它的入参字段本来就是通用命名，
 * 不含"朋友圈专属"语义，可以直接喂论坛数据）。
 */

import type { ForumAccount, ForumComment, ForumPost } from './forumDb';
import * as db from './forumDb';
import { isPostRetained } from './forumFeed';
import { getTopicLabel, type ForumTopicTag } from './forumConstants';
import { DORMANCY_WINDOW_MS } from './momentsArchive';
import { ingestMomentThreadToPalace, type MomentThreadIngestInput, type MomentIngestResult } from './memoryPalace/pipeline';
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

// ==================== 三、新起的薄封装：ingestForumThreadToPalace ====================

/**
 * [交接5 二.2.2] "结构照抄 ingestMomentThreadToPalace"——直接调用现成函数，
 * 每一轮都把这一轮的压缩摘要当作一条独立 fake message 喂进去（includeBodyAsMessage
 * 恒为 true，因为每轮摘要内容本来就只覆盖这一轮的新增部分，不是要反复重喂同一段原文）。
 */
export async function ingestForumThreadToPalace(
  char: { id: string; name: string; memoryPalaceEnabled?: boolean; embeddingConfig?: any; systemPrompt?: string; worldview?: string },
  postId: string,
  summaryText: string,
  postAuthorIsUser: boolean,
  eventTimestamp: number,
  lightLLMConfig: LightLLMConfig | null | undefined,
  userName: string,
): Promise<MomentIngestResult> {
  const input: MomentThreadIngestInput = {
    postId,
    postAuthorIsUser,
    postBodyText: summaryText,
    postCreatedAt: eventTimestamp,
    includeBodyAsMessage: true,
    comments: [], // 已经在压缩阶段把评论并进 summaryText 里了，这里不重复传
  };
  return ingestMomentThreadToPalace(char, input, lightLLMConfig, userName);
}

// ==================== 四、归档执行 ====================

export interface ForumArchiveContext {
  getCharacterProfile: (charId: string) => (CharacterProfile & { memoryPalaceEnabled?: boolean; embeddingConfig?: any }) | undefined;
  lightLLM?: LightLLMConfig | null;
  userName: string;
}

export type ForumArchiveOutcome = 'archived' | 'skipped' | 'not_ready' | 'no_target_char';

/** 找这条帖子归档时该记进哪个角色的记忆宫殿：author 优先，否则找评论里第一个 char/shared 账号。 */
function resolveTargetCharId(
  post: ForumPost,
  comments: ForumComment[],
  accountsById: Map<string, ForumAccount>,
): string | null {
  const author = accountsById.get(post.authorAccountId);
  if (author && (author.ownerType === 'char' || author.ownerType === 'shared') && author.charId) {
    return author.charId;
  }
  for (const c of comments) {
    const acc = accountsById.get(c.authorAccountId);
    if (acc && (acc.ownerType === 'char' || acc.ownerType === 'shared') && acc.charId) return acc.charId;
  }
  return null; // 纯路人帖子，没有任何 char/shared 账号参与，没有对应的记忆宫殿可记
}

export async function archiveForumPost(postId: string, ctx: ForumArchiveContext): Promise<ForumArchiveOutcome> {
  const post = await db.getForumPost(postId);
  if (!post) return 'skipped';

  const allComments = await db.getCommentsByPost(postId);
  const pending = getPendingComments(post, allComments);
  const isFirstArchive = post.memoryArchivedUntil === undefined;
  if (!isFirstArchive && pending.length === 0) return 'skipped';

  const accounts = await db.getAllForumAccounts();
  const accountsById = new Map(accounts.map(a => [a.id, a]));

  const targetCharId = resolveTargetCharId(post, allComments, accountsById);
  if (!targetCharId) {
    // 没有可记的对象：水位照样推进，避免这条纯路人帖子被反复扫描判定为"待归档"。
    const latest = await db.getForumPost(postId);
    if (latest) await db.saveForumPost({ ...latest, memoryArchivedUntil: post.lastActivityAt });
    return 'no_target_char';
  }

  const char = ctx.getCharacterProfile(targetCharId);
  if (!char) return 'no_target_char';

  const summary = await compressForumThreadForArchive(post, pending, accountsById, ctx.lightLLM);

  const authorAccount = accountsById.get(post.authorAccountId);
  const postAuthorIsUser = authorAccount?.ownerType === 'user' || authorAccount?.ownerType === 'shared';

  const result = await ingestForumThreadToPalace(
    char, post.id, summary, postAuthorIsUser, post.lastActivityAt, ctx.lightLLM, ctx.userName,
  );

  if (result.status === 'palace_disabled' || result.status === 'lightllm_missing' || result.status === 'embedding_missing') {
    return 'not_ready'; // 配置没就绪：不推进水位，等配好了下次扫描重新扫到
  }

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
  const due = all.filter(p => shouldArchiveForumPost(p, now)).slice(0, MAX_ENQUEUE_PER_SWEEP);

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
