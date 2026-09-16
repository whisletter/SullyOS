/**
 * 论坛 · 账号引导
 *
 * 报告没有覆盖"NPC账号池怎么生出来"，但用户主号/角色主号/共管账号这三种是结构性的、
 * 每个用户+角色必然存在的账号，这里负责"不存在就建一个"的幂等引导。
 *
 * 主号类账号用固定 id（不像小号那样随机生成），因为：
 *   - 主号永远只有一个、永不销号重开，固定 id 方便到处直接引用，不用每次查一遍；
 *   - 小号不能这样做——小号销号重开后必须换一个新 id，旧号的历史帖子/评论还挂着
 *     旧 id 展示"已注销用户"，如果新小号复用同一个 id，会让旧内容的作者身份被顶替。
 */

import * as db from './forumDb';
import type { ForumAccount } from './forumDb';

function userMainAccountId(): string {
  return 'facc_user_main';
}
function charMainAccountId(charId: string): string {
  return `facc_char_main_${charId}`;
}
function sharedAccountId(charId: string): string {
  return `facc_shared_${charId}`;
}

function fallbackHandle(seed: string): string {
  return `u${seed.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6) || Math.random().toString(36).slice(2, 8)}`;
}

export async function ensureUserMainAccount(displayName: string, avatar?: string): Promise<ForumAccount> {
  const id = userMainAccountId();
  const existing = await db.getForumAccount(id);
  if (existing) return existing;
  const now = Date.now();
  const account: ForumAccount = {
    id, ownerType: 'user', isAlt: false, handle: fallbackHandle(displayName || 'me'),
    displayName: displayName || '我', avatar, status: 'active', createdAt: now, updatedAt: now,
  };
  await db.saveForumAccount(account);
  return account;
}

export async function ensureCharMainAccount(charId: string, displayName: string, avatar?: string): Promise<ForumAccount> {
  const id = charMainAccountId(charId);
  const existing = await db.getForumAccount(id);
  if (existing) return existing;
  const now = Date.now();
  const account: ForumAccount = {
    id, ownerType: 'char', charId, isAlt: false, handle: fallbackHandle(displayName || charId),
    displayName: displayName || 'TA', avatar, status: 'active', createdAt: now, updatedAt: now,
  };
  await db.saveForumAccount(account);
  return account;
}

/** 共管账号是可选的（不是每对用户+角色都必然有），调用方自己决定要不要建。 */
export async function ensureSharedAccount(charId: string, displayName: string, avatar?: string): Promise<ForumAccount> {
  const id = sharedAccountId(charId);
  const existing = await db.getForumAccount(id);
  if (existing) return existing;
  const now = Date.now();
  const account: ForumAccount = {
    id, ownerType: 'shared', charId, isAlt: false, handle: fallbackHandle(`${displayName}team`),
    displayName: displayName || '我们', avatar, status: 'active', createdAt: now, updatedAt: now,
  };
  await db.saveForumAccount(account);
  return account;
}

export { userMainAccountId, charMainAccountId, sharedAccountId };

/**
 * 取"当前使用中的身份账号" [交接5 4.8/4.10]。默认记住上次退出时的身份；
 * 唯一兜底例外：那个身份后来失效了（比如是个已被注销的小号），自动切回主号。
 */
export async function resolveActiveIdentityAccount(userDisplayName: string, userAvatar?: string): Promise<ForumAccount> {
  const mainAccount = await ensureUserMainAccount(userDisplayName, userAvatar);
  const settings = await db.getForumSettings(mainAccount.id);
  const activeId = settings.activeIdentityAccountId || mainAccount.id;

  const activeAccount = await db.getForumAccount(activeId);
  const isUserSideAndActive = !!activeAccount
    && (activeAccount.ownerType === 'user' || activeAccount.ownerType === 'shared')
    && activeAccount.status === 'active';

  if (isUserSideAndActive) return activeAccount!;

  // 失效兜底：切回主号，并把这次兜底结果写回设置，避免每次打开都要重新判定一遍。
  if (settings.activeIdentityAccountId !== mainAccount.id) {
    await db.saveForumSettings({ ...settings, activeIdentityAccountId: mainAccount.id });
  }
  return mainAccount;
}

export async function setActiveIdentityAccount(accountId: string, fallbackDefaultId: string): Promise<void> {
  const settings = await db.getForumSettings(fallbackDefaultId);
  await db.saveForumSettings({ ...settings, activeIdentityAccountId: accountId });
}
