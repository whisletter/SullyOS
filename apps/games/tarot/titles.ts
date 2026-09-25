/**
 * 塔罗 · 称号
 *
 * 数据是现成的：duoStore 的 DuoStats 已经在按「谁解的 × 哪个模式」分别累计分数
 * （很准/一半准/不准 → SCORE 表），这里只负责把分数翻译成称号，不改计分。
 *
 * ── 两条奖励线，别混 ──
 * 苹果币只从**称号**来，而且你和 TA 各算各的，不存在"两人合计"这个概念。
 * **默契值（两人之和）不换币**，它只用来解锁塔罗专属的新牌背。
 *
 * ── 为什么你和 TA 分开记 ──
 * 称号是"占卜师"的头衔。合成一个数字的话，TA 解得准你也跟着升「见习占卜师」，
 * 那个称号就名不副实了。分开还多一层拉扯：你会看到"我 23 / TA 31"然后想追上去。
 * 两人之和另算一个**默契值**，那才是共同的东西，留给塔罗专属奖励（新牌背之类）。
 *
 * ── 两条路各走各的 ──
 * 学徒之路数基础模式的分，学者之路数进阶模式的分，互不顶替。
 * 不然在基础模式刷满就能直接拿「缄默先知」，进阶模式就白设计了。
 */

import { loadDuoStats, loadDuoRecords, SCORE, type DuoMode, type DuoStats } from './duoStore';

export type TitlePath = 'apprentice' | 'scholar';
export type TitleSide = 'user' | 'ta';

export interface TitleTier {
  id: string;
  name: string;
  /** 达到这个分数解锁。 */
  need: number;
  /** 解锁时赠送的苹果币。 */
  coins: number;
}

/**
 * 学徒之路（基础模式）。
 *
 * 满级 30 分、一次"很准" 0.5 分 = 要 60 次，比学者之路的 50 次还多。
 * **这是有意的，不是配错了**：基础模式能翻牌意之书，猜准本来就容易得多，
 * 所以每次给的分少、总量要求高。含金量靠"次数"堆，学者之路靠"难度"。
 * 以后看到这个数字别去"修"它。
 */
export const APPRENTICE_PATH: TitleTier[] = [
  { id: 'apprentice_1', name: '小屋新访客', need: 1, coins: 5 },
  { id: 'apprentice_2', name: '星尘学徒', need: 5, coins: 10 },
  { id: 'apprentice_3', name: '月光学徒', need: 15, coins: 20 },
  { id: 'apprentice_4', name: '见习占卜师', need: 30, coins: 30 },
];

/** 学者之路（进阶模式）。一次"很准" 1 分。 */
export const SCHOLAR_PATH: TitleTier[] = [
  { id: 'scholar_1', name: '羊皮纸译者', need: 3, coins: 5 },
  { id: 'scholar_2', name: '秘典研习者', need: 10, coins: 10 },
  { id: 'scholar_3', name: '观心学者', need: 25, coins: 20 },
  { id: 'scholar_4', name: '缄默先知', need: 50, coins: 30 },
];

/** 两条路都走满才有。 */
export const ULTIMATE_TITLE: TitleTier = { id: 'ultimate', name: '命运执笔人', need: 0, coins: 50 };

export const PATHS: Record<TitlePath, { label: string; mode: DuoMode; tiers: TitleTier[] }> = {
  apprentice: { label: '学徒之路', mode: 'basic', tiers: APPRENTICE_PATH },
  scholar: { label: '学者之路', mode: 'advanced', tiers: SCHOLAR_PATH },
};

// ==================== 隐藏称号 ====================

export interface HiddenTitle {
  id: string;
  name: string;
  /** 解锁后才显示的说明。没解锁时显示问号。 */
  hint: string;
  coins: number;
}

/**
 * 四个隐藏称号。条件是我按名字拟的，你想改直接改 checkHidden 里对应那一段。
 * 全部从占卜记录（loadDuoRecords）里算，不需要额外记账。
 */
export const HIDDEN_TITLES: HiddenTitle[] = [
  // coins 是**每人**的数量：隐藏称号双方同得，跟女巫那套 1:1 一个道理——
  // 这四个本来就是"你们俩一起达成的"，只给一边说不过去。
  { id: 'hidden_sync', name: '心有灵犀', hint: '同一场占卜里，你们互相判了对方"很准"', coins: 25 },
  { id: 'hidden_duo', name: '默契双星', hint: '连续 5 局，双方的解读都至少"一半准"', coins: 25 },
  { id: 'hidden_reader', name: '天生读心者', hint: '进阶模式下连续 3 局被判"很准"', coins: 25 },
  { id: 'hidden_collector', name: '三牌收藏家', hint: '塔罗、雷诺曼、神谕卡三种牌都用来占卜过', coins: 25 },
];

// ==================== 进度 ====================

export interface PathProgress {
  path: TitlePath;
  score: number;
  /** 当前称号。一个都没达到就是 null。 */
  current: TitleTier | null;
  /** 下一个目标。满了就是 null。 */
  next: TitleTier | null;
  /** 到下一档的完成度 0-1。满了固定 1。 */
  ratio: number;
  /** 已解锁的档位 id。 */
  unlocked: string[];
}

export interface SideProgress {
  side: TitleSide;
  apprentice: PathProgress;
  scholar: PathProgress;
  /** 两条路都满了。 */
  ultimate: boolean;
  /** 这一侧的总分（两条路相加），只用来显示。 */
  total: number;
}

export interface TitlesSnapshot {
  user: SideProgress;
  ta: SideProgress;
  /**
   * 默契值 = 四个数之和。
   *
   * **它不换苹果币。** 苹果币只从称号来，而且各人算各人的。默契值是另一条线：
   * 只涨不减，走到里程碑解锁塔罗专属的新牌背。两条线互不换算，别把它们加在一起。
   */
  harmony: number;
  /** 已解锁的隐藏称号 id。 */
  hidden: string[];
  rounds: number;
}

function pathProgress(path: TitlePath, score: number): PathProgress {
  const tiers = PATHS[path].tiers;
  const unlocked = tiers.filter(t => score >= t.need);
  const current = unlocked.length > 0 ? unlocked[unlocked.length - 1] : null;
  const next = tiers.find(t => score < t.need) || null;
  const from = current?.need ?? 0;
  const ratio = next ? Math.max(0, Math.min(1, (score - from) / (next.need - from))) : 1;
  return { path, score, current, next, ratio, unlocked: unlocked.map(t => t.id) };
}

function sideProgress(side: TitleSide, stats: DuoStats): SideProgress {
  const apprentice = pathProgress('apprentice', stats[side].basic);
  const scholar = pathProgress('scholar', stats[side].advanced);
  return {
    side, apprentice, scholar,
    ultimate: apprentice.next === null && scholar.next === null,
    total: stats[side].basic + stats[side].advanced,
  };
}

/**
 * 隐藏称号的判定。全部从占卜记录里现算。
 *
 * 记录里每一局（DuoRound）都带着 rating（很准/一半准/不准）、mode、play 和用了哪些牌组，
 * 所以"连续几局""同一场里互相"这种条件都算得出来，不用额外记账。
 */
async function checkHidden(charId: string): Promise<string[]> {
  const out: string[] = [];
  let sessions;
  try {
    sessions = (await loadDuoRecords(charId)).sessions;
  } catch {
    return out;
  }

  // 按时间把所有局摊平，用来算"连续 N 局"
  const allRounds = sessions
    .flatMap(s => s.rounds)
    .filter(r => !!r.rating)
    .sort((a, b) => a.startedAt - b.startedAt);

  // 心有灵犀：同一场里，既有"TA抽我解"被判很准，也有"我抽TA解"被判很准
  if (sessions.some(s =>
    s.rounds.some(r => r.play === 'ta_draws' && r.rating === 'hit')
    && s.rounds.some(r => r.play === 'user_draws' && r.rating === 'hit')
  )) out.push('hidden_sync');

  // 默契双星：连续 5 局都至少"一半准"
  let streakHalf = 0;
  for (const r of allRounds) {
    streakHalf = (r.rating === 'hit' || r.rating === 'half') ? streakHalf + 1 : 0;
    if (streakHalf >= 5) { out.push('hidden_duo'); break; }
  }

  // 天生读心者：进阶模式连续 3 局"很准"
  let streakHit = 0;
  for (const r of allRounds.filter(r => r.mode === 'advanced')) {
    streakHit = r.rating === 'hit' ? streakHit + 1 : 0;
    if (streakHit >= 3) { out.push('hidden_reader'); break; }
  }

  // 三牌收藏家：三种牌都占卜过
  const kinds = new Set<string>();
  for (const s of sessions) for (const r of s.rounds) for (const d of r.decks) kinds.add(d.kind);
  if (kinds.size >= 3) out.push('hidden_collector');

  return out;
}

export async function loadTitles(charId: string): Promise<TitlesSnapshot> {
  const stats = await loadDuoStats(charId);
  const user = sideProgress('user', stats);
  const ta = sideProgress('ta', stats);
  return {
    user, ta,
    harmony: user.total + ta.total,
    hidden: await checkHidden(charId),
    rounds: stats.rounds,
  };
}

// ==================== 赠币 ====================

/** 一个称号对应的赠币 token。同一个称号只赠一次，靠 wallet 的 paid 记录挡住。 */
export const titleCoinToken = (side: TitleSide, titleId: string) => `tarot_title:${side}:${titleId}`;

/** 这一侧当前已解锁的全部称号 id（含终极）。 */
export function unlockedTitleIds(p: SideProgress): string[] {
  const ids = [...p.apprentice.unlocked, ...p.scholar.unlocked];
  if (p.ultimate) ids.push(ULTIMATE_TITLE.id);
  return ids;
}

export function titleById(id: string): TitleTier | HiddenTitle | undefined {
  if (id === ULTIMATE_TITLE.id) return ULTIMATE_TITLE;
  return [...APPRENTICE_PATH, ...SCHOLAR_PATH].find(t => t.id === id)
    || HIDDEN_TITLES.find(t => t.id === id);
}

/** 一次"很准"在这个模式下值多少分。称号页上拿来说明进度用。 */
export const hitValueOf = (mode: DuoMode) => SCORE[mode].hit;
