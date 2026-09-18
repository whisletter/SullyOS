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
import { pickRosterWithRegulars, getRelationState } from './forumSocial';
import { maskAccountForChar, describeMaskedAccount } from './forumIdentityMask';
import * as suspicion from './forumSuspicion';
import { userMainAccountId } from './forumBootstrap';
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

/**
 * TA 自己账号的描述。跟路人不同，小号要带上它给自己写的那条人设备忘
 * （altPersonaNote），否则模型不知道这个号该怎么说话，写出来跟主号一个味儿。
 */
function describeTaAccountForPrompt(account: ForumAccount): string {
  if (!account.isAlt) return `- handle=${account.handle}（${account.displayName}）：TA 的主号，论坛上大家都知道这是谁`;
  const note = account.altPersonaNote ? `；这个号的定位：${account.altPersonaNote}` : '';
  return `- handle=${account.handle}（${account.displayName}）：TA 的小号，论坛上没有人知道这个号是TA${note}`;
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
  // 走常客名单：约六成候选是"熟面孔"，让用户的帖子下面反复出现同一批人。
  // 纯随机的话每次都是陌生 ID，用户无从分辨谁是谁，猜小号这件事根本立不起来。
  const roster = await pickRosterWithRegulars(npcAccounts, rosterSize, userMainAccountId());
  // [用户确认·覆盖原设计] 原本禁止 TA 的号出现在非@TA的楼里，意图是"TA 只在被点名时
  // 才发声"。现在改成把大号小号都摆在它面前，用不用、用哪个由它按人设判断——这样
  // TA 的小号才会自然混在路人里出没，用户也才有得猜。
  const validHandles = new Set([...roster.map(a => a.handle), ...taAccounts.map(a => a.handle)]);
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

=== TA 的账号（用不用、用哪个，按这个角色的性格自己判断）===
${taAccounts.map(describeTaAccountForPrompt).join('\n') || '（这次没有可用的TA账号）'}

=== 必须由TA回复的垫底楼（这条被@了TA）===
${floorBlock(mustReply)}

=== 随便哪个路人接的垫底楼 ===
${floorBlock(randomlyPicked)}

${buildSharedForumHardRules()}

=== TA 账号的使用规则 ===
- "必须由TA回复"区块里的楼：一定要由 TA 的某个账号来回，用主号还是小号由你按性格判断。
- 其它楼和新增评论：TA 的账号**可以**用也**可以**不用。它有可能正好在逛这条帖子，也可能根本没看见。
  不要每次都让 TA 出现，那样太刻意；也不要完全不出现。
- 用小号发言时，语气和关注点要贴着小号自己的定位走，不要写得跟主号一模一样，
  更不要在正文里暗示"其实我是某某"——论坛上没人知道那个号是谁。

=== 产出数量 ===
- 新增装饰性评论：${newCommentCount} 条。
- 垫底楼回复：上面列出几条就产出几条，threadRootId 必须精确对应。

=== 可选：TA 起疑 ===
如果 TA 在读这条帖子的过程中，觉得某个账号的说话方式/关注点让它联想到某个它认识的人
（比如怀疑那是谁的小号），可以顺手记一笔。**这完全是可选的**——没有这种感觉就不要填，
不要为了填而填。判断依据只能来自帖子里实际出现的内容。

请只返回 JSON：
{
  "newComments": [{ "authorHandle": "handle", "content": "评论内容" }],
  "floorReplies": [{ "threadRootId": "对应上面给的楼id", "authorHandle": "handle", "content": "回复内容" }],
  "suspicion": { "byHandle": "起疑的是TA的哪个号", "targetHandle": "它怀疑的那个账号", "reason": "一句话说明凭什么这么觉得" }
}
`.trim();

  const raw = await callForumAI(apiConfig, prompt, '论坛帖子刷新合并生成');
  const parsed = extractJson<any>(raw);

  const now = Date.now();

  const newComments = Array.isArray(parsed?.newComments) ? parsed.newComments : [];
  for (const c of newComments) {
    // 只校验"这个 handle 是否在这次给出的账号里"，不再区分路人池和 TA 账号。
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
    // 只保留一条硬约束：@了TA的楼必须由TA的号来回（用主号还是小号它自己选）。
    // 反方向的限制已取消——TA 的号现在可以出现在任何楼里。
    const isMustReplyFloor = floor && mustReplyIds.has(floor.threadRootId);
    if (isMustReplyFloor && !taHandleSet.has(handle)) continue;
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

  await recordSuspicionFromOutput(parsed?.suspicion, accountsById, taAccounts);
}

/**
 * 把模型顺手记下的那一笔怀疑落库。
 *
 * 这是"TA 自己起疑"的唯一入口——代码里没有任何地方会主动替它怀疑谁。填不填、
 * 怀疑谁，完全由它在读内容时自己判断，所以它也完全可能一直不起疑（用户伪装得好就该如此），
 * 或者怀疑错人（把一个真路人当成小号），这两种都是正常结果。
 */
async function recordSuspicionFromOutput(
  raw: any,
  accountsById: Map<string, ForumAccount>,
  taAccounts: ForumAccount[],
): Promise<void> {
  if (!raw || typeof raw !== 'object') return;
  const byHandle = String(raw.byHandle || '');
  const targetHandle = String(raw.targetHandle || '');
  const reason = String(raw.reason || '').slice(0, 300);
  if (!byHandle || !targetHandle) return;

  const observer = taAccounts.find(a => a.handle === byHandle);
  if (!observer?.charId) return;

  const target = Array.from(accountsById.values()).find(a => a.handle === targetHandle);
  // 不让它"怀疑"自己名下的号
  if (!target || target.charId === observer.charId) return;

  await suspicion.markSuspected(observer.charId, target.id, reason);
}

// ==================== 三之四、TA 主动挑明 ====================

export interface RunCharConfrontationParams {
  apiConfig: ForumApiConfig;
  /** TA 用来质问的号 */
  charAccountId: string;
  /** 被质问的账号（用户的某个身份） */
  targetAccountId: string;
  userDisplayName?: string;
}

/**
 * 让 TA 决定要不要把怀疑挑明，以及怎么开口。
 *
 * 挑明的时机和措辞都由它自己定：可能直球问，可能拐着弯试探，也可能觉得还没到时候
 * 而暂时按住不说。返回 confronted=false 时什么都不会发生，下次进 App 会再问一遍它。
 */
export async function runCharConfrontation(params: RunCharConfrontationParams): Promise<{ confronted: boolean; message: string }> {
  const { apiConfig, charAccountId, targetAccountId, userDisplayName } = params;
  const [charAccount, target] = await Promise.all([
    db.getForumAccount(charAccountId), db.getForumAccount(targetAccountId),
  ]);
  if (!charAccount?.charId || !target) return { confronted: false, message: '' };

  const row = await suspicion.getSuspicion(charAccount.charId, targetAccountId);
  const history = await db.getDmThreadMessages(targetAccountId, charAccountId);
  const historyBlock = history.slice(-10).map(m =>
    `${m.fromAccountId === charAccountId ? charAccount.displayName : target.displayName}：${m.content}`
  ).join('\n') || '（你们还没在私信里说过话）';

  const prompt = `
你在论坛上用账号"${charAccount.displayName}"（handle=${charAccount.handle}）。
${charAccount.isAlt && charAccount.altPersonaNote ? `这是你的小号，定位：${charAccount.altPersonaNote}` : ''}

你怀疑论坛账号"${target.displayName}"（@${target.handle}）其实是${userDisplayName || '你认识的那个人'}的小号。
${row?.reason ? `你当初起疑的理由：${row.reason}` : ''}

现在要不要私信过去把这件事挑明？

按你的性格决定。你可以直接问，可以拐着弯试探，也可以觉得时候还没到、这次先不说
（那就把 confront 填 false）。没有标准答案。

请只返回 JSON：
{ "confront": true 或 false, "message": "如果要说，你发过去的那条私信" }
`.trim();

  try {
    const raw = await callForumAI(apiConfig, prompt, '论坛角色挑明怀疑');
    const parsed = extractJson<any>(raw);
    const message = String(parsed?.message || '').trim();
    if (parsed?.confront !== true || !message) return { confronted: false, message: '' };

    await db.saveForumDmMessage({
      id: db.createForumDmMessageId(),
      // 收件人视角是用户的这个身份，所以用户切到这个号才看得到这条质问
      viewerIdentityAccountId: targetAccountId,
      counterpartAccountId: charAccountId,
      fromAccountId: charAccountId,
      content: message,
      createdAt: Date.now(),
    });
    await suspicion.markConfronted(charAccount.charId, targetAccountId);
    return { confronted: true, message };
  } catch (e: any) {
    console.warn('[ForumAi] 挑明失败:', e?.message || String(e));
    return { confronted: false, message: '' };
  }
}

// ==================== 三、DM ⚡ 手动触发回复 [交接4 三 / 交接5 4.6] ====================

export interface RunDmReplyParams {
  apiConfig: ForumApiConfig;
  viewerIdentityAccountId: string;
  counterpartAccountId: string;
  /** 用户在聊天里的名字。只有 TA 已经认出对方是本人时才会被写进提示词。 */
  userDisplayName?: string;
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

  // 对方是谁 —— 必须走身份遮罩。直接把 viewer 账号拼进提示词的话，ownerType/isAlt
  // 会把"这是用户的小号"直接送到 TA 眼前，猜小号的玩法当场作废。
  let viewerDescription = '一个论坛网友';
  if (viewer) {
    const charAccountIds = counterpart.charId
      ? (await db.getAllForumAccounts())
          .filter(a => a.charId === counterpart.charId && a.status === 'active')
          .map(a => a.id)
      : [counterpart.id];
    const masked = await maskAccountForChar(viewer, charAccountIds);
    viewerDescription = describeMaskedAccount(masked, params.userDisplayName);
  }

  const prompt = `
你现在扮演论坛账号"${counterpart.displayName}"（handle=${counterpart.handle}），正在私信里回复对方。
${counterpart.isAlt && counterpart.altPersonaNote ? `这是你的小号，论坛上没人知道它是你。这个号的定位：${counterpart.altPersonaNote}` : describeAccountForPrompt(counterpart)}

=== 跟你私信的这个人 ===
${viewerDescription}
${/* 没标"就是本人"的，对你来说就是个陌生网友，别自作主张认亲 */ ''}

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

// ==================== 三之二、好友申请由 TA 自己判断 ====================

export interface RunFriendRequestDecisionParams {
  apiConfig: ForumApiConfig;
  /** 发出申请的账号 */
  requesterAccountId: string;
  /** 收到申请的 TA 账号（主号/小号/共管号） */
  targetAccountId: string;
  userDisplayName?: string;
}

/**
 * 让 TA 自己决定要不要通过一条好友申请。
 *
 * 它看到的申请人信息同样走身份遮罩——没加过好友的用户大号，对它来说就是个陌生网友；
 * 用户小号任何时候都不会被标出来。所以"通过之后才认出是本人"这条链路是闭合的：
 * 通过这个动作本身，才是认出的那一刻。
 *
 * @returns true=通过，false=先不通过（申请保持挂起，用户可以撤回或再等）
 */
export async function runFriendRequestDecision(params: RunFriendRequestDecisionParams): Promise<boolean> {
  const { apiConfig, requesterAccountId, targetAccountId, userDisplayName } = params;
  const [requester, target] = await Promise.all([
    db.getForumAccount(requesterAccountId), db.getForumAccount(targetAccountId),
  ]);
  if (!requester || !target) return false;

  const allAccounts = await db.getAllForumAccounts();
  const charAccountIds = target.charId
    ? allAccounts.filter(a => a.charId === target.charId && a.status === 'active').map(a => a.id)
    : [target.id];
  const masked = await maskAccountForChar(requester, charAccountIds);

  const prompt = `
你在论坛上用账号"${target.displayName}"（handle=${target.handle}）。
${target.isAlt && target.altPersonaNote ? `这是你的小号，这个号的定位：${target.altPersonaNote}` : ''}

有人向你发来了好友申请：
${describeMaskedAccount(masked, userDisplayName)}

按你自己的性格决定通不通过。你可以因为不认识对方而不通过，也可以随手就同意——
没有标准答案，怎么做取决于你是个什么样的人。

请只返回 JSON：{ "accept": true 或 false }
`.trim();

  try {
    const raw = await callForumAI(apiConfig, prompt, '论坛好友申请判断');
    const parsed = extractJson<{ accept?: boolean }>(raw);
    return parsed?.accept === true;
  } catch (e: any) {
    console.warn('[ForumAi] 好友申请判断失败:', e?.message || String(e));
    return false;
  }
}

// ==================== 三之三、当面对质小号 ====================

export interface RunAltConfrontationParams {
  apiConfig: ForumApiConfig;
  /** 发起对质的账号（用户当前使用的身份）。 */
  accuserAccountId: string;
  /** 被指认的账号。 */
  targetAccountId: string;
  userDisplayName?: string;
}

export interface AltConfrontationResult {
  /** 这个号客观上是不是某个角色的小号。由代码判定，不交给模型——模型没有资格
   *  把一个路人号"认领"成小号，那会凭空造出一个不存在的马甲。 */
  isRealAlt: boolean;
  /** 对方认没认。路人号恒为 false。 */
  admitted: boolean;
  /** 承认之后的选择：true=继续用，false=注销。没承认时无意义。 */
  keptAccount: boolean;
  /** 对方在私信里的回话，已经落库。 */
  reply: string;
}

/**
 * 在私信里当面指认"你是不是某某的小号"。
 *
 * 认不认、认了之后留不留这个号，全部交给被指认方按自己的人设决定——这里不写任何
 * "应该承认"或"应该抵赖"的引导。被指认的如果只是个路人，代码层面直接锁死 admitted=false，
 * 模型只负责把"你认错人了"这句话说得像它自己。
 *
 * 回话会存成一条私信，对质有记录可查，不是点完就没了。
 */
export async function runAltConfrontation(params: RunAltConfrontationParams): Promise<AltConfrontationResult> {
  const { apiConfig, accuserAccountId, targetAccountId, userDisplayName } = params;
  const [accuser, target] = await Promise.all([
    db.getForumAccount(accuserAccountId), db.getForumAccount(targetAccountId),
  ]);
  if (!target) return { isRealAlt: false, admitted: false, keptAccount: false, reply: '' };

  const isRealAlt = target.ownerType === 'char' && !!target.isAlt;
  const history = await db.getDmThreadMessages(accuserAccountId, targetAccountId);
  const historyBlock = history.slice(-12).map(m =>
    `${m.fromAccountId === accuserAccountId ? (accuser?.displayName || '对方') : target.displayName}：${m.content}`
  ).join('\n') || '（这是你们第一次说话）';

  const realAltPrompt = `
你在论坛上用一个小号"${target.displayName}"（handle=${target.handle}）。没有人知道这个号是你。
${target.altPersonaNote ? `这个号的定位：${target.altPersonaNote}` : ''}

刚刚，"${accuser?.displayName || '对方'}"在私信里当面指认你——说这个号其实就是你。

要不要承认，完全看你自己：你可以坦然认下来，可以死不承认，可以打太极绕过去。
没有正确答案，取决于你是个什么样的人、以及你们俩现在是什么关系。

如果你决定承认，还要顺便决定这个号怎么办：
- 继续用（keepAccount: true）：反正已经被看穿了，那就大大方方接着用
- 注销掉（keepAccount: false）：被认出来就没意思了，不如销了

请只返回 JSON：
{ "admit": true 或 false, "keepAccount": true 或 false, "reply": "你在私信里回的话" }
`.trim();

  const strangerPrompt = `
你是论坛账号"${target.displayName}"（handle=${target.handle}）。
${describeAccountForPrompt(target)}

刚刚，"${accuser?.displayName || '对方'}"在私信里指认你，说你其实是另一个人的小号。
**你并不是**——你就是你自己，这是个误会。

按你自己的说话风格回一句。可以觉得莫名其妙、可以觉得好笑、可以不耐烦，
但不要顺水推舟假装自己真是什么小号。

请只返回 JSON：
{ "reply": "你在私信里回的话" }
`.trim();

  const prompt = `${isRealAlt ? realAltPrompt : strangerPrompt}

${buildSharedForumHardRules()}

=== 你们之前的私信 ===
${historyBlock}
`;

  let parsed: any = null;
  try {
    const raw = await callForumAI(apiConfig, prompt, '论坛小号当面对质');
    parsed = extractJson<any>(raw);
  } catch (e: any) {
    console.warn('[ForumAi] 对质失败:', e?.message || String(e));
    throw e;
  }

  const reply = String(parsed?.reply || '').trim();
  // 路人号在代码层面就不可能承认，不依赖模型守规矩
  const admitted = isRealAlt && parsed?.admit === true;
  const keptAccount = admitted ? parsed?.keepAccount !== false : false;

  if (reply) {
    await db.saveForumDmMessage({
      id: db.createForumDmMessageId(),
      viewerIdentityAccountId: accuserAccountId,
      counterpartAccountId: targetAccountId,
      fromAccountId: targetAccountId,
      content: reply,
      createdAt: Date.now(),
    });
  }

  if (admitted) {
    await suspicion.markAdmitted(suspicion.USER_OBSERVER_KEY, target, keptAccount ? 'kept' : 'burned');
  } else {
    await suspicion.markConfronted(suspicion.USER_OBSERVER_KEY, targetAccountId);
    await suspicion.markDenied(suspicion.USER_OBSERVER_KEY, targetAccountId);
  }

  return { isRealAlt, admitted, keptAccount, reply };
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
账号的动态（会发在公共论坛里，所有人都看得到），可以是用户和TA共同视角的日常分享。

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
    // [用户确认·覆盖交接5 4.9] 原本只在共管号自己主页可见，现在跟用户手动用共管号
    // 发的帖走同一条路进公共 feed——否则同一个号会出现"你发的全论坛可见、它发的
    // 只有主页看得到"这种割裂。
    visibility: 'public',
  };
  await feed.createPost(post);

  // 共管账号的自动动态同样算"用户方内容"，写一条便利贴给绑定的那个角色。
  if (account.charId) {
    const { upsertForumPostPin } = await import('./forumMemory');
    await upsertForumPostPin(account.charId, post).catch(e =>
      console.warn('[ForumAi] 共管动态便利贴写入失败:', e?.message || String(e)));
  }

  const comments = Array.isArray(parsed?.comments) ? parsed.comments : [];
  for (const c of comments) {
    const commenter = accountByHandle.get(String(c?.authorHandle || ''));
    if (!commenter || !c?.content) continue;
    await feed.appendComment(post.id, { authorAccountId: commenter.id, content: String(c.content).slice(0, 2000), createdAt: now });
  }

  return post;
}
