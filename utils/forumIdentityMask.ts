/**
 * 论坛 · 身份遮罩
 *
 * 这个文件只有一个职责：**决定 TA 能知道关于某个论坛账号的什么**。
 *
 * 为什么需要它：账号数据里带着 ownerType（user/char/shared/npc）和 isAlt。这些字段
 * 只要顺手拼进给 TA 的提示词，TA 一眼就能看出"这个号是用户的小号"，互相猜小号这套
 * 玩法当场作废。所以凡是喂给 TA 的账号信息，一律只能从这里出，不允许别处直接拼账号对象。
 *
 * 认知规则（[用户确认]）：
 *   - 用户大号 —— 只有在跟 TA 互相加了好友之后，TA 才认得出"这就是我认识的那个人"；
 *     没加好友之前，它只是个名字而已；
 *   - 用户小号 —— 任何情况下都不揭示，哪怕用小号加了好友。TA 想知道只能靠聊天内容自己猜，
 *     也完全可能猜不到（用户伪装得好就该猜不到）；
 *   - 路人号 —— 就是路人，不标注"这是系统生成的NPC"；
 *   - TA 自己的号 —— 它当然知道，包括自己的小号。
 *
 * 这里刻意不提供"怀疑度"之类的字段：要不要怀疑、怀疑谁，交给 TA 依据聊天内容和自己的
 * 人设判断，提示词里不写任何引导。
 */

import * as db from './forumDb';
import type { ForumAccount } from './forumDb';
import { getRelationState } from './forumSocial';

// ==================== 一、描述单个账号 ====================

export interface MaskedAccount {
  handle: string;
  displayName: string;
  bio?: string;
  isVerified?: boolean;
  /** TA 是否认得出这个号背后就是现实里跟它说话的那个用户。 */
  knownAsUser: boolean;
}

/**
 * 把一个账号加工成"TA 可以知道的样子"。
 *
 * @param charAccountIds TA 自己名下所有论坛账号的 id（主号+小号），用来判断好友关系
 * @param userDisplayName 用户在聊天里的名字，只有 knownAsUser 时才会被用上
 */
export async function maskAccountForChar(
  target: ForumAccount,
  charAccountIds: string[],
): Promise<MaskedAccount> {
  const masked: MaskedAccount = {
    handle: target.handle,
    displayName: target.displayName,
    bio: target.bio,
    isVerified: target.isVerified,
    knownAsUser: false,
  };

  // 小号永不揭示，先短路，避免下面的好友查询把它也算进去
  if (target.ownerType !== 'user' || target.isAlt) return masked;

  for (const charAccountId of charAccountIds) {
    const state = await getRelationState(charAccountId, target.id);
    if (state === 'friends') { masked.knownAsUser = true; break; }
  }
  return masked;
}

/** 渲染成提示词里的一行。userDisplayName 只在确认认识时才写进去。 */
export function describeMaskedAccount(masked: MaskedAccount, userDisplayName?: string): string {
  const parts = [`@${masked.handle}（${masked.displayName}）`];
  if (masked.isVerified) parts.push('蓝V认证');
  if (masked.bio) parts.push(`签名：${masked.bio}`);
  if (masked.knownAsUser && userDisplayName) {
    parts.push(`这个号就是${userDisplayName}本人——你们已经在论坛上互加好友了`);
  }
  return parts.join('，');
}

// ==================== 二、TA 自己的账号 ====================

export interface CharForumIdentity {
  main?: ForumAccount;
  alt?: ForumAccount;
  shared?: ForumAccount;
}

export async function getCharForumIdentity(charId: string): Promise<CharForumIdentity> {
  const accounts = await db.getAllForumAccounts();
  const mine = accounts.filter(a => a.charId === charId && a.status === 'active');
  return {
    main: mine.find(a => a.ownerType === 'char' && !a.isAlt),
    alt: mine.find(a => a.ownerType === 'char' && a.isAlt),
    shared: mine.find(a => a.ownerType === 'shared'),
  };
}

export function getCharAccountIds(identity: CharForumIdentity): string[] {
  return [identity.main?.id, identity.alt?.id, identity.shared?.id].filter((x): x is string => !!x);
}

// ==================== 三、注入聊天上下文的那一段 ====================

/**
 * 给主线聊天用的论坛状态块。塞进 volatileState（跟群聊背景同一条路），
 * 这样用户在聊天里问"你论坛账号是什么"，TA 答得上来，也能把论坛上发生的事和
 * 聊天对上号。
 *
 * 小号一并写进去 [用户确认选 B]：逻辑上那本来就是 TA 自己开的号，它没理由不知道。
 * 这里不写"你要保密"之类的指令——嘴严不嘴严，交给它自己的人设。
 */
export async function buildForumContextForChar(charId: string, userDisplayName: string): Promise<string> {
  const identity = await getCharForumIdentity(charId);
  if (!identity.main && !identity.alt && !identity.shared) return '';

  const lines: string[] = ['', '【论坛「杂波频段」·你的账号】'];

  if (identity.main) {
    lines.push(`- 你的主号：@${identity.main.handle}（${identity.main.displayName}）`);
  }
  if (identity.alt) {
    lines.push(`- 你的小号：@${identity.alt.handle}（${identity.alt.displayName}）——这个号是你自己开的，论坛上没人知道它是你`);
    if (identity.alt.altPersonaNote) {
      lines.push(`  小号的人设方向（你自己定的）：${identity.alt.altPersonaNote}`);
    }
  }
  if (identity.shared) {
    lines.push(`- 共管账号：@${identity.shared.handle}（${identity.shared.displayName}）——你和${userDisplayName}共同使用的号`);
  }

  // TA 认得出来的人：只有已经互加好友的用户大号
  const charAccountIds = getCharAccountIds(identity);
  const accounts = await db.getAllForumAccounts();
  const knownUserAccounts: string[] = [];
  for (const acc of accounts) {
    if (acc.ownerType !== 'user' || acc.isAlt || acc.status !== 'active') continue;
    const masked = await maskAccountForChar(acc, charAccountIds);
    if (masked.knownAsUser) knownUserAccounts.push(`@${acc.handle}（${acc.displayName}）`);
  }

  if (knownUserAccounts.length > 0) {
    lines.push(`- 你在论坛上已经认出${userDisplayName}的账号：${knownUserAccounts.join('、')}`);
  } else {
    lines.push(`- 你还没在论坛上跟${userDisplayName}互加好友，所以论坛上哪个号是${userDisplayName}，你并不知道`);
  }

  lines.push('（论坛上其他账号对你来说就是普通网友，谁是谁得靠你自己从言行里判断。）');
  return `${lines.join('\n')}\n`;
}
