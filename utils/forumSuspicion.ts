/**
 * 论坛 · 小号怀疑与掉马
 *
 * 玩法对称：你可能认出 TA 的小号，TA 也可能认出你的。两边走同一套状态机，
 * 区别只在"谁来做决定"——TA 的号由模型按人设自己选，你的号由你在界面上选。
 *
 * 状态机：
 *   （无） → suspected 起疑 → confronted 当面对质 → admitted 承认 / denied 否认
 *   admitted 之后还要选 outcome：kept 继续用 / burned 注销
 *
 * 一条重要的设计性质：**否认不提供任何信息**。小号被指认时可以否认，路人被指认时
 * 也会否认，两者的回应从外部看没有区别。所以挨个指认所有账号是无效策略，
 * 不需要额外加次数限制来防刷——只有"承认"才是信号，而认不认由当事人自己决定。
 */

import * as db from './forumDb';
import type { ForumAccount, ForumSuspicion } from './forumDb';
import { FORUM_DEFAULTS } from './forumConstants';

/** 观察者标识：用户统一用 'user'，角色用自己的 charId。 */
export const USER_OBSERVER_KEY = 'user';

/**
 * 小号被注销后，隔多久才允许开新的。
 *
 * 不加冷却的话，刚抓到 TA 的小号、它转头就开一个新的，显得很假，也让"抓到"这件事
 * 失去分量。3 天是个能让掉马有余韵、又不至于让玩法停摆太久的值。
 */
export const ALT_REOPEN_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

// ==================== 读 ====================

export async function getSuspicion(observerKey: string, targetAccountId: string): Promise<ForumSuspicion | null> {
  return db.getForumSuspicion(observerKey, targetAccountId);
}

export async function listSuspicions(observerKey: string): Promise<ForumSuspicion[]> {
  return db.getForumSuspicionsByObserver(observerKey);
}

/**
 * 这个小号是不是"已经掉马、且当事人选择继续用"。
 *
 * 帖子保留判定要用它：按原设计，角色小号的互动只有在掉马并继续沿用之后才算
 * "角色本人互动过"、才触发帖子永久保留。之前这里是写死的占位，现在接真实状态。
 */
export async function isAltContinuedInUse(altAccountId: string): Promise<boolean> {
  const rows = await db.getForumSuspicionsByTarget(altAccountId);
  return rows.some(r => r.stage === 'admitted' && r.outcome === 'kept');
}

/** 批量版本，给帖子刷新那种要一次判断多个号的场景用，避免逐个查库。 */
export async function buildAltContinuedLookup(altAccountIds: string[]): Promise<Set<string>> {
  const result = new Set<string>();
  for (const id of altAccountIds) {
    if (await isAltContinuedInUse(id)) result.add(id);
  }
  return result;
}

// ==================== 写 ====================

async function upsert(
  observerKey: string,
  targetAccountId: string,
  patch: Partial<ForumSuspicion>,
): Promise<ForumSuspicion> {
  const existing = await db.getForumSuspicion(observerKey, targetAccountId);
  const now = Date.now();
  const row: ForumSuspicion = {
    id: db.makeForumSuspicionId(observerKey, targetAccountId),
    observerKey,
    targetAccountId,
    stage: patch.stage || existing?.stage || 'suspected',
    reason: patch.reason ?? existing?.reason,
    outcome: patch.outcome ?? existing?.outcome,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await db.saveForumSuspicion(row);
  return row;
}

/** 起疑（还没挑明）。同一个号反复起疑只会更新理由，不会重复建记录。 */
export async function markSuspected(observerKey: string, targetAccountId: string, reason?: string) {
  const existing = await db.getForumSuspicion(observerKey, targetAccountId);
  // 已经对质过/已定论的，不要被一条新的"起疑"打回初始状态
  if (existing && existing.stage !== 'suspected') {
    return reason ? upsert(observerKey, targetAccountId, { reason }) : existing;
  }
  return upsert(observerKey, targetAccountId, { stage: 'suspected', reason });
}

export async function markConfronted(observerKey: string, targetAccountId: string, reason?: string) {
  return upsert(observerKey, targetAccountId, { stage: 'confronted', reason });
}

export async function markDenied(observerKey: string, targetAccountId: string) {
  return upsert(observerKey, targetAccountId, { stage: 'denied' });
}

/**
 * 承认掉马，并落实选择。
 *
 * burned 时：账号停用、销号计数 +1、到上限就锁死不能再开。旧帖不删，显示"已注销用户"——
 * 删了的话历史内容会变成无主的，那条时间线就断了。
 */
export async function markAdmitted(
  observerKey: string,
  targetAccount: ForumAccount,
  outcome: db.ForumSuspicionOutcome,
): Promise<ForumSuspicion> {
  const row = await upsert(observerKey, targetAccount.id, { stage: 'admitted', outcome });

  if (outcome === 'burned') {
    await db.saveForumAccount({ ...targetAccount, status: 'deactivated', updatedAt: Date.now() });
    // 配额是按"人"分开记的：用户一份，每个角色各一份，各自 5 次
    const isUserSide = targetAccount.ownerType === 'user';
    const budget = isUserSide
      ? await db.getAltBudget('user')
      : await db.getAltBudget('char', targetAccount.charId);
    const nextCount = budget.burnCount + 1;
    await db.saveAltBudget({
      ...budget,
      burnCount: nextCount,
      locked: nextCount >= FORUM_DEFAULTS.altBurnCap,
    });
  }
  return row;
}

/**
 * 找出"某个角色已经当面质问过这个账号、但还没有定论"的那条记录。
 * 私信界面靠它决定要不要弹出"承认/否认"的选择条。
 */
export async function getPendingConfrontationFor(targetAccountId: string): Promise<ForumSuspicion | null> {
  const rows = await db.getForumSuspicionsByTarget(targetAccountId);
  return rows.find(r => r.observerKey !== USER_OBSERVER_KEY && r.stage === 'confronted') || null;
}

/** 某个角色当前起了疑、但还没挑明的目标。 */
export async function listUnconfronted(observerKey: string): Promise<ForumSuspicion[]> {
  const rows = await db.getForumSuspicionsByObserver(observerKey);
  return rows.filter(r => r.stage === 'suspected');
}

// ==================== 小号能不能（再）开 ====================

export interface AltOpenability {
  allowed: boolean;
  /** 不允许时的原因，给界面显示用。 */
  reason?: string;
  /** 处于冷却中时，还要等多久（毫秒）。 */
  cooldownRemainingMs?: number;
}

/**
 * 判断某个"人"（用户或某个角色）现在能不能开小号。
 *
 * 两道闸：销号次数上限（用户一份、每个角色各一份，各自 5 次），
 * 以及上一个号注销之后的冷却期。
 */
export async function canOpenAlt(
  subject: { type: 'user' | 'char'; charId?: string },
  existingAccounts: ForumAccount[],
): Promise<AltOpenability> {
  const budget = await db.getAltBudget(subject.type, subject.charId);
  if (budget.locked || budget.burnCount >= FORUM_DEFAULTS.altBurnCap) {
    return { allowed: false, reason: `销号次数已用尽（${FORUM_DEFAULTS.altBurnCap} 次），不能再开新小号` };
  }

  // 找最近一个被注销的小号，看冷却过了没有
  const burned = existingAccounts
    .filter(a => a.isAlt && a.status === 'deactivated')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];

  if (burned) {
    const elapsed = Date.now() - burned.updatedAt;
    if (elapsed < ALT_REOPEN_COOLDOWN_MS) {
      return {
        allowed: false,
        reason: '上一个小号刚注销不久，还开不了新的',
        cooldownRemainingMs: ALT_REOPEN_COOLDOWN_MS - elapsed,
      };
    }
  }
  return { allowed: true };
}
