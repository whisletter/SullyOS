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

const COOLDOWN_MS = 12 * 60 * 60 * 1000;
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

export interface TaGiftResult {
  /** 送了东西。 */
  gift?: Gift;
  /** 没送时它说的那句话。不是"暂无"，是它此刻的一句真话。 */
  line?: string;
  gifts: Gift[];
}

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

  // 不管送不送，这一次尝试都要记冷却——否则没送的时候可以无限按
  writeNum(lastTryKey(charId), Date.now());

  const must = gate.can && (gate.reason === 'milestone' || gate.reason === 'fallback');
  const milestoneDay = gate.can && gate.reason === 'milestone' ? gate.day : 0;

  const { isImageGenApiReady } = await import('../../utils/imageGenApi');
  const canImage = isImageGenApiReady(apiConfig?.imageGenApi);

  const persona = [char?.systemPrompt, char?.description].filter(Boolean).join('\n\n');

  const system = `${persona || `一个和${userName}很亲近的人`}

你和${userName}之间有一个"藏柜"，可以把亲手做的小礼物放进去，对方会看到一个包装好的盒子，
拆开才知道里面是什么。

${must
  ? milestoneDay
    ? `今天是你们在一起的第 ${milestoneDay} 天。**这一次你一定要送**，而且心里清楚是为了这个日子。`
    : '**这一次你一定要送**——已经很久没给过对方东西了。'
  : '现在由你决定要不要送。**多数时候是不送的**——只有此刻确实想到了什么、或者有什么想让对方知道，才送。'}

要送的话：
- wrap 选一种包装：box（小纸箱，朴素）、ribbon（缎带礼盒，郑重一点）、bottle（玻璃瓶，像给对方写了张纸条塞进去）。
- note 是附在礼物里的话，按你自己的说话习惯写，60 字以内。不要写成贺卡套话。
${canImage ? '- 想附一件"东西"就填 imageWhat，只写送什么（比如"一盏照亮书桌的小灯"），别写画风。不想附就不写这个字段。' : ''}

不送的话：只填 line —— 你此刻想说的一句话，不要是"暂无"这种交代，就正常说一句。

只返回 JSON：
${must
  ? `{"wrap":"box|ribbon|bottle","note":"附言"${canImage ? ',"imageWhat":"可选"' : ''}}`
  : `{"give":true或false,"wrap":"box|ribbon|bottle","note":"附言"${canImage ? ',"imageWhat":"可选"' : ''},"line":"不送时说的话"}`}`;

  const reply = await callGameAI({
    api: apiConfig,
    label: taName,
    temperature: 0.95,
    system,
    messages: [{ role: 'user', content: must ? '现在做一件送给对方。' : '现在去藏柜那边看一眼，想送就送。' }],
    meta: { appName: '与昼', charId: charId || undefined, charName: taName, purpose: '礼物 · TA送礼' },
  });

  const parsed = (() => {
    try {
      const raw = (reply || '').replace(/```json|```/g, '').trim();
      return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    } catch { return null; }
  })();

  const { loadGifts } = await import('./gifts');

  // 没解析出来 / 它选择不送
  if (!parsed || (!must && parsed.give === false)) {
    return {
      line: String(parsed?.line || '').trim() || '今天没什么想给你的，就是有点想你。',
      gifts: await loadGifts(charId),
    };
  }

  const wrap: GiftWrap = WRAPS.some(w => w.id === parsed.wrap) ? parsed.wrap : 'ribbon';
  const note = String(parsed.note || '').trim().slice(0, 200);

  let image: string | undefined;
  let imagePrompt: string | undefined;
  const what = String(parsed.imageWhat || '').trim();
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

  if (!note && !image) {
    return { line: '想了半天，还是没弄出个像样的东西。', gifts: await loadGifts(charId) };
  }

  const gifts = await addGift(charId, { from: 'ta', wrap, note, image, imagePrompt });
  writeNum(lastGiftKey(charId), Date.now());
  if (milestoneDay) markMilestone(charId, milestoneDay);

  return { gift: gifts[0], gifts };
}
