/**
 * 与昼 · 礼物
 *
 * 礼物和券是两回事，别混：
 *   礼物是**送给对方的**——亲手做，落进对方的藏柜，永久保留，不花苹果币；
 *   券是**自己用的**——拿游戏赚的币在商店换，是一份权利，用一次就没了。
 * 两者各占礼物界面的一栏，数据也完全分开（券在 coupons.ts）。
 *
 * 一件礼物 = 包装 + 内容。内容三选一或者叠加：
 *   一段话（永远可以有）、一张相册图、一张 AI 现做的图。
 * 只写一段话就能送，**不点生图按钮就不花任何额度**。
 *
 * 存储：DB.saveAsset（主库 assets 表），所以自动随备份走。
 * 用 assets 而不是 localStorage，是因为礼物里可能带 blobref 图片令牌，
 * 而且这是要长期留着的东西——跟心情月历、留言板一个待遇。
 */

import { DB } from '../../utils/db';

export type GiftWrap = 'box' | 'ribbon' | 'bottle';
export type GiftSide = 'user' | 'ta';

export const WRAPS: { id: GiftWrap; label: string; hint: string }[] = [
  { id: 'box', label: '小纸箱', hint: '牛皮纸，朴素' },
  { id: 'ribbon', label: '缎带礼盒', hint: '粉蓝缎带' },
  { id: 'bottle', label: '玻璃瓶', hint: '像漂流瓶' },
];

export interface Gift {
  id: string;
  /** 谁送的。落在对方的柜子里。 */
  from: GiftSide;
  wrap: GiftWrap;
  /** 附言。可以是礼物的全部内容。 */
  note: string;
  /**
   * 图片。blobref 令牌或 data URL，渲染走 TokenImg。
   * 相册选的和 AI 做的存在同一个字段——收到的人不需要知道是哪来的。
   */
  image?: string;
  /** AI 做的那张用的画面描述。留着给以后"再做一张类似的"用。 */
  imagePrompt?: string;
  createdAt: number;
  /** 拆开的时间。没拆就是 undefined。 */
  openedAt?: number;
}

export interface GiftShelf {
  version: 1;
  gifts: Gift[];
}

const shelfKey = (charId: string) => `yuzhou-gifts-${charId || 'default'}`;

export async function loadGifts(charId: string): Promise<Gift[]> {
  try {
    const raw = await DB.getAssetRaw(shelfKey(charId));
    const list = raw && Array.isArray(raw.gifts) ? raw.gifts : [];
    return list.filter((g: any) => g && g.id && g.from).sort((a: Gift, b: Gift) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

async function writeGifts(charId: string, gifts: Gift[]): Promise<void> {
  try {
    await DB.saveAssetRaw(shelfKey(charId), { version: 1, gifts } satisfies GiftShelf);
  } catch (e) {
    console.warn('[YuZhou] 礼物写入失败', e);
  }
}

export function giftUid(): string {
  return `gift_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 封装一件礼物。调用方保证 note 和 image 至少有一样。 */
export async function addGift(charId: string, gift: Omit<Gift, 'id' | 'createdAt'>): Promise<Gift[]> {
  const list = await loadGifts(charId);
  const next: Gift = { ...gift, id: giftUid(), createdAt: Date.now() };
  const all = [next, ...list];
  await writeGifts(charId, all);
  return all;
}

/**
 * 拆开。**一次性**——拆完那一格永久变成拆开的样子。
 * "第一次拆开"这件事只有一次才值钱，能反复拆就没感觉了。内容永久保留，随时重看。
 */
export async function openGift(charId: string, giftId: string): Promise<Gift[]> {
  const list = await loadGifts(charId);
  const g = list.find(x => x.id === giftId);
  if (g && !g.openedAt) {
    g.openedAt = Date.now();
    await writeGifts(charId, list);
  }
  return list;
}

export async function deleteGift(charId: string, giftId: string): Promise<Gift[]> {
  const list = (await loadGifts(charId)).filter(g => g.id !== giftId);
  await writeGifts(charId, list);
  return list;
}

/** 某一侧送出的礼物（藏柜按这个分两列）。 */
export const giftsFrom = (list: Gift[], from: GiftSide) => list.filter(g => g.from === from);

/** TA 送我的里面还没拆的，用来在入口上点红点。 */
export const unopenedFromTa = (list: Gift[]) => list.filter(g => g.from === 'ta' && !g.openedAt).length;

/**
 * 生图时统一加的风格后缀。
 *
 * 为什么要钉死风格：让模型自己写详细画面描述，结果会飘——今天写实明天赛博朋克，
 * 柜子里十件礼物十种画风。所以它（和你）只写"送什么"，风格由这里补齐，
 * 两列摆在一起才像一套。
 */
export const GIFT_IMAGE_STYLE =
  '温暖的礼物插画，柔和的粉白色调，水彩质感，浅色干净背景，居中构图，没有文字，没有人物';

export const buildGiftImagePrompt = (what: string) => `${what.trim()}，${GIFT_IMAGE_STYLE}`;
