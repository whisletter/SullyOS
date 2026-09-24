/**
 * 与昼 · 苹果币钱包（四个小游戏共用）
 *
 * 你和 TA 各有一个钱包，**分开记**。这是整套设计的前提：只有 TA 有自己的钱，
 * 它拿去给你买东西才叫惊喜；共用一个钱包的话，就变成你自己花自己的钱给自己买。
 *
 * 🍏 绿苹果 = 你　　🍎 红苹果 = TA
 *
 * 存储用 localStorage 且以 `yuzhou_` 开头：utils/yuzhouBackup.ts 按这个前缀收进备份、
 * utils/lsMirror.ts 按它做 IndexedDB 镜像，所以钱包**自动随备份走**，
 * 也防得住"浏览器只清 localStorage"那种情况。加新游戏沿用这个前缀即可。
 *
 * 按角色分钱包（key 带 charId）：跟不同角色玩攒的钱各算各的，
 * 跟聊天记录、朋友圈那些按角色分的数据是同一个口径。
 */

export type WalletSide = 'user' | 'ta';

/** 发币的来源游戏。加新游戏时在这里加一项。 */
export type WalletGame = 'turtle_soup' | 'monopoly' | 'witch_poison' | 'tarot' | 'other';

export interface WalletEntry {
  id: string;
  at: number;
  side: WalletSide;
  /** 正数是赚，负数是花（以后商店消费用）。 */
  amount: number;
  game: WalletGame;
  /** 给人看的一句话，比如"海龟汤 · 基本还原 · 严格"。 */
  reason: string;
}

export interface Wallet {
  user: number;
  ta: number;
  /** 流水。只留最近若干条——这东西是给人看的，不是账本审计。 */
  ledger: WalletEntry[];
}

const LEDGER_LIMIT = 120;

const walletKey = (charId: string) => `yuzhou_wallet_${charId || 'default'}`;

export const EMPTY_WALLET: Wallet = { user: 0, ta: 0, ledger: [] };

export function loadWallet(charId: string): Wallet {
  try {
    const v = JSON.parse(localStorage.getItem(walletKey(charId)) || 'null');
    if (!v || typeof v !== 'object') return { ...EMPTY_WALLET, ledger: [] };
    return {
      user: Number.isFinite(v.user) ? Math.max(0, Math.floor(v.user)) : 0,
      ta: Number.isFinite(v.ta) ? Math.max(0, Math.floor(v.ta)) : 0,
      ledger: Array.isArray(v.ledger) ? v.ledger.slice(-LEDGER_LIMIT) : [],
    };
  } catch {
    return { ...EMPTY_WALLET, ledger: [] };
  }
}

export function saveWallet(charId: string, w: Wallet): void {
  try {
    localStorage.setItem(walletKey(charId), JSON.stringify({
      user: Math.max(0, Math.floor(w.user)),
      ta: Math.max(0, Math.floor(w.ta)),
      ledger: w.ledger.slice(-LEDGER_LIMIT),
    }));
  } catch { /* quota 满：这一次不记，不让它影响游戏本身 */ }
}

export interface AwardInput {
  side: WalletSide;
  amount: number;
  game: WalletGame;
  reason: string;
}

/**
 * 记一笔（或几笔）。返回更新后的钱包，调用方直接拿去渲染。
 *
 * amount 为 0 的条目会被跳过——"这局你没拿到币"不需要在流水里留一行，
 * 结算页上说一句就够了。
 */
export function award(charId: string, awards: AwardInput[]): Wallet {
  const w = loadWallet(charId);
  const now = Date.now();
  let seq = 0;
  for (const a of awards) {
    const amount = Math.floor(a.amount);
    if (!amount) continue;
    w[a.side] = Math.max(0, w[a.side] + amount);
    w.ledger.push({
      id: `wl_${now.toString(36)}_${seq++}`,
      at: now, side: a.side, amount, game: a.game, reason: a.reason,
    });
  }
  w.ledger = w.ledger.slice(-LEDGER_LIMIT);
  saveWallet(charId, w);
  return w;
}

// ==================== 防重复结算 ====================

/**
 * 已经结算过币的"一次性对象"。
 *
 * 海龟汤有个明显的漏洞：设置页能清空抽取记录，清完 129 碗全回来，可以无限刷同一碗。
 * 所以**同一碗汤只发一次币**——即使清空记录重玩，也只算一次。
 * 这份记录跟"喝过的汤"分开存，清空抽取记录不会连它一起清掉。
 *
 * 别的游戏要是有类似的一次性奖励（比如塔罗的称号），也用这里，key 各自加前缀。
 */
const paidKey = (charId: string) => `yuzhou_wallet_paid_${charId || 'default'}`;

export function loadPaidTokens(charId: string): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(paidKey(charId)) || '[]');
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch { return new Set(); }
}

export function isPaid(charId: string, token: string): boolean {
  return loadPaidTokens(charId).has(token);
}

/** 带某个前缀的已结算条目有几个。海龟汤用它数"129 碗里已经结算过几碗"。 */
export function countPaid(charId: string, prefix: string): number {
  let n = 0;
  for (const t of loadPaidTokens(charId)) if (t.startsWith(prefix)) n++;
  return n;
}

/**
 * 清掉某个前缀下的全部已结算记录，让这些对象可以重新赚一次币。
 *
 * 调用方必须自己先判断"该不该给重置"（比如海龟汤要求 129 碗全部结算过），
 * 这里不做资格判断——它只是个工具，把条件写在业务侧更好读。
 */
export function resetPaid(charId: string, prefix: string): void {
  try {
    const kept = [...loadPaidTokens(charId)].filter(t => !t.startsWith(prefix));
    localStorage.setItem(paidKey(charId), JSON.stringify(kept));
  } catch { /* ignore */ }
}

export function markPaid(charId: string, token: string): void {
  try {
    const set = loadPaidTokens(charId);
    set.add(token);
    localStorage.setItem(paidKey(charId), JSON.stringify([...set]));
  } catch { /* ignore */ }
}
