/**
 * 论坛 · AI 生成层
 *
 * 调用约定完全照抄 apps/LifeSimApp.tsx 里的 callCharAI：OpenAI 兼容
 * `${baseUrl}/chat/completions`，response_format: json_object，重试2次。
 * prompt 拼装风格照抄 utils/lifeSimPrompts.ts 的 buildWorldDramaPlannerPrompt
 * （大段中文说明 + 结构化上下文 + 末尾"请只返回 JSON"schema）。
 *
 * 覆盖四个生成场景：
 *   一、批量生成（自然触发 / 手动刷新）[交接1 论坛话题内容生成策略 + 交接4 一/二]
 *   二、帖子级"刷新"合并（新装饰评论 + 垫底楼回复）[交接4 二]
 *   三、DM ⚡ 手动触发回复 [交接4 三 / 交接5 4.6]
 *   四、共管账号4档专属动态 [交接5 4.9]
 */

import { safeFetchJson, extractJson } from './safeApi';
import * as db from './forumDb';
import type { ForumAccount, ForumPost, ForumComment } from './forumDb';
import * as feed from './forumFeed';
import type { PendingFloor } from './forumFeed';
import {
  FORUM_TOPIC_TAGS, type ForumTopicTag,
  FORUM_PERSONA_ARCHETYPES, getPersonaLabel,
  getForumProfessionLabel,
  buildSharedForumHardRules, FORUM_NEWS_AUTHENTICITY_RULE,
  FORUM_DEFAULTS,
} from './forumConstants';
import type { HotNewsItem } from '../types';

// ==================== 调用约定 ====================

export interface ForumApiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const AI_MAX_RETRIES = 2;

async function callForumAI(apiConfig: ForumApiConfig, systemPrompt: string, purpose: string): Promise<string> {
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
            messages: [{ role: 'user', content: systemPrompt }],
            temperature: 0.9, max_tokens: 8192, stream: false,
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

function pickInRange([min, max]: [number, number]): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// ==================== NPC 抽取：70/30 偏好加权 [交接1 论坛话题内容生成策略] ====================

/**
 * 从 NPC 池里为这次批量生成抽取候选。约70%按用户偏好标签（=圈子标签复用同一套
 * taxonomy）加权抽，30%走原本随机，避免完全信息茧房化。
 */
export function pickNpcPoolForBatch(
  npcAccounts: ForumAccount[],
  userPreferenceTags: ForumTopicTag[],
  count: number,
  weightedRatio = FORUM_DEFAULTS.npcPickWeightedRatio,
): ForumAccount[] {
  if (npcAccounts.length <= count) return [...npcAccounts];

  const preferred = npcAccounts.filter(a => (a.cliqueTags || []).some(t => userPreferenceTags.includes(t as ForumTopicTag)));
  const rest = npcAccounts.filter(a => !preferred.includes(a));

  const weightedCount = userPreferenceTags.length > 0 ? Math.round(count * weightedRatio) : 0;
  const randomCount = count - weightedCount;

  const shuffle = <T,>(arr: T[]) => [...arr].sort(() => Math.random() - 0.5);
  const fromPreferred = shuffle(preferred.length > 0 ? preferred : npcAccounts).slice(0, weightedCount);
  const remainingPool = npcAccounts.filter(a => !fromPreferred.includes(a));
  const fromRandom = shuffle(remainingPool).slice(0, randomCount);

  const picked = [...fromPreferred, ...fromRandom];
  // 万一因为候选不够没凑够，从剩余池里补齐
  if (picked.length < count) {
    const pickedIds = new Set(picked.map(a => a.id));
    const filler = shuffle(npcAccounts.filter(a => !pickedIds.has(a.id))).slice(0, count - picked.length);
    picked.push(...filler);
  }
  return picked;
}

function describeAccountForPrompt(account: ForumAccount): string {
  const persona = account.personaArchetype
    ? FORUM_PERSONA_ARCHETYPES.find(p => p.id === account.personaArchetype)
    : undefined;
  const professionLabel = account.profession ? getForumProfessionLabel(account.profession as any) : undefined;
  const badges = [
    account.isVerified ? '蓝V认证官方号' : undefined,
    professionLabel ? `职业:${professionLabel}` : undefined,
    persona ? `说话风格:${persona.label}——${persona.promptDescription}` : undefined,
  ].filter(Boolean).join('；');
  return `- handle=${account.handle}（${account.displayName}）${badges ? `：${badges}` : ''}`;
}

// ==================== 一、批量生成（自然触发 / 手动刷新） ====================

export interface ForumBatchPostDraft {
  authorHandle: string;
  postKind: 'news' | 'organic';
  topicTag: ForumTopicTag;
  title: string;
  content: string;
  sourceNewsUrl?: string;
  sourceNewsTitle?: string;
  comments: {
    authorHandle: string;
    content: string;
    /** 引用同一条帖子 comments 数组里更早一条的下标，用于楼中楼吵起来的效果；不填=顶层评论。 */
    replyToIndex?: number;
  }[];
}

function buildBatchGenerationPrompt(opts: {
  hotNewsItems: HotNewsItem[];
  npcRoster: ForumAccount[];
  userPreferenceTags: ForumTopicTag[];
  postCount: number;
  commentRange: [number, number];
}): string {
  const { hotNewsItems, npcRoster, userPreferenceTags, postCount, commentRange } = opts;

  const newsBlock = hotNewsItems.length > 0
    ? hotNewsItems.map((n, i) => `${i + 1}. 《${n.title}》${n.source ? `（来源:${n.source}）` : ''}${n.url ? ` url:${n.url}` : ''}${n.desc ? `\n   要点: ${n.desc}` : ''}`).join('\n')
    : '（这个时段没有可用的真实热点，这次全部产出 organic 原创贴，不要生成 news 贴）';

  const npcBlock = npcRoster.map(describeAccountForPrompt).join('\n');
  const topicBlock = FORUM_TOPIC_TAGS.map(t => `${t.tag}(${t.label})`).join('、');
  const preferenceBlock = userPreferenceTags.length > 0
    ? `用户这次的偏好标签：${userPreferenceTags.join('、')}（可以但不必每条都往这个方向靠，只是权重参考）`
    : '用户没有设置偏好标签，正常自由发挥即可';

  return `
你不是某个角色，也不是玩家，你是这个论坛世界的"内容生成器"。这次要一次性批量产出
一批帖子（含帖子下面的评论），模拟一个真实、混杂、有的冷清有的热闹的论坛此刻的样子。

=== 本次可用的 NPC 账号池（只能用下面这些 handle 当作者，不能编不存在的账号）===
${npcBlock}

=== 真实热点新闻条目（仅供 postKind='news' 的帖子使用）===
${newsBlock}

=== 用户偏好 ===
${preferenceBlock}

=== 可用话题分类（topicTag，必须从下面选一个，不能自己编）===
${topicBlock}

${buildSharedForumHardRules()}

${FORUM_NEWS_AUTHENTICITY_RULE}

=== 产出数量要求 ===
- 一共产出 ${postCount} 条帖子。
- 每条帖子配 ${commentRange[0]}-${commentRange[1]} 条评论（随机，允许某些帖子是0条冷清帖）。
- authorHandle 必须精确等于上面账号池里的某个 handle，一字不差。

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
      "comments": [
        { "authorHandle": "评论者handle", "content": "评论内容", "replyToIndex": 0 }
      ]
    }
  ]
}
`.trim();
}

function normalizeBatchDrafts(raw: any, validHandles: Set<string>): ForumBatchPostDraft[] {
  const posts = Array.isArray(raw?.posts) ? raw.posts : [];
  const out: ForumBatchPostDraft[] = [];
  for (const p of posts) {
    if (!p || typeof p !== 'object') continue;
    const authorHandle = String(p.authorHandle || '');
    if (!validHandles.has(authorHandle)) continue;
    const postKind = p.postKind === 'news' ? 'news' : 'organic';
    const topicTag = FORUM_TOPIC_TAGS.some(t => t.tag === p.topicTag) ? p.topicTag : 'daily_chatter';
    const title = String(p.title || '').slice(0, 100);
    const content = String(p.content || '').slice(0, 5000);
    if (!content) continue;
    const comments = Array.isArray(p.comments) ? p.comments
      .filter((c: any) => c && validHandles.has(String(c.authorHandle || '')))
      .map((c: any) => ({
        authorHandle: String(c.authorHandle),
        content: String(c.content || '').slice(0, 2000),
        replyToIndex: Number.isInteger(c.replyToIndex) ? c.replyToIndex : undefined,
      }))
      .filter((c: any) => !!c.content) : [];
    out.push({
      authorHandle, postKind, topicTag: topicTag as ForumTopicTag, title, content,
      sourceNewsUrl: postKind === 'news' ? (p.sourceNewsUrl ? String(p.sourceNewsUrl) : undefined) : undefined,
      sourceNewsTitle: postKind === 'news' ? (p.sourceNewsTitle ? String(p.sourceNewsTitle) : undefined) : undefined,
      comments,
    });
  }
  return out;
}

export interface RunBatchGenerationParams {
  apiConfig: ForumApiConfig;
  hotNewsItems: HotNewsItem[];
  userPreferenceTags: ForumTopicTag[];
  trigger: 'natural' | 'manual';
}

/** 批量生成主入口：自然触发用 naturalBatchPostRange，手动刷新用 manualRefreshPostRange。 */
export async function runBatchGeneration(params: RunBatchGenerationParams): Promise<ForumPost[]> {
  const { apiConfig, hotNewsItems, userPreferenceTags, trigger } = params;

  const postCount = pickInRange(
    trigger === 'natural' ? FORUM_DEFAULTS.naturalBatchPostRange : FORUM_DEFAULTS.manualRefreshPostRange,
  );
  const npcAccounts = await db.getActiveNpcAccounts();
  if (npcAccounts.length === 0) return [];

  // 候选池：粗略给够抽取用的NPC数量（帖子数+每帖平均评论数的估计），避免prompt里塞入全部NPC
  const rosterSize = Math.min(npcAccounts.length, postCount * 3);
  const roster = pickNpcPoolForBatch(npcAccounts, userPreferenceTags, rosterSize);
  const validHandles = new Set(roster.map(a => a.handle));
  const accountByHandle = new Map(roster.map(a => [a.handle, a]));

  const prompt = buildBatchGenerationPrompt({
    hotNewsItems, npcRoster: roster, userPreferenceTags, postCount,
    commentRange: FORUM_DEFAULTS.postCommentRange,
  });

  const raw = await callForumAI(apiConfig, prompt, trigger === 'natural' ? '论坛自然批量生成' : '论坛手动刷新批量生成');
  const parsed = extractJson<any>(raw);
  const drafts = normalizeBatchDrafts(parsed, validHandles);

  const createdPosts: ForumPost[] = [];
  const now = Date.now();
  for (const draft of drafts) {
    const authorAccount = accountByHandle.get(draft.authorHandle);
    if (!authorAccount) continue;
    const post: ForumPost = {
      id: db.createForumPostId(),
      authorAccountId: authorAccount.id,
      postKind: draft.postKind,
      topicTag: draft.topicTag,
      title: draft.title,
      content: draft.content,
      sourceNewsUrl: draft.sourceNewsUrl,
      sourceNewsTitle: draft.sourceNewsTitle,
      createdAt: now,
      lastActivityAt: now,
      isCollected: false,
      involvesCharInteraction: false,
      isOwnedByUserSide: false, // 批量层只生成NPC内容，用户/TA内容走别的路径
      likes: [],
      visibility: 'public',
    };
    await feed.createPost(post);

    // 楼中楼：按 replyToIndex 把 draft.comments 数组下标映射回真实 comment.id
    const insertedIds: string[] = [];
    for (const c of draft.comments) {
      const commenterAccount = accountByHandle.get(c.authorHandle);
      if (!commenterAccount) { insertedIds.push(''); continue; }
      const parentId = (typeof c.replyToIndex === 'number' && insertedIds[c.replyToIndex]) || undefined;
      const saved = await feed.appendComment(post.id, {
        authorAccountId: commenterAccount.id,
        content: c.content,
        createdAt: now,
        parentCommentId: parentId,
      });
      insertedIds.push(saved.id);
    }
    createdPosts.push(post);
  }
  return createdPosts;
}

// ==================== 二、帖子级"刷新"合并（新评论 + 垫底楼回复）[交接4 二] ====================

export interface RunPostRefreshParams {
  apiConfig: ForumApiConfig;
  postId: string;
  heatLevel: number;
  /** TA 相关账号（主号 + 目前继续沿用的小号），用于判定 @TA、以及标记 involvesCharInteraction。 */
  taAccounts: ForumAccount[];
  altIsContinuedInUse: (accountId: string) => boolean;
}

export async function runPostRefresh(params: RunPostRefreshParams): Promise<void> {
  const { apiConfig, postId, heatLevel, taAccounts, altIsContinuedInUse } = params;
  const post = await db.getForumPost(postId);
  if (!post) return;

  const accounts = await db.getAllForumAccounts();
  const accountsById = new Map(accounts.map(a => [a.id, a]));
  const npcAccounts = accounts.filter(a => a.ownerType === 'npc' && a.status === 'active');
  const taHandles = taAccounts.map(a => a.handle);

  const pending = await feed.getPendingFloors(postId, accountsById, taHandles);
  const { mustReply, randomlyPicked } = feed.pickFloorsForRefresh(pending, heatLevel);

  const rosterSize = Math.min(npcAccounts.length, 8);
  const roster = pickNpcPoolForBatch(npcAccounts, [], rosterSize);
  // 路人池和 TA 账号严格分开传给模型：新增装饰评论、非@TA的垫底楼，只能从路人池里选，
  // TA 的号只出现在"必须回复"区块，不能被顺手当成随机路人接垫底或写装饰评论——
  // 不然就违背了"TA只在被精准点名/走共管账号定时节奏时才发声"的设计。
  const validHandles = new Set(roster.map(a => a.handle));
  const accountByHandle = new Map<string, ForumAccount>([
    ...roster.map(a => [a.handle, a] as const),
    ...taAccounts.map(a => [a.handle, a] as const),
  ]);

  const newCommentCount = pickInRange(FORUM_DEFAULTS.postRefreshNewCommentRange);

  const floorBlock = (floors: PendingFloor[]) => floors.map(f =>
    `- 楼 ${f.threadRootId}：用户最新发言"${f.latestComment.content}"`
  ).join('\n') || '（无）';

  const prompt = `
你是这个论坛帖子的"评论区生成器"。这次刷新要做两件事，一次性完成：
1) 给这条帖子补一批新的路人装饰性评论/立场发言（不针对下面的垫底楼，是普通的新增热闹）；
2) 针对下面列出的垫底楼各生成一条回复。

=== 帖子 ===
标题：${post.title}
正文：${post.content}

=== 路人账号池（新增装饰评论 + "随便哪个路人接"的垫底楼，只能用这些handle）===
${roster.map(describeAccountForPrompt).join('\n')}

=== TA 专属账号（下面这些handle只能用在"必须由TA回复"区块，不能用于新增评论或其它垫底楼）===
${taAccounts.map(describeAccountForPrompt).join('\n') || '（这次没有需要TA出面的楼，不要使用TA账号）'}

=== 必须由TA回复的垫底楼（这条被@了TA）===
${floorBlock(mustReply)}

=== 随便哪个路人接的垫底楼 ===
${floorBlock(randomlyPicked)}

${buildSharedForumHardRules()}

=== 产出数量 ===
- 新增装饰性评论：${newCommentCount} 条（只能用路人账号池，不针对垫底楼）。
- 垫底楼回复：上面列出几条就产出几条，threadRootId 必须精确对应，"必须由TA回复"区块的楼只能填TA专属账号的handle。

请只返回 JSON：
{
  "newComments": [{ "authorHandle": "handle", "content": "评论内容" }],
  "floorReplies": [{ "threadRootId": "对应上面给的楼id", "authorHandle": "handle", "content": "回复内容" }]
}
`.trim();

  const raw = await callForumAI(apiConfig, prompt, '论坛帖子刷新合并生成');
  const parsed = extractJson<any>(raw);

  const now = Date.now();

  const newComments = Array.isArray(parsed?.newComments) ? parsed.newComments : [];
  for (const c of newComments) {
    // 装饰性新评论只信任路人池，哪怕模型手滑填了TA的handle也不采纳，双重保险。
    if (!validHandles.has(String(c?.authorHandle || ''))) continue;
    const account = accountByHandle.get(String(c?.authorHandle || ''));
    if (!account || !c?.content) continue;
    await feed.appendComment(postId, { authorAccountId: account.id, content: String(c.content).slice(0, 2000), createdAt: now });
  }

  const floorReplies = Array.isArray(parsed?.floorReplies) ? parsed.floorReplies : [];
  const mustReplyIds = new Set(mustReply.map(f => f.threadRootId));
  const taHandleSet = new Set(taAccounts.map(a => a.handle));
  const allFloors = [...mustReply, ...randomlyPicked];
  for (const r of floorReplies) {
    const floor = allFloors.find(f => f.threadRootId === r?.threadRootId);
    const handle = String(r?.authorHandle || '');
    // 隔离校验：@TA的楼必须是TA专属handle；非@TA的楼不能用TA专属handle顶替路人。
    const isMustReplyFloor = floor && mustReplyIds.has(floor.threadRootId);
    if (isMustReplyFloor && !taHandleSet.has(handle)) continue;
    if (!isMustReplyFloor && taHandleSet.has(handle)) continue;
    const account = accountByHandle.get(handle);
    if (!floor || !account || !r?.content) continue;
    await feed.appendComment(postId, {
      authorAccountId: account.id,
      content: String(r.content).slice(0, 2000),
      createdAt: now,
      parentCommentId: floor.latestComment.id,
    });
    await feed.markCharInteractionIfApplicable(postId, account, altIsContinuedInUse(account.id));
  }
}

// ==================== 三、DM ⚡ 手动触发回复 [交接4 三 / 交接5 4.6] ====================

export interface RunDmReplyParams {
  apiConfig: ForumApiConfig;
  viewerIdentityAccountId: string;
  counterpartAccountId: string;
}

export async function runDmReply(params: RunDmReplyParams): Promise<void> {
  const { apiConfig, viewerIdentityAccountId, counterpartAccountId } = params;
  const counterpart = await db.getForumAccount(counterpartAccountId);
  if (!counterpart) return;

  const history = await db.getDmThreadMessages(viewerIdentityAccountId, counterpartAccountId);
  const viewer = await db.getForumAccount(viewerIdentityAccountId);

  const historyBlock = history.map(m =>
    `${m.fromAccountId === viewerIdentityAccountId ? (viewer?.displayName || '我') : counterpart.displayName}：${m.content}`
  ).join('\n');

  const prompt = `
你现在扮演论坛账号"${counterpart.displayName}"（handle=${counterpart.handle}），正在私信里回复对方。
${describeAccountForPrompt(counterpart)}

${buildSharedForumHardRules()}

=== 私信记录（含对方刚发的、还没被回复的消息）===
${historyBlock}

请以这个账号的口吻写一条回复（可以是针对最近几条消息的综合回应，不用逐条回，像真人私信一样自然）。
请只返回 JSON：
{ "reply": "回复正文" }
`.trim();

  const raw = await callForumAI(apiConfig, prompt, '论坛DM回复');
  const parsed = extractJson<{ reply?: string }>(raw);
  const reply = String(parsed?.reply || '').trim();
  if (!reply) return;

  await db.saveForumDmMessage({
    id: db.createForumDmMessageId(),
    viewerIdentityAccountId,
    counterpartAccountId,
    fromAccountId: counterpartAccountId,
    content: reply,
    createdAt: Date.now(),
  });
}

// ==================== 四、共管账号专属动态 [用户确认，按热点新闻App的6档走] ====================

export interface RunSharedAccountExclusivePostParams {
  apiConfig: ForumApiConfig;
  sharedAccountId: string;
  /** 时段标签，直接传 forumScheduler.SHARED_ACCOUNT_BANDS 里对应项的 label（如"08:00–12:00"）。 */
  bandLabel: string;
}

/** 1次调用同时产出帖子正文 + 一批装饰性NPC评论/点赞，只在共管账号自己主页可见。 */
export async function runSharedAccountExclusivePost(params: RunSharedAccountExclusivePostParams): Promise<ForumPost | null> {
  const { apiConfig, sharedAccountId, bandLabel } = params;
  const account = await db.getForumAccount(sharedAccountId);
  if (!account || account.ownerType !== 'shared') return null;

  const npcAccounts = await db.getActiveNpcAccounts();
  const roster = pickNpcPoolForBatch(npcAccounts, [], Math.min(npcAccounts.length, 5));
  const validHandles = new Set(roster.map(a => a.handle));
  const accountByHandle = new Map(roster.map(a => [a.handle, a]));

  const prompt = `
现在是 ${bandLabel} 这个时段，给共管账号"${account.displayName}"（handle=${account.handle}）生成一条只属于这个
账号自己主页的专属动态（不进公共论坛feed），可以是用户和TA共同视角的日常分享。

=== 可用的装饰性评论/点赞账号池 ===
${roster.map(describeAccountForPrompt).join('\n')}

${buildSharedForumHardRules()}

请只返回 JSON：
{
  "topicTag": "话题tag",
  "title": "标题",
  "content": "正文",
  "comments": [{ "authorHandle": "handle", "content": "评论内容" }]
}
`.trim();

  const raw = await callForumAI(apiConfig, prompt, '论坛共管账号专属动态生成');
  const parsed = extractJson<any>(raw);
  const content = String(parsed?.content || '').trim();
  if (!content) return null;

  const now = Date.now();
  const topicTag = FORUM_TOPIC_TAGS.some(t => t.tag === parsed?.topicTag) ? parsed.topicTag : 'daily_chatter';
  const post: ForumPost = {
    id: db.createForumPostId(),
    authorAccountId: sharedAccountId,
    postKind: 'organic',
    topicTag,
    title: String(parsed?.title || '').slice(0, 100),
    content: content.slice(0, 5000),
    createdAt: now,
    lastActivityAt: now,
    isCollected: false,
    involvesCharInteraction: false,
    isOwnedByUserSide: true, // [交接5 4.9] 系统自动生成的专属动态同样 isOwnedByUserSide=true
    likes: [],
    visibility: 'sharedAccountExclusive',
  };
  await feed.createPost(post);

  const comments = Array.isArray(parsed?.comments) ? parsed.comments : [];
  for (const c of comments) {
    const commenter = accountByHandle.get(String(c?.authorHandle || ''));
    if (!commenter || !c?.content) continue;
    await feed.appendComment(post.id, { authorAccountId: commenter.id, content: String(c.content).slice(0, 2000), createdAt: now });
  }

  return post;
}
