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
 *
 * 一条纪律（本轮新增）：**凡是由 TA 出面说话的地方，人设一律从 forumCharContext 取**，
 * 不在这个文件里现拼。那个模块复用的是聊天用的同一个函数，所以论坛里的 TA 和聊天里的
 * 是同一个人——世界书怎么触发、对用户的印象是什么、长期记忆记得哪些事，两边完全一致。
 * 路人 NPC（批量生成、装饰性评论）那一侧不碰这个模块，它们就是路人。
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
  describeAccountLanguageStyle, getTopicCommentStyle, getTopicLabel,
} from './forumConstants';
import { pickRosterWithRegulars, getRelationState } from './forumSocial';
import { maskAccountForChar, describeMaskedAccount, getCharForumIdentity } from './forumIdentityMask';
import * as suspicion from './forumSuspicion';
import { userMainAccountId } from './forumBootstrap';
import { getForumCharContext, loadForumUserProfile, type ForumCharContext } from './forumCharContext';
import type { CharacterProfile, HotNewsItem, ImageGenApiConfig } from '../types';

// ==================== 调用约定 ====================

export interface ForumApiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * 全局「生图 API」。ForumApp 传进来的本来就是整个 apiConfig 对象，这个字段一直在，
   * 只是以前论坛用不上所以没写进类型。TA 发帖配图要用它。
   * 没配 / 没开时整条配图链路静默跳过，TA 照常发纯文字帖。
   */
  imageGenApi?: ImageGenApiConfig;
}

const AI_MAX_RETRIES = 2;

/**
 * 发给模型的一张图。url 是 data URL（本地相册图解析出来的）或 http(s) 外链。
 */
export interface ForumPromptImage {
  url: string;
}

/**
 * 带图请求会被某些不支持视觉的模型直接 400 拒掉。这个错误跟网络错误不一样，
 * 重试多少次都是同样的结果，所以单独认出来，退回纯文本再跑一次——宁可这次的评论
 * 没看见图，也不能让"刷新"这个按钮在换了个模型之后整个不能用。
 */
function looksLikeVisionUnsupported(e: any): boolean {
  const msg = String(e?.message || e || '').toLowerCase();
  return msg.includes('image')
    || msg.includes('vision')
    || msg.includes('multimodal')
    || msg.includes('content must be a string')
    || msg.includes('invalid_request');
}

async function callForumAI(
  apiConfig: ForumApiConfig,
  systemPrompt: string,
  purpose: string,
  images?: ForumPromptImage[],
): Promise<string> {
  // 没图就是原来那条路，一个字节都不变。
  const content: any = (images && images.length > 0)
    ? [
        { type: 'text', text: systemPrompt },
        ...images.map(img => ({ type: 'image_url', image_url: { url: img.url } })),
      ]
    : systemPrompt;

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
            messages: [{ role: 'user', content }],
            temperature: 0.9, max_tokens: 8192, stream: false,
            response_format: { type: 'json_object' },
          }),
        },
        2, 0, { appName: '杂波频段', purpose },
      );
      return data?.choices?.[0]?.message?.content?.trim() || '';
    } catch (e: any) {
      lastError = e;
      // 带图被拒：立刻退回纯文本重跑一次，不占用重试次数
      if (images && images.length > 0 && looksLikeVisionUnsupported(e)) {
        console.warn('[ForumAi] 模型似乎不支持带图请求，退回纯文本重试:', e?.message || String(e));
        return callForumAI(apiConfig, systemPrompt, purpose);
      }
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

/**
 * 把帖子的配图解析成能塞进请求的 data URL。
 *
 * 只处理本地相册图（blobref 令牌）和已经内嵌的 data URL。http(s) 外链不送——让模型
 * 自己去拉一张外网图，慢、可能超时，而且用户说了不会传网图。真有外链时在提示词里
 * 注一句有这么张图就够了。
 *
 * 解析不出来的（图已经被清理掉了）静默跳过，不让一张死图把整次刷新搞挂。
 */
async function resolvePostImagesForPrompt(
  images: string[] | undefined,
  limit: number,
): Promise<{ sent: ForumPromptImage[]; skippedRemote: number; skippedBroken: number }> {
  const sent: ForumPromptImage[] = [];
  let skippedRemote = 0;
  let skippedBroken = 0;
  if (!images || images.length === 0 || limit <= 0) return { sent, skippedRemote, skippedBroken };

  const { isBlobRef, resolveRefToDataUrl } = await import('./blobRef');

  for (const value of images) {
    if (sent.length >= limit) break;
    if (typeof value !== 'string' || !value) continue;
    if (value.startsWith('data:')) { sent.push({ url: value }); continue; }
    if (/^https?:\/\//i.test(value)) { skippedRemote += 1; continue; }
    if (!isBlobRef(value)) { skippedBroken += 1; continue; }
    try {
      const dataUrl = await resolveRefToDataUrl(value);
      if (dataUrl) sent.push({ url: dataUrl });
      else skippedBroken += 1;
    } catch {
      skippedBroken += 1;
    }
  }
  return { sent, skippedRemote, skippedBroken };
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
  const lang = describeAccountLanguageStyle(account.handle);
  return `- handle=${account.handle}（${account.displayName}）${lang}${badges ? `：${badges}` : ''}`;
}

// ==================== TA 那一侧的人设（统一从 forumCharContext 取） ====================

/**
 * 按 charId 取人设块，带一层本次调用内的缓存——一次帖子刷新里同一个角色可能要用好几处，
 * 每处都重读一遍聊天记录太浪费。缓存只活在这一次调用里，不跨调用。
 */
function createCharContextLoader(userDisplayName?: string) {
  const cache = new Map<string, Promise<ForumCharContext | null>>();
  return (charId: string): Promise<ForumCharContext | null> => {
    let hit = cache.get(charId);
    if (!hit) {
      hit = getForumCharContext(charId, { userDisplayName }).catch(e => {
        console.warn('[ForumAi] 读取角色人设失败:', e?.message || String(e));
        return null;
      });
      cache.set(charId, hit);
    }
    return hit;
  };
}

/** 单个角色出场时的提示词开头。没取到人设就返回空串，调用方退回原来的通用写法。 */
async function buildSingleCharHeader(
  charId: string | undefined,
  userDisplayName: string | undefined,
): Promise<string> {
  if (!charId) return '';
  const ctx = await getForumCharContext(charId, { userDisplayName }).catch(e => {
    console.warn('[ForumAi] 读取角色人设失败:', e?.message || String(e));
    return null;
  });
  return ctx?.text || '';
}

/**
 * 评论区渲染：每条都标上网名，不再出现"用户最新发言"这种标签。
 *
 * 原来那个标签是个泄漏点——TA 一旦有了人设，"用户"两个字等于直接告诉它"这条是你认识的
 * 那个人说的"，猜小号当场作废。现在它看到的和一个真网友看到的一样：一堆网名和话。
 */
function renderCommentSection(
  comments: ForumComment[],
  accountsById: Map<string, ForumAccount>,
  opts: { floorLabels?: Map<string, string> } = {},
): string {
  if (comments.length === 0) return '（这条帖子下面还没有人说话）';
  const sorted = [...comments].sort((a, b) => a.createdAt - b.createdAt);
  return sorted.map(c => {
    const acc = accountsById.get(c.authorAccountId);
    const who = acc ? `@${acc.handle}（${acc.displayName}）` : '@已注销用户';
    const floorTag = opts.floorLabels?.get(c.threadRootId);
    const reply = c.parentCommentId ? '（回复楼里上一条）' : '';
    return `${floorTag ? `[${floorTag}] ` : ''}${who}${reply}：${c.content}`;
  }).join('\n');
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
  /** 用户在聊天里的名字。不传就从档案里读，这里只是给调用方一个省一次读库的机会。 */
  userDisplayName?: string;
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

  // ── 这次让哪几个角色在场 ──
  // 每个角色都要带完整人设 + 最近的聊天，全塞进来又慢又容易串味（生成器会把 A 知道的事
  // 安到 B 头上）。所以：被 @ 的角色一定在场，另外再随机拉一个角色进来——它可能正好在
  // 逛这条帖子，也可能看了不说话。代价是没被 @ 的角色不是每次刷新都出现。
  const charIdsByHandle = new Map<string, string>();
  for (const acc of taAccounts) if (acc.charId) charIdsByHandle.set(acc.handle, acc.charId);

  const mentionedCharIds = new Set<string>();
  for (const floor of mustReply) {
    for (const [handle, charId] of charIdsByHandle) {
      if (handle && floor.latestComment.content.includes(`@${handle}`)) mentionedCharIds.add(charId);
    }
  }
  const allCharIds = Array.from(new Set(taAccounts.map(a => a.charId).filter((x): x is string => !!x)));
  const bystanderPool = allCharIds.filter(id => !mentionedCharIds.has(id));
  const presentCharIds = new Set(mentionedCharIds);
  if (bystanderPool.length > 0) {
    presentCharIds.add(bystanderPool[Math.floor(Math.random() * bystanderPool.length)]);
  }

  const presentTaAccounts = taAccounts.filter(a => a.charId && presentCharIds.has(a.charId));

  // [用户确认·覆盖原设计] 原本禁止 TA 的号出现在非@TA的楼里，意图是"TA 只在被点名时
  // 才发声"。现在改成把大号小号都摆在它面前，用不用、用哪个由它按人设判断——这样
  // TA 的小号才会自然混在路人里出没，用户也才有得猜。
  const validHandles = new Set([...roster.map(a => a.handle), ...presentTaAccounts.map(a => a.handle)]);
  const accountByHandle = new Map<string, ForumAccount>([
    ...roster.map(a => [a.handle, a] as const),
    ...presentTaAccounts.map(a => [a.handle, a] as const),
  ]);

  // 在场角色的人设：完整读取，跟聊天里的同一份。
  const loadCharContext = createCharContextLoader(params.userDisplayName);
  const charBlocks: string[] = [];
  for (const charId of presentCharIds) {
    const ctx = await loadCharContext(charId);
    if (!ctx) continue;
    const myAccounts = presentTaAccounts.filter(a => a.charId === charId);
    charBlocks.push([
      `——————【在场的人：${ctx.char.name}】——————`,
      ctx.text,
      '',
      `${ctx.char.name}在论坛上的号（这次只能用这些 handle 替它发言）：`,
      myAccounts.map(describeTaAccountForPrompt).join('\n') || '（没有可用的号）',
    ].join('\n'));
  }

  const newCommentCount = pickInRange(FORUM_DEFAULTS.postRefreshNewCommentRange);
  // [用户确认] 主楼底下要有人接话，评论区才像评论区。随机挑几条主楼带楼中楼，
  // 不是每条都带——每条都有人接反而显得假。
  const repliedFloorCount = Math.min(
    newCommentCount,
    pickInRange(FORUM_DEFAULTS.postRefreshRepliedFloorRange),
  );
  const subCommentRange = FORUM_DEFAULTS.postRefreshSubCommentRange;

  // 评论区全貌：TA 看到的就是一个普通网友看到的样子——一堆网名和话，没有"用户"这种标签。
  const allComments = await db.getCommentsByPost(postId);
  const floorLabels = new Map<string, string>();
  mustReply.forEach(f => floorLabels.set(f.threadRootId, `楼 ${f.threadRootId}·等人接`));
  randomlyPicked.forEach(f => floorLabels.set(f.threadRootId, `楼 ${f.threadRootId}·等人接`));
  const postAuthor = accountsById.get(post.authorAccountId);

  const floorBlock = (floors: PendingFloor[]) => floors.map(f => {
    const speaker = accountsById.get(f.latestComment.authorAccountId);
    const who = speaker ? `@${speaker.handle}（${speaker.displayName}）` : '@已注销用户';
    return `- threadRootId=${f.threadRootId}，这楼最新一条是 ${who} 说的："${f.latestComment.content}"`;
  }).join('\n') || '（无）';

  // 配图：全给它看（帖子最多 9 张）。[用户确认] 宁可慢一点也要让评论对得上图。
  // 本地相册图解析成 data URL 直接进请求；外链不送（用户不传网图，真有也只在文里提一句）。
  const { sent: promptImages, skippedRemote, skippedBroken } =
    await resolvePostImagesForPrompt(post.images, FORUM_DEFAULTS.postRefreshMaxImages);

  const imageNote = (() => {
    const lines: string[] = [];
    if (promptImages.length > 0) {
      lines.push(`这条帖子配了 ${promptImages.length} 张图，已经附在这条消息后面，你能直接看到。`);
      lines.push('评论时可以针对图里的内容说话——夸、吐槽、问细节、玩梗都行。');
      lines.push('但不要每条评论都提图，那样很假；就像真人刷到一张照片那样，有人说图、有人只说文字。');
      lines.push('也不要描述图里明显没有的东西。看不清的就别硬写。');
    }
    if (skippedRemote > 0) {
      lines.push(`另外还有 ${skippedRemote} 张是网图，没给你看，只知道有这么几张。`);
    }
    if (skippedBroken > 0) {
      lines.push(`还有 ${skippedBroken} 张图已经打不开了，当它们不存在。`);
    }
    if (lines.length === 0 && post.images && post.images.length > 0) {
      lines.push(`这条帖子配了 ${post.images.length} 张图，但这次没能给你看到，所以别去评论图的内容。`);
    }
    return lines.length > 0 ? `\n=== 这条帖子的配图 ===\n${lines.join('\n')}\n` : '';
  })();

  const prompt = `
你是这个论坛帖子的"评论区生成器"。这次刷新要做两件事，一次性完成：
1) 给这条帖子补一批新的路人装饰性评论/立场发言（不针对下面的垫底楼，是普通的新增热闹）；
2) 针对下面列出的垫底楼各生成一条回复。

${charBlocks.join('\n\n') || '（这次没有具体角色在场，只有路人）'}

=== 帖子 ===
作者：${postAuthor ? `@${postAuthor.handle}（${postAuthor.displayName}）` : '@已注销用户'}
分区：${getTopicLabel(post.topicTag as ForumTopicTag)}
标题：${post.title}
正文：${post.content}
${imageNote}${(() => {
  const style = getTopicCommentStyle(post.topicTag);
  return style ? `\n=== 这个区的评论区风气 ===\n${style}\n（风气只影响大家怎么说话，不覆盖每个账号自己的人设——安静的人到了热闹的区还是偏安静，只是比平时多说两句。）\n` : '';
})()}
=== 目前的评论区（按时间从旧到新，每条前面是发言的网名）===
${renderCommentSection(allComments, accountsById, { floorLabels })}

=== 路人账号池（新增装饰评论 + "随便哪个路人接"的垫底楼，只能用这些handle）===
${roster.map(describeAccountForPrompt).join('\n')}

=== 这次在场的角色的号（用不用、用哪个，按上面那份人设自己判断）===
${presentTaAccounts.map(describeTaAccountForPrompt).join('\n') || '（这次没有可用的角色账号）'}

=== 必须由角色本人回复的垫底楼（这条 @ 了它）===
${floorBlock(mustReply)}

=== 随便哪个路人接的垫底楼 ===
${floorBlock(randomlyPicked)}

${buildSharedForumHardRules()}

=== 角色账号的使用规则 ===
- "必须由角色本人回复"区块里的楼：一定要由那个角色的某个账号来回，用主号还是小号由它按性格判断。
- 其它楼和新增评论：角色的账号**可以**用也**可以**不用。它有可能正好在逛这条帖子，也可能根本没看见。
  不要每次都让它出现，那样太刻意；也不要完全不出现。
- 替角色发言时，用的是上面那份人设：它的语气、在意什么、对谁什么态度，都照那份写，
  不要写成一个泛泛的网友。
- 用小号发言时，语气和关注点要贴着小号自己的定位走，不要写得跟主号一模一样，
  更不要在正文里暗示"其实我是某某"——论坛上没人知道那个号是谁。

=== 路人与角色的信息隔离（硬性约束） ===
上面那份角色人设**只在替这个角色本人发言时**才能用。写路人账号的评论时，你要当作
自己从来没读过那一块：
- 路人不知道这个角色是谁、叫什么、认识谁、跟谁私下聊过什么，也不知道任何人的真名或简介。
- 路人评论里不允许出现角色人设块里的任何信息——人名、称呼、简介内容、你们私下聊过的事、
  角色对某个人的看法，一律不行。哪怕是"听说你跟某某很熟"这种暗示也不行。
- 路人能看到的只有：这条帖子的标题正文、上面那份评论区里实际出现过的话、以及路人账号池里
  给出的账号信息。除此之外一无所知。
- 角色本人发言时同样不要在论坛上复述私下聊过的内容——论坛是公开场合，别人看得见。

=== 产出数量 ===
- 新增主楼评论：${newCommentCount} 条（每条都是新开的一楼）。
- 这 ${newCommentCount} 条里挑 ${repliedFloorCount} 条，底下各带 ${subCommentRange[0]}-${subCommentRange[1]} 条楼中楼回复
  （写进那条主楼的 replies 数组里）。挑哪几条你自己定——挑最容易引起反应的那种，
  别机械地挑前几条。剩下的主楼 replies 留空数组或者不写。
- 楼中楼要像真的在接话：可以是附和、抬杠、歪楼、追问，回的是**这一楼说的内容**，
  不是重新对帖子发表一遍看法。同一楼里的几条也可以互相呛。
- 垫底楼回复：上面列出几条就产出几条，threadRootId 必须精确对应。

=== 可选：角色起疑 ===
论坛上没有任何标签告诉你哪个号是谁。如果在场的角色读完这个评论区，觉得某个网名的说话
方式、用词习惯、在意的点，让它联想到自己认识的某个人（比如怀疑那是谁开的小号），
可以顺手记一笔。**这完全是可选的**——没有这种感觉就不要填，不要为了填而填；
判断依据只能来自评论区里实际出现的内容，不能凭空指认。记下来不等于要说出口，
说不说是另一回事。

请只返回 JSON：
{
  "newComments": [{ "authorHandle": "handle", "content": "评论内容", "replies": [{ "authorHandle": "handle", "content": "楼中楼回复" }] }],
  "floorReplies": [{ "threadRootId": "对应上面给的楼id", "authorHandle": "handle", "content": "回复内容" }],
  "suspicion": { "byHandle": "起疑的是角色的哪个号", "targetHandle": "它怀疑的那个账号", "reason": "一句话说明凭什么这么觉得" }
}
`.trim();

  const raw = await callForumAI(apiConfig, prompt, '论坛帖子刷新合并生成', promptImages);
  const parsed = extractJson<any>(raw);

  const now = Date.now();

  const newComments = Array.isArray(parsed?.newComments) ? parsed.newComments : [];
  for (const c of newComments) {
    // 只校验"这个 handle 是否在这次给出的账号里"，不再区分路人池和 TA 账号。
    if (!validHandles.has(String(c?.authorHandle || ''))) continue;
    const account = accountByHandle.get(String(c?.authorHandle || ''));
    if (!account || !c?.content) continue;
    const root = await feed.appendComment(postId, {
      authorAccountId: account.id,
      content: String(c.content).slice(0, 2000),
      createdAt: now,
    });

    // 楼中楼：挂在刚落库的这条主楼下面。时间戳逐条加 1 秒，保证楼内排序稳定——
    // appendComment 里楼内是按 createdAt 排的，全都同一毫秒的话顺序就不确定了。
    const replies = Array.isArray(c?.replies) ? c.replies : [];
    let offset = 0;
    for (const r of replies) {
      const replyHandle = String(r?.authorHandle || '');
      if (!validHandles.has(replyHandle)) continue;
      const replyAccount = accountByHandle.get(replyHandle);
      if (!replyAccount || !r?.content) continue;
      offset += 1000;
      await feed.appendComment(postId, {
        authorAccountId: replyAccount.id,
        content: String(r.content).slice(0, 2000),
        createdAt: now + offset,
        parentCommentId: root.id,
      });
      await feed.markCharInteractionIfApplicable(postId, replyAccount, altIsContinuedInUse(replyAccount.id));
    }
  }

  const floorReplies = Array.isArray(parsed?.floorReplies) ? parsed.floorReplies : [];
  const mustReplyIds = new Set(mustReply.map(f => f.threadRootId));
  const taHandleSet = new Set(presentTaAccounts.map(a => a.handle));
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

  await recordSuspicionFromOutput(parsed?.suspicion, accountsById, presentTaAccounts);
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
  /** 起疑的那个角色。用哪个号去问，由它自己在这次调用里选。 */
  charId?: string;
  /** 旧签名：直接指定用哪个号。留着是为了兼容老调用点，新代码传 charId。 */
  charAccountId?: string;
  /** 被质问的账号（用户的某个身份） */
  targetAccountId: string;
  userDisplayName?: string;
}

/**
 * 让 TA 决定要不要把怀疑挑明、用哪个号开口、以及怎么说。
 *
 * 用哪个号这件事原来是代码写死的（优先小号），但一个陌生小号跑来问"你是不是某某"，
 * 基本等于自曝——只有认识那个人的号才会问这种话。所以改成把两个号和各自的后果摆给它，
 * 让它自己挑：
 *   - 主号：摆明了是本人在问，对方一看就知道是谁在关心这件事；
 *   - 小号：藏住自己，但对方可能反过来意识到"这个小号怎么会问这个"，从而猜到是它。
 *
 * 挑明的时机和措辞同样由它自己定。返回 confronted=false 时什么都不会发生，
 * 下一个 4 小时时段会再给它一次开口的机会。
 */
export async function runCharConfrontation(params: RunCharConfrontationParams): Promise<{ confronted: boolean; message: string; usedAccountId?: string }> {
  const { apiConfig, targetAccountId, userDisplayName } = params;

  // charId 优先；只传了旧的 charAccountId 时，从那个号反查它的主人。
  let charId = params.charId;
  if (!charId && params.charAccountId) {
    charId = (await db.getForumAccount(params.charAccountId))?.charId;
  }
  if (!charId) return { confronted: false, message: '' };

  const target = await db.getForumAccount(targetAccountId);
  if (!target) return { confronted: false, message: '' };

  const identity = await getCharForumIdentity(charId);
  // 共管号不参与挑明：那是你们俩共用的号，用它去质问你自己很荒唐。
  const usableAccounts = [identity.main, identity.alt].filter((a): a is ForumAccount => !!a);
  if (usableAccounts.length === 0) return { confronted: false, message: '' };

  const ctx = await getForumCharContext(charId, { userDisplayName });
  const userName = ctx?.user.name || userDisplayName || '你认识的那个人';

  const row = await suspicion.getSuspicion(charId, targetAccountId);

  // 私信是按"用哪个号"分会话的，所以两个号的历史都要给它看——它选号时得知道
  // 自己用哪个号跟对方说过话。
  const historyBlocks: string[] = [];
  for (const acc of usableAccounts) {
    const history = await db.getDmThreadMessages(targetAccountId, acc.id);
    if (history.length === 0) continue;
    const lines = history.slice(-10).map(m =>
      `${m.fromAccountId === acc.id ? acc.displayName : target.displayName}：${m.content}`
    ).join('\n');
    historyBlocks.push(`【用 @${acc.handle} 跟 @${target.handle} 说过的话】\n${lines}`);
  }

  const optionLines = usableAccounts.map(acc => acc.isAlt
    ? `- 用小号 @${acc.handle}（${acc.displayName}）问：对方不知道这个号是你。`
      + `好处是你没暴露自己；风险是——一个素不相识的小号突然跑来问"你是不是某某"，`
      + `对方很可能反过来想"谁会问这种话"，于是猜到这个号就是你。`
      + `${acc.altPersonaNote ? `这个号的定位：${acc.altPersonaNote}` : ''}`
    : `- 用主号 @${acc.handle}（${acc.displayName}）问：等于摆明了是你本人在问。`
      + `对方会知道你在意这件事、也知道是你在查；但反过来，这个号本来就是你，没什么可暴露的。`
  ).join('\n');

  const prompt = `
${ctx?.text || ''}

=== 现在要决定的事 ===
你怀疑论坛账号"${target.displayName}"（@${target.handle}）其实是${userName}开的小号。
${row?.reason ? `你当初起疑的理由：${row.reason}` : ''}

要不要私信过去把这件事挑明？如果要，用你的哪个号去问？

${optionLines}

${historyBlocks.length > 0 ? `=== 你和这个号之间已有的私信 ===\n${historyBlocks.join('\n\n')}` : '（你还没跟这个号在私信里说过话）'}

${buildSharedForumHardRules()}

按你的性格决定。你可以直接问，可以拐着弯试探、先聊点别的再绕过去，也可以觉得时候
还没到、这次先不说（那就把 confront 填 false，什么都不会发生）。没有标准答案。

请只返回 JSON：
{
  "confront": true 或 false,
  "useHandle": "你决定用哪个号的 handle，必须是上面列出的其中一个",
  "message": "如果要说，你发过去的那条私信（用你选的那个号的口吻写）"
}
`.trim();

  try {
    const raw = await callForumAI(apiConfig, prompt, '论坛角色挑明怀疑');
    const parsed = extractJson<any>(raw);
    const message = String(parsed?.message || '').trim();
    if (parsed?.confront !== true || !message) return { confronted: false, message: '' };

    const chosen = usableAccounts.find(a => a.handle === String(parsed?.useHandle || ''))
      // 没选或选了个不存在的号：退回主号。宁可用主号，也不要替它拿小号去冒险。
      || identity.main || usableAccounts[0];

    await db.saveForumDmMessage({
      id: db.createForumDmMessageId(),
      // 收件人视角是用户的这个身份，所以用户切到这个号才看得到这条质问
      viewerIdentityAccountId: targetAccountId,
      counterpartAccountId: chosen.id,
      fromAccountId: chosen.id,
      content: message,
      createdAt: Date.now(),
    });
    await suspicion.markConfronted(charId, targetAccountId);
    return { confronted: true, message, usedAccountId: chosen.id };
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

  // 回话的是不是 TA 本人的号（主号/小号/共管号）。是的话就带上完整人设——
  // 以前这里只给了一个名字，回你的其实是个顶着 TA 名字的通用网友。
  const charId = counterpart.charId;
  const ctx = charId ? await getForumCharContext(charId, { userDisplayName: params.userDisplayName }) : null;
  const userName = ctx?.user.name || params.userDisplayName;

  // 对方是谁 —— 必须走身份遮罩。直接把 viewer 账号拼进提示词的话，ownerType/isAlt
  // 会把"这是用户的小号"直接送到 TA 眼前，猜小号的玩法当场作废。
  let viewerDescription = '一个论坛网友';
  let viewerKnownAsUser = false;
  if (viewer) {
    const charAccountIds = counterpart.charId
      ? (await db.getAllForumAccounts())
          .filter(a => a.charId === counterpart.charId && a.status === 'active')
          .map(a => a.id)
      : [counterpart.id];
    const masked = await maskAccountForChar(viewer, charAccountIds);
    viewerKnownAsUser = masked.knownAsUser;
    viewerDescription = describeMaskedAccount(masked, userName);
  }

  // "TA 猜你"的第二个入口。私信本来就是最该起疑的地方——你用小号直接跟它说话，
  // 说话习惯藏不住。已经确认是本人的号不用再猜，那边就不给这个出口。
  const canSuspect = !!ctx
    && counterpart.ownerType === 'char'      // 共管号不算：那个号你们俩共用，没什么好猜的
    && !!viewer && viewer.ownerType === 'user'
    && !viewerKnownAsUser;                   // 已经确认是本人的号，不用再猜
  const suspicionSlot = canSuspect ? `
=== 可选：你心里的判断 ===
论坛上没有任何标签告诉你对面是谁。如果跟这个号来回几句之后，你觉得对方的用词、语气、
在意的点很像${userName || '你认识的某个人'}，可以在 suspicion 里记一笔。
**这完全是可选的**：没有这种感觉就不要填，也不要因为对方随便说了句话就往这上面靠。
记下来只是你心里存了个疑，**不等于要在这条回复里说出来**——要不要挑明、什么时候挑明，
是以后你自己决定的事。这一轮你完全可以若无其事地把话接下去。
` : '';

  const prompt = `
${ctx?.text || ''}

=== 现在这件事 ===
你在论坛上用账号"${counterpart.displayName}"（handle=${counterpart.handle}），正在私信里回复对方。
${counterpart.isAlt && counterpart.altPersonaNote
    ? `这是你的小号，论坛上没人知道它是你。这个号的定位：${counterpart.altPersonaNote}`
    : ctx ? '这是你自己的号。' : describeAccountForPrompt(counterpart)}

=== 跟你私信的这个人 ===
${viewerDescription}
${/* 没标"就是本人"的，对你来说就是个陌生网友，别自作主张认亲 */ ''}

${buildSharedForumHardRules()}

=== 私信记录（含对方刚发的、还没被回复的消息）===
${historyBlock}
${suspicionSlot}
请以这个账号的口吻写一条回复（可以是针对最近几条消息的综合回应，不用逐条回，像真人私信一样自然）。
请只返回 JSON：
{ "reply": "回复正文"${suspicionSlot ? `,
  "suspicion": { "isThem": true 或 false, "reason": "为什么这么觉得，一句话" }` : ''} }
`.trim();

  const raw = await callForumAI(apiConfig, prompt, '论坛DM回复');
  const parsed = extractJson<any>(raw);
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

  // 起疑落库：跟帖子那边共用同一张表，所以聊天上下文、进论坛时的挑明流程都能看到这一笔。
  if (suspicionSlot && charId && parsed?.suspicion?.isThem === true) {
    const reason = String(parsed.suspicion.reason || '').slice(0, 300);
    await suspicion.markSuspected(charId, viewerIdentityAccountId, reason)
      .catch(e => console.warn('[ForumAi] 私信起疑落库失败:', e?.message || String(e)));
  }
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
  const charHeader = await buildSingleCharHeader(target.charId, userDisplayName);

  const prompt = `
${charHeader}

=== 现在这件事 ===
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

  // 被指认的是 TA 本人的小号时，认不认这件事必须由它按自己的性格和你们的关系来定，
  // 所以这里要带上完整人设；路人号就不用了，它本来就是路人。
  const realAltHeader = isRealAlt ? await buildSingleCharHeader(target.charId, userDisplayName) : '';

  const realAltPrompt = `
${realAltHeader}

=== 现在这件事 ===
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
  /** 由谁来发。TA 名下的主号/小号/共管号都在候选里，具体用哪个由它自己选。 */
  charId: string;
  /** 时段标签，直接传 forumScheduler.SHARED_ACCOUNT_BANDS 里对应项的 label（如"08:00–12:00"）。 */
  bandLabel: string;
}


/** TA 发帖时能挑的歌。跟朋友圈那套同源：它自己歌单 + 用户网易云"喜欢的音乐"。 */
interface ForumMusicCandidate {
  id: number;
  name: string;
  artists: string;
  albumPic: string;
  source: 'ta' | 'user';
}

/**
 * 攒一份真实的歌曲候选池给 TA 挑。
 *
 * 为什么不让它直接写歌名：它编出来的歌可能根本不存在，封面和歌手也只能一起编，
 * 点开还播不了。给一份真名单让它挑，挑出来的一定是真歌——这也是朋友圈的做法。
 *
 * 用户那半需要网易云 cookie 有效，而且这个角色被允许读用户音乐（canReadUserMusic）。
 * 拿不到就只剩 TA 自己歌单里的歌，再拿不到就返回空池，发帖时干脆不提配歌这回事。
 */
async function buildForumMusicCandidates(char: CharacterProfile): Promise<ForumMusicCandidate[]> {
  const out: ForumMusicCandidate[] = [];
  const seen = new Set<number>();

  for (const song of (char.musicProfile?.playlists || []).flatMap(pl => pl.songs || [])) {
    if (!song?.id || seen.has(song.id)) continue;
    seen.add(song.id);
    out.push({
      id: song.id,
      name: song.name || '',
      artists: song.artists || '未知歌手',
      albumPic: song.albumPic || '',
      source: 'ta',
    });
  }

  try {
    const { loadMusicCfgStandalone, musicApi, toHttps } = await import('../context/MusicContext');
    const musicCfg = loadMusicCfgStandalone();
    const canReadUser = char.musicProfile?.canReadUserMusic ?? true;
    if (musicCfg?.cookie && canReadUser) {
      const likeRes = await musicApi.call(musicCfg, 'likelist', {});
      const likedIds: number[] = (likeRes?.ids || likeRes?.data?.ids || []).slice(0, 8);
      if (likedIds.length > 0) {
        const detail = await musicApi.call(musicCfg, 'song/detail', { ids: likedIds });
        for (const song of (detail?.songs || [])) {
          if (!song?.id || seen.has(song.id)) continue;
          seen.add(song.id);
          out.push({
            id: song.id,
            name: song.name || '',
            artists: (song.ar || song.artists || []).map((a: any) => a.name).filter(Boolean).join(' / ') || '未知歌手',
            albumPic: toHttps(song.al?.picUrl || song.album?.picUrl || ''),
            source: 'user',
          });
        }
      }
    }
  } catch (e: any) {
    // cookie 失效 / 网络问题：静默降级成"只有 TA 自己歌单"，不影响发帖
    console.warn('[ForumAi] 读取用户网易云喜欢列表失败，跳过:', e?.message || String(e));
  }
  return out;
}

/** 候选池渲染成提示词里的清单，两边分开列，让 TA 知道哪些是对方的歌。 */
function formatForumMusicCandidates(candidates: ForumMusicCandidate[]): string {
  const taSongs = candidates.filter(c => c.source === 'ta').slice(0, 8);
  const userSongs = candidates.filter(c => c.source === 'user').slice(0, 8);
  const lines: string[] = [];
  if (taSongs.length > 0) {
    lines.push('你自己歌单里的：');
    lines.push(...taSongs.map(s => `  [id=${s.id}] ${s.name} - ${s.artists}`));
  }
  if (userSongs.length > 0) {
    lines.push('对方网易云"喜欢的音乐"里的（你能看到，因为对方允许你读）：');
    lines.push(...userSongs.map(s => `  [id=${s.id}] ${s.name} - ${s.artists}`));
  }
  return lines.join('\n');
}

/** 把一个账号的档案渲染成提示词里的几行。签名每次现读，你在界面上改完下一条就按新的来。 */
function describeOwnAccountForPrompt(account: ForumAccount, kindLabel: string, userName: string): string {
  const lines = [`【${kindLabel}】@${account.handle}（${account.displayName}）`];
  if (account.bio && account.bio.trim()) {
    lines.push(`  签名：${account.bio.trim()}`);
    lines.push(`  （签名是这个号公开的调性，论坛上谁都看得到。它要是写明了这个号该发什么、`
      + `不该发什么、用什么口气，就照着走；只是句普通签名的话，当成底色，别跟它拧着来。）`);
  }
  if (account.avatar || account.banner) lines.push(`  这个号有自己的头像/封面。`);
  return lines.join('\n');
}

/**
 * TA 在论坛上发一条帖子。1 次调用同时产出正文 + 一批装饰性 NPC 评论。
 *
 * [用户确认改动] 以前这里写死只有共管号能发。现在 TA 名下的三个号都是候选，
 * **用哪个由它自己选**：
 *   - 主号：摆明是它本人发的，谁都看得出来；
 *   - 小号：论坛上没人知道那是它，但${'${userName}'}可能从说话方式认出来——这是它自己要担的风险；
 *   - 共管号：它和用户共用的号，发出去等于代表你们俩。
 * 三种后果都写进提示词里，让它按当下想说什么、想不想被认出来自己权衡。
 */
export async function runSharedAccountExclusivePost(params: RunSharedAccountExclusivePostParams): Promise<ForumPost | null> {
  const { apiConfig, charId, bandLabel } = params;

  const identity = await getCharForumIdentity(charId);
  const candidates: { account: ForumAccount; kind: 'main' | 'alt' | 'shared'; label: string }[] = [];
  if (identity.main) candidates.push({ account: identity.main, kind: 'main', label: '你的主号' });
  if (identity.alt) candidates.push({ account: identity.alt, kind: 'alt', label: '你的小号' });
  if (identity.shared) candidates.push({ account: identity.shared, kind: 'shared', label: '共管账号' });
  if (candidates.length === 0) return null;

  const npcAccounts = await db.getActiveNpcAccounts();
  const roster = pickNpcPoolForBatch(npcAccounts, [], Math.min(npcAccounts.length, 5));
  const accountByHandle = new Map(roster.map(a => [a.handle, a]));

  // 这条帖子是 TA 本人发的，不是系统代笔。以前这里是一个既不认识你、也不认识 TA 的
  // 模型在写，写完还会进 TA 的长期记忆——等于往它脑子里塞别人的日记。
  const ctx = await getForumCharContext(charId);
  const user = ctx?.user || await loadForumUserProfile();

  // 生图能力：没配 / 没开「生图 API」时，提示词里连"可以配图"这件事都不提，
  // 免得 TA 写了 imagePrompt 却出不了图，白白多一段废字段。
  const { isImageGenApiReady } = await import('./imageGenApi');
  const canMakeImage = isImageGenApiReady(apiConfig.imageGenApi);

  // 配歌：给它一份真实歌单挑，没歌可挑就不提这回事。
  const musicCandidates = ctx?.char ? await buildForumMusicCandidates(ctx.char) : [];
  const canShareMusic = musicCandidates.length > 0;

  // 每个号的档案都是现读的，所以你在界面上改完签名，下一条帖子立刻按新的来。
  const accountBlock = candidates
    .map(c => describeOwnAccountForPrompt(c.account, c.label, user.name))
    .join('\n');

  const prompt = `
${ctx?.text || ''}

=== 你名下的论坛账号 ===
${accountBlock}

=== 现在这件事 ===
现在是 ${bandLabel} 这个时段。你要在论坛「杂波频段」上发一条**帖子**。

先决定用上面哪个号发，再写内容。三个号的后果不一样，按你此刻想说什么、想不想被认出来自己权衡：
- 用主号：论坛上谁都看得出这是你。想说的话要是你不介意被人对上号，就用它。
- 用小号：论坛上没人知道那是你。但${user.name}也在这个论坛上，可能从你的说话方式认出来——
  这个风险你自己担。有些话只有在没人知道是你的时候才说得出口，那就用它。
- 用共管账号：那是你和${user.name}共用的号，发出去等于代表你们俩，不只是你一个人。

写什么由你定：此刻在做的事、突然想到的一句话、想说给${user.name}听又不介意别人看到的话都行。
按你自己的性格、你们现在的关系、以及那个号本身的调性来写——不要写成一篇谁都能发的通用帖子。
也不要在正文里写论坛上没人该知道的事（你们私下聊过的细节、你另外那个号之类），
更不要在小号的帖子里暗示"其实我是某某"。
${canMakeImage ? `
=== 要不要配一张图 ===
你可以给这条帖子配**一张**图——就当是你自己随手拍的，或者顺手存的一张图。
要配就填 imagePrompt，不配就把这个字段留空或者干脆不写。**多数帖子是不配图的**，
只有当你此刻确实看到/做了什么值得拍下来的事，才配。别为了配而配。

imagePrompt 写成一句画面描述（中文英文都行），只描述**画面里有什么**：
场景、主体、光线、氛围、构图。不要写"发一张…的图"这种指令句，也不要在里面写人名。
它不是给人看的文案，是给画图的模型看的。
` : ''}${canShareMusic ? `
=== 要不要配一首歌 ===
你也可以给这条帖子配**一首**歌。只能从下面这份名单里挑，填 musicSongId（那个 id 数字），
不配就留空或者不写这个字段。**多数帖子是不配歌的**——只有当此刻确实在听、
或者这条帖子想说的话正好有首歌能替你说，才配。

${formatForumMusicCandidates(musicCandidates)}

名单之外的歌不要写，编一个 id 出来只会是一首点不开的歌。
挑对方歌单里的歌是有意味的——那等于在说"我听了你在听的"，你自己掂量要不要这么做。
图和歌只能选一样，不要同时配。
` : ''}
=== 可用的装饰性评论/点赞账号池（路人，随便谁来留两句）===
${roster.map(describeAccountForPrompt).join('\n')}

${buildSharedForumHardRules()}

请只返回 JSON：
{
  "accountHandle": "你决定用哪个号发（必须是上面列出的 handle 之一）",
  "topicTag": "话题tag",
  "title": "标题",
  "content": "正文",${canMakeImage ? `
  "imagePrompt": "要配图就写一句画面描述，不配就留空或省略这个字段",` : ''}${canShareMusic ? `
  "musicSongId": 要配歌就填上面名单里的那个 id 数字，不配就留空或省略,` : ''}
  "comments": [{ "authorHandle": "handle", "content": "评论内容" }]
}
`.trim();

  const raw = await callForumAI(apiConfig, prompt, '论坛角色发帖');
  const parsed = extractJson<any>(raw);
  const content = String(parsed?.content || '').trim();
  if (!content) return null;

  // 它选的号。选不出来或乱填就退回共管号，没有共管号就退回主号——宁可摆在明面上，
  // 也不替它拿小号去冒不该冒的风险（跟挑明那边同一个取舍）。
  const chosenHandle = String(parsed?.accountHandle || '').trim();
  const chosen = candidates.find(c => c.account.handle === chosenHandle)
    || candidates.find(c => c.kind === 'shared')
    || candidates.find(c => c.kind === 'main')
    || candidates[0];
  const account = chosen.account;

  // 配图：TA 自己决定要不要配（没写 imagePrompt 就是它判断这条不用配，不是故障）。
  // 一张封顶——九宫格对一条随手发的帖子来说太夸张，生图也是按张计费的。
  // 出图失败只退化成纯文字，绝不因此让整条帖子发不出去。
  let images: string[] | undefined;
  const imagePrompt = String(parsed?.imagePrompt || '').trim();
  if (canMakeImage && imagePrompt && apiConfig.imageGenApi) {
    try {
      const { generateImage } = await import('./imageGenApi');
      const results = await generateImage(apiConfig.imageGenApi, imagePrompt, {
        n: 1,
        meta: {
          appId: 'forum', appName: '杂波频段', purpose: 'TA 论坛发帖配图',
          charId, charName: ctx?.char.name,
        } as any,
      });
      const first = results[0];
      if (first?.src) {
        const { migrateDataUrlToRef } = await import('./blobRef');
        images = [first.src.startsWith('data:') ? await migrateDataUrlToRef(first.src) : first.src];
      }
    } catch (e: any) {
      console.warn(
        '[ForumAi] 发帖配图失败，退化成纯文字:',
        '\nprompt:', imagePrompt,
        '\nmessage:', e?.message || String(e),
      );
    }
  }

  // 配歌：只认名单里的 id，编出来的一律丢掉。图和歌只留一样，图优先。
  let music: db.ForumMusicCard | undefined;
  if (canShareMusic && !images) {
    const wantedId = Number(parsed?.musicSongId);
    const picked = Number.isFinite(wantedId) ? musicCandidates.find(c => c.id === wantedId) : undefined;
    if (picked) {
      music = {
        songId: picked.id,
        songName: picked.name || '未知歌曲',
        artists: picked.artists || '未知歌手',
        albumPic: picked.albumPic || '',
      };
    } else if (parsed?.musicSongId) {
      console.warn('[ForumAi] TA 给的 musicSongId 不在候选名单里，忽略:', parsed.musicSongId);
    }
  }

  const now = Date.now();
  const topicTag = FORUM_TOPIC_TAGS.some(t => t.tag === parsed?.topicTag) ? parsed.topicTag : 'daily_chatter';
  const post: ForumPost = {
    id: db.createForumPostId(),
    authorAccountId: account.id,
    postKind: 'organic',
    topicTag,
    title: String(parsed?.title || '').slice(0, 100),
    content: content.slice(0, 5000),
    images,
    music,
    createdAt: now,
    lastActivityAt: now,
    isCollected: false,
    involvesCharInteraction: false,
    // [用户确认] TA 用哪个号发的都永久保留，小号也一样——小号那几条往往正是你最想
    // 回头翻的（"它当时用那个号说了什么"），被三天水线清掉就找不回来了。
    isOwnedByUserSide: true,
    likes: [],
    // [用户确认·覆盖交接5 4.9] 原本只在共管号自己主页可见，现在跟用户手动发的帖走
    // 同一条路进公共 feed——否则同一个号会出现"你发的全论坛可见、它发的只有主页
    // 看得到"这种割裂。
    visibility: 'public',
  };
  await feed.createPost(post);

  // 便利贴：让 TA 在聊天里记得自己刚发过什么。
  // 小号的帖子不写——那是它瞒着用户的一面，写进便利贴等于给了它一个在聊天里
  // 顺嘴说漏的由头，互相猜小号的玩法就废了。它自己知道有这个号（见 forumIdentityMask）。
  if (chosen.kind !== 'alt') {
    const { upsertForumPostPin } = await import('./forumMemory');
    await upsertForumPostPin(charId, post).catch(e =>
      console.warn('[ForumAi] 发帖便利贴写入失败:', e?.message || String(e)));
  }

  const comments = Array.isArray(parsed?.comments) ? parsed.comments : [];
  for (const c of comments) {
    const commenter = accountByHandle.get(String(c?.authorHandle || ''));
    if (!commenter || !c?.content) continue;
    await feed.appendComment(post.id, { authorAccountId: commenter.id, content: String(c.content).slice(0, 2000), createdAt: now });
  }

  return post;
}
