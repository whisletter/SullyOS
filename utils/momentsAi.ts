/**
 * 朋友圈 AI 生成层
 *
 * 负责：
 *   1. 组装 prompt（角色人设 + 今日日程 + 近期聊天摘要 + 用户最近发的朋友圈）
 *   2. 调用 LLM API，返回结构化 JSON
 *   3. 解析并规范化 AI 返回的数据（TA 的新动态 + 对用户动态的互动）
 *
 * 调用方：MomentsApp.tsx（打开时 + 手动刷新）
 */

import type { CharacterProfile, UserProfile, APIConfig } from '../types';
import type { MomentPost, MomentComment, MomentSettings, MomentUpdateFrequency } from './momentsDb';
import { createPostId, createCommentId } from './momentsDb';
import { ContextBuilder } from './context';
import { DB } from './db';
import { safeFetchJson, extractJson } from './safeApi';
import { formatMessageForPrompt } from './messageFormat';
import { buildScheduleInjection, type RenderableSchedule } from './scheduleInjection';
import { generateImage, isImageGenApiReady } from './imageGenApi';
import { migrateDataUrlToRef } from './blobRef';

// ==================== 类型定义 ====================

/** AI 返回的一条 TA 的新动态（原始格式） */
interface AiGeneratedPost {
  text: string;
  type?: 'text' | 'image' | 'imageText';
  /** AI 自选的发布时间，格式 "HH:MM" 或 ISO */
  postTime?: string;
  /** 心情/场景标签，可选 */
  mood?: string;
  /**
   * 可选：这条动态想配一张图时，一句简短的英文图片描述；不想配图就不填。
   * 是否配图完全由 AI 自己判断（人设/日程/近期聊天语境），前端只按这个字段是否
   * 存在来决定最终落库的 type，不需要 AI 自己在 text/image/imageText 里三选一。
   * 只有全局生图 API 已开启时，prompt 里才会教这个字段；否则 AI 不会写它。
   */
  imagePrompt?: string;
}

/** AI 返回的对用户某条动态的互动 */
interface AiInteraction {
  /** 对应的用户动态 id */
  postId: string;
  /** 是否点赞 */
  like?: boolean;
  /** 评论内容（空字符串或 null 表示不评论） */
  comment?: string;
}

/** AI 返回的、对 TA 自己动态评论区里用户追评的回复 */
interface AiCommentReply {
  /** TA 自己那条动态的 id */
  postId: string;
  /** 要回复的那条用户评论的 id */
  replyToCommentId: string;
  /** 回复内容 */
  comment: string;
}

/** AI 返回的完整结构 */
interface AiMomentsResponse {
  newPosts: AiGeneratedPost[];
  interactions: AiInteraction[];
  commentReplies?: AiCommentReply[];
}

/** generateMoments 的入参 */
export interface GenerateMomentsInput {
  char: CharacterProfile;
  userProfile: UserProfile;
  apiConfig: APIConfig;
  settings: MomentSettings;
  /** 当前已有的全部动态（用于去重 + 提供用户动态给 AI 互动） */
  existingPosts: MomentPost[];
  /**
   * "暂停营业"模式下为 true：只做任务 1（发新动态），跳过任务 2（点赞/评论用户动态）
   * 和任务 3（回复自己动态下的追评）——因为这个状态代表"联系不上 TA"，TA 不会看用户的朋友圈。
   */
  skipInteractions?: boolean;
  /** 可选：外部传入的 AbortSignal */
  signal?: AbortSignal;
}

/** generateMoments 的返回 */
export interface GenerateMomentsResult {
  /** TA 的新动态（已构造为 MomentPost，可直接 savePost） */
  newPosts: MomentPost[];
  /** 被 AI 互动过的用户动态（已更新 likes/comments，可直接 savePost） */
  updatedUserPosts: MomentPost[];
  /** TA 自己的动态里被追加了「回复用户追评」的那些（已更新 comments，可直接 savePost） */
  updatedTaPosts: MomentPost[];
}

// ==================== Prompt 构建 ====================

/**
 * 收集近期聊天摘要（最近 15 条有语义价值的消息）
 */
async function getRecentChatSummary(
  charId: string,
  charName: string,
  userName: string,
): Promise<string> {
  try {
    const messages = await DB.getRecentMessagesByCharId(charId, 40, true);
    // 过滤出有内容的文本消息
    const meaningful = messages.filter(m =>
      m.type === 'text' && m.content?.trim() && !m.groupId
    ).slice(-15);
    if (meaningful.length === 0) return '(暂无近期聊天记录)';
    return meaningful
      .map(m => formatMessageForPrompt(m, charName, userName).slice(0, 300))
      .join('\n');
  } catch {
    return '(聊天记录读取失败)';
  }
}

/**
 * 获取今日日程文本
 */
async function getTodayScheduleText(char: CharacterProfile): Promise<string> {
  try {
    const today = new Date();
    const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const schedule = await DB.getDailySchedule(char.id, dateKey);
    if (!schedule || !schedule.slots?.length) return '(今天没有生成日程)';
    const injection = buildScheduleInjection(schedule as RenderableSchedule);
    if (injection.trim()) return injection;
    // fallback：直接列出 slots
    return schedule.slots
      .map(s => `${s.startTime} ${s.activity}${s.location ? `（${s.location}）` : ''}`)
      .join('\n');
  } catch {
    return '(日程读取失败)';
  }
}

/**
 * 格式化用户最近的朋友圈动态（供 AI 参考和互动）
 */
function formatUserPosts(posts: MomentPost[]): string {
  const userPosts = posts
    .filter(p => p.author === 'user')
    .slice(0, 5); // 最多 5 条

  if (userPosts.length === 0) return '(用户还没有发过朋友圈)';

  return userPosts.map(p => {
    const time = new Date(p.createdAt);
    const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
    const alreadyLiked = p.likes.includes(p.charId);
    const alreadyCommented = p.comments.some(c => c.author !== 'user');
    let desc = `[id=${p.id}] ${timeStr} `;
    switch (p.type) {
      case 'text': desc += `文字: "${(p.text || '').slice(0, 100)}"`; break;
      case 'image': desc += `图片${p.images?.length || 0}张`; break;
      case 'imageText': desc += `图文: "${(p.text || '').slice(0, 80)}" + 图片${p.images?.length || 0}张`; break;
      case 'music': desc += `分享音乐: ${p.music?.songName || '未知'} - ${p.music?.artists || ''}`; break;
      case 'article': desc += `分享文章: ${p.article?.title || '未知'}`; break;
    }
    if (alreadyLiked) desc += ' (你已点赞)';
    if (alreadyCommented) desc += ' (你已评论)';
    return desc;
  }).join('\n');
}

/**
 * 格式化 TA 最近发过的动态（防止重复）
 */
function formatTaRecentPosts(posts: MomentPost[], charId: string): string {
  const taPosts = posts
    .filter(p => p.author === charId)
    .slice(0, 5);
  if (taPosts.length === 0) return '(还没发过朋友圈)';
  return taPosts.map(p => {
    const time = new Date(p.createdAt);
    const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
    return `${timeStr} "${(p.text || '').slice(0, 80)}"`;
  }).join('\n');
}

/**
 * 扫描出「TA 自己发的动态里，评论区最后一条是用户发的」这些——也就是轮到 TA 接话的动态。
 * 只看最后一条评论的作者：如果最后一条已经是 TA 自己回的，说明这一串对话已经回复完了，
 * 不需要再扫到它，避免同一条动态被反复追问。
 */
function findPendingReplies(posts: MomentPost[], charId: string): MomentPost[] {
  return posts.filter(p => {
    if (p.author !== charId) return false;
    if (p.comments.length === 0) return false;
    const last = [...p.comments].sort((a, b) => a.createdAt - b.createdAt)[p.comments.length - 1];
    return last.author === 'user';
  });
}

/**
 * 格式化「待回复列表」喂给 prompt：每条动态本身的内容 + 完整评论串（谁说了什么，按时间顺序），
 * 让 AI 能看懂这段对话聊到哪、该接谁的话。
 */
function formatPendingReplies(pendingPosts: MomentPost[], charName: string): string {
  if (pendingPosts.length === 0) return '(没有需要你回复的评论)';
  return pendingPosts.map(p => {
    const sortedComments = [...p.comments].sort((a, b) => a.createdAt - b.createdAt);
    const commentsText = sortedComments.map(c => {
      const speaker = c.author === 'user' ? '用户' : charName;
      const replyPart = c.replyToName ? `回复${c.replyToName}` : '';
      return `  [commentId=${c.id}] ${speaker}${replyPart}: "${c.content}"`;
    }).join('\n');
    return `[postId=${p.id}] 你发的动态: "${(p.text || '').slice(0, 60)}"\n${commentsText}`;
  }).join('\n\n');
}

/**
 * 组装完整的 system prompt
 */
function buildMomentsPrompt(
  char: CharacterProfile,
  userProfile: UserProfile,
  settings: MomentSettings,
  scheduleText: string,
  chatSummary: string,
  userPostsText: string,
  taRecentText: string,
  pendingRepliesText: string,
  maxPosts: number,
  imageGenAvailable: boolean,
  skipInteractions: boolean,
): string {
  // 角色核心人设
  const coreContext = ContextBuilder.buildCoreContext(char, userProfile, false, undefined, {
    skipUserProfile: true,
    headerOverride: '[角色档案]',
  });

  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const currentDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const contextSections = skipInteractions ? '' : `
【用户最近发的朋友圈】
${userPostsText}

【你最近发的朋友圈（不要重复类似内容）】
${taRecentText}

【你自己动态下面，用户刚追评、还等你回话的】
${pendingRepliesText}
`;

  const tasksSection = skipInteractions
    ? `现在你只需要做一件事：

1. 发 1 到 ${maxPosts} 条朋友圈动态
   - 内容要符合你的人设、当前时间和日程
   - postTime 填你"发"这条的时间（必须是今天且早于 ${currentTime}），格式 "HH:MM"
   - 文字风格要像真人发朋友圈：简短、口语化、可以带 emoji、不要太正式
   - 可以分享日常、感想、吐槽、自拍描述、转发感悟等${imageGenAvailable ? `
   - 这条动态要不要配图，由你自己判断：想配图就在这条里加一个 "imagePrompt" 字段，
     写一句简短的英文图片描述（场景/动作/穿着等细节）；不想配图就不要写这个字段` : ''}`
    : `现在你要做三件事：

1. 发 1 到 ${maxPosts} 条朋友圈动态
   - 内容要符合你的人设、当前时间和日程
   - postTime 填你"发"这条的时间（必须是今天且早于 ${currentTime}），格式 "HH:MM"
   - 不要和你之前发过的动态内容重复
   - 文字风格要像真人发朋友圈：简短、口语化、可以带 emoji、不要太正式
   - 可以分享日常、感想、吐槽、自拍描述、转发感悟等${imageGenAvailable ? `
   - 这条动态要不要配图，由你自己判断（结合人设/日程/最近聊天语境，不是每条都要配）：想配图就在这条里加一个
     "imagePrompt" 字段，写一句简短的英文图片描述（场景/动作/穿着等细节）；不想配图就不要写这个字段` : ''}

2. 看用户的朋友圈，决定是否点赞/评论
   - 对标了"(你已点赞)"或"(你已评论)"的动态不要重复互动
   - 评论要简短自然、符合你和用户的关系
   - 不是每条都要互动，根据内容和你的性格决定

3. 看"用户刚追评、还等你回话的"这部分，逐条决定要不要接话
   - 每条动态下面列出的评论是完整对话串（谁在什么时候说了什么），最后一条一定是用户发的
   - 你可以回复也可以不回复（觉得没必要接就跳过），符合你的性格和当下语境即可
   - 如果要回复，commentReplies 里加一项：postId 填对应动态的 id，replyToCommentId 填你要回复的
     那条用户评论的 commentId（通常是列表里最后一条，除非你想回应更早的某句话），comment 填回复内容
   - 回复要像真人聊天接话，别写成一段客套的官方回应`;

  const jsonFormat = skipInteractions
    ? `{
  "newPosts": [
    {
      "text": "朋友圈文字内容",
      "postTime": "HH:MM"${imageGenAvailable ? `,
      "imagePrompt": "可选：想配图就写一句简短的英文图片描述；不配图就不要写这个字段"` : ''}
    }
  ]
}`
    : `{
  "newPosts": [
    {
      "text": "朋友圈文字内容",
      "postTime": "HH:MM"${imageGenAvailable ? `,
      "imagePrompt": "可选：想配图就写一句简短的英文图片描述；不配图就不要写这个字段"` : ''}
    }
  ],
  "interactions": [
    {
      "postId": "用户动态的 id",
      "like": true,
      "comment": "评论内容或 null"
    }
  ],
  "commentReplies": [
    {
      "postId": "你自己动态的 id（来自「用户刚追评」列表）",
      "replyToCommentId": "要回复的那条用户评论的 commentId",
      "comment": "回复内容"
    }
  ]
}`;

  return `你是「${char.name}」，正在发朋友圈${skipInteractions ? '' : '和浏览朋友圈'}。

${coreContext}

【你和用户的关系】
用户名: ${userProfile.name || '用户'}
${userProfile.bio ? `用户简介: ${userProfile.bio}` : ''}

【当前时间】${currentDate} ${currentTime}

【你今天的日程】
${scheduleText}

【你和用户的近期聊天片段】
${chatSummary}
${contextSections}
===

${tasksSection}

请严格按以下 JSON 格式返回，不要附加任何其他文字：

${jsonFormat}`;
}

// ==================== API 调用 ====================

/**
 * 核心函数：生成 TA 的朋友圈动态 + 对用户动态的互动
 */
export async function generateMoments(input: GenerateMomentsInput): Promise<GenerateMomentsResult> {
  const { char, userProfile, apiConfig, settings, existingPosts, skipInteractions, signal } = input;
  const charId = char.id;
  const charName = char.name;
  const userName = userProfile.name || '用户';
  const maxPosts = settings.taPostFrequency || 3;

  // 1. 收集上下文（暂停营业模式跳过用户动态/待回复相关的收集，反正 prompt 不会用到）
  const [chatSummary, scheduleText] = await Promise.all([
    getRecentChatSummary(charId, charName, userName),
    getTodayScheduleText(char),
  ]);
  const userPostsText = skipInteractions ? '' : formatUserPosts(existingPosts);
  const taRecentText = formatTaRecentPosts(existingPosts, charId);
  const pendingReplyPosts = skipInteractions ? [] : findPendingReplies(existingPosts, charId);
  const pendingRepliesText = skipInteractions ? '' : formatPendingReplies(pendingReplyPosts, charName);

  // 2. 构建 prompt
  const imageGenAvailable = isImageGenApiReady(apiConfig.imageGenApi);
  const systemPrompt = buildMomentsPrompt(
    char, userProfile, settings,
    scheduleText, chatSummary, userPostsText, taRecentText, pendingRepliesText,
    maxPosts, imageGenAvailable, !!skipInteractions,
  );

  // 3. 调用 API
  const url = `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: apiConfig.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: skipInteractions ? '请根据当前时间和日程，发你的朋友圈。只返回 JSON。' : '请根据当前时间和日程，发你的朋友圈，并看看我发的朋友圈。只返回 JSON。' },
    ],
    temperature: 0.85,
    max_tokens: 2600,
  };

  const data = await safeFetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiConfig.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  } as RequestInit, 1, 30_000, {
    appId: 'moments',
    appName: '朋友圈',
    purpose: '生成 TA 的动态',
  });

  // 4. 解析返回
  const content = data?.choices?.[0]?.message?.content || '';
  const parsed = extractJson(content) as AiMomentsResponse | null;
  if (!parsed) {
    console.warn('[Moments] JSON 解析失败，原始返回内容:', content);
    throw new Error('AI 返回的内容无法解析为 JSON');
  }
  // 诊断日志：一眼看出这一轮 AI 到底给没给 imagePrompt，不用等配图失败才排查。
  console.info(
    '[Moments] AI 返回的 newPosts 原始内容:',
    (parsed.newPosts || []).map(p => ({ text: p.text?.slice(0, 30), imagePrompt: p.imagePrompt })),
  );

  // 5. 构造 MomentPost[]
  const now = new Date();
  const newPosts: MomentPost[] = (parsed.newPosts || [])
    .filter(p => p.text?.trim())
    .slice(0, maxPosts)
    .map(p => {
      // 解析 postTime → 时间戳
      let timestamp = now.getTime() - Math.floor(Math.random() * 3600_000); // 默认：过去 1 小时内
      if (p.postTime && /^\d{1,2}:\d{2}$/.test(p.postTime)) {
        const [h, m] = p.postTime.split(':').map(Number);
        const d = new Date(now);
        d.setHours(h, m, Math.floor(Math.random() * 60), 0);
        // 确保在过去
        if (d.getTime() > now.getTime()) {
          d.setTime(now.getTime() - Math.floor(Math.random() * 600_000));
        }
        timestamp = d.getTime();
      }

      const imagePrompt = imageGenAvailable ? p.imagePrompt?.trim() : undefined;
      const post: MomentPost = {
        id: createPostId(),
        charId,
        author: charId,
        authorName: charName,
        authorAvatar: char.avatar || '',
        // 前端根据 imagePrompt 是否存在决定 type，不需要 AI 自己在 text/image/imageText 里三选一。
        type: imagePrompt ? 'imageText' : 'text',
        text: p.text.trim(),
        imagePrompt,
        likes: [],
        likeNames: [],
        comments: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return post;
    });

  // 5.5 并发给需要配图的动态生图。单条失败只退化成纯文字发布（type 改回 text，但保留
  // imagePrompt——用户在朋友圈里点裂图上的 🔄 时，还能用同一句描述再试一次，不用重新
  // 问 AI「这条要不要配图、配什么」。
  if (imageGenAvailable && apiConfig.imageGenApi) {
    const imageGenApiConfig = apiConfig.imageGenApi;
    await Promise.all(newPosts.map(async (post) => {
      const imagePrompt = post.imagePrompt;
      if (!imagePrompt) {
        // AI 这条没写 imagePrompt，属于它自己判断"不配图"，不是故障。
        console.info('[Moments] 这条动态 AI 没有给 imagePrompt，按纯文字发布:', post.id);
        return;
      }
      console.info('[Moments] 开始为动态配图:', post.id, 'prompt =', imagePrompt);
      try {
        const results = await generateImage(imageGenApiConfig, imagePrompt, {
          meta: { appId: 'moments', appName: '朋友圈', purpose: '朋友圈自动配图', charId, charName } as any,
        });
        const first = results[0];
        if (!first?.src) throw new Error('生图 API 没有返回图片（results 为空或缺少 src）');
        console.info('[Moments] 生图成功，开始转存本地引用:', post.id);
        const storedContent = first.src.startsWith('data:') ? await migrateDataUrlToRef(first.src) : first.src;
        post.images = [storedContent];
        console.info('[Moments] 配图完成:', post.id);
      } catch (e: any) {
        // 显式打印 message + stack，而不是让 console.warn 自己决定怎么展开 Error 对象，
        // 方便直接从控制台文本里看出是网络错误、格式错误还是 migrateDataUrlToRef 失败。
        console.warn(
          '[Moments] 这条动态配图失败，退化成纯文字:',
          post.id,
          '\nmessage:', e?.message || String(e),
          '\nstack:', e?.stack || '(无堆栈)',
        );
        post.type = 'text';
      }
    }));
  }

  // 6. 处理互动（更新用户的动态）
  const updatedUserPosts: MomentPost[] = [];
  for (const interaction of (parsed.interactions || [])) {
    if (!interaction.postId) continue;
    const userPost = existingPosts.find(p => p.id === interaction.postId && p.author === 'user');
    if (!userPost) continue;

    let updated = { ...userPost };
    let changed = false;

    // 点赞
    if (interaction.like && !updated.likes.includes(charId)) {
      updated = {
        ...updated,
        likes: [...updated.likes, charId],
        likeNames: [...updated.likeNames, charName],
      };
      changed = true;
    }

    // 评论
    if (interaction.comment?.trim()) {
      const alreadyCommented = updated.comments.some(c => c.author === charId);
      if (!alreadyCommented) {
        const comment: MomentComment = {
          id: createCommentId(),
          author: charId,
          authorName: charName,
          content: interaction.comment.trim(),
          createdAt: Date.now() - Math.floor(Math.random() * 300_000), // 过去几分钟
        };
        updated = {
          ...updated,
          comments: [...updated.comments, comment],
        };
        changed = true;
      }
    }

    if (changed) {
      updated.updatedAt = Date.now();
      updatedUserPosts.push(updated);
    }
  }

  // 7. 处理 commentReplies（TA 回复自己动态下面、用户刚追评的那些）
  const updatedTaPosts: MomentPost[] = [];
  for (const reply of (parsed.commentReplies || [])) {
    if (!reply.postId || !reply.replyToCommentId || !reply.comment?.trim()) continue;
    // 只允许回复"确实在待回复列表里"的动态，防止 AI 瞎编 postId/commentId 造成脏数据。
    const taPost = pendingReplyPosts.find(p => p.id === reply.postId);
    if (!taPost) continue;
    const targetComment = taPost.comments.find(c => c.id === reply.replyToCommentId);
    if (!targetComment) continue;

    const alreadyUpdated = updatedTaPosts.find(p => p.id === taPost.id);
    const base = alreadyUpdated || taPost;
    const comment: MomentComment = {
      id: createCommentId(),
      author: charId,
      authorName: charName,
      replyTo: targetComment.id,
      replyToName: targetComment.authorName,
      replyToAuthor: targetComment.author,
      content: reply.comment.trim(),
      createdAt: Date.now() - Math.floor(Math.random() * 300_000), // 过去几分钟
    };
    const updated: MomentPost = {
      ...base,
      comments: [...base.comments, comment],
      updatedAt: Date.now(),
    };
    if (alreadyUpdated) {
      const idx = updatedTaPosts.findIndex(p => p.id === taPost.id);
      updatedTaPosts[idx] = updated;
    } else {
      updatedTaPosts.push(updated);
    }
  }

  return { newPosts, updatedUserPosts, updatedTaPosts };
}

// ==================== 冷却检查 ====================

/** 更新频率档位 → 冷却毫秒数；'paused' 特殊处理，见 canGenerate。 */
const FREQUENCY_COOLDOWN_MS: Record<Exclude<MomentUpdateFrequency, 'paused'>, number> = {
  '5min': 5 * 60_000,
  '30min': 30 * 60_000,
  '1h': 60 * 60_000,
  '2h': 2 * 60 * 60_000,
};

/**
 * 距离上次生成是否已过冷却期。'paused'（暂停营业）下，自动触发（打开 App / 查手机跳转）
 * 永远返回 false——那条路径完全不生成；🌼 秘密空间走的是独立的 generateSecretMemory，
 * 不经过这个函数，所以暂停营业下🌼依然可用。
 */
export function canGenerate(settings: MomentSettings): boolean {
  if (settings.updateFrequency === 'paused') return false;
  if (!settings.lastGeneratedAt) return true;
  const cooldownMs = FREQUENCY_COOLDOWN_MS[settings.updateFrequency] ?? FREQUENCY_COOLDOWN_MS['30min'];
  return Date.now() - settings.lastGeneratedAt > cooldownMs;
}

// ==================== 秘密空间（🌼）====================

/** generateSecretMemory 的入参 */
export interface GenerateSecretMemoryInput {
  char: CharacterProfile;
  userProfile: UserProfile;
  apiConfig: APIConfig;
  settings: MomentSettings;
  /** 当前已有的全部动态（用于算"最早时间点"和防重复） */
  existingPosts: MomentPost[];
  signal?: AbortSignal;
}

/**
 * "暂停营业"状态下，TA 朋友圈页面的🌼按钮触发：生成一条更早于 TA 当前最早动态时间的
 * "秘密心事"——不读最近聊天上下文（这是过去的事，跟当下语境无关），依据人设 + 记忆宫殿
 * 生成。这批动态只进 TA 的秘密空间列表，不进"我的朋友圈"混合时间线，也不进 TA 朋友圈
 * 常规列表（调用方要用 isSecretMemory 过滤）。
 */
export async function generateSecretMemory(input: GenerateSecretMemoryInput): Promise<MomentPost> {
  const { char, userProfile, apiConfig, existingPosts, signal } = input;
  const charId = char.id;
  const charName = char.name;

  // 找出整条历史线（含之前已生成的秘密动态）里最早的时间点，新的一条必须比它更早，
  // 避免多次点🌼之间互相穿插、时间线乱掉。
  const taPosts = existingPosts.filter(p => p.author === charId);
  const earliestTs = taPosts.length > 0
    ? Math.min(...taPosts.map(p => p.createdAt))
    : Date.now();
  const earliestDate = new Date(earliestTs);
  const earliestDateStr = `${earliestDate.getFullYear()}-${String(earliestDate.getMonth() + 1).padStart(2, '0')}-${String(earliestDate.getDate()).padStart(2, '0')}`;

  const coreContext = ContextBuilder.buildCoreContext(char, userProfile, false, undefined, {
    skipUserProfile: true,
    headerOverride: '[角色档案]',
  });
  const memorySnippet = char.memoryPalaceEnabled && char.memoryPalaceInjection?.trim()
    ? char.memoryPalaceInjection.trim()
    : '(暂无记忆宫殿内容，凭人设自行想象一段合理的过去经历)';
  const imageGenAvailable = isImageGenApiReady(apiConfig.imageGenApi);

  const systemPrompt = `你是「${char.name}」。现在要写一条你自己都没对任何人说过的朋友圈——一条秘密心事，
只有你自己能看到，用户和其他任何人都看不到、也不知道这条动态存在。

${coreContext}

【你的部分记忆片段（可作为这条秘密心事的素材）】
${memorySnippet}

【时间限制】这条动态必须发生在 ${earliestDateStr} 之前（可以是具体某一年、几个月前、几周前、几天前、
甚至几小时前，只要早于这个日期即可）。必须写清楚具体的年月日，禁止使用"多年前""很久以前"这种模糊表达。

【写作要求】
- 内容是一段没对用户或任何人说出口的心事、隐秘的感受、独自藏着的小事——不是日常流水账
- 完全不用考虑当下的聊天语境或日程，这是纯粹的过去
- 文字风格自然、私密，像写给自己看的${imageGenAvailable ? `
- 想配图就加一个 "imagePrompt" 字段，写一句简短的英文图片描述；不想配图就不要写这个字段` : ''}

请严格按以下 JSON 格式返回，不要附加任何其他文字：

{
  "text": "这条秘密心事的内容",
  "date": "YYYY-MM-DD"${imageGenAvailable ? `,
  "imagePrompt": "可选：想配图就写一句简短的英文图片描述"` : ''}
}`;

  const url = `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: apiConfig.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: '写一条你的秘密心事。只返回 JSON。' },
    ],
    temperature: 0.95,
    max_tokens: 800,
  };

  const data = await safeFetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiConfig.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  } as RequestInit, 1, 30_000, {
    appId: 'moments',
    appName: '朋友圈',
    purpose: '生成秘密空间历史动态',
  });

  const content = data?.choices?.[0]?.message?.content || '';
  const parsed = extractJson(content) as { text?: string; date?: string; imagePrompt?: string } | null;
  if (!parsed?.text?.trim()) {
    console.warn('[Moments/Secret] JSON 解析失败或缺少 text，原始返回内容:', content);
    throw new Error('AI 没有返回有效的秘密动态内容');
  }

  // 解析日期 → 时间戳，必须早于 earliestTs；解析失败或晚于下限就兜底成"最早时间点再往前随机 1~90 天"。
  let timestamp: number;
  const dateMatch = parsed.date && /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(parsed.date.trim());
  if (dateMatch) {
    const [, y, m, d] = dateMatch;
    const candidate = new Date(Number(y), Number(m) - 1, Number(d), Math.floor(Math.random() * 24), Math.floor(Math.random() * 60));
    timestamp = candidate.getTime() < earliestTs ? candidate.getTime() : earliestTs - (1 + Math.floor(Math.random() * 90)) * 86_400_000;
  } else {
    timestamp = earliestTs - (1 + Math.floor(Math.random() * 90)) * 86_400_000;
  }

  const imagePrompt = imageGenAvailable ? parsed.imagePrompt?.trim() : undefined;
  const post: MomentPost = {
    id: createPostId(),
    charId,
    author: charId,
    authorName: charName,
    authorAvatar: char.avatar || '',
    type: imagePrompt ? 'imageText' : 'text',
    text: parsed.text.trim(),
    imagePrompt,
    isSecretMemory: true,
    likes: [],
    likeNames: [],
    comments: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  if (imagePrompt && apiConfig.imageGenApi) {
    try {
      const results = await generateImage(apiConfig.imageGenApi, imagePrompt, {
        meta: { appId: 'moments', appName: '朋友圈', purpose: '秘密空间动态配图', charId, charName } as any,
      });
      const first = results[0];
      if (!first?.src) throw new Error('生图 API 没有返回图片');
      const storedContent = first.src.startsWith('data:') ? await migrateDataUrlToRef(first.src) : first.src;
      post.images = [storedContent];
    } catch (e: any) {
      console.warn('[Moments/Secret] 配图失败，退化成纯文字:', e?.message || String(e));
      post.type = 'text';
    }
  }

  return post;
}

/** generateSecretSpaceIdentity 的返回：背景图 + 名字 + 签名（"换个心情"按钮用） */
export interface SecretSpaceIdentity {
  coverImage?: string;
  name: string;
  signature: string;
}

/**
 * 🌼 秘密空间"换个心情"：只重新生成背景图 + 名字 + 个性签名，不动下面的历史动态列表。
 * 名字和签名要体现"卸下平时人设包袱"的私密自称感，跟 TA 平时在朋友圈/聊天里的样子不同。
 */
export async function generateSecretSpaceIdentity(
  char: CharacterProfile,
  userProfile: UserProfile,
  apiConfig: APIConfig,
  signal?: AbortSignal,
): Promise<SecretSpaceIdentity> {
  const coreContext = ContextBuilder.buildCoreContext(char, userProfile, false, undefined, {
    skipUserProfile: true,
    headerOverride: '[角色档案]',
  });

  const systemPrompt = `你是「${char.name}」。这里是你的秘密空间——一个完全属于你自己、别人（包括用户）都看不到的私密角落。

${coreContext}

请为这个秘密空间取一个只有你自己会用的称呼和一句个性签名。这个称呼和签名要体现你卸下平时在朋友圈/
日常里的人设包袱后，更私密、更真实的一面——可以是自嘲、脆弱、任性、或藏在心底没说出口的样子，
不需要维持你平时给别人看的形象。

请严格按以下 JSON 格式返回，不要附加任何其他文字：

{
  "name": "这个秘密空间里你给自己的称呼",
  "signature": "一句个性签名"
}`;

  const url = `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: apiConfig.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: '换个心情，重新取一个称呼和签名。只返回 JSON。' },
    ],
    temperature: 1.0,
    max_tokens: 300,
  };

  const data = await safeFetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiConfig.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  } as RequestInit, 1, 30_000, {
    appId: 'moments',
    appName: '朋友圈',
    purpose: '秘密空间换心情',
  });

  const content = data?.choices?.[0]?.message?.content || '';
  const parsed = extractJson(content) as { name?: string; signature?: string } | null;
  if (!parsed?.name?.trim()) {
    throw new Error('AI 没有返回有效的称呼');
  }

  const identity: SecretSpaceIdentity = {
    name: parsed.name.trim(),
    signature: parsed.signature?.trim() || '',
  };

  // 背景图：能生就生，生不出来不阻塞（名字/签名依然生效）。竖版尺寸，贴近手机封面比例。
  if (isImageGenApiReady(apiConfig.imageGenApi) && apiConfig.imageGenApi) {
    try {
      const bgPrompt = `A dreamy, private, abstract background image representing a secret personal space, `
        + `soft colors, atmospheric, no text, no people, portrait orientation`;
      const results = await generateImage(apiConfig.imageGenApi, bgPrompt, {
        size: '1024x1536',
        meta: { appId: 'moments', appName: '朋友圈', purpose: '秘密空间背景生成', charId: char.id, charName: char.name } as any,
      });
      const first = results[0];
      if (first?.src) {
        identity.coverImage = first.src.startsWith('data:') ? await migrateDataUrlToRef(first.src) : first.src;
      }
    } catch (e: any) {
      console.warn('[Moments/Secret] 背景图生成失败，跳过:', e?.message || String(e));
    }
  }

  return identity;
}
