/**
 * 论坛 · 社交关系（好友 / 拉黑）与"常客"机制
 *
 * 两块内容放一个文件，因为它们解决的是同一件事：让论坛里的人产生"熟"的感觉。
 *
 * 关系模型：一行代表一个方向（from 对 to 的态度）。
 *   - 加好友：A→B 存 pending；B 同意后两边各存一行 accepted
 *   - 拉黑：单向 blocked，但**私信只要任一方向存在 blocked 就断**——被拉黑的人
 *     不该能继续发消息，拉黑的人自己也不该还能发过去
 *   - 好友不是私信的前提（[用户确认]，跟微信/X 一样，陌生人也能发），
 *     好友只是个关系标记，为后面的玩法留口子
 */

import * as db from './forumDb';
import type { ForumAccount, ForumRelation } from './forumDb';

// ==================== 关系读写 ====================

function makeRelation(fromAccountId: string, toAccountId: string, status: db.ForumRelationStatus, createdAt?: number): ForumRelation {
  const now = Date.now();
  return {
    id: db.makeForumRelationId(fromAccountId, toAccountId),
    fromAccountId, toAccountId, status,
    createdAt: createdAt ?? now,
    updatedAt: now,
  };
}

/** 我和某人的关系状态，UI 按这个决定按钮显示什么。 */
export type RelationState =
  | 'self'        // 就是我自己
  | 'none'        // 没有任何关系
  | 'outgoing'    // 我发出的申请，等对方处理
  | 'incoming'    // 对方发来的申请，等我处理
  | 'friends'     // 互为好友
  | 'blocked'     // 我拉黑了对方
  | 'blockedBy';  // 对方拉黑了我

export async function getRelationState(myAccountId: string, otherAccountId: string): Promise<RelationState> {
  if (myAccountId === otherAccountId) return 'self';
  const [mine, theirs] = await Promise.all([
    db.getForumRelation(myAccountId, otherAccountId),
    db.getForumRelation(otherAccountId, myAccountId),
  ]);
  if (mine?.status === 'blocked') return 'blocked';
  if (theirs?.status === 'blocked') return 'blockedBy';
  if (mine?.status === 'accepted' && theirs?.status === 'accepted') return 'friends';
  if (mine?.status === 'pending') return 'outgoing';
  if (theirs?.status === 'pending') return 'incoming';
  return 'none';
}

/**
 * 发好友申请。
 *
 * 路人号直接通过——路人本来就是"随手加一下"的关系，没必要让用户等一个永远不会
 * 有人点的按钮。角色/共管账号保持 pending，等 TA 自己判断通不通过（下一批接）。
 */
export async function sendFriendRequest(fromAccountId: string, toAccountId: string): Promise<RelationState> {
  if (fromAccountId === toAccountId) return 'self';
  const state = await getRelationState(fromAccountId, toAccountId);
  if (state === 'blocked' || state === 'blockedBy' || state === 'friends') return state;

  // 对方已经先申请过我了 → 直接互相通过，不要求再走一遍流程
  if (state === 'incoming') return acceptFriendRequest(toAccountId, fromAccountId);

  const target = await db.getForumAccount(toAccountId);
  if (target?.ownerType === 'npc') {
    await db.saveForumRelation(makeRelation(fromAccountId, toAccountId, 'accepted'));
    await db.saveForumRelation(makeRelation(toAccountId, fromAccountId, 'accepted'));
    return 'friends';
  }

  await db.saveForumRelation(makeRelation(fromAccountId, toAccountId, 'pending'));
  return 'outgoing';
}

/** requesterId 发来的申请被 accepterId 通过。 */
export async function acceptFriendRequest(requesterId: string, accepterId: string): Promise<RelationState> {
  const pending = await db.getForumRelation(requesterId, accepterId);
  await db.saveForumRelation(makeRelation(requesterId, accepterId, 'accepted', pending?.createdAt));
  await db.saveForumRelation(makeRelation(accepterId, requesterId, 'accepted'));
  return 'friends';
}

/** 拒绝：直接把这条申请删掉，对方可以再申请。 */
export async function declineFriendRequest(requesterId: string, accepterId: string): Promise<void> {
  await db.deleteForumRelation(requesterId, accepterId);
}

/** 删好友：两个方向都清掉。 */
export async function removeFriend(aAccountId: string, bAccountId: string): Promise<void> {
  await db.deleteForumRelation(aAccountId, bAccountId);
  await db.deleteForumRelation(bAccountId, aAccountId);
}

/** 拉黑：清掉双方的好友关系，然后单向记一条 blocked。 */
export async function blockAccount(fromAccountId: string, toAccountId: string): Promise<void> {
  if (fromAccountId === toAccountId) return;
  await db.deleteForumRelation(toAccountId, fromAccountId);
  await db.saveForumRelation(makeRelation(fromAccountId, toAccountId, 'blocked'));
}

export async function unblockAccount(fromAccountId: string, toAccountId: string): Promise<void> {
  const row = await db.getForumRelation(fromAccountId, toAccountId);
  if (row?.status === 'blocked') await db.deleteForumRelation(fromAccountId, toAccountId);
}

/** 私信是否被拦。任一方向存在 blocked 就断，双向生效。 */
export async function isDmBlocked(aAccountId: string, bAccountId: string): Promise<boolean> {
  const [x, y] = await Promise.all([
    db.getForumRelation(aAccountId, bAccountId),
    db.getForumRelation(bAccountId, aAccountId),
  ]);
  return x?.status === 'blocked' || y?.status === 'blocked';
}

/** 跟我有 blocked 关系的所有账号 id（任一方向），列表页一次性拿来过滤用。 */
export async function getBlockedCounterparts(myAccountId: string): Promise<Set<string>> {
  const [from, to] = await Promise.all([
    db.getForumRelationsFrom(myAccountId, 'blocked'),
    db.getForumRelationsTo(myAccountId, 'blocked'),
  ]);
  return new Set([...from.map(r => r.toAccountId), ...to.map(r => r.fromAccountId)]);
}

export async function getFriendAccounts(myAccountId: string): Promise<ForumAccount[]> {
  const rows = await db.getForumRelationsFrom(myAccountId, 'accepted');
  const accounts = await Promise.all(rows.map(r => db.getForumAccount(r.toAccountId)));
  return accounts.filter((a): a is ForumAccount => !!a);
}

export async function getIncomingRequests(myAccountId: string): Promise<ForumAccount[]> {
  const rows = await db.getForumRelationsTo(myAccountId, 'pending');
  const accounts = await Promise.all(rows.map(r => db.getForumAccount(r.fromAccountId)));
  return accounts.filter((a): a is ForumAccount => !!a);
}

export async function getBlockedAccounts(myAccountId: string): Promise<ForumAccount[]> {
  const rows = await db.getForumRelationsFrom(myAccountId, 'blocked');
  const accounts = await Promise.all(rows.map(r => db.getForumAccount(r.toAccountId)));
  return accounts.filter((a): a is ForumAccount => !!a);
}

// ==================== 常客机制 ====================

/** 常客人数。太少了显得这论坛只有几个活人，太多就谈不上"眼熟"了。 */
export const FORUM_REGULARS_COUNT = 10;

/** 帖子刷新时，候选路人里有多大比例来自常客名单。 */
const REGULARS_RATIO = 0.6;

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * 确保常客名单存在。只在第一次调用时抽签，之后固定不变——常客每次都换人就不叫常客了。
 * 名单里的号如果被删了，会自动补足。
 */
export async function ensureRegulars(defaultIdentityAccountId: string): Promise<string[]> {
  const settings = await db.getForumSettings(defaultIdentityAccountId);
  const npcs = await db.getActiveNpcAccounts();
  if (npcs.length === 0) return [];

  const npcIds = new Set(npcs.map(a => a.id));
  const kept = (settings.regularsAccountIds || []).filter(id => npcIds.has(id));
  if (kept.length >= FORUM_REGULARS_COUNT) return kept;

  const pool = shuffle(npcs.filter(a => !kept.includes(a.id)));
  const filled = [...kept, ...pool.slice(0, FORUM_REGULARS_COUNT - kept.length).map(a => a.id)];
  await db.saveForumSettings({ ...settings, regularsAccountIds: filled });
  return filled;
}

export async function getRegularIds(defaultIdentityAccountId: string): Promise<string[]> {
  const settings = await db.getForumSettings(defaultIdentityAccountId);
  return settings.regularsAccountIds || [];
}

/**
 * 给"帖子刷新"挑路人候选：约六成从常客名单里出，其余随机。
 *
 * 熟面孔反复出现，才可能让用户从"这人怎么老在"里嗅出点什么——这同时也是 TA 小号
 * 的掩护：一个眼熟的 ID，可能是常客，也可能是 TA，得靠说话内容分辨。
 */
export async function pickRosterWithRegulars(
  npcAccounts: ForumAccount[],
  size: number,
  defaultIdentityAccountId: string,
): Promise<ForumAccount[]> {
  if (npcAccounts.length <= size) return [...npcAccounts];

  const regularIds = new Set(await getRegularIds(defaultIdentityAccountId));
  const regulars = shuffle(npcAccounts.filter(a => regularIds.has(a.id)));
  const others = shuffle(npcAccounts.filter(a => !regularIds.has(a.id)));

  const regularCount = Math.min(regulars.length, Math.round(size * REGULARS_RATIO));
  const picked = [...regulars.slice(0, regularCount)];
  picked.push(...others.slice(0, size - picked.length));

  // 常客不够时用剩下的补齐
  if (picked.length < size) {
    const pickedIds = new Set(picked.map(a => a.id));
    picked.push(...npcAccounts.filter(a => !pickedIds.has(a.id)).slice(0, size - picked.length));
  }
  return shuffle(picked);
}
