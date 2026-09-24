/**
 * 海龟汤 · 引擎层（不调 API）
 *
 * 这里放三类东西：
 *   1. 局面状态与存档（localStorage，`yuzhou_` 前缀，自动随备份和镜像走）；
 *   2. **本地校验** —— 重复提问拦截、非是否句驳回。这两件事不调 API 就能做掉，
 *      是省调用次数的大头：一局下来被驳回和重复的问题往往不少，
 *      每挡下一个就省一次主持人调用，而且是即时反馈，比等模型返回快得多；
 *   3. 抽汤（按难度和内容标签筛，抽过的不重复）。
 *
 * 汤底相关的一切只经过这里存取，判定和评分在 ai.ts。
 */

import { SOUPS, SOUP_CONTENT_TAGS, type Soup, type SoupDifficulty } from './soups';

// ==================== 一、规则难度 ====================

export type RuleLevel = 'easy' | 'normal' | 'hard';

export interface RuleConfig {
  id: RuleLevel;
  label: string;
  /** 每人可提问次数。null = 无限。 */
  questionsEach: number | null;
  /** 可用提示次数。null = 无限。 */
  hints: number | null;
  desc: string;
}

export const RULES: RuleConfig[] = [
  { id: 'easy', label: '轻松', questionsEach: null, hints: null, desc: '无限提问、无限提示，纯休闲' },
  { id: 'normal', label: '正常', questionsEach: 6, hints: 3, desc: '每人 6 问 + 3 次提示，标准体验' },
  { id: 'hard', label: '严格', questionsEach: 3, hints: 0, desc: '每人 3 问、没有提示，硬核' },
];

export const ruleOf = (id: RuleLevel): RuleConfig => RULES.find(r => r.id === id) || RULES[1];

// ==================== 二、局面 ====================

/** 主持人只回这四个词。其余一律算驳回。 */
export type HostVerdict = '是' | '否' | '是也不是' | '无关';
export const HOST_VERDICTS: HostVerdict[] = ['是', '否', '是也不是', '无关'];

export type Asker = 'user' | 'ta';

export interface QaEntry {
  id: string;
  asker: Asker;
  question: string;
  verdict: HostVerdict;
  /** 主持人偶尔补的一句话（可选，不影响判定）。 */
  note?: string;
  at: number;
}

/**
 * 对局里的闲聊。跟提问是两回事：提问要过主持人、扣次数；闲聊只在你和 TA 之间，
 * 不扣次数、不惊动主持人，就是猜谜过程里随口说的话——
 * "我怀疑这人根本不是人""你刚才那个方向我觉得不对"之类。
 */
export interface ChatEntry {
  id: string;
  who: Asker;
  text: string;
  at: number;
}

export interface GameState {
  soupId: string;
  rule: RuleLevel;
  /** 公开问答记录。TA 看得到全部，但永远看不到汤底。 */
  qa: QaEntry[];
  /** 你和 TA 的闲聊。不扣提问次数，也不经过主持人。 */
  chat: ChatEntry[];
  /** 已经放出去的提示条数（对应 soup.hints 的前 n 条）。 */
  hintsUsed: number;
  userAsked: number;
  taAsked: number;
  /** 谁该问了。用户提交问题后轮到 TA，TA 问完轮回用户。 */
  turn: Asker;
  startedAt: number;
  /** 结算之后填。 */
  result?: GameResult;
}

export interface GameResult {
  score: number;
  /** 完全还原 / 基本还原 / 部分还原 / 方向错误 */
  tier: string;
  breakdown: { key: number; logic: number; detail: number };
  comment: string;
  /** 玩家提交的那段还原。 */
  submitted: string;
  at: number;
}

export const scoreTier = (score: number): string => {
  if (score >= 85) return '完全还原';
  if (score >= 65) return '基本还原';
  if (score >= 40) return '部分还原';
  return '方向错误';
};

export function createGame(soupId: string, rule: RuleLevel): GameState {
  return {
    soupId, rule, qa: [], chat: [], hintsUsed: 0,
    userAsked: 0, taAsked: 0, turn: 'user',
    startedAt: Date.now(),
  };
}

/** 还能不能问。轻松难度永远能问。 */
export function canAsk(g: GameState, who: Asker): boolean {
  const limit = ruleOf(g.rule).questionsEach;
  if (limit === null) return true;
  return (who === 'user' ? g.userAsked : g.taAsked) < limit;
}

export function canHint(g: GameState, soup: Soup): boolean {
  const limit = ruleOf(g.rule).hints;
  if (g.hintsUsed >= soup.hints.length) return false;
  if (limit === null) return true;
  return g.hintsUsed < limit;
}

/** 双方都问完了 = 只剩提交。 */
export function isOutOfQuestions(g: GameState): boolean {
  return !canAsk(g, 'user') && !canAsk(g, 'ta');
}

// ==================== 三、本地校验（省 API 的关键） ====================

/**
 * 这句话能不能用"是/否"回答。
 *
 * 纯启发式，不调 API。两条线索：
 *   - 出现疑问词（谁/什么/为什么/怎么/哪/多少/如何）→ 基本可以断定是开放式问题；
 *   - 结尾是「吗/么/吧」「是不是/有没有/能不能」这类 → 基本可以断定是是非问句。
 *
 * 判错的代价不对称：把是非问句误判成开放式（假阳性）会挡住合法提问，很烦；
 * 把开放式放过去（假阴性）最多浪费一次主持人调用，而且主持人会回「无关」或者
 * 自己驳回。所以这里**偏向放行**——只有明确出现疑问词、且没有是非句式时才拦。
 */
export function isYesNoQuestion(raw: string): boolean {
  const q = raw.trim();
  if (!q) return false;

  // 明确的是非句式：出现就直接放行，不再看疑问词
  //（"他是不是因为什么原因才走的" 这种混合句，还是让主持人去判）
  const yesNoPatterns = /(是不是|有没有|能不能|会不会|对不对|算不算|可不可以|要不要|曾经|吗[？?]?$|么[？?]?$|吧[？?]?$)/;
  if (yesNoPatterns.test(q)) return true;

  // 开放式疑问词
  const openPatterns = /(为什么|为何|怎么样|怎么|怎样|如何|什么|啥|哪一?[个些里儿]|哪|谁|多少|几个|何时|何地)/;
  if (openPatterns.test(q)) return false;

  // 两样都没有：可能是陈述式猜测（"他其实已经死了"），这种能用是/否回答，放行
  return true;
}

/**
 * 跟已经问过的问题重不重。
 *
 * 先做归一化（去标点空白、统一全半角），完全相同直接判重；
 * 否则算一个粗糙的字符重合率，超过阈值也判重。不调 API，所以宁可宽松一点——
 * 误判成重复会挡掉合法提问，比多花一次调用更让人烦。
 */
export function findDuplicate(g: GameState, raw: string): QaEntry | null {
  const norm = (s: string) => s.replace(/[\s，。？?！!、,.；;："'"'（）()]/g, '').toLowerCase();
  const a = norm(raw);
  if (!a) return null;
  for (const entry of g.qa) {
    const b = norm(entry.question);
    if (!b) continue;
    if (a === b) return entry;
    // 字符重合率：短的那句有 85% 以上的字出现在长的那句里，就算同一个问题
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    if (short.length < 6) continue; // 太短的句子重合率没意义
    let hit = 0;
    for (const ch of new Set(short)) if (long.includes(ch)) hit++;
    if (hit / new Set(short).size >= 0.85 && short.length / long.length >= 0.7) return entry;
  }
  return null;
}

export type AskRejection = { reason: 'not_yes_no' } | { reason: 'duplicate'; previous: QaEntry };

/** 提交问题前的本地闸门。返回 null 表示放行，可以去调主持人。 */
export function preCheckQuestion(g: GameState, raw: string): AskRejection | null {
  const dup = findDuplicate(g, raw);
  if (dup) return { reason: 'duplicate', previous: dup };
  if (!isYesNoQuestion(raw)) return { reason: 'not_yes_no' };
  return null;
}

// ==================== 四、抽汤 ====================

export interface SoupFilter {
  /** 允许的汤难度。空数组 = 不限。 */
  difficulties: SoupDifficulty[];
  /** 允许红汤（凶杀悬疑向）。 */
  allowRed: boolean;
  /** 允许黄汤（成人向）。 */
  allowYellow: boolean;
}

export const DEFAULT_FILTER: SoupFilter = { difficulties: [], allowRed: true, allowYellow: true };

export function filterSoups(filter: SoupFilter, playedIds: Set<string>): Soup[] {
  return SOUPS.filter(s => {
    if (playedIds.has(s.id)) return false;
    if (filter.difficulties.length > 0 && !filter.difficulties.includes(s.difficulty)) return false;
    if (!filter.allowRed && s.tags.includes(SOUP_CONTENT_TAGS.red)) return false;
    if (!filter.allowYellow && s.tags.includes(SOUP_CONTENT_TAGS.yellow)) return false;
    return true;
  });
}

/** 抽一碗没喝过的。库存耗尽返回 null，界面提示"清空记录再来"。 */
export function drawSoup(filter: SoupFilter, playedIds: Set<string>): Soup | null {
  const pool = filterSoups(filter, playedIds);
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

export const soupById = (id: string): Soup | undefined => SOUPS.find(s => s.id === id);

// ==================== 五、存档 ====================
// 键名一律 `yuzhou_` 前缀：utils/yuzhouBackup.ts 按前缀收，utils/lsMirror.ts 按前缀镜像，
// 所以这几样自动随备份走、也防得住"浏览器只清 localStorage"。新加键沿用这个前缀即可。

const keyPlayed = (charId: string) => `yuzhou_turtle_played_${charId || 'default'}`;
const keyFilter = (charId: string) => `yuzhou_turtle_filter_${charId || 'default'}`;
const keyGame = (charId: string) => `yuzhou_turtle_game_${charId || 'default'}`;
/**
 * 两套各自独立的 API 设置：**主持人一套、TA 一套**，每套都是完整的 URL / Key / Model。
 *
 * 为什么分两套而不是共用地址只换模型名：两边很可能压根不是同一家。主持人只做
 * 是非判定，挂个便宜服务商就够；TA 要有人设、要会推理，值得挂好的。真要用两家，
 * 地址和 key 当然也得各填各的。
 *
 * 两套都可以留空：留空的那一套退回 App 的主 API。所以你可以只配主持人、
 * 只配 TA、两个都配、或者两个都不配。
 *
 * 判定"配好了"的口径跟大富翁一致：baseUrl 和 model 填了就算数（key 允许为空，
 * 有些本地服务不需要）。
 */
export const KEY_HOST_API = 'yuzhou_turtle_host_api';
export const KEY_TA_API = 'yuzhou_turtle_ta_api';

export interface GameApiSetting { baseUrl: string; apiKey: string; model: string }

export const EMPTY_API: GameApiSetting = { baseUrl: '', apiKey: '', model: '' };

export function loadApiSetting(key: string): GameApiSetting {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '{}');
    return {
      baseUrl: String(v?.baseUrl || ''),
      apiKey: String(v?.apiKey || ''),
      model: String(v?.model || ''),
    };
  } catch { return { ...EMPTY_API }; }
}

export function saveApiSetting(key: string, v: GameApiSetting): void {
  try {
    localStorage.setItem(key, JSON.stringify({
      baseUrl: v.baseUrl.trim(), apiKey: v.apiKey.trim(), model: v.model.trim(),
    }));
  } catch { /* ignore */ }
}

export const apiFilled = (v: GameApiSetting) => !!(v.baseUrl.trim() && v.model.trim());

export function loadPlayed(charId: string): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(keyPlayed(charId)) || '[]');
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch { return new Set(); }
}

export function savePlayed(charId: string, ids: Set<string>): void {
  try { localStorage.setItem(keyPlayed(charId), JSON.stringify([...ids])); } catch { /* ignore */ }
}

export function loadFilter(charId: string): SoupFilter {
  try {
    const v = JSON.parse(localStorage.getItem(keyFilter(charId)) || 'null');
    if (!v || typeof v !== 'object') return { ...DEFAULT_FILTER };
    return {
      difficulties: Array.isArray(v.difficulties) ? v.difficulties : [],
      allowRed: v.allowRed !== false,
      allowYellow: v.allowYellow !== false,
    };
  } catch { return { ...DEFAULT_FILTER }; }
}

export function saveFilter(charId: string, f: SoupFilter): void {
  try { localStorage.setItem(keyFilter(charId), JSON.stringify(f)); } catch { /* ignore */ }
}

/** 断点续玩：退出 App 再进来能接着上一局。结算完就清掉。 */
export function loadGame(charId: string): GameState | null {
  try {
    const v = JSON.parse(localStorage.getItem(keyGame(charId)) || 'null');
    if (!v || typeof v !== 'object' || !v.soupId) return null;
    if (!soupById(v.soupId)) return null; // 汤库变了，旧档作废
    // chat 是后加的字段，这次改动之前存的档没有它。不补的话渲染时 .map 会炸。
    if (!Array.isArray(v.chat)) v.chat = [];
    return v as GameState;
  } catch { return null; }
}

export function saveGame(charId: string, g: GameState | null): void {
  try {
    if (!g) localStorage.removeItem(keyGame(charId));
    else localStorage.setItem(keyGame(charId), JSON.stringify(g));
  } catch { /* ignore */ }
}

export const makeChatId = () => `ct_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const makeQaId = () => `qa_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ==================== 六、汤的色系 ====================

/**
 * 这碗汤归哪一类。只影响汤面卡片的配色，不影响玩法。
 *
 * 判定有优先级：黄汤 > 红汤 > 抽象 > 日常。一碗汤可能同时挂着「红汤」和「都市」，
 * 按最重的那个走，免得同一碗汤在不同地方显示成不同颜色。
 */
export type SoupKind = 'daily' | 'red' | 'yellow' | 'abstract';

export function soupKind(soup: Soup): SoupKind {
  const tags = new Set(soup.tags);
  if (tags.has(SOUP_CONTENT_TAGS.yellow)) return 'yellow';
  if (tags.has(SOUP_CONTENT_TAGS.red)) return 'red';
  if (soup.difficulty === '抽象' || tags.has('抽象')) return 'abstract';
  return 'daily';
}

/**
 * 四套配色。整个游戏的底子是「深夜汤馆」——近黑带棕的暖色深底 + 琥珀点光，
 * 这套底色不随汤变；变的只有**汤面那张卡片**。
 *
 * 日常汤用的就是那套琥珀，所以抽到日常汤时整屏是最和谐的；
 * 另外三类各自偏一点，让你端起碗的第一眼就对这碗的调性有预期。
 */
export interface SoupPalette {
  /** 卡片背景（渐变的两端）。 */
  from: string;
  to: string;
  /** 边框和点光。 */
  accent: string;
  /** 标题文字。 */
  title: string;
  /** 正文。 */
  body: string;
  label: string;
}

export const SOUP_PALETTES: Record<SoupKind, SoupPalette> = {
  daily: {
    from: '#2a1f14', to: '#1a130d', accent: '#d9a441',
    title: '#f5dfae', body: '#e6d4b8', label: '日常',
  },
  red: {
    from: '#2a1416', to: '#170c0e', accent: '#c0555c',
    title: '#f2c9cb', body: '#ddbdbf', label: '红汤',
  },
  yellow: {
    from: '#251522', to: '#160d15', accent: '#b56aa6',
    title: '#eec6e4', body: '#d9bad3', label: '黄汤',
  },
  abstract: {
    from: '#10242a', to: '#0b171b', accent: '#4fa8ac',
    title: '#bfe5e6', body: '#a9d2d3', label: '抽象',
  },
};

export const paletteOf = (soup: Soup): SoupPalette => SOUP_PALETTES[soupKind(soup)];

/** 深夜汤馆的底色。整个游戏的外壳用它，不随汤变。 */
export const SHELL = {
  bg: '#141009',
  panel: 'rgba(255,255,255,0.04)',
  border: 'rgba(217,164,65,0.18)',
  text: '#e8dcc6',
  dim: 'rgba(232,220,198,0.45)',
  amber: '#d9a441',
} as const;

/** 主持人四个判定的颜色。这是全局唯一的强视觉——你要一眼扫出哪些方向是通的。 */
export const VERDICT_COLORS: Record<HostVerdict, { fg: string; bg: string }> = {
  '是': { fg: '#7fd4a0', bg: 'rgba(127,212,160,0.14)' },
  '否': { fg: '#e0767e', bg: 'rgba(224,118,126,0.14)' },
  '是也不是': { fg: '#e5b95c', bg: 'rgba(229,185,92,0.14)' },
  '无关': { fg: '#8b8a86', bg: 'rgba(255,255,255,0.07)' },
};

// ==================== 七、苹果币结算 [用户确认] ====================

/**
 * 这一局各得几个苹果币。
 *
 * 海龟汤是**协作**游戏——你和 TA 对着同一道谜题，不是互相赢。所以两边拿一样多，
 * 这件事本身就在表达"我们是一队的"。
 *
 * 档位基础分：
 *   完全还原 15 / 基本还原 10 / 部分还原 5 / 方向错误 2
 * 方向错误也给 2 而不是 0：海龟汤本来就经常猜不中，空手而归会让人不想开第二局。
 *
 * 难度系数：严格 ×1.5 / 正常 ×1 / 轻松 ×0.6
 * 轻松是无限提问无限提示，拿满分太容易，不该跟严格一个价。
 *
 * 没用提示 +3：硬猜出来的应该比查着答案猜出来的值钱。
 *
 * 上限是严格难度完全还原不用提示：15×1.5+3 = 25。
 */
export function calcTurtleReward(score: number, rule: RuleLevel, hintsUsed: number): {
  coins: number;
  /** 拆开给结算页显示，让你知道钱是怎么来的。 */
  breakdown: { base: number; multiplier: number; noHintBonus: number };
} {
  const base = score >= 85 ? 15 : score >= 65 ? 10 : score >= 40 ? 5 : 2;
  const multiplier = rule === 'hard' ? 1.5 : rule === 'easy' ? 0.6 : 1;
  const noHintBonus = hintsUsed === 0 ? 3 : 0;
  return {
    coins: Math.max(1, Math.round(base * multiplier) + noHintBonus),
    breakdown: { base, multiplier, noHintBonus },
  };
}
