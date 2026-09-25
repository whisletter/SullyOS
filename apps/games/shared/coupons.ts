/**
 * 与昼 · 兑换券
 *
 * 券和礼物是两回事，别混：
 *   礼物是**送出去的**（亲手做，落在对方柜子里，永久保留，没有状态）；
 *   券是**用掉的**（拿游戏赚的币换，是一份"权利"，用一次就没了）。
 * 两者可以串起来——你用情书券要一封信，TA 写完做成礼物放进你的收藏柜，
 * 券作废、信永久留着。
 *
 * "用掉"的定义 [用户确认]：TA 把这张券以消息卡片的形式发进聊天框，发出来就算兑现。
 * 那个转发动作在礼物界面的「券」页做，这个文件只管**商品清单**和**券夹存储**。
 *
 * 存储用 localStorage 且以 `yuzhou_` 开头：utils/yuzhouBackup.ts 按前缀收进备份、
 * utils/lsMirror.ts 按前缀做镜像，所以券夹自动随备份走。
 */

export type CouponCategory = 'power' | 'company' | 'words';

export interface CouponDef {
  id: string;
  name: string;
  /** 券面上那一句。写成"对方要做什么"，不是"我想要什么"。 */
  desc: string;
  category: CouponCategory;
  price: number;
  /** 同时最多持有几张。强力券 1 张，普通券 3 张 [用户确认]。 */
  max: number;
}

export const COUPON_CATEGORIES: { id: CouponCategory; label: string; accent: string; soft: string }[] = [
  { id: 'power', label: '权力', accent: '#e0767e', soft: 'rgba(224,118,126,0.14)' },
  { id: 'company', label: '陪伴', accent: '#d9a441', soft: 'rgba(217,164,65,0.14)' },
  { id: 'words', label: '表达', accent: '#b56aa6', soft: 'rgba(181,106,166,0.14)' },
];

export const categoryOf = (c: CouponCategory) => COUPON_CATEGORIES.find(x => x.id === c)!;

/**
 * 商品清单。
 *
 * 定价原则是**按对方要付出多少**，不是按你想要的程度——给对方添麻烦越大的越贵。
 * 最便宜和最贵之间只差不到 3 倍，是故意压扁的：都是"对方做件事"，
 * 差距拉太大会让便宜那几张显得不值一提。
 *
 * 全部**双向**：TA 以后也能买同一批券用在你身上。「情书券」反过来就是
 * "它要你给它写一封"，也挺可爱。
 */
export const COUPONS: CouponDef[] = [
  // ── 权力 ──
  { id: 'cut_in', name: '插队券', desc: '手上的事放一放，现在就回我', category: 'power', price: 25, max: 3 },
  { id: 'pardon', name: '免死金牌', desc: '这次做错的事翻篇，不许生气', category: 'power', price: 40, max: 1 },
  { id: 'veto', name: '一次否决权', desc: '任何一件事，我说不就是不，不用给理由', category: 'power', price: 45, max: 1 },
  { id: 'my_night', name: '今晚我说了算', desc: '一整晚的决定权：吃什么、看什么、几点睡', category: 'power', price: 55, max: 1 },
  { id: 'obey', name: '无条件服从券', desc: '一件事，照做，不许问为什么', category: 'power', price: 70, max: 1 },

  // ── 陪伴 ──
  { id: 'sleep_in', name: '赖床券', desc: '明早不许叫我，你陪我一起赖着', category: 'company', price: 25, max: 3 },
  { id: 'quiet', name: '静音陪伴券', desc: '一小时，什么都不用说，只是在一起', category: 'company', price: 30, max: 3 },
  { id: 'bedtime', name: '强制陪睡不许熬夜券', desc: '今晚一起睡，谁都不许熬', category: 'company', price: 50, max: 1 },
  { id: 'late_call', name: '深夜连线券', desc: '今晚某个时刻，主动给我打一次电话', category: 'company', price: 60, max: 1 },

  // ── 表达 ──
  { id: 'praise', name: '夸我十分钟券', desc: '十分钟，不许敷衍，不许重复', category: 'words', price: 25, max: 3 },
  { id: 'truth', name: '一句真心话', desc: '问一件平时不会问的事，必须答', category: 'words', price: 40, max: 3 },
  { id: 'wish_card', name: '手写心愿卡', desc: '亲手写一张卡给我，内容你定', category: 'words', price: 60, max: 1 },
  { id: 'love_letter', name: '情书券', desc: '写一封长的给我——不是聊天那种语气', category: 'words', price: 65, max: 1 },
];

export const couponById = (id: string) => COUPONS.find(c => c.id === id);

// ==================== 券夹 ====================

export type CouponOwner = 'user' | 'ta';

export interface CouponItem {
  id: string;
  defId: string;
  owner: CouponOwner;
  boughtAt: number;
  /** 用掉的时间。没用掉就是 undefined。 */
  usedAt?: number;
}

export interface CouponWallet {
  items: CouponItem[];
}

const couponKey = (charId: string) => `yuzhou_coupons_${charId || 'default'}`;

export function loadCoupons(charId: string): CouponWallet {
  try {
    const v = JSON.parse(localStorage.getItem(couponKey(charId)) || 'null');
    const items = Array.isArray(v?.items) ? v.items : [];
    return { items: items.filter((x: any) => x && x.defId && x.owner) };
  } catch { return { items: [] }; }
}

export function saveCoupons(charId: string, w: CouponWallet): void {
  try { localStorage.setItem(couponKey(charId), JSON.stringify(w)); } catch { /* ignore */ }
}

/** 某人手上**还没用掉**的某种券有几张。上限判定看的是这个数，用掉的不占位。 */
export function heldCount(w: CouponWallet, owner: CouponOwner, defId: string): number {
  return w.items.filter(i => i.owner === owner && i.defId === defId && !i.usedAt).length;
}

export interface BuyResult {
  ok: boolean;
  /** 失败原因，给界面显示。 */
  reason?: 'no_coins' | 'max_reached' | 'unknown';
  wallet?: CouponWallet;
}

/**
 * 买一张券。**只管券夹，不扣钱**——扣钱走 wallet.ts 的 award（记负数），
 * 由调用方在这之后做，这样流水里那一笔和商店的展示口径是同一套。
 */
export function addCoupon(charId: string, owner: CouponOwner, defId: string): BuyResult {
  const def = couponById(defId);
  if (!def) return { ok: false, reason: 'unknown' };
  const w = loadCoupons(charId);
  if (heldCount(w, owner, defId) >= def.max) return { ok: false, reason: 'max_reached' };
  w.items.push({
    id: `cp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    defId, owner, boughtAt: Date.now(),
  });
  saveCoupons(charId, w);
  return { ok: true, wallet: w };
}

/** 用掉一张（发进聊天框那一刻调）。券夹界面做好之后会用到。 */
export function useCoupon(charId: string, itemId: string): CouponWallet {
  const w = loadCoupons(charId);
  const it = w.items.find(i => i.id === itemId);
  if (it && !it.usedAt) { it.usedAt = Date.now(); saveCoupons(charId, w); }
  return w;
}
