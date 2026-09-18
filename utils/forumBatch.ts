/**
 * 论坛 · 分区配额批量生成
 *
 * 替代 forumAi.runBatchGeneration 的"让模型自由发挥话题"写法，改成按分区下配额：
 * 明确告诉模型"社会时事 1 条、美食 1 条、游戏 1 条…"，否则模型会扎堆在几个好写的
 * 话题上，17 个分区里十来个是空的（这正是"分区页没有帖子"的直接原因）。
 *
 * 两个入口：
 *   - runQuotaBatch：进 App / 主页🔄。默认全部 17 个分区各 1 条，其中随机 5 条各配
 *     1 条评论。一次调用，输出约 5500 token，在 8192 上限下有安全余量。
 *   - runTopicRefresh：分区页🔄。只刷当前这一个分区，默认 5 条。一次调用。
 *
 * 为什么不把评论一次配满：单条帖子带 3-4 条评论楼时体积要 500-600 output token，
 * 17 条就是一万往上，必然被截断成半截 JSON 而整批丢失。评论改成在帖子详情页点🔄
 * 时按需生成（走 forumAi.runPostRefresh），只为真正打开的帖子花钱。
 *
 * 注：callForumAI / describeAccountForPrompt 与 forumAi.ts 里的同名实现重复，是刻意的
 * 取舍——那两个在 forumAi.ts 里没有 export，为了不大改那个文件（改动面越大越难排查），
 * 这里先各留一份。等这一轮验证稳定后可以合并到一处。
 */

import { safeFetchJson, extractJson } from './safeApi';
import * as db from './forumDb';
import type { ForumAccount, ForumPost } from './forumDb';
import * as feed from './forumFeed';
import type { ForumApiConfig } from './forumAi';
import { ensureNpcPool } from './forumNpcSeed';
import {
  FORUM_TOPIC_TAGS, type ForumTopicTag,
  FORUM_PERSONA_ARCHETYPES,
  buildSharedForumHardRules, FORUM_NEWS_AUTHENTICITY_RULE,
} from './forumConstants';
import type { HotNewsItem } from '../types';

// ==================== 可调参数 ====================

/** 模型单次输出上限。这是整个方案的硬边界：超了就是半截 JSON，整批作废。
 *  如果确认所用模型支持更大的输出，可以调高，然后相应提高每次调用的帖子数。 */
const MAX_OUTPUT_TOKENS = 8192;

/** 进 App / 主页🔄：每个分区几条。 */
export const POSTS_PER_TOPIC_ON_BATCH = 1;

/** 进 App / 主页🔄：随机给几条帖子各配 1 条评论，让首页有疏有密。 */
export const COMMENTED_POSTS_ON_BATCH = 5;

/** 分区页🔄：单个分区刷几条。 */
export const POSTS_PER_TOPIC_REFRESH = 5;

/** 时间戳打散窗口：整批生成铺在过去 2 小时内，单分区刷新铺在过去 15 分钟内。
 *  不打散的话一批帖子时间戳完全相同，主页混合流会变成"美食美食美食、科技科技科技"
 *  这样按分区码放的货架，一眼假；而且分页游标靠 createdAt 比较，同值会漏帖。 */
const SCATTER_WINDOW_BATCH_MS = 2 * 60 * 60 * 1000;
const SCATTER_WINDOW_REFRESH_MS = 15 * 60 * 1000;

const AI_MAX_RETRIES = 2;

// ==================== 诊断记录 ====================

/**
 * 记录最近一次生成到底发生了什么。手机上看不到控制台，出问题时只能靠这个在
 * 设置页里把中间过程摊开：池子多大、模型返回了多长、解析出几条、被什么理由刷掉的。
 */
export interface BatchDiagnostics {
  at: number;
  npcPoolSize: number;
  rosterSize: number;
  expected: number;
  /** 模型返回的原始字符数。0 = 模型什么都没返回。 */
  rawChars: number;
  /** 原始返回的开头一段，用来肉眼判断是不是被截断/返回了报错文本。 */
  rawHead: string;
  /** JSON 解析后 posts 数组的长度。 */
  parsedPostCount: number;
  /** 通过校验、准备落库的条数。 */
  acceptedCount: number;
  /** 被刷掉的理由统计。 */
  rejectReasons: string[];
  savedCount: number;
  error?: string;
}

let lastDiagnostics: BatchDiagnostics | null = null;

export function getLastBatchDiagnostics(): BatchDiagnostics | null {
  return lastDiagnostics;
}

// ==================== 调用约定（同 forumAi 的 callForumAI） ====================

async function callForumAI(apiConfig: ForumApiConfig, prompt: string, purpose: string): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt++) {
    try {
      const data = await safeFetchJson(
        `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
          body: JSON.stringify({
            model: apiConfig.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.9,
            max_tokens: MAX_OUTPUT_TOKENS,
            stream: false,
            response_format: { type: 'json_object' },
          }),
        },
        2, 0, { appName: '杂波频段', purpose },
      );
      return data?.choices?.[0]?.message?.content?.trim() || '';
    } catch (e: any) {
      lastError = e;
      const isNetwork = e?.name === 'AbortError' || e?.message?.includes('fetch') || e?.message?.includes('network');
      if (isNetwork && attempt < AI_MAX_RETRIES) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError || new Error('论坛AI请求失败');
}

function describeAccountForPrompt(account: ForumAccount): string {
  const persona = account.personaArchetype
    ? FORUM_PERSONA_ARCHETYPES.find(p => p.id === account.personaArchetype)
    : undefined;
  const badges = [
    account.isVerified ? '蓝V认证官方号' : undefined,
    persona ? `说话风格:${persona.label}——${persona.promptDescription}` : undefined,
  ].filter(Boolean).join('；');
  return `- handle=${account.handle}（${account.displayName}）${badges ? `：${badges}` : ''}`;
}

// ==================== 工具 ====================

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * 生成一批互不相同的时间戳，铺在 now 往前 windowMs 的区间内，返回时按升序。
 * 保证互不相同：分页游标是"比上一页最后一条的 createdAt 更早"，时间戳撞车会让
 * 同值的兄弟帖在翻页时被整体跳过。
 */
function scatterTimestamps(count: number, now: number, windowMs: number): number[] {
  const set = new Set<number>();
  let guard = 0;
  while (set.size < count && guard < count * 50) {
    set.add(now - Math.floor(Math.random() * windowMs));
    guard++;
  }
  // 极端情况下没凑够（窗口太小），往前顺延补齐，仍然保证唯一
  let filler = now - windowMs - 1;
  while (set.size < count) { set.add(filler); filler -= 1000; }
  return Array.from(set).sort((a, b) => a - b);
}

/**
 * 按这次要生成的分区挑选账号池：每个分区优先挑圈子标签命中该分区的号，不够就随机补。
 * 这样"美食区的帖子"更可能出自一个真的挂着美食标签的号，而不是随机路人。
 */
function pickRosterForTopics(
  npcAccounts: ForumAccount[],
  topics: ForumTopicTag[],
  totalPosts: number,
  perTopic = 2,
): ForumAccount[] {
  const chosen = new Map<string, ForumAccount>();

  for (const topic of topics) {
    const matching = shuffle(npcAccounts.filter(a =>
      (a.cliqueTags || []).includes(topic) && !chosen.has(a.id)
    ));
    for (const acc of matching.slice(0, perTopic)) chosen.set(acc.id, acc);
  }

  // 候选池规模要同时看"几个分区"和"一共几条帖"——单分区刷 5 条时，只按分区数算的话
  // 池子里只有 2 个号，5 条帖会全出自同两个人，看着就假。
  const wanted = Math.min(
    npcAccounts.length,
    Math.max(topics.length * perTopic, totalPosts * 2, 8),
  );
  if (chosen.size < wanted) {
    const rest = shuffle(npcAccounts.filter(a => !chosen.has(a.id)));
    for (const acc of rest.slice(0, wanted - chosen.size)) chosen.set(acc.id, acc);
  }

  return Array.from(chosen.values());
}

// ==================== Prompt ====================

export interface TopicQuota {
  tag: ForumTopicTag;
  count: number;
}

function buildQuotaPrompt(opts: {
  quotas: TopicQuota[];
  roster: ForumAccount[];
  hotNewsItems: HotNewsItem[];
  commentedPostCount: number;
}): string {
  const { quotas, roster, hotNewsItems, commentedPostCount } = opts;

  const totalPosts = quotas.reduce((sum, q) => sum + q.count, 0);

  const quotaBlock = quotas.map(q => {
    const label = FORUM_TOPIC_TAGS.find(t => t.tag === q.tag)?.label || q.tag;
    return `- ${q.tag}（${label}）：${q.count} 条`;
  }).join('\n');

  const newsBlock = hotNewsItems.length > 0
    ? hotNewsItems.slice(0, 12).map((n, i) =>
        `${i + 1}. 《${n.title}》${n.source ? `（来源:${n.source}）` : ''}${n.url ? ` url:${n.url}` : ''}`
      ).join('\n')
    : '（这个时段没有可用的真实热点，这次全部产出 organic 原创贴，不要生成 news 贴）';

  return `
你不是某个角色，也不是玩家，你是这个论坛世界的"内容生成器"。这次要一次性批量产出一批帖子，
模拟一个真实、混杂、有的冷清有的热闹的论坛此刻的样子。

=== 本次可用的账号池（只能用下面这些 handle 当作者，不能编不存在的账号）===
${roster.map(describeAccountForPrompt).join('\n')}

=== 真实热点新闻条目（仅供 postKind='news' 的帖子使用）===
${newsBlock}

${buildSharedForumHardRules()}

${FORUM_NEWS_AUTHENTICITY_RULE}

=== 分区配额（必须严格按这个数量产出，一条不多一条不少）===
${quotaBlock}

一共 ${totalPosts} 条帖子。每条帖子的 topicTag 必须精确等于上面配额里对应的那个英文 key。

=== 评论要求 ===
这批帖子里**只有大约 ${commentedPostCount} 条**各配 1 条评论，其余帖子的 comments 一律是空数组 []。
真实论坛本来就是大部分帖子没人理、少数几条有人接，不要每条都配评论。
配评论的那几条，评论者必须是账号池里**另一个**账号，不能自己评论自己。

=== 写作要求 ===
- 正文控制在 150 字以内，像随手发的帖子，不要写成小作文。
- 标题可以口语化、可以是半句话，不要每条都工整对仗。
- 不同分区的语气差别要明显：财经区和搞笑玩梗区不该是同一个人在说话。
- 允许有几条是很短、很随意、没什么信息量的帖子——论坛里这种最多。

请只返回 JSON：
{
  "posts": [
    {
      "authorHandle": "账号handle",
      "postKind": "news 或 organic",
      "topicTag": "话题tag英文key",
      "title": "帖子标题",
      "content": "帖子正文",
      "sourceNewsUrl": "仅news贴填，照抄给你的url",
      "sourceNewsTitle": "仅news贴填，照抄给你的新闻标题",
      "comments": [{ "authorHandle": "评论者handle", "content": "评论内容" }]
    }
  ]
}
`.trim();
}

// ==================== 解析 ====================

interface QuotaDraft {
  authorHandle: string;
  postKind: 'news' | 'organic';
  topicTag: ForumTopicTag;
  title: string;
  content: string;
  sourceNewsUrl?: string;
  sourceNewsTitle?: string;
  comment?: { authorHandle: string; content: string };
}

function normalizeQuotaDrafts(
  raw: any,
  validHandles: Set<string>,
  commentedPostCount: number,
  reasons: string[],
): QuotaDraft[] {
  const posts = Array.isArray(raw?.posts) ? raw.posts : [];
  if (!Array.isArray(raw?.posts)) reasons.push('返回里没有 posts 数组');
  const out: QuotaDraft[] = [];
  let commentBudget = commentedPostCount;
  let badHandle = 0;
  let emptyContent = 0;

  for (const p of posts) {
    if (!p || typeof p !== 'object') continue;
    const authorHandle = String(p.authorHandle || '');
    if (!validHandles.has(authorHandle)) { badHandle++; continue; }

    const content = String(p.content || '').slice(0, 5000);
    if (!content.trim()) { emptyContent++; continue; }

    const postKind: 'news' | 'organic' = p.postKind === 'news' ? 'news' : 'organic';
    const topicTag = (FORUM_TOPIC_TAGS.some(t => t.tag === p.topicTag) ? p.topicTag : 'daily_chatter') as ForumTopicTag;

    // 每帖最多收 1 条评论，且全批总数不超过预算——模型经常忍不住给每条都配评论
    let comment: QuotaDraft['comment'];
    if (commentBudget > 0 && Array.isArray(p.comments)) {
      const candidate = p.comments.find((c: any) =>
        c && validHandles.has(String(c.authorHandle || ''))
        && String(c.authorHandle) !== authorHandle
        && String(c.content || '').trim()
      );
      if (candidate) {
        comment = { authorHandle: String(candidate.authorHandle), content: String(candidate.content).slice(0, 2000) };
        commentBudget--;
      }
    }

    out.push({
      authorHandle, postKind, topicTag,
      title: String(p.title || '').slice(0, 100),
      content,
      sourceNewsUrl: postKind === 'news' && p.sourceNewsUrl ? String(p.sourceNewsUrl) : undefined,
      sourceNewsTitle: postKind === 'news' && p.sourceNewsTitle ? String(p.sourceNewsTitle) : undefined,
      comment,
    });
  }

  if (badHandle > 0) reasons.push(`${badHandle} 条的作者 handle 不在账号池里（模型自己编了账号）`);
  if (emptyContent > 0) reasons.push(`${emptyContent} 条正文是空的`);
  return out;
}

// ==================== 落库 ====================

async function persistDrafts(
  drafts: QuotaDraft[],
  accountByHandle: Map<string, ForumAccount>,
  scatterWindowMs: number,
): Promise<ForumPost[]> {
  const now = Date.now();
  const stamps = scatterTimestamps(drafts.length, now, scatterWindowMs);
  const created: ForumPost[] = [];

  for (let i = 0; i < drafts.length; i++) {
    const draft = drafts[i];
    const authorAccount = accountByHandle.get(draft.authorHandle);
    if (!authorAccount) continue;

    const createdAt = stamps[i];
    const post: ForumPost = {
      id: db.createForumPostId(),
      authorAccountId: authorAccount.id,
      postKind: draft.postKind,
      topicTag: draft.topicTag,
      title: draft.title,
      content: draft.content,
      sourceNewsUrl: draft.sourceNewsUrl,
      sourceNewsTitle: draft.sourceNewsTitle,
      createdAt,
      lastActivityAt: createdAt,
      isCollected: false,
      involvesCharInteraction: false,
      isOwnedByUserSide: false,
      likes: [],
      visibility: 'public',
    };
    await feed.createPost(post);

    if (draft.comment) {
      const commenter = accountByHandle.get(draft.comment.authorHandle);
      if (commenter) {
        // 评论晚于帖子 1-30 分钟，但不能穿越到未来
        const commentAt = Math.min(now, createdAt + 60_000 + Math.floor(Math.random() * 29 * 60_000));
        await feed.appendComment(post.id, {
          authorAccountId: commenter.id,
          content: draft.comment.content,
          createdAt: commentAt,
        });
      }
    }

    created.push(post);
  }

  return created;
}

// ==================== 生成主流程 ====================

interface GenerateParams {
  apiConfig: ForumApiConfig;
  hotNewsItems: HotNewsItem[];
  quotas: TopicQuota[];
  commentedPostCount: number;
  scatterWindowMs: number;
  purpose: string;
  /** 内部递归用：截断降级时把配额拆两半重试，只降一级，避免无限拆分。 */
  depth?: number;
}

async function generate(params: GenerateParams): Promise<ForumPost[]> {
  const { apiConfig, hotNewsItems, quotas, commentedPostCount, scatterWindowMs, purpose, depth = 0 } = params;
  if (quotas.length === 0) return [];

  // 自愈：任何入口进来都先确认路人池存在。池子空的时候整条链路会静默空转，
  // 这正是"点刷新没反应"的根因，所以在最靠近生成的地方兜一道。
  await ensureNpcPool();

  const npcAccounts = await db.getActiveNpcAccounts();

  const expected = quotas.reduce((sum, q) => sum + q.count, 0);
  const report: BatchDiagnostics = {
    at: Date.now(),
    npcPoolSize: npcAccounts.length,
    rosterSize: 0,
    expected,
    rawChars: 0,
    rawHead: '',
    parsedPostCount: 0,
    acceptedCount: 0,
    rejectReasons: [],
    savedCount: 0,
  };
  if (depth === 0) lastDiagnostics = report;

  if (npcAccounts.length === 0) {
    report.error = '路人账号池是空的（建号这一步就失败了）';
    throw new Error('路人账号池是空的，无法生成内容');
  }

  const roster = pickRosterForTopics(npcAccounts, quotas.map(q => q.tag), expected);
  report.rosterSize = roster.length;
  const validHandles = new Set(roster.map(a => a.handle));
  const accountByHandle = new Map(roster.map(a => [a.handle, a]));
  const prompt = buildQuotaPrompt({ quotas, roster, hotNewsItems, commentedPostCount });

  let raw = '';
  try {
    raw = await callForumAI(apiConfig, prompt, purpose);
  } catch (e: any) {
    report.error = `请求模型失败：${e?.message || String(e)}`;
    throw e;
  }
  report.rawChars = raw.length;
  report.rawHead = raw.slice(0, 300);
  if (!raw) report.rejectReasons.push('模型返回是空的');

  let drafts: QuotaDraft[] = [];
  try {
    const parsed = extractJson<any>(raw);
    report.parsedPostCount = Array.isArray(parsed?.posts) ? parsed.posts.length : 0;
    drafts = normalizeQuotaDrafts(parsed, validHandles, commentedPostCount, report.rejectReasons);
  } catch (e: any) {
    report.rejectReasons.push(`JSON 解析失败：${e?.message || String(e)}`);
    console.warn('[ForumBatch] JSON 解析失败:', e?.message || String(e));
  }
  report.acceptedCount = drafts.length;

  // 截断降级：解析失败或产出明显少于配额，多半是输出被 max_tokens 剪断。
  // 把配额拆成两半各跑一次，单次输出减半就不会再撞上限。只降一级。
  if (depth === 0 && quotas.length > 1 && drafts.length < Math.ceil(expected / 2)) {
    console.warn(`[ForumBatch] 产出 ${drafts.length}/${expected}，疑似输出被截断，拆半重试`);
    const mid = Math.ceil(quotas.length / 2);
    const halves = [quotas.slice(0, mid), quotas.slice(mid)];
    const results = await Promise.all(halves.map(half =>
      generate({
        ...params,
        quotas: half,
        commentedPostCount: Math.ceil(commentedPostCount / 2),
        depth: 1,
      }).catch(e => {
        console.warn('[ForumBatch] 拆半重试的一半失败:', e?.message || String(e));
        return [] as ForumPost[];
      })
    ));
    const merged = results.flat();
    report.savedCount = merged.length;
    report.rejectReasons.push(`产出少于配额，已拆成 ${halves.length} 次重试，最终存下 ${merged.length} 条`);
    return merged;
  }

  const saved = await persistDrafts(drafts, accountByHandle, scatterWindowMs);
  report.savedCount = saved.length;
  return saved;
}

// ==================== 对外入口 ====================

/**
 * 进 App（每个 slot 一次）/ 主页🔄：全部 17 个分区各 1 条，随机若干条配 1 条评论。
 * 一次调用。
 */
export async function runQuotaBatch(params: {
  apiConfig: ForumApiConfig;
  hotNewsItems: HotNewsItem[];
  postsPerTopic?: number;
  commentedPostCount?: number;
}): Promise<ForumPost[]> {
  const postsPerTopic = params.postsPerTopic ?? POSTS_PER_TOPIC_ON_BATCH;
  const quotas: TopicQuota[] = FORUM_TOPIC_TAGS.map(t => ({ tag: t.tag, count: postsPerTopic }));

  return generate({
    apiConfig: params.apiConfig,
    hotNewsItems: params.hotNewsItems,
    quotas,
    commentedPostCount: params.commentedPostCount ?? COMMENTED_POSTS_ON_BATCH,
    scatterWindowMs: SCATTER_WINDOW_BATCH_MS,
    purpose: '论坛分区配额批量生成',
  });
}

/** 分区页🔄：只刷当前这一个分区。一次调用。 */
export async function runTopicRefresh(params: {
  apiConfig: ForumApiConfig;
  hotNewsItems: HotNewsItem[];
  topicTag: ForumTopicTag;
  count?: number;
}): Promise<ForumPost[]> {
  const count = params.count ?? POSTS_PER_TOPIC_REFRESH;

  return generate({
    apiConfig: params.apiConfig,
    hotNewsItems: params.hotNewsItems,
    quotas: [{ tag: params.topicTag, count }],
    // 单分区 5 条里配 2 条评论，比例跟整批生成大致一致
    commentedPostCount: 2,
    scatterWindowMs: SCATTER_WINDOW_REFRESH_MS,
    purpose: '论坛单分区刷新生成',
  });
}
