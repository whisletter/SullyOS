/**
 * 论坛 · 调度逻辑
 *
 * 两件事，触发方式完全不同，分两节写：
 *   一、自然触发批量生成 [交接5 三]：复用 HotNewsApp 的 slot 概念做水位判断，本身
 *      不含"确定性随机"，纯粹是"当前 slot 有没有对应批次"的水位比较。
 *   二、共管账号专属动态 [用户确认，覆盖交接5 4.9原定的4档]：复用 momentsWindow.ts 导出的
 *      pickFireMinute（同一套哈希确定性随机算法），窗口直接对齐 HotNewsApp 现成的6个
 *      4小时时段（不单独设计"凌晨/早/午/晚"4档），一天6次而不是4次，不需要额外调LLM
 *      决定窗口本身。
 */

import * as db from './forumDb';
import { pickFireMinute } from './momentsWindow';
import type { MomentsWindow } from '../types';

// ==================== 一、自然触发批量生成 [交接5 三] ====================

/**
 * 判断"当前 slot 有没有对应批次"。currentSlotId 由调用方传入
 * （直接用 RealtimeContextManager.getHotNewsSlot().id，跟 HotNewsApp 同一个函数），
 * 这里只做纯水位比较，不关心 slot 本身怎么算出来的，避免论坛自己重复写时间对齐逻辑
 * [交接1 四.5]。
 */
export async function needsNaturalBatch(currentSlotId: string, defaultIdentityAccountId: string): Promise<boolean> {
  const settings = await db.getForumSettings(defaultIdentityAccountId);
  return settings.lastNaturalBatchSlotId !== currentSlotId;
}

/** 生成完成后调用，把水位推进到这个 slot，防止同一 slot 内重复触发。 */
export async function markNaturalBatchDone(currentSlotId: string, defaultIdentityAccountId: string): Promise<void> {
  const settings = await db.getForumSettings(defaultIdentityAccountId);
  await db.saveForumSettings({ ...settings, lastNaturalBatchSlotId: currentSlotId });
}

// ==================== 二、共管账号专属动态：直接按热点新闻App的6档走 [用户确认，覆盖交接5 4.9原定的4档] ====================

export interface SharedAccountBand {
  label: string;
  window: MomentsWindow;
}

/**
 * 不单独设计"凌晨/早/午/晚"4档，直接对齐 HotNewsApp.tsx 现成的 SLOT_WINDOW
 * 六个4小时时段，一天6次而不是4次。末档用 23:59 而不是 24:00，是因为
 * momentsWindow.ts 的时间格式校验只接受 00-23 小时。
 */
export const SHARED_ACCOUNT_BANDS: SharedAccountBand[] = [
  { label: '00:00–04:00', window: { start: '00:00', end: '04:00' } },
  { label: '04:00–08:00', window: { start: '04:00', end: '08:00' } },
  { label: '08:00–12:00', window: { start: '08:00', end: '12:00' } },
  { label: '12:00–16:00', window: { start: '12:00', end: '16:00' } },
  { label: '16:00–20:00', window: { start: '16:00', end: '20:00' } },
  { label: '20:00–23:59', window: { start: '20:00', end: '23:59' } },
];

const FIRED_STORAGE_KEY = 'forum_shared_account_band_fired';

/** 跟 momentsScheduler.ts 的 moments_window_fired 同一个取舍：纯调度用派生数据，
 *  只用 localStorage，不进 IndexedDB、不随备份迁移，丢了最多"今天这一档不发了"。 */
function loadFiredSet(): Set<string> {
  try {
    const raw = localStorage.getItem(FIRED_STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveFiredSet(set: Set<string>): void {
  // 只保留最近两天的 key，避免 localStorage 无限增长（key 格式里带日期，直接按前缀过滤）
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const trimmed = Array.from(set).filter(k => k.includes(today) || k.includes(yesterday));
  localStorage.setItem(FIRED_STORAGE_KEY, JSON.stringify(trimmed));
}

function fireKey(sharedAccountId: string, dateKey: string, bandIndex: number): string {
  return `${sharedAccountId}|${dateKey}|${bandIndex}`;
}

/**
 * 检查共管账号今天的6个时段里，有没有"已经到点但还没触发过"的。
 * dateKey 用本地日期（YYYY-MM-DD），nowMinutesOfDay 是从当天0点起算的分钟数，
 * 调用方按本地时间自己算好传进来，这里不碰 Date 本地时区细节。
 *
 * 一次最多返回一个待触发档位——即使程序长时间没打开、一次性错过好几档，也只补
 * 触发一次（跟朋友圈"暂停营业"恢复后不秋后算账的思路一致，不需要把错过的档位
 * 全部追发一遍）。
 */
export function findDueSharedAccountBand(
  sharedAccountId: string,
  dateKey: string,
  nowMinutesOfDay: number,
): { bandIndex: number; band: SharedAccountBand } | null {
  const fired = loadFiredSet();
  for (let i = 0; i < SHARED_ACCOUNT_BANDS.length; i++) {
    const band = SHARED_ACCOUNT_BANDS[i];
    const key = fireKey(sharedAccountId, dateKey, i);
    if (fired.has(key)) continue;
    const fireMinute = pickFireMinute(sharedAccountId, dateKey, i, band.window);
    if (nowMinutesOfDay >= fireMinute) {
      return { bandIndex: i, band };
    }
  }
  return null;
}

/** 生成完成后调用，标记这一档今天已经触发过，不再重复生成。 */
export function markSharedAccountBandFired(sharedAccountId: string, dateKey: string, bandIndex: number): void {
  const fired = loadFiredSet();
  fired.add(fireKey(sharedAccountId, dateKey, bandIndex));
  saveFiredSet(fired);
}
