/**
 * 与昼 · TA 送礼
 *
 * 礼物界面那个 🔄 的含义不是「送我一个」，而是**「去看看它有没有留下什么」**——
 * 按一下它自己判断此刻想不想送，可能有也可能没有。按一下就必给的话，
 * 惊喜就变成了自动贩卖机。
 *
 * 三道闸，从严到松：
 *   1. 冷却 12 小时。不然连按二十下就有二十个。
 *   2. 保底 7 天。超过七天没送过，下次必定有——不能让柜子长期空着，
 *      这个功能的全部意义就在于它那一列有东西。
 *   3. 里程碑。在一起满 100/200/300… 天，到点必定送，而且它知道是为什么。
 *
 * 一次最多 1 件。它要是一次给三个，拆的时候就没有"就这一个"的分量了。
 */

import type { CharacterProfile } from '../../types';
import { callGameAI } from '../games/shared/ai';
import { addGift, buildGiftImagePrompt, type Gift, type GiftWrap } from './gifts';
import { WRAPS } from './gifts';
import { COUPONS, couponById, addCoupon, loadCoupons, heldCount } from '../games/shared/coupons';
import { award, loadWallet } from '../games/shared/wallet';

const COOLDOWN_MS = 12 * 60 * 60 * 1000;
/**
 * [用户确认] 调用失败时只锁 30 分钟，不吃满 12 小时。
 * 网络抖一下就要等半天太冤；但也不能完全不锁，否则失败一次就能立刻连按二十下。
 */
const FAIL_COOLDOWN_MS = 30 * 60 * 1000;
const FALLBACK_MS = 7 * 24 * 60 * 60 * 1000;

const lastTryKey = (charId: string) => `yuzhou_gift_last_try_${charId || 'default'}`;
const lastGiftKey = (charId: string) => `yuzhou_gift_last_sent_${charId || 'default'}`;
const milestoneKey = (charId: string) => `yuzhou_gift_milestones_${charId || 'default'}`;

const readNum = (k: string): number => {
  try { return Number(localStorage.getItem(k)) || 0; } catch { return 0; }
};
const writeNum = (k: string, v: number) => {
  try { localStorage.setItem(k, String(v)); } catch { /* ignore */ }
};

function readDoneMilestones(charId: string): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(milestoneKey(charId)) || '[]');
    return Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : [];
  } catch { return []; }
}

function markMilestone(charId: string, day: number) {
  try {
    const next = Array.from(new Set([...readDoneMilestones(charId), day]));
    localStorage.setItem(milestoneKey(charId), JSON.stringify(next));
  } catch { /* ignore */ }
}

/** 在一起第几天。读的是与昼首页那个数字，没设过就返回 0。 */
export function daysTogether(): number {
  try { return Number(localStorage.getItem('yuzhou_anniversary_day')) || 0; } catch { return 0; }
}

/** 今天是不是没领过的里程碑（满 100 的整数倍）。 */
function pendingMilestone(charId: string): number | null {
  const d = daysTogether();
  if (d < 100 || d % 100 !== 0) return null;
  return readDoneMilestones(charId).includes(d) ? null : d;
}

export type GiftGateState =
  | { can: true; reason: 'milestone'; day: number }
  | { can: true; reason: 'fallback' }
  | { can: true; reason: 'normal' }
  | { can: false; nextAt: number };

/** 现在能不能去看看。冷却中返回下次可用的时刻，界面照实显示，不藏着。 */
export function checkGiftGate(charId: string): GiftGateState {
  const ms = pendingMilestone(charId);
  if (ms !== null) return { can: true, reason: 'milestone', day: ms };

  const lastGift = readNum(lastGiftKey(charId));
  if (lastGift > 0 && Date.now() - lastGift > FALLBACK_MS) return { can: true, reason: 'fallback' };

  const lastTry = readNum(lastTryKey(charId));
  if (lastTry > 0 && Date.now() - lastTry < COOLDOWN_MS) {
    return { can: false, nextAt: lastTry + COOLDOWN_MS };
  }
  return { can: true, reason: 'normal' };
}

export interface TaTurnResult {
  /** 送了东西。 */
  gift?: Gift;
  /** 它买了哪张券（只报名字，用来在界面上提一句）。 */
  bought?: string;
  /** 它对你用了哪张券。发进聊天框那条已经写好了。 */
  played?: string;
  /** 什么都没做时它说的那句话。不是"暂无"，是它此刻的一句真话。 */
  line?: string;
  gifts: Gift[];
}

/** 兼容旧名字。 */
export type TaGiftResult = TaTurnResult;

/**
 * 跑一次。
 *
 * 保底和里程碑那两种情况**强制它必须送**（prompt 里明说），普通情况才由它自己决定。
 * 不这样的话保底会被它一句"今天没什么想给你的"化解掉，柜子照样空着。
 */
export async function runTaGift(opts: {
  charId: string;
  char: CharacterProfile | null;
  apiConfig: any;
  userName: string;
  gate: GiftGateState;
}): Promise<TaGiftResult> {
  const { charId, char, apiConfig, userName, gate } = opts;
  const taName = char?.name || 'TA';

  // 先按"失败"记一个短冷却：调用真的挂了也不至于让你立刻连按二十下。
  // 拿到回复之后再改写成满 12 小时（见函数末尾）——**成功才吃满冷却**。
  writeNum(lastTryKey(charId), Date.now() - (COOLDOWN_MS - FAIL_COOLDOWN_MS));

  const must = gate.can && (gate.reason === 'milestone' || gate.reason === 'fallback');
  const milestoneDay = gate.can && gate.reason === 'milestone' ? gate.day : 0;

  const { isImageGenApiReady } = await import('../../utils/imageGenApi');
  const canImage = isImageGenApiReady(apiConfig?.imageGenApi);

  const persona = [char?.systemPrompt, char?.description].filter(Boolean).join('\n\n');

  // 它手上还有什么券、买得起什么——都塞进同一次调用里 [用户确认：三件事一次判完，省 API]
  const cw = loadCoupons(charId);
  const wallet = loadWallet(charId);
  const heldList = COUPONS
    .map(d => ({ d, n: heldCount(cw, 'ta', d.id) }))
    .filter(x => x.n > 0);
  const affordable = COUPONS.filter(d => d.price <= wallet.ta && heldCount(cw, 'ta', d.id) < d.max);

  const system = `${persona || `一个和${userName}很亲近的人`}

你和${userName}之间有一个"藏柜"，可以把亲手做的小礼物放进去，对方会看到一个包装好的盒子，
拆开才知道里面是什么。你们还各自有一些"券"——花打游戏赚的苹果币换的，用掉就是对对方行使一次那个权利。

这一次你可以同时做三件事，也可以一件都不做。**多数时候什么都不做才正常。**

──① 送不送礼物 ──
${must
  ? milestoneDay
    ? `今天是你们在一起的第 ${milestoneDay} 天。**这一次你一定要送**，而且心里清楚是为了这个日子。`
    : '**这一次你一定要送**——已经很久没给过对方东西了。'
  : '由你决定。只有此刻确实想到了什么、或者有什么想让对方知道，才送。'}
要送就填 gift：
- wrap 选一种：box（小纸箱，朴素）、ribbon（缎带礼盒，郑重）、bottle（玻璃瓶，像塞了张纸条）
- note 是附言，按你自己的说话习惯写，60 字以内，不要贺卡套话
${canImage ? '- imageWhat 可选，只写送什么（"一盏照亮书桌的小灯"），别写画风' : ''}

──② 用不用券 ──
你手上的券：${heldList.length > 0 ? heldList.map(x => `${x.d.name}×${x.n}（${x.d.desc}）`).join('；') : '（一张都没有）'}
想现在对${userName}用一张就填 playCoupon（写券的名字）。用了会直接发到你们的聊天里，
对方看到就是你在行使这个权利。没券或者此刻不想用就别填。

──③ 买不买券 ──
你现在有 ${wallet.ta} 个苹果币。买得起且没到上限的：${affordable.length > 0 ? affordable.map(d => `${d.name}(${d.price})`).join('、') : '（都买不起或已满）'}
想买就填 buyCoupon（写券的名字）。买了**不用告诉${userName}**，留着以后再用。
按你自己的性子挑——你会更想要哪种权利？别为了花钱而花钱。

三件都不做就只填 line：你此刻想说的一句话，正常说，别写"暂无"这种交代。

只返回 JSON：
{
  "gift": ${must ? '' : '可选，'}{"wrap":"box|ribbon|bottle","note":"附言"${canImage ? ',"imageWhat":"可选"' : ''}},
  "playCoupon": "可选，券名",
  "buyCoupon": "可选，券名",
  "line": "什么都不做时说的一句话"
}`;

  const reply = await callGameAI({
    api: apiConfig,
    label: taName,
    temperature: 0.95,
    system,
    messages: [{ role: 'user', content: must ? '现在做一件送给对方，另外两件随意。' : '现在去看一眼，想做什么就做。' }],
    meta: { appName: '与昼', charId: charId || undefined, charName: taName, purpose: '礼物 · TA送礼' },
  });

  const parsed = (() => {
    try {
      const raw = (reply || '').replace(/```json|```/g, '').trim();
      return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    } catch { return null; }
  })();

  // 调用成功了（不管它决定做不做事），吃满 12 小时冷却
  writeNum(lastTryKey(charId), Date.now());

  const { loadGifts } = await import('./gifts');
  const out: TaTurnResult = { gifts: [] };

  if (!parsed) {
    return { line: '今天没什么想给你的，就是有点想你。', gifts: await loadGifts(charId) };
  }

  // ── ② 用券：发进聊天框，以它的身份 [用户确认：不能拒绝，但可以赖账] ──
  const playName = String(parsed.playCoupon || '').trim();
  if (playName) {
    const item = loadCoupons(charId).items.find(i => {
      const d = couponById(i.defId);
      return i.owner === 'ta' && !i.usedAt && d && (d.name === playName || playName.includes(d.name));
    });
    if (item) {
      const d = couponById(item.defId)!;
      try {
        const { DB } = await import('../../utils/db');
        const { categoryOf } = await import('../games/shared/coupons');
        await DB.saveMessage({
          charId, role: 'assistant', type: 'coupon_card',
          content: `【${d.name}】${d.desc}`,
          metadata: { couponName: d.name, couponDesc: d.desc, couponAccent: categoryOf(d.category).accent },
        } as never);
        const { useCoupon } = await import('../games/shared/coupons');
        useCoupon(charId, item.id);
        out.played = d.name;
      } catch (e) { console.warn('[YuZhou] TA 用券失败', e); }
    }
  }

  // ── ③ 买券：不通知你，只有余额会掉一截 [用户确认 C：券夹里看得到] ──
  const buyName = String(parsed.buyCoupon || '').trim();
  if (buyName) {
    const def = COUPONS.find(d => d.name === buyName || buyName.includes(d.name));
    if (def && loadWallet(charId).ta >= def.price) {
      const r = addCoupon(charId, 'ta', def.id);
      if (r.ok) {
        award(charId, [{ side: 'ta', amount: -def.price, game: 'other', reason: `兑换「${def.name}」` }]);
        out.bought = def.name;
      }
    }
  }

  // ── ① 礼物 ──
  const gi = parsed.gift && typeof parsed.gift === 'object' ? parsed.gift : (must ? parsed : null);
  if (gi) {
    const wrap: GiftWrap = WRAPS.some(w => w.id === gi.wrap) ? gi.wrap : 'ribbon';
    const note = String(gi.note || '').trim().slice(0, 200);

    let image: string | undefined;
    let imagePrompt: string | undefined;
    const what = String(gi.imageWhat || '').trim();
    if (canImage && what) {
      try {
        const { generateImage } = await import('../../utils/imageGenApi');
        const { migrateDataUrlToRef } = await import('../../utils/blobRef');
        const res = await generateImage(apiConfig.imageGenApi, buildGiftImagePrompt(what), {
          n: 1,
          meta: { appName: '与昼', charId: charId || undefined, charName: taName, purpose: '礼物 · TA做的东西' } as any,
        });
        const src = res[0]?.src;
        if (src) {
          image = src.startsWith('data:') ? await migrateDataUrlToRef(src) : src;
          imagePrompt = what;
        }
      } catch (e: any) {
        // 出图失败只退化成纯文字，不让整件礼物送不出去
        console.warn('[YuZhou] TA 的礼物配图失败，退化成纯文字', e?.message || String(e));
      }
    }

    if (note || image) {
      const gifts = await addGift(charId, { from: 'ta', wrap, note, image, imagePrompt });
      writeNum(lastGiftKey(charId), Date.now());
      if (milestoneDay) markMilestone(charId, milestoneDay);
      out.gift = gifts[0];
      out.gifts = gifts;
    }
  }

  if (!out.gifts.length) out.gifts = await loadGifts(charId);
  if (!out.gift && !out.played && !out.bought) {
    out.line = String(parsed.line || '').trim() || '今天没什么想给你的，就是有点想你。';
  }
  return out;
}
