/**
 * 论坛 · TA 那一侧的统一上下文出口
 *
 * 论坛里的 TA 必须和聊天里的 TA 是同一个人。所以人设不在这里重抄一份，而是直接复用
 * 聊天用的那个函数（ContextBuilder.buildCoreContext）——核心设定、世界观、世界书
 * （含关键词触发规则）、用户档案、TA 对用户的印象、记忆宫殿召回，全部跟聊天一致，
 * 完整读取、不截断。查手机/通话/见面走的也是同一个函数，这样四个 App 里的 TA 不会各是各的。
 *
 * 在此之上再补两样论坛专属的东西：
 *   - 最近 N 条主线聊天原文：TA 认出"这个号说话像那个人"的唯一依据，没有它起疑无从谈起；
 *   - 它自己在论坛上的身份状态（主号/小号/共管号 + 已有的疑心），走 forumIdentityMask。
 *
 * 纪律：凡是"由 TA 出面"的调用（私信回复、帖子评论、挑明、被对质、好友申请、共管号发帖）
 * 一律从这里取上下文，不允许在 forumAi.ts 里现拼人设。路人 NPC 那一侧一个字都不走这里。
 */

import type { CharacterProfile, Message, UserProfile } from '../types';
import { DB } from './db';
import { ContextBuilder } from './context';
import { loadCharacterContextMessages } from './chatContextRange';
import { buildForumContextForChar } from './forumIdentityMask';

/** 带进论坛的主线聊天条数。只影响"认出说话习惯"，不影响人设完整性。 */
export const FORUM_RECENT_CHAT_COUNT = 20;

/**
 * 用户档案。buildCoreContext 只会用到 name 和 bio 两项（见 context.ts 的「互动对象」块）。
 *
 * 这里对 DB 的取法做了软处理：如果 utils/db.ts 里有 getUserProfile 就用真档案，
 * 没有就退回"只有名字"的最小档案，绝不因此让整条链路报错。
 * （把 db.ts 里真正的函数名告诉我，可以把这段换成直连。）
 */
export async function loadForumUserProfile(fallbackName?: string): Promise<UserProfile> {
  const fallback = { name: fallbackName || '用户', avatar: '', bio: '' } as UserProfile;
  try {
    const anyDb = DB as any;
    const loaded = typeof anyDb.getUserProfile === 'function' ? await anyDb.getUserProfile() : null;
    if (loaded && typeof loaded.name === 'string' && loaded.name) {
      return { ...loaded, name: loaded.name || fallback.name } as UserProfile;
    }
  } catch {
    /* 取不到就用最小档案，不影响出场 */
  }
  return fallback;
}

export interface ForumCharContext {
  char: CharacterProfile;
  user: UserProfile;
  /** 最近若干条主线聊天，按时间正序。 */
  recentMessages: Message[];
  /** 拼好的整块提示词，直接塞进各个论坛 prompt 的最前面。 */
  text: string;
}

export interface BuildForumCharContextOptions {
  /** 用户在聊天里的名字。拿不到真档案时用它兜底。 */
  userDisplayName?: string;
  /** 已经有 UserProfile 的调用方可以直接传进来，省一次读库。 */
  user?: UserProfile | null;
  /** 带几条聊天，默认 FORUM_RECENT_CHAT_COUNT。传 0 表示不带。 */
  recentChatCount?: number;
  /** 是否附上它在论坛上的身份状态（主号/小号/共管号/疑心）。默认 true。 */
  includeForumIdentity?: boolean;
}

/** 把一条主线消息渲染成一行。语气/用词是重点，所以不做截断。 */
function renderChatLine(m: Message, charName: string, userName: string): string {
  const who = m.role === 'user' ? userName : m.role === 'assistant' ? charName : '系统';
  const body = (m.content || '').replace(/\s*\n\s*/g, ' ').trim();
  if (!body) return '';
  return `${who}：${body}`;
}

/**
 * 取一个角色在论坛上的完整上下文。角色不存在时返回 null（调用方退回"通用网友"那套）。
 */
export async function getForumCharContext(
  charId: string,
  options: BuildForumCharContextOptions = {},
): Promise<ForumCharContext | null> {
  const char = await DB.getCharacter(charId);
  if (!char) return null;

  const user = options.user || await loadForumUserProfile(options.userDisplayName);

  // 聊天原文：范围规则跟聊天完全一致（自适应水位线 / 手动条数 / 用户断点都由这个函数管），
  // 论坛只在它给出的范围里取最后 N 条，不自己另算一套边界。
  const count = options.recentChatCount ?? FORUM_RECENT_CHAT_COUNT;
  let recentMessages: Message[] = [];
  if (count > 0) {
    try {
      const all = await loadCharacterContextMessages(char);
      recentMessages = all.slice(-count);
    } catch (e: any) {
      console.warn('[ForumCharContext] 读取主线聊天失败:', e?.message || String(e));
    }
  }

  // 世界书的关键词触发要拿最近的对话去扫，跟聊天同一套规则；没有聊天就只剩常驻条目。
  const lastInteractionTs = recentMessages.length > 0
    ? recentMessages[recentMessages.length - 1].timestamp
    : undefined;

  const core = ContextBuilder.buildCoreContext(
    char,
    user,
    true,
    undefined,
    undefined,
    {
      worldbookMessages: recentMessages as any,
      conversational: true,
      lastInteractionTs,
    },
  );

  const blocks: string[] = [core.trim()];

  if (recentMessages.length > 0) {
    const lines = recentMessages.map(m => renderChatLine(m, char.name, user.name)).filter(Boolean);
    if (lines.length > 0) {
      blocks.push(
        [
          `### 你和${user.name}最近的聊天（最新 ${lines.length} 条，从旧到新）`,
          `（这是你们在聊天软件里的原话。论坛上有人说话像不像${user.name}，你只能靠这个判断。`,
          `不要在论坛上复述这里的内容——论坛上的人不知道你们私下聊过什么。）`,
          '',
          ...lines,
        ].join('\n'),
      );
    }
  }

  if (options.includeForumIdentity !== false) {
    try {
      const forumIdentity = await buildForumContextForChar(charId, user.name);
      if (forumIdentity.trim()) blocks.push(forumIdentity.trim());
    } catch (e: any) {
      console.warn('[ForumCharContext] 读取论坛身份状态失败:', e?.message || String(e));
    }
  }

  blocks.push(
    [
      '### 你现在在论坛「杂波频段」上',
      `接下来要做的事发生在论坛里。你就是上面这个人——性格、说话习惯、对${user.name}的看法、你们之间发生过的事，`,
      '换个地方不会变。不要因为"这是论坛"就退回成一个通用网友。',
      '同时记住论坛是公开场合：别人不知道你和谁认识、私下聊过什么，你也不必主动交代。',
    ].join('\n'),
  );

  return { char, user, recentMessages, text: blocks.join('\n\n') };
}

/**
 * 只要那段文本的简写版。取不到角色时返回空串，调用方自己决定怎么降级。
 */
export async function buildForumCharContextBlock(
  charId: string,
  options: BuildForumCharContextOptions = {},
): Promise<string> {
  const ctx = await getForumCharContext(charId, options);
  return ctx?.text || '';
}
