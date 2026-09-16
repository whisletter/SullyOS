// ═══════════════════════════════════════════════════════════════════════════
// ⛔ 大富翁引擎（机制代码，不需要改）
//   逐条移植自原版 monopoly_play.py（Game 类 + CLI 懒结算）。
//   所有状态只由 runCommand 改动；打印出来的 engine 行就是唯一真值。
//   App 版的差异只有：两个玩家固定叫 user / ta；飞鸟停局；开局锁定确认；
//   跨局去重和拉黑名单存在本机（按角色分开）。
// ═══════════════════════════════════════════════════════════════════════════

import {
  BACKDOOR_KINK, BOARD_DENSE, BOARD_NORMAL, CONTENT_VERSION, DENSE_BOARD_MAX_ROUNDS, DUEL_HINT, FINAL_ORDER_HINT,
  FUNCTION_CARDS, GAME_NUMBERS as N, IDENTITY_CARDS, INTENSITY_NOTES, INTENSITY_RANGES, LEVEL_NAMES, LEVEL_STEPS,
  LIBRARY, MARK_PARTS, MYSTERY_BAD, MYSTERY_GOOD, RED_LINE_DEFAULT_ON, RED_LINE_LABELS, REDLINE_CONTENT, TIE_HINT,
  TRUTHS, DEALER_NAME, SUPER_CAN_EXCEED_RANGE,
} from './content';
import type {
  BackdoorMode, CellKind, FirstMove, IdentityCard, IdentityEffect, IdentityMode, Intensity, LibTask, LibTruth,
  MonopolySettings, Profiles, Role, Who,
} from './types';

// ═══ 一、设置 ═══════════════════════════════════════════════════════════════

export const RED_LINE_COUNT = 13;
export const INTENSITIES: readonly Intensity[] = ['light', 'medium', 'heavy'];
export const BACKDOOR_MODES: readonly BackdoorMode[] = ['off', 'open', 'giveOnly'];
export const IDENTITY_MODES: readonly IdentityMode[] = ['off', 'mixed', 'nsfw_only'];
export const FIRST_MOVES: readonly FirstMove[] = ['default', 'user', 'ta'];
export const ROLES: readonly Role[] = ['攻', '受'];
export const REVERSALS = [0, 0.3, 0.5, 1] as const;
export const ROUND_OPTIONS = [12, 18, 24] as const;
export const LEVEL_MARKS = ['①', '②', '③', '④', '⑤', '⑥'];
export const BACKDOOR_LABEL: Record<BackdoorMode, string> = { off: '关', open: '开门', giveOnly: '禁门' };
export const WHO: readonly Who[] = ['user', 'ta'];

const SETTINGS_KEY = `yuzhou_monopoly_settings_v${CONTENT_VERSION}`;
const clip2 = (s: string) => Array.from((s || '').trim()).slice(0, 2).join('').trim();
export const RED_LINES: string[] = Array.from({ length: RED_LINE_COUNT }, (_, i) => clip2(RED_LINE_LABELS[i] ?? ''));
export const other = (w: Who): Who => (w === 'user' ? 'ta' : 'user');
export const pad2 = (n: number) => String(n).padStart(2, '0');

export function parseRange(r: string): [number, number] | null {
  const m = /^([1-6])-([1-6])$/.exec((r || '').trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a <= b ? [a, b] : null;
}

export const DEFAULT_SETTINGS: MonopolySettings = {
  intensity: 'medium',
  roles: { user: '受', ta: '攻' },
  pureTop: { user: false, ta: false },
  backdoor: { user: 'off', ta: 'off' },
  redLineActive: RED_LINES.map((l, i) => !!l && !!RED_LINE_DEFAULT_ON[i]),
  reversal: 0.3,
  rounds: 24,
  identityMode: 'mixed',
  firstMove: 'default',
};

const pickOne = <T,>(v: unknown, allowed: readonly T[], fb: T): T => (allowed.includes(v as T) ? (v as T) : fb);

export function loadSettings(): MonopolySettings {
  const d = DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return d;
    const p = JSON.parse(raw) || {};
    const lines = Array.isArray(p.redLineActive) && p.redLineActive.length === RED_LINE_COUNT ? p.redLineActive : null;
    return {
      intensity: pickOne(p.intensity, INTENSITIES, d.intensity),
      roles: { user: pickOne(p.roles?.user, ROLES, d.roles.user), ta: pickOne(p.roles?.ta, ROLES, d.roles.ta) },
      pureTop: { user: !!p.pureTop?.user, ta: !!p.pureTop?.ta },
      backdoor: { user: pickOne(p.backdoor?.user, BACKDOOR_MODES, d.backdoor.user), ta: pickOne(p.backdoor?.ta, BACKDOOR_MODES, d.backdoor.ta) },
      redLineActive: lines ? lines.map((v: unknown, i: number) => !!v && !!RED_LINES[i]) : d.redLineActive,
      reversal: pickOne(p.reversal, REVERSALS, d.reversal),
      rounds: pickOne(p.rounds, ROUND_OPTIONS, d.rounds),
      identityMode: pickOne(p.identityMode, IDENTITY_MODES, d.identityMode),
      firstMove: pickOne(p.firstMove, FIRST_MOVES, d.firstMove),
    };
  } catch { return d; }
}

export function saveSettings(s: MonopolySettings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export const activeRedLines = (s: MonopolySettings) => RED_LINES.filter((l, i) => l && s.redLineActive[i]);

// 开局指令预览（写法对齐原版 CLI 的 new）
export function buildOpeningCommand(s: MonopolySettings, profiles: Pick<Profiles, 'names' | 'sexes'>): string {
  const n = profiles.names;
  const p = (w: Who) => `"${n[w]}:${profiles.sexes[w] ?? '?'}:${s.roles[w]}"`;
  const parts = ['new', p('user'), p('ta'), s.intensity, String(s.reversal), String(s.rounds)];
  const lines = activeRedLines(s);
  if (lines.length) parts.push(lines.join(','));
  const open = WHO.filter(w => s.backdoor[w] === 'open').map(w => n[w]);
  if (open.length) parts.push(`开肛=${open.join(',')}`);
  const give = WHO.filter(w => s.backdoor[w] === 'giveOnly').map(w => n[w]);
  if (give.length) parts.push(`禁肛=${give.join(',')}`);
  const tops = WHO.filter(w => s.pureTop[w]).map(w => n[w]);
  if (tops.length) parts.push(`纯top=${tops.join(',')}`);
  parts.push(`身份=${s.identityMode}`);
  if (s.firstMove !== 'default') parts.push(`先手=${n[s.firstMove]}`);
  return parts.join(' ');
}

export function intensityNote(s: MonopolySettings): string {
  const r = parseRange(INTENSITY_RANGES[s.intensity]) ?? [1, 6];
  const steps = Array.from({ length: r[1] - r[0] + 1 }, (_, i) => `${r[0] + i}:${LEVEL_STEPS[r[0] + i - 1]}`).join(' → ');
  return `${s.intensity}=强度 ${r[0]}-${r[1]}：${steps}。${INTENSITY_NOTES[s.intensity]}前 2 回合有热身、从低段起步逐步升温。想更轻/更狠可换档。`;
}

// ═══ 二、内容检查（只查结构） ═══════════════════════════════════════════════

const CELL_KINDS: readonly CellKind[] = ['start', 'task', 'truth', 'chance', 'mystery', 'jail', 'shop'];
const KNOWN_EFFECTS = new Set([
  'modify_reward', 'strength_bonus', 'kink_coin', 'type_bonus', 'reverse_bonus', 'target_bonus', 'serve_bonus', 'kink_bonus',
  'modify_intensity', 'modify_cost', 'immunity', 'task_reroll', 'gamble_guess', 'id_event_reward', 'id_event_penalty',
  'toll_plus', 'toll_free', 'toll_serve_only', 'end_transfer', 'mystery_luck', 'lap_bonus', 'sleep_beauty', 'extra_task',
  'truth_witness', 'declare_persona', 'mark_holder',
]);

function checkContent(): string[] {
  const issues: string[] = [];
  INTENSITIES.forEach(k => { if (!parseRange(INTENSITY_RANGES[k])) issues.push(`INTENSITY_RANGES.${k} 应写成「起-止」，1-6 之间且起≤止`); });
  if (RED_LINE_LABELS.length !== RED_LINE_COUNT) issues.push(`RED_LINE_LABELS 应为 13 项，当前 ${RED_LINE_LABELS.length}`);
  if (RED_LINE_DEFAULT_ON.length !== RED_LINE_COUNT) issues.push('RED_LINE_DEFAULT_ON 应为 13 项');
  const kinks = new Set(LIBRARY.flatMap(t => t.kink || []));
  RED_LINE_LABELS.forEach((raw, i) => {
    const t = (raw || '').trim();
    if (t && LIBRARY.length && !kinks.has(t) && !REDLINE_CONTENT[t]) issues.push(`红线第 ${i + 1} 项「${t}」在任务库 kink 里一张都没有`);
  });
  if (!LIBRARY.length) issues.push('任务库是空的：检查 data/monopoly-library_v2.json');
  if (!TRUTHS.length) issues.push('真心话库是空的：检查 data/monopoly-truths.json');
  if (!IDENTITY_CARDS.length) issues.push('身份卡库是空的：检查 data/monopoly-identities.json');
  LIBRARY.forEach((t, i) => {
    if (!(t.强度 >= 1 && t.强度 <= 6) || typeof t.内容 !== 'string' || !Array.isArray(t.kink)) issues.push(`任务库第 ${i + 1} 条缺字段（强度 / 内容 / kink）`);
  });
  TRUTHS.forEach((t, i) => { if (!(t.强度 >= 1 && t.强度 <= 6) || typeof t.内容 !== 'string') issues.push(`真心话第 ${i + 1} 条缺字段`); });
  IDENTITY_CARDS.forEach((c, i) => {
    if (!c.name || !Array.isArray(c.effects)) issues.push(`身份卡第 ${i + 1} 张缺 name / effects`);
    (c.effects || []).forEach(e => { if (!KNOWN_EFFECTS.has(e.type)) issues.push(`身份卡第 ${i + 1} 张的效果类型「${e.type}」引擎不认识，不会生效`); });
  });
  [BOARD_NORMAL, BOARD_DENSE].forEach((b, bi) => {
    if (b.length !== 20 || b[0] !== 'start' || b.some(k => !CELL_KINDS.includes(k))) issues.push(`棋盘 ${bi ? 'BOARD_DENSE' : 'BOARD_NORMAL'} 应为 20 格、00 是 start`);
  });
  if (!MARK_PARTS.length || MARK_PARTS.some(p => /\s/.test(p))) issues.push('MARK_PARTS 不能为空或带空格');
  if (!DEALER_NAME.trim() || DEALER_NAME.trim().toLowerCase() === 'ta') issues.push('DEALER_NAME 不能为空，也不要叫 TA');
  if (issues.length) console.warn('[Monopoly] 内容检查：\n' + issues.join('\n'));
  return issues;
}
export const CONTENT_ISSUES = checkContent();

// ═══ 三、状态 ═══════════════════════════════════════════════════════════════

export const BOARD_SIZE = 20;
export const CELL_ICON: Record<CellKind, string> = { start: '🏁', task: '🎯', truth: '💬', shop: '🛒', chance: '🎴', mystery: '❓', jail: '🔒' };
export const CELL_NAME: Record<CellKind, string> = { start: '起点', task: '任务', truth: '真心话', shop: '商店', chance: '抽卡', mystery: '未知格', jail: '监狱' };
export const LEVEL_NAME = (lv: number) => LEVEL_NAMES[lv - 1] ?? '';

// 卡库条目的稳定 key（跨局去重 / 拉黑用；换库后不会错位）
function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + s.length.toString(36);
}
const LIB_KEYS = LIBRARY.map(t => hashText(t.内容 || ''));
const TRUTH_KEYS = TRUTHS.map(t => hashText(t.内容 || ''));

export interface PendingTask {
  pool: 'task' | 'truth';
  idx: number;
  super: boolean;
  tile: number;
  cardId: number;
}
export type CardKind = 'task' | 'truth' | 'super' | 'shame' | 'extra' | 'toll' | 'jail' | 'sleep' | 'duel' | 'expose';
export interface TaskCard {
  id: number;
  kind: CardKind;
  owner: Who;        // 这道题挂在谁身上（做 / 答 / 被处置 / 踩进地盘的人）
  actor: Who;        // 行动方
  level: number;
  type: string;      // 玩法类型
  kink: string;
  dir: string;
  label: string;
  text: string;
  note: string;      // 奖励 / 规则说明
  pool: 'task' | 'truth';
  idx: number;       // 卡库下标
}
export interface LastSettle { pend: PendingTask; coin: number; witness: number; tileClaimed: number | null; prevOwner: Who | null; turnCount: number }
export interface PlayerState {
  pos: number;
  coins: number;
  lap: number;
  hand: number[];
  pendingCards: number[];
  identity: number | null;
  identitySince: number;
  identityRerolled: boolean;
  taskRerolled: number;
  swapUsed: number;
  swapNopay: boolean;
  extraUsed: number;
  jailed: number;
  jailImmune: number;
  doubleNext: boolean;
  persona: string;
  markSpot: string | null;
  markFound: boolean;
  markGuessed: boolean;
  guessNext: '大' | '小' | null;
  swapIdentityNext: boolean;
  lastSettle: LastSettle | null;
}
export type LogKind = 'cmd' | 'engine' | 'error';
export interface LogLine { id: number; kind: LogKind; text: string; by?: Who }
export type GamePhase = 'lobby' | 'lock' | 'playing' | 'stopped' | 'over';

export interface GameState {
  version: number;
  phase: GamePhase;
  resumePhase: GamePhase;
  settings: MonopolySettings;
  profiles: Profiles;
  board: CellKind[];
  totalRounds: number;
  turnCount: number;
  turn: Who;
  lastMover: Who | null;
  lastRoll: number | null;
  players: Record<Who, PlayerState>;
  owners: (Who | null)[];
  pending: Record<Who, PendingTask | null>;
  pendingToll: { who: Who; landlord: Who; fee: number; serveOnly: boolean } | null;
  lastTollPaid: { who: Who; landlord: Who; fee: number } | null;
  pendingDuel: boolean;
  cards: TaskCard[];
  cardSeq: number;
  history: string[];
  recentTypes: string[];
  recentKinks: string[];
  recentStrengths: number[];
  revAcc: number;
  chanceSwapOffer: Who | null;
  idAvoid: string[];
  idEventsUsed: string[];
  blocklist: string[];
  recency: Record<string, number>;
  finalSettled: boolean;
  finalText: string;
  stoppedBy: Who | null;
  lockLine: string;
  log: LogLine[];
  seq: number;
}

class CommandError extends Error {}
const rand = (n: number) => Math.floor(Math.random() * n);
const choice = <T,>(arr: readonly T[]): T => arr[rand(arr.length)];

function newPlayer(): PlayerState {
  return {
    pos: 0, coins: N.startCoins, lap: 0, hand: [], pendingCards: [], identity: null, identitySince: 0, identityRerolled: false,
    taskRerolled: 0, swapUsed: 0, swapNopay: false, extraUsed: 0, jailed: 0, jailImmune: 0, doubleNext: false, persona: '',
    markSpot: null, markFound: false, markGuessed: false, guessNext: null, swapIdentityNext: false, lastSettle: null,
  };
}

export const identityOf = (g: GameState, w: Who): IdentityCard | null => {
  const i = g.players[w].identity;
  return i === null ? null : IDENTITY_CARDS[i] ?? null;
};
const effects = (g: GameState, w: Who): IdentityEffect[] => identityOf(g, w)?.effects || [];
// 原版 _id_effect_val：取第一条同类型钩子的 value（没有 value 视为 true）
function effVal<T>(g: GameState, w: Who, type: string, dflt: T): number | boolean | T {
  const e = effects(g, w).find(x => x.type === type);
  if (!e) return dflt;
  return e.value === undefined ? true : e.value;
}
const effNum = (g: GameState, w: Who, type: string, dflt = 0) => Number(effVal(g, w, type, dflt)) || 0;
export const hasEffect = (g: GameState, w: Who, type: string) => effects(g, w).some(e => e.type === type);

const redline = (g: GameState) => activeRedLines(g.settings);
const receiveAnal = (g: GameState, w: Who) => g.settings.backdoor[w] === 'open';
const receivePen = (g: GameState, w: Who) => !g.settings.pureTop[w];
const rangeOf = (g: GameState) => parseRange(INTENSITY_RANGES[g.settings.intensity]) ?? [1, 6];

// ─── 跨局记忆（本机，按角色） ───
const seenKey = (charId: string) => `yuzhou_monopoly_seen_v${CONTENT_VERSION}_${charId || 'default'}`;
export function loadSeen(charId: string): { recency: string[]; blocklist: string[]; identities: string[] } {
  try {
    const v = JSON.parse(localStorage.getItem(seenKey(charId)) || '{}');
    return { recency: Array.isArray(v.recency) ? v.recency : [], blocklist: Array.isArray(v.blocklist) ? v.blocklist : [], identities: Array.isArray(v.identities) ? v.identities : [] };
  } catch { return { recency: [], blocklist: [], identities: [] }; }
}
export function saveSeen(charId: string, g: GameState) {
  try {
    const old = loadSeen(charId);
    const merged = [...old.recency.filter(k => !g.history.includes(k)), ...g.history];
    const ids = WHO.map(w => identityOf(g, w)?.name).filter(Boolean) as string[];
    const identities = [...old.identities.filter(x => !ids.includes(x)), ...ids].slice(-6);
    localStorage.setItem(seenKey(charId), JSON.stringify({ recency: merged, blocklist: Array.from(new Set([...old.blocklist, ...g.blocklist])), identities }));
  } catch { /* ignore */ }
}
export function clearSeen(charId: string) { try { localStorage.removeItem(seenKey(charId)); } catch { /* ignore */ } }

export function createLobby(settings: MonopolySettings, profiles: Profiles): GameState {
  const rounds = settings.rounds;
  return {
    version: CONTENT_VERSION, phase: 'lobby', resumePhase: 'playing', settings, profiles,
    board: rounds <= DENSE_BOARD_MAX_ROUNDS ? BOARD_DENSE : BOARD_NORMAL, totalRounds: rounds, turnCount: 0,
    turn: 'user', lastMover: null, lastRoll: null, players: { user: newPlayer(), ta: newPlayer() },
    owners: Array(BOARD_SIZE).fill(null), pending: { user: null, ta: null }, pendingToll: null, lastTollPaid: null,
    pendingDuel: false, cards: [], cardSeq: 0, history: [], recentTypes: [], recentKinks: [], recentStrengths: [], revAcc: Math.random(),
    chanceSwapOffer: null, idAvoid: [], idEventsUsed: [], blocklist: [], recency: {}, finalSettled: false, finalText: '',
    stoppedBy: null, lockLine: '', log: [], seq: 0,
  };
}

type Out = (kind: LogKind, text: string) => void;

// ═══ 四、身份 ═══════════════════════════════════════════════════════════════

function identityPool(g: GameState): number[] {
  const all = IDENTITY_CARDS.map((_, i) => i);
  if (g.settings.identityMode === 'off') return [];
  if (g.settings.identityMode === 'nsfw_only') {
    const pool = all.filter(i => IDENTITY_CARDS[i].nsfw);
    return pool.length ? pool : all;
  }
  return all;
}

function identityDeadByRedline(g: GameState, card: IdentityCard) {
  const rl = redline(g);
  return (card.effects || []).some(e => (e.type === 'kink_coin' || e.type === 'kink_bonus') && rl.includes(String(e.kink)));
}

function assignIdentity(g: GameState, who: Who) {
  const p = g.players[who];
  let pool = identityPool(g);
  if (!pool.length) { p.identity = null; return; }
  const alive = pool.filter(i => !identityDeadByRedline(g, IDENTITY_CARDS[i]));
  if (alive.length) pool = alive;
  const takenBy = identityOf(g, other(who))?.name;
  let fresh = pool.filter(i => !g.idAvoid.includes(IDENTITY_CARDS[i].name) && IDENTITY_CARDS[i].name !== takenBy);
  if (!fresh.length) fresh = pool.filter(i => IDENTITY_CARDS[i].name !== takenBy);
  if (!fresh.length) fresh = pool;
  p.identity = choice(fresh);
  const holder = hasEffect(g, who, 'mark_holder');
  if (holder && !p.markSpot) { p.markSpot = choice(MARK_PARTS); p.markFound = false; }
  else if (!holder && p.markSpot) { p.markSpot = null; p.markFound = false; }
  p.identitySince = g.turnCount;
}

function identityReminder(g: GameState): string {
  const n = g.profiles.names;
  return WHO.map(w => {
    const c = identityOf(g, w);
    if (!c) return '';
    let tag = c.hint || c.name;
    const p = g.players[w];
    if (p.persona) tag += `·背德身份【${p.persona}】`;
    if (p.markSpot && !p.markFound) tag += `·🌀淫纹藏在下列某处等对方猜：${MARK_PARTS.join('/')}`;
    return `${n[w]}=${tag}`;
  }).filter(Boolean).join(' ｜ ');
}

// ═══ 五、抽题 ═══════════════════════════════════════════════════════════════

function windowOf(g: GameState, mod = 0): [number, number] {
  const [floor, ceil] = rangeOf(g);
  const tr = g.totalRounds;
  const prog = Math.min(1, g.turnCount / tr);
  const span = ceil - floor;
  let lo = floor + Math.floor(prog * Math.max(0, span - 1) + 0.5);
  if (g.turnCount > Math.floor((tr * 3) / 4)) lo = ceil;
  lo = Math.max(floor, lo + mod);
  let hi = lo + 2;
  let cap = ceil;
  if (g.turnCount <= Math.floor(tr / 2)) cap = Math.min(cap, ceil - 1);
  if (g.turnCount <= 2) cap = Math.min(cap, floor + 1);
  lo = Math.min(lo, cap);
  hi = Math.min(hi, cap);
  hi = Math.max(hi, lo);
  return [lo, hi];
}
const intensityMod = (g: GameState, w: Who) => effects(g, w).filter(e => e.type === 'modify_intensity').reduce((s, e) => s + (Number(e.value) || 0), 0);
const needOk = (need: string, sex: string | null) => need === '任意' || need === sex;
const servable = (t: LibTask, landerSex: string | null, partnerSex: string | null) =>
  needOk(t.行动方需 ?? '任意', landerSex) && needOk(t.对方需 ?? '任意', partnerSex);

function contentOk(g: GameState, content: string) {
  return !redline(g).some(tag => REDLINE_CONTENT[tag]?.test(content || ''));
}

const NEUTRAL_HOLE = /(?<![花蜜小阴])穴|菊/;
// 性别未识别时，按「可能是男」处理（偏安全）
const maybeMale = (g: GameState, w: Who) => g.profiles.sexes[w] !== '女';

function analOk(g: GameState, t: LibTask, who: Who): boolean {
  const opp = other(who);
  let recv = t.穴承受方 || t.后庭承受方 || null;
  if (t.target === '彼此') recv = '双方';
  const explicit = (t.kink || []).includes(BACKDOOR_KINK);
  let receivers: Who[] | null;
  if (recv === '行动方' || recv === '自己') receivers = [who];
  else if (recv === '对方') receivers = [opp];
  else if (recv === '双方') receivers = [who, opp];
  else if (recv === '无' && !explicit) receivers = [];
  else if (explicit) receivers = t.target === '彼此' ? [who, opp] : t.target === '自己' ? [who] : [opp];
  else receivers = null;
  const ride = new Set<Who>();
  (t.骨架 || []).forEach(seg => {
    if (seg.动作 === '骑乘' && ['鸡巴', '龟头', '假鸡巴'].includes(seg.受动部位 || '')) {
      const rider = seg.受动方 === '行动方' ? opp : seg.受动方 === '对方' ? who : null;
      if (rider) ride.add(rider);
    }
  });
  if (ride.size) receivers = receivers === null ? Array.from(ride) : Array.from(new Set([...receivers, ...ride]));
  if (receivers !== null) {
    return receivers.every(r => !((explicit || maybeMale(g, r)) && !receiveAnal(g, r)));
  }
  if (WHO.some(p => maybeMale(g, p) && !receiveAnal(g, p)) && NEUTRAL_HOLE.test(t.内容 || '')) return false;
  return true;
}

function penOk(g: GameState, t: LibTask, who: Who): boolean {
  if (receivePen(g, 'user') && receivePen(g, 'ta')) return true;
  const opp = other(who);
  let recv = t.穴承受方 || t.后庭承受方 || null;
  if (t.target === '彼此') recv = '双方';
  const receivers = new Set<Who>();
  if (recv === '行动方' || recv === '自己') receivers.add(who);
  else if (recv === '对方') receivers.add(opp);
  else if (recv === '双方') { receivers.add(who); receivers.add(opp); }
  const m: Record<string, Who> = { 行动方: who, 对方: opp };
  (t.骨架 || []).forEach(seg => {
    const act = seg.动作 || '';
    const part = seg.受动部位 || '';
    if (['插入', '手', '舔', '揉捏', '摸', '口', '骑乘'].includes(act) && ['穴', '后穴', '阴道'].includes(part)) {
      const r = m[seg.受动方 || ''];
      if (r) receivers.add(r);
    }
    if (act === '骑乘' && ['鸡巴', '龟头', '假鸡巴'].includes(part)) {
      const rider = seg.受动方 === '行动方' ? opp : seg.受动方 === '对方' ? who : null;
      if (rider) receivers.add(rider);
    }
  });
  if ((t.kink || []).includes(BACKDOOR_KINK) && !receivers.size) {
    (t.target === '彼此' ? [who, opp] : t.target === '自己' ? [who] : [opp]).forEach(x => receivers.add(x));
  }
  return Array.from(receivers).every(r => receivePen(g, r));
}

const recencyRank = (g: GameState, key: string) => (key in g.recency ? g.recency[key] : -1);
function lruTier<T>(g: GameState, cands: T[], keyOf: (x: T) => string): T[] {
  if (!cands.length) return cands;
  const best = Math.min(...cands.map(c => recencyRank(g, keyOf(c))));
  return cands.filter(c => recencyRank(g, keyOf(c)) === best);
}

interface DrawOpts { override?: [number, number]; forceDesired?: Role; requireTarget?: string; applyMod?: boolean }

function drawTask(g: GameState, who: Who, opts: DrawOpts = {}): number | null {
  let lo: number;
  let hi: number;
  if (opts.override) [lo, hi] = opts.override;
  else [lo, hi] = windowOf(g, opts.applyMod === false ? 0 : intensityMod(g, who));
  const loUnjam = lo;
  const rs = g.recentStrengths;
  if (!opts.override && rs.length >= 3 && new Set(rs.slice(-3)).size === 1) {
    const jam = rs[rs.length - 1];
    if (lo <= jam && jam < hi) lo = jam + 1;
  }
  const sx = g.profiles.sexes;
  const rl = redline(g);
  const base = (i: number, ignoreBlock = false) => {
    const t = LIBRARY[i];
    return lo <= t.强度 && t.强度 <= hi && t.玩法类型 !== '互相' && servable(t, sx[who], sx[other(who)])
      && !(t.kink || []).some(k => rl.includes(k)) && contentOk(g, t.内容) && analOk(g, t, who) && penOk(g, t, who)
      && (ignoreBlock || !g.blocklist.includes(LIB_KEYS[i])) && (opts.requireTarget === undefined || t.target === opts.requireTarget);
  };
  const all = LIBRARY.map((_, i) => i);
  let pool = all.filter(i => base(i));
  if (!pool.length && lo !== loUnjam) { lo = loUnjam; pool = all.filter(i => base(i)); }
  if (!pool.length && g.blocklist.length) pool = all.filter(i => base(i, true));
  if (!pool.length) return null;

  const landerRole = g.settings.roles[who];
  const otherRole: Role = landerRole === '攻' ? '受' : '攻';
  let wantReverse = false;
  let desired: Role;
  if (opts.forceDesired) desired = opts.forceDesired;
  else {
    g.revAcc += g.settings.reversal;
    wantReverse = g.revAcc >= 1;
    desired = wantReverse ? otherRole : landerRole;
  }
  const rk = new Set(g.recentKinks);
  const kinkOk = (i: number) => { const ks = LIBRARY[i].kink || []; return !ks.length || !ks.some(k => rk.has(k)); };
  const climax = !opts.override && g.turnCount > Math.floor((g.totalRounds * 3) / 4);
  const isIns = (i: number) => (LIBRARY[i].骨架 || []).some(s => s.动作 === '插入');
  const pick = (group: number[]): number | null => {
    const noh = group.filter(i => !g.history.includes(LIB_KEYS[i]));
    const fresh = lruTier(g, noh.length ? noh : group, i => LIB_KEYS[i]);
    const a = fresh.filter(i => !g.recentTypes.includes(LIBRARY[i].玩法类型));
    const a0 = a.filter(kinkOk);
    const bk = fresh.filter(kinkOk);
    let gg = a0.length ? a0 : bk.length ? bk : a.length ? a : fresh;
    if (climax) { const gi = gg.filter(isIns); if (gi.length) gg = gi; }
    return gg.length ? choice(gg) : null;
  };
  let t = pick(pool.filter(i => LIBRARY[i].flavor === desired || LIBRARY[i].flavor === '任意'));
  if (t === null) t = pick(pool);
  if (t === null) return null;
  if (wantReverse && LIBRARY[t].flavor === otherRole) g.revAcc -= 1;
  const card = LIBRARY[t];
  g.history.push(LIB_KEYS[t]);
  g.recentTypes = [card.玩法类型, ...g.recentTypes].slice(0, 2);
  g.recentKinks = [...(card.kink || []), ...g.recentKinks].slice(0, 4);
  g.recentStrengths = [...g.recentStrengths, card.强度].slice(-3);
  return t;
}

function drawTruth(g: GameState): number | null {
  if (!TRUTHS.length) return null;
  const [lo, hi] = windowOf(g);
  const all = TRUTHS.map((_, i) => i);
  const byRl = all.filter(i => contentOk(g, TRUTHS[i].内容));
  const safe0 = byRl.filter(i => !g.blocklist.includes(TRUTH_KEYS[i]));
  const safe = safe0.length ? safe0 : byRl;
  const [floor, ceil] = rangeOf(g);
  const inWin = safe.filter(i => lo <= TRUTHS[i].强度 && TRUTHS[i].强度 <= hi);
  const inRange = safe.filter(i => floor <= TRUTHS[i].强度 && TRUTHS[i].强度 <= ceil);
  const cands = inWin.length ? inWin : inRange.length ? inRange : safe;
  if (!cands.length) return null;
  const noh0 = cands.filter(i => !g.history.includes(TRUTH_KEYS[i]));
  const noh = noh0.length ? noh0 : cands;
  const pick = choice(lruTier(g, noh, i => TRUTH_KEYS[i]));
  g.history.push(TRUTH_KEYS[pick]);
  g.recentStrengths = [...g.recentStrengths, TRUTHS[pick].强度].slice(-3);
  return pick;
}

function drawDuel(g: GameState, who: Who): number | null {
  const [lo, hi] = windowOf(g);
  const sx = g.profiles.sexes;
  const rl = redline(g);
  const ok = (i: number, ignoreBlock = false) => {
    const t = LIBRARY[i];
    return t.玩法类型 === '互相' && !(t.kink || []).some(k => rl.includes(k)) && contentOk(g, t.内容)
      && servable(t, sx[who], sx[other(who)]) && analOk(g, t, who) && penOk(g, t, who)
      && (ignoreBlock || !g.blocklist.includes(LIB_KEYS[i]));
  };
  const all = LIBRARY.map((_, i) => i);
  // 原版窗口里没货会回落到任意强度；App 版只回落到本局强度区间内（不越过开局说好的档）
  const [floor, ceil] = rangeOf(g);
  const inRange = (i: number) => floor <= LIBRARY[i].强度 && LIBRARY[i].强度 <= ceil;
  let cands = all.filter(i => ok(i) && lo <= LIBRARY[i].强度 && LIBRARY[i].强度 <= hi);
  if (!cands.length) cands = all.filter(i => ok(i) && inRange(i));
  if (!cands.length) cands = all.filter(i => ok(i, true) && inRange(i));
  if (!cands.length) return null;
  const noh0 = cands.filter(i => !g.history.includes(LIB_KEYS[i]));
  const t = choice(lruTier(g, noh0.length ? noh0 : cands, i => LIB_KEYS[i]));
  g.history.push(LIB_KEYS[t]);
  g.recentStrengths = [...g.recentStrengths, LIBRARY[t].强度].slice(-3);
  return t;
}

// ═══ 六、渲染 ═══════════════════════════════════════════════════════════════

export function renderText(g: GameState, raw: string, actor: Who): string {
  const a = g.profiles.names[actor];
  const b = g.profiles.names[other(actor)];
  return (raw || '').split('行动方').map(part => part.split('对方').join(b)).join(a);
}

const isReversed = (g: GameState, t: LibTask, who: Who) => t.flavor !== '任意' && t.flavor !== g.settings.roles[who];

function makeCard(g: GameState, kind: CardKind, owner: Who, idx: number, actor: Who, mechanic: string | null, note: string): TaskCard {
  const n = g.profiles.names;
  const t = LIBRARY[idx];
  const partner = other(actor);
  let label: string;
  if (mechanic) label = mechanic;
  else if (isReversed(g, t, actor)) label = '🔄反转·' + (t.flavor === '攻' ? '变强势主导' : '被服务/服从');
  else label = ({ 攻: '攻主动·dom', 受: '受主动·sub', 任意: '中性·任意' } as Record<string, string>)[t.flavor] ?? t.flavor;
  let text: string;
  if (t.resolve === 'dice_vs') {
    let d1 = 0; let d2 = 0;
    while (d1 === d2) { d1 = 1 + rand(6); d2 = 1 + rand(6); }
    const win = d1 > d2;
    text = `🎲${n[actor]}掷${d1}·${n[partner]}掷${d2} → ${n[win ? actor : partner]}赢！　` + renderText(g, win ? t.内容 : (t.内容_输 || t.内容), actor);
  } else {
    text = renderText(g, t.内容, actor);
  }
  return {
    id: 0, kind, owner, actor, level: t.强度, type: t.玩法类型 || '', kink: (t.kink || []).join('/') || '-',
    dir: t.target === '彼此' ? `${n[actor]}↔${n[partner]}` : `${n[actor]}→${t.target === '自己' ? '自己' : n[partner]}`,
    label, text, note, pool: 'task', idx,
  };
}

function truthCard(g: GameState, kind: 'truth' | 'expose', who: Who, idx: number, note: string): TaskCard {
  const n = g.profiles.names;
  const t = TRUTHS[idx];
  return { id: 0, kind, owner: who, actor: who, level: t.强度, type: '真心话', kink: '-', dir: `${n[who]} 答`, label: kind === 'expose' ? '🎭暴露' : '💬真心话', text: renderText(g, t.内容, who), note, pool: 'truth', idx };
}

function pushCard(g: GameState, out: Out, c: TaskCard): TaskCard {
  g.cardSeq += 1;
  c.id = g.cardSeq;
  g.cards.push(c);
  const n = g.profiles.names;
  const lv = `${c.level} ${LEVEL_NAME(c.level)}`;
  out('engine', `📋 〔${lv}｜${c.type}｜${c.label}｜${c.dir}〕\n${c.text}${c.note ? `\n→ ${c.note}` : ''}\n（这道记在 ${n[c.owner]} 头上）`);
  return c;
}
const removeCard = (g: GameState, id: number) => { g.cards = g.cards.filter(c => c.id !== id); };

export function boardArt(g: GameState): string {
  const n = g.profiles.names;
  const line = g.board.map((k, i) => `［${g.players.user.pos === i ? '🙋' : ''}${g.players.ta.pos === i ? '💞' : ''}${CELL_ICON[k]}］`).join('');
  const handOf = (w: Who) => g.players[w].hand.map(ci => FUNCTION_CARDS[ci]?.name ?? '?').join(',') || '空';
  const row = (w: Who, icon: string) => {
    const p = g.players[w];
    return `${icon}${n[w]}@${p.pos}(第${p.lap + 1}圈) · 💰${p.coins} · 🃏［${handOf(w)}］ · 身份:${identityOf(g, w)?.name ?? '无'}`;
  };
  const plots = g.owners.map((o, i) => (o ? `第${i}格(${n[o]})` : '')).filter(Boolean).join('、') || '无';
  return `${line}　〔回合 ${g.turnCount}/${g.totalRounds}〕\n${row('user', '🙋')}\n${row('ta', '💞')}\n🚩地盘：${plots}`;
}

export function safetySummary(g: GameState): string {
  const n = g.profiles.names;
  const parts: string[] = [];
  const rl = redline(g);
  if (rl.length) parts.push('🚫红线不出：' + rl.join('/'));
  const on = WHO.filter(w => receiveAnal(g, w));
  parts.push(!on.length ? '后庭：两人都关（默认）' : on.length === 2 ? '后庭：两人都开' : `后庭：只 ${n[on[0]]} 开（另一人不被做）`);
  const tops = WHO.filter(w => !receivePen(g, w));
  if (tops.length) parts.push('纯top（只插别人不被插）：' + tops.map(w => n[w]).join('/'));
  return parts.join(' ｜ ');
}

// ═══ 七、结算与动作（对应原版方法） ══════════════════════════════════════════

const taskCoin = (lv: number, isSuper: boolean) => (isSuper ? N.coinSuper : lv <= 2 ? N.coinLight : lv <= 4 ? N.coinMedium : N.coinHeavy);

function identityTaskBonus(g: GameState, who: Who, pend: PendingTask): number {
  if (pend.pool !== 'task') {
    const lv = TRUTHS[pend.idx]?.强度 ?? 1;
    return effects(g, who).reduce((s, e) => s + (e.type === 'modify_reward' || (e.type === 'strength_bonus' && lv >= (Number(e.min) || 4)) ? Number(e.value) || 0 : 0), 0);
  }
  const t = LIBRARY[pend.idx];
  const kinks = t.kink || [];
  const rev = isReversed(g, t, who);
  let bonus = 0;
  effects(g, who).forEach(e => {
    const v = Number(e.value) || 0;
    if (e.type === 'modify_reward') bonus += v;
    else if (e.type === 'strength_bonus' && t.强度 >= (Number(e.min) || 4)) bonus += v;
    else if (e.type === 'kink_coin' && kinks.includes(String(e.kink))) bonus += v;
    else if (e.type === 'type_bonus' && t.玩法类型 === e['玩法类型'] && (e.target === undefined || e.target === null || e.target === t.target)) bonus += v;
    else if (e.type === 'reverse_bonus' && rev) bonus += v;
    else if (e.type === 'target_bonus' && t.target === e.target) bonus += v;
  });
  return bonus;
}

export function rewardPreview(g: GameState, who: Who): number | null {
  const pend = g.pending[who];
  if (!pend) return null;
  if (g.players[who].swapNopay) return 0;
  const lv = pend.pool === 'task' ? LIBRARY[pend.idx].强度 : TRUTHS[pend.idx].强度;
  let coin = taskCoin(lv, pend.super);
  if (pend.pool === 'task') effects(g, who).forEach(e => { if (e.type === 'kink_bonus' && (LIBRARY[pend.idx].kink || []).includes(String(e.kink))) coin *= 2; });
  return Math.max(0, coin + identityTaskBonus(g, who, pend));
}

function done(g: GameState, out: Out, who: Who): boolean {
  const n = g.profiles.names;
  const pend = g.pending[who];
  if (!pend) return false;
  g.pending[who] = null;
  removeCard(g, pend.cardId);
  const p = g.players[who];
  const isTruth = pend.pool === 'truth';
  const lv = isTruth ? TRUTHS[pend.idx].强度 : LIBRARY[pend.idx].强度;
  let coin = taskCoin(lv, pend.super);
  if (!isTruth) effects(g, who).forEach(e => { if (e.type === 'kink_bonus' && (LIBRARY[pend.idx].kink || []).includes(String(e.kink))) coin *= 2; });
  const bonus = identityTaskBonus(g, who, pend);
  coin = Math.max(0, coin + bonus);
  const swapFree = p.swapNopay;
  p.swapNopay = false;
  if (swapFree) coin = 0;
  p.coins += coin;
  let extra = '';
  let witness = 0;
  if (isTruth) {
    const w = effNum(g, other(who), 'truth_witness');
    if (w) { g.players[other(who)].coins += w; witness = w; extra = ` · ⛪ ${n[other(who)]} 听告解 +${w}币`; }
  }
  const bTag = bonus > 0 ? `·身份+${bonus}` : bonus < 0 ? `·身份${bonus}` : '';
  const tag = `${isTruth ? '真心话·' : ''}强度${lv}${pend.super ? '·超级' : ''}${swapFree ? '·💱白工换的' : ''}${bTag}`;
  const prevOwner = g.owners[pend.tile];
  let claimed = '';
  let tileClaimed: number | null = null;
  if (g.board[pend.tile] === 'task') { g.owners[pend.tile] = who; tileClaimed = pend.tile; claimed = ` · 🚩占下第${pend.tile}格`; }
  p.lastSettle = { pend, coin, witness, tileClaimed, prevOwner, turnCount: g.turnCount };
  out('engine', `✅ ${n[who]} 完成（${tag}），+${coin}币（现${p.coins}）${claimed}${extra}`);
  return true;
}

function revertLastSettle(g: GameState, who: Who): LastSettle | null {
  const p = g.players[who];
  const ls = p.lastSettle;
  if (!ls || ls.turnCount !== g.turnCount) return null;
  p.coins -= ls.coin;
  if (ls.witness) g.players[other(who)].coins -= ls.witness;
  if (ls.tileClaimed !== null) g.owners[ls.tileClaimed] = ls.prevOwner;
  p.lastSettle = null;
  return ls;
}

function offerCard(g: GameState, who: Who, ci: number): string {
  const p = g.players[who];
  if (p.hand.length < N.handLimit) { p.hand.push(ci); return ''; }
  if (p.pendingCards.length >= N.handLimit) return `手牌${N.handLimit}张、暂存${p.pendingCards.length}张都满了，这张没收住`;
  p.pendingCards.push(ci);
  return `手牌已满（${N.handLimit}张），这张先替你留着——弃掉或打出一张就自动收进来（暂存${p.pendingCards.length}张）`;
}
function drainPendingCards(g: GameState, who: Who): string[] {
  const p = g.players[who];
  const got: string[] = [];
  while (p.pendingCards.length && p.hand.length < N.handLimit) { const c = p.pendingCards.shift()!; p.hand.push(c); got.push(FUNCTION_CARDS[c]?.name ?? '?'); }
  return got;
}
export function cardPrice(g: GameState, who: Who): number {
  let cost = N.cardCost;
  effects(g, who).forEach(e => { if (e.type === 'modify_cost') cost = Math.floor(cost * (Number(e.value) || 0)); });
  return cost;
}
export const tollOf = (g: GameState, owner: Who) => N.toll + effNum(g, owner, 'toll_plus');

function sendToJail(g: GameState, who: Who): string | null {
  const p = g.players[who];
  if (effects(g, who).some(e => e.type === 'immunity' && e.target === 'jail')) return `${identityOf(g, who)?.name}免疫，潇洒走过`;
  if (p.jailImmune > 0) { p.jailImmune -= 1; return `用🔓出狱卡潇洒走过（剩${p.jailImmune}张）`; }
  const jailIdx = g.board.indexOf('jail');
  p.pos = jailIdx >= 0 ? jailIdx : 10;
  p.jailed = N.jailTurns;
  return null;
}

function settlePendingToll(g: GameState, out: Out, mode: 'pay' | 'serve'): boolean {
  const n = g.profiles.names;
  if (!g.pendingToll) {
    if (mode !== 'serve' || !g.lastTollPaid) return false;
    const lt = g.lastTollPaid;
    g.lastTollPaid = null;
    g.players[lt.who].coins += lt.fee;
    const short = Math.max(0, lt.fee - g.players[lt.landlord].coins);
    g.players[lt.landlord].coins = Math.max(0, g.players[lt.landlord].coins - lt.fee);
    const sb = effNum(g, lt.who, 'serve_bonus');
    if (sb) g.players[lt.who].coins += sb;
    out('engine', `↩️ 改判：${n[lt.who]} 那 ${lt.fee} 币过路费退回来了（做的是 ${n[lt.landlord]} 的差遣），现在 ${n[lt.who]} ${g.players[lt.who].coins}币 · ${n[lt.landlord]} ${g.players[lt.landlord].coins}币${sb ? ` · ⛓️奴隶被使唤 +${sb}币` : ''}${short ? `（${n[lt.landlord]} 已经花掉 ${short} 币，只退得出剩下的）` : ''}`);
    return true;
  }
  const pt = g.pendingToll;
  g.pendingToll = null;
  g.cards = g.cards.filter(c => c.kind !== 'toll');
  const pw = g.players[pt.who];
  if (mode === 'serve' || pt.serveOnly || pw.coins < pt.fee) {
    const why = pt.serveOnly ? '🍯蜜罐地盘·只能差遣' : mode !== 'serve' ? '钱不够·用身体抵' : '用身体抵了过路费';
    g.lastTollPaid = null;
    const sb = effNum(g, pt.who, 'serve_bonus');
    if (sb) pw.coins += sb;
    out('engine', `🩺 ${n[pt.who]} 做了 ${n[pt.landlord]} 的差遣（${why}·不扣钱）${sb ? ` · ⛓️奴隶被使唤 +${sb}币` : ''}`);
    return true;
  }
  pw.coins -= pt.fee;
  g.players[pt.landlord].coins += pt.fee;
  g.lastTollPaid = { who: pt.who, landlord: pt.landlord, fee: pt.fee };
  out('engine', `💰 ${n[pt.who]} 交 ${pt.fee} 币过路费给 ${n[pt.landlord]}，剩${pw.coins}币`);
  return true;
}

function finalResult(g: GameState, out: Out) {
  const n = g.profiles.names;
  const lines: string[] = [];
  if (!g.finalSettled) {
    g.finalSettled = true;
    WHO.forEach(p => {
      effects(g, p).filter(e => e.type === 'end_transfer').forEach(e => {
        const opp = other(p);
        const v = Number(e.value) || 2;
        if ((e.direction ?? 'give') === 'give') {
          const pay = Math.min(g.players[p].coins, v); g.players[p].coins -= pay; g.players[opp].coins += pay;
          lines.push(`🎩 ${n[p]} 终局给 ${n[opp]} ${pay}币（年上的风度）`);
        } else {
          const pay = Math.min(g.players[opp].coins, v); g.players[opp].coins -= pay; g.players[p].coins += pay;
          lines.push(`🐤 ${n[p]} 终局向 ${n[opp]} 讨走 ${pay}币（年下会撒娇）`);
        }
      });
    });
    WHO.forEach(p => {
      const pl = g.players[p];
      if (pl.markSpot && !pl.markFound) { pl.coins += N.markHiddenReward; lines.push(`🌀 ${n[p]} 的淫纹藏在【${pl.markSpot}】整局没被找到·守住秘密 +${N.markHiddenReward}币`); }
    });
  }
  const head = lines.length ? lines.join('\n') + '\n' : '';
  const cu = g.players.user.coins;
  const ct = g.players.ta.coins;
  if (cu === ct) {
    g.finalText = `${head}🏁 终局平局！${n.user} ${cu}币 = ${n.ta} ${ct}币\n${TIE_HINT}`;
  } else {
    const winner: Who = cu > ct ? 'user' : 'ta';
    const loser = other(winner);
    const ceil = rangeOf(g)[1];
    let t = drawTask(g, winner, { override: [ceil, Math.min(ceil + 1, 6)], forceDesired: '攻', requireTarget: '对方', applyMod: false });
    if (t === null) t = drawTask(g, winner, { forceDesired: '攻', requireTarget: '对方', applyMod: false });
    const cmd = t !== null ? renderText(g, LIBRARY[t].内容, winner) : '你说了算·一道 ta 不能拒绝的';
    g.finalText = `${head}🏁 终局！${n[winner]} ${g.players[winner].coins}币 ＞ ${n[loser]} ${g.players[loser].coins}币 → 🏆 ${n[winner]} 赢！\n🏆 ${n[winner]} 免费砸一道终极指令（除红线 / 飞鸟·${n[loser]} 不能拒绝）：${cmd}\n${FINAL_ORDER_HINT}`;
  }
  out('engine', g.finalText);
}

// ─── 掷骰（原版 roll） ───
function roll(g: GameState, out: Out) {
  const n = g.profiles.names;
  const who = g.turn;
  const p = g.players[who];
  const opp = other(who);
  g.turnCount += 1;
  g.lastMover = who;
  WHO.forEach(w => { g.players[w].markGuessed = false; });
  const guess = p.guessNext; p.guessNext = null;
  const swapId = p.swapIdentityNext; p.swapIdentityNext = false;

  if (p.jailed > 0) {
    g.lastRoll = null;
    const t = drawTask(g, opp, { forceDesired: '攻', requireTarget: '对方' });
    const sb = effNum(g, who, 'serve_bonus');
    if (sb) p.coins += sb;
    p.jailed -= 1;
    const tail = p.jailed <= 0 ? '　🔓这轮完→释放，下个回合正常掷骰' : `　还关${p.jailed}轮`;
    out('engine', `🔒 ${n[who]} 被关进监狱、双手反绑动弹不得——这一轮，${n[opp]} 可以对 ta 为所欲为！${tail}${sb ? `　⛓️${n[who]}奴隶被使唤 +${sb}币` : ''}`);
    if (t !== null) pushCard(g, out, makeCard(g, 'jail', who, t, opp, '⛓监狱处置', `🔒${n[who]}被绑·任${n[opp]}处置（不能反抗·无币）`));
    g.turn = opp;
    return;
  }
  const d = 1 + rand(6);
  g.lastRoll = d;
  let gambleNote = '';
  if (guess && effVal(g, who, 'gamble_guess', false)) {
    const hit = (guess === '大') === (d >= 4);
    p.coins = Math.max(0, p.coins + (hit ? N.gambleGuess : -N.gambleGuess));
    gambleNote = `　🎰押${guess}${hit ? `中✓+${N.gambleGuess}` : `错✗-${N.gambleGuess}`}币`;
  }
  if ((d === 1 || d === 6) && effVal(g, who, 'sleep_beauty', false)) {
    const t = drawTask(g, opp, { forceDesired: '攻', requireTarget: '对方' });
    p.coins += N.sleepWakeBonus;
    g.turn = opp;
    out('engine', `😴 ${n[who]} 掷出 ${d} 陷入沉睡、任人摆布——这一轮，${n[opp]} 可以对熟睡的 ta 为所欲为（需吻醒），醒来 +${N.sleepWakeBonus}币${gambleNote}`);
    if (t !== null) pushCard(g, out, makeCard(g, 'sleep', who, t, opp, '😴睡美人处置', `😴${n[who]}睡着·任${n[opp]}处置·需吻醒·${n[who]}醒来+${N.sleepWakeBonus}币`));
    return;
  }
  let swapNote = '';
  if (g.chanceSwapOffer === who) {
    if (swapId && g.settings.identityMode !== 'off') {
      const old = identityOf(g, who)?.name;
      if (old) g.idAvoid.push(old);
      assignIdentity(g, who);
      swapNote = `　🎴（你选择换掉刚保留的身份 → ${identityOf(g, who)?.name ?? '无'}）`;
    }
    g.chanceSwapOffer = null;
  }
  const old = p.pos;
  const nw = (old + d) % BOARD_SIZE;
  const passed = nw < old;
  let lapGain = 0;
  if (passed) { lapGain = N.lapBonus + effNum(g, who, 'lap_bonus'); p.lap += 1; p.coins += lapGain; }
  p.pos = nw;
  const kind = g.board[nw];
  let say = '';
  const cardsToPush: TaskCard[] = [];
  let truthCardIdx: TaskCard | null = null;

  if (kind === 'task') {
    const owner = g.owners[nw];
    if (owner && owner !== who && effVal(g, who, 'toll_free', false)) {
      say = `🎲 ${n[who]} 掷 ${d} → 第${nw}格 · 🚩${n[owner]} 的地盘，但 ${identityOf(g, who)?.name} 身份免过路费，潇洒走过`;
    } else if (owner && owner !== who) {
      const serveOnly = !!effVal(g, owner, 'toll_serve_only', false);
      const fee = tollOf(g, owner);
      g.pendingToll = { who, landlord: owner, fee, serveOnly };
      const dt = drawTask(g, owner, { forceDesired: '攻', requireTarget: '对方' });
      say = `🎲 ${n[who]} 掷 ${d} → 第${nw}格 · 🚩踩进 ${n[owner]} 的地盘！${serveOnly ? `🍯${n[owner]}是蜜罐，只收差遣不收钱` : `交${fee}币过路费（pay）或 听凭差遣做下面这道（serve）；都不管，下次掷骰默认交钱`}`;
      if (dt !== null) cardsToPush.push(makeCard(g, 'toll', who, dt, owner, '👑地主主导', `${n[owner]}的地盘·听凭差遣（做完无币${serveOnly ? '' : `；交${fee}币过路费可免`}）`));
    } else {
      const t = drawTask(g, who);
      let rev = '';
      if (t !== null) {
        const c = makeCard(g, 'task', who, t, who, null, '真做完 → 下一次掷骰自动结算：按强度给币 + 占地（嫌弃可换 · 不做可跳过）');
        cardsToPush.push(c);
        g.pending[who] = { pool: 'task', idx: t, super: false, tile: nw, cardId: 0 };
        if (isReversed(g, LIBRARY[t], who)) rev = `　🔄反转！这道${n[who]}${LIBRARY[t].flavor === '攻' ? '临时变强势主导' : '临时被服务/被支配'}`;
      } else {
        out('error', '⚠️ 这里出错了：符合当前设置的任务一张都抽不到（红线/后庭/纯top/性别/强度都避开后没货），这格空过。');
      }
      say = `🎲 ${n[who]} 掷 ${d} → 第${nw}格 · 🎯动作任务${owner === who ? '（你的地盘）' : ''}${rev}`;
    }
  } else if (kind === 'truth') {
    const tr = drawTruth(g);
    say = `🎲 ${n[who]} 掷 ${d} → 第${nw}格 · 💬真心话（答完给币）`;
    if (tr !== null) {
      truthCardIdx = truthCard(g, 'truth', who, tr, '答了就是做了 → 下一次掷骰自动按强度给币');
      g.pending[who] = { pool: 'truth', idx: tr, super: false, tile: nw, cardId: 0 };
    }
  } else if (kind === 'mystery') {
    const luck = Number(effVal(g, who, 'mystery_luck', N.mysteryGoodChance));
    const good = Math.random() < luck;
    const evt = choice(good ? MYSTERY_GOOD : MYSTERY_BAD);
    let result = '';
    switch (evt.effect) {
      case 'push_opponent': g.players[opp].pos = Math.max(0, g.players[opp].pos - 3); result = `${n[opp]} 后退到第${g.players[opp].pos}格`; break;
      case 'bonus_coins': p.coins += 3; break;
      case 'found_coins': p.coins += 2; break;
      case 'free_card': { const ci = rand(FUNCTION_CARDS.length); const note = offerCard(g, who, ci); result = `摸到【${FUNCTION_CARDS[ci].name}】${note ? `·${note}` : ''}`; break; }
      case 'super_task': {
        const [, hi] = windowOf(g);
        const top = SUPER_CAN_EXCEED_RANGE ? 6 : rangeOf(g)[1];
        const t = drawTask(g, who, { override: [Math.min(hi + 1, top), Math.min(hi + 2, top)] });
        if (t !== null) {
          cardsToPush.push(makeCard(g, 'super', who, t, who, null, `做完 → +${N.coinSuper}币；不做花${N.buyoutCost}币买断`));
          g.pending[who] = { pool: 'task', idx: t, super: true, tile: nw, cardId: 0 };
        }
        break;
      }
      case 'fine': { const tr = Math.min(p.coins, 3); p.coins -= tr; g.players[opp].coins += tr; result = `交给 ${n[opp]} ${tr}币`; break; }
      case 'go_jail': { const jm = sendToJail(g, who); result = jm ?? `被关${N.jailTurns}轮`; break; }
      case 'go_back': p.pos = Math.max(0, p.pos - 5); result = `退到第${p.pos}格`; break;
      case 'expose': { const tr = drawTruth(g); if (tr !== null) truthCardIdx = truthCard(g, 'expose', who, tr, '惩罚真心话·必须答·不给币'); break; }
      case 'shame_task': {
        const t = drawTask(g, who);
        if (t !== null) {
          cardsToPush.push(makeCard(g, 'shame', who, t, who, null, '🫣羞耻展示·不能买断·做完照常给币'));
          g.pending[who] = { pool: 'task', idx: t, super: false, tile: nw, cardId: 0 };
        }
        break;
      }
      default: break;
    }
    say = `🎲 ${n[who]} 掷 ${d} → 第${nw}格 · ❓未知格 → ${good ? '好运' : '坏运'}${evt.name}：${evt.desc}${result ? `（${result}）` : ''}`;
  } else if (kind === 'chance') {
    const ci = rand(FUNCTION_CARDS.length);
    const note = offerCard(g, who, ci);
    const cardName = FUNCTION_CARDS[ci].name;
    say = `🎲 ${n[who]} 掷 ${d} → 第${nw}格 · 🎴抽卡 → ${cardName}：${FUNCTION_CARDS[ci].description}${note ? `（${note}）` : ''}`;
    if (g.settings.identityMode !== 'off') {
      const tenure = g.turnCount - p.identitySince;
      const cur = identityOf(g, who)?.name ?? '无';
      if (tenure >= N.identityTenure) {
        if (cur !== '无') g.idAvoid.push(cur);
        assignIdentity(g, who);
        say += ` | 身份：${cur}→${identityOf(g, who)?.name ?? '无'}`;
      } else {
        g.chanceSwapOffer = who;
        say += ` | 身份【${cur}】才玩了${tenure}轮·默认保留（想换：下一次掷骰前按「换身份」）`;
      }
    }
  } else if (kind === 'start') {
    say = `🎲 ${n[who]} 掷 ${d} → 🏁起点，+${lapGain}币（现${p.coins}）`;
  } else if (kind === 'shop') {
    say = `🎲 ${n[who]} 掷 ${d} → 🛒商店：花${cardPrice(g, who)}币可摸一张功能卡（buy）`;
  } else if (kind === 'jail') {
    const jm = sendToJail(g, who);
    say = jm ? `🎲 ${n[who]} 掷 ${d} → 🔒监狱 但${jm}` : `🎲 ${n[who]} 掷 ${d} → 🔒监狱：被关${N.jailTurns}轮，下个回合被绑任 ${n[opp]} 处置`;
  }

  // 同格对决（起点 / 有人在监狱 不触发）
  if (p.pos === g.players[opp].pos && p.pos !== 0 && !p.jailed && !g.players[opp].jailed) {
    const dropped = g.pending[who];
    g.pending[who] = null;
    cardsToPush.length = 0;
    const dt = drawDuel(g, who);
    say += `　⚔️ 撞上 ${n[opp]}！色色对决——这道两人一起做，谁先破功谁输！`;
    if (dropped || truthCardIdx) {
      const what = dropped?.super ? '🔥超级任务' : (truthCardIdx || dropped?.pool === 'truth') ? '💬真心话' : '这道任务';
      say += `　（本轮踩中的${what}被对决盖过·这次免了）`;
      truthCardIdx = null;
    }
    if (dt !== null) {
      g.pendingDuel = true;
      cardsToPush.push(makeCard(g, 'duel', who, dt, who, '⚔️同格对决', `${DUEL_HINT}（下一次掷骰前要报赢家）`));
    }
  }
  if (p.doubleNext) { p.doubleNext = false; say += '　⏩（加速：你再掷一次）'; } else g.turn = opp;
  if (passed && kind !== 'start') say += `　🏁路过起点+${lapGain}币（现${p.coins}）`;
  say += gambleNote + swapNote;
  out('engine', say);
  const reminder = identityReminder(g);
  if (reminder) out('engine', `🎭 ${reminder}`);
  cardsToPush.forEach(c => {
    const pushed = pushCard(g, out, c);
    const pd = g.pending[c.owner];
    if (pd && (c.kind === 'task' || c.kind === 'super' || c.kind === 'shame') && pd.cardId === 0) pd.cardId = pushed.id;
  });
  if (truthCardIdx) {
    const pushed = pushCard(g, out, truthCardIdx);
    const pd = g.pending[who];
    if (pd && pd.pool === 'truth' && pd.cardId === 0 && truthCardIdx.kind === 'truth') pd.cardId = pushed.id;
  }
  out('engine', boardArt(g));
  if (g.turnCount >= g.totalRounds) out('engine', '🏁 满回合！做完/答完这最后一题，再掷一次结算并看结果。');
}

// ═══ 八、开局 ═══════════════════════════════════════════════════════════════

function buildLockLine(g: GameState): string {
  const s = g.settings;
  const n = g.profiles.names;
  const sexOf = (w: Who) => g.profiles.sexes[w] ?? '性别未识别';
  const lines = [
    `✅ 开局！${n.user}（${sexOf('user')}·${s.roles.user}）vs ${n.ta}（${sexOf('ta')}·${s.roles.ta}）· ${s.intensity}盘 · ${g.totalRounds}回合 · 反转${s.reversal}`,
    `🔒 安全（念给人类确认）：${safetySummary(g)} · 身份=${s.identityMode} · 先手=${n[g.turn]}`,
    `🎚️ 强度（念给人类·知情再开）：${intensityNote(s)}`,
  ];
  if (s.identityMode !== 'off') lines.push(`🎭 身份 ${n.user}=${identityOf(g, 'user')?.name ?? '无'} · ${n.ta}=${identityOf(g, 'ta')?.name ?? '无'}`);
  lines.push(`💡 金币怎么赚：做任务按强度给币（轻1/中2/狠3/超5）、路过或踩中起点+${N.lapBonus}；做完一道就白占那格当地盘，对方踩进来要么交过路费、要么听你差遣。终局金币多的赢。`);
  lines.push('💡 反转：小概率攻受临时对调，是故意设计的惊喜，卡上会标🔄。');
  return lines.join('\n');
}

export function createGame(settings: MonopolySettings, profiles: Profiles, seen?: { recency: string[]; blocklist: string[]; identities: string[] }): GameState {
  const g = createLobby(settings, profiles);
  g.turn = settings.firstMove === 'ta' ? 'ta' : 'user';
  if (seen) {
    seen.recency.forEach((k, i) => { g.recency[k] = i; });
    g.blocklist = [...seen.blocklist];
    g.idAvoid = [...seen.identities];
  }
  assignIdentity(g, 'user');
  assignIdentity(g, 'ta');
  g.phase = 'lock';
  g.lockLine = buildLockLine(g);
  g.seq = 2;
  g.log = [{ id: 1, kind: 'cmd', text: `$ ${buildOpeningCommand(settings, profiles)}` }, { id: 2, kind: 'engine', text: `${g.lockLine}\n${boardArt(g)}` }];
  return g;
}

// ═══ 九、指令 ═══════════════════════════════════════════════════════════════

export function resolveWho(g: GameState, name?: string): Who | null {
  if (!name) return null;
  const s = name.trim().toLowerCase();
  if (['我', 'user', 'me', g.profiles.names.user.toLowerCase()].includes(s)) return 'user';
  if (['ta', g.profiles.names.ta.toLowerCase()].includes(s)) return 'ta';
  return null;
}

// 原版 CLI 里「刚掷骰/待结算的人」
export function defaultActor(g: GameState): Who {
  const pw = WHO.find(w => g.pending[w]);
  return pw ?? g.lastMover ?? other(g.turn);
}

// 执行一条指令。出错时状态完全不变，只追加指令行和一条错误说明。
export function runCommand(prev: GameState, raw: string, by?: Who): GameState {
  const body = raw.trim().replace(/^python3?\s+monopoly_play\.py\s*/, '').replace(/\s+/g, ' ');
  const [verbRaw = '', ...args] = body.split(' ');
  const verb = verbRaw.toLowerCase();
  const g: GameState = JSON.parse(JSON.stringify(prev));
  const n = g.profiles.names;
  const buffer: LogLine[] = [];
  let seq = g.seq;
  const out: Out = (kind, text) => { seq += 1; buffer.push({ id: seq, kind, text, by }); };
  out('cmd', `$ ${body}${by ? `   ← ${n[by]}` : ''}`);
  const cmdLine = buffer[0];

  const need = (ok: unknown, msg: string) => { if (!ok) throw new CommandError(msg); };
  const needPlaying = () => {
    need(g.phase !== 'lobby' && g.phase !== 'lock', '还没开局');
    need(g.phase !== 'stopped', '游戏被飞鸟停着，要继续先 resume');
    need(g.phase !== 'over', '这局已经结束');
  };
  const nameOf = (arg: string | undefined, fallback: Who | null): Who => {
    if (arg === undefined || arg === '') { need(fallback, `要带名字：${n.user} 或 ${n.ta}`); return fallback!; }
    const w = resolveWho(g, arg);
    need(w, `不认识「${arg}」，只能写 ${n.user} 或 ${n.ta}`);
    return w!;
  };
  const cardOf = (idx: number | undefined) => g.cards.find(c => c.id === idx);

  try {
    switch (verb) {
      case 'confirm': {
        need(g.phase === 'lock', '现在不在开局确认阶段');
        g.phase = 'playing';
        out('engine', '✅ 开局确认，开始。每回合点骰子；「掷下一轮 = 上一题玩完了」。');
        break;
      }
      case 'guess': {
        needPlaying();
        const who = nameOf(args[1], by ?? g.turn);
        need(hasEffect(g, who, 'gamble_guess'), `${n[who]} 不是赌徒，不用押大小`);
        need(args[0] === '大' || args[0] === '小', '格式：guess 大 或 guess 小');
        g.players[who].guessNext = args[0] as '大' | '小';
        out('engine', `🎰 ${n[who]} 押${args[0]}（1-3 小 / 4-6 大，下次掷骰揭晓）`);
        break;
      }
      case 'swapid': {
        needPlaying();
        const who = nameOf(args[0], by ?? g.turn);
        need(g.chanceSwapOffer === who, `${n[who]} 现在没有「抽卡格保留下来、可以主动换」的身份`);
        g.players[who].swapIdentityNext = true;
        out('engine', `🎴 ${n[who]} 下一次掷骰时换掉刚保留的身份`);
        break;
      }
      case 'roll': {
        needPlaying();
        need(!g.pendingDuel, '⚔️ 上一轮的对决还没报赢家，先报赢家（duel 名字）');
        if (args.includes('大') || args.includes('小')) {
          const gs = args.includes('大') ? '大' : '小';
          if (hasEffect(g, g.turn, 'gamble_guess')) g.players[g.turn].guessNext = gs;
        }
        if (args.includes('换身份') && g.chanceSwapOffer === g.turn) g.players[g.turn].swapIdentityNext = true;
        // 懒结算：先把上一题结清（过路费默认交钱 · 任务默认照做）
        const notes: LogLine[] = [];
        const noteOut: Out = (kind, text) => { seq += 1; notes.push({ id: seq, kind, text, by }); };
        settlePendingToll(g, noteOut, 'pay');
        WHO.forEach(w => { if (g.pending[w]) done(g, noteOut, w); });
        if (notes.length) out('engine', '〔上一题结算〕' + notes.map(x => x.text).join(' ｜ '));
        g.cards = [];
        if (g.turnCount >= g.totalRounds) {
          g.phase = 'over';
          out('engine', '🏁 游戏结束。');
          finalResult(g, out);
          break;
        }
        roll(g, out);
        break;
      }
      case 'done': {
        needPlaying();
        const who = nameOf(args[0], by && g.pending[by] ? by : defaultActor(g));
        need(g.pending[who], `${n[who]} 这格没有待结算的题`);
        done(g, out, who);
        break;
      }
      case 'skip': {
        needPlaying();
        const cardId = args[0] && /^#\d+$/.test(args[0]) ? Number(args[0].slice(1)) : undefined;
        const c = cardOf(cardId);
        if (c && !['task', 'truth', 'super', 'shame', 'extra'].includes(c.kind)) {
          removeCard(g, c.id);
          if (c.kind === 'duel') { g.pendingDuel = false; out('engine', `⏭️ 这场对决不比了（不追问理由），可以直接掷下一轮。`); }
          else if (c.kind === 'toll') out('engine', `⏭️ ${n[c.owner]} 不做这道差遣。过路费还挂着：交钱（pay），或者不管它、下次掷骰默认交钱（钱不够不扣）。`);
          else out('engine', `⏭️ 这道${c.label}不做（不追问理由）。`);
          break;
        }
        const who = c ? c.owner : nameOf(cardId === undefined ? args[0] : undefined, by && g.pending[by] ? by : defaultActor(g));
        let pend = g.pending[who];
        let revert = '';
        if (!pend) {
          const ls = revertLastSettle(g, who);
          need(ls, `${n[who]} 没有可跳过的题（要跳得在下一次掷骰前）`);
          pend = ls!.pend;
          revert = `（先退回刚结算的${ls!.coin}币和占地）`;
        }
        g.pending[who] = null;
        g.players[who].lastSettle = null;
        g.players[who].swapNopay = false;
        removeCard(g, pend.cardId);
        out('engine', `⏭️ ${n[who]} 跳过这道${pend.pool === 'truth' ? '真心话' : pend.super ? '🔥超级任务' : '任务'}·不做、不给币不占地${revert}`);
        break;
      }
      case 'swap':
      case 'reroll_task': {
        needPlaying();
        const cat = verb === 'reroll_task';
        const who = nameOf(args[0], by && g.pending[by] ? by : defaultActor(g));
        const p = g.players[who];
        let pend = g.pending[who];
        let revert = '';
        if (!pend && !cat) {
          const ls = revertLastSettle(g, who);
          need(ls, `${n[who]} 没有可换的题（要换得在下一次掷骰前）`);
          pend = ls!.pend;
          g.pending[who] = pend;
          revert = `（先退回刚结算的${ls!.coin}币和占地）`;
        }
        need(pend, `${n[who]} 没有可换的题`);
        const pd = pend!;
        const oldCard = g.cards.find(c => c.id === pd.cardId);
        if (cat) {
          const quota = effNum(g, who, 'task_reroll');
          need(p.taskRerolled < quota, `${n[who]} 没有（或用完了）身份的免费换题`);
          need(pd.pool === 'task', '身份特权只能换动作任务');
          const t = drawTask(g, who);
          need(t !== null, '换不出新任务（库抽干了），原任务保留');
          p.taskRerolled += 1;
          g.pending[who] = { ...pd, idx: t!, cardId: 0 };
          removeCard(g, pd.cardId);
          out('engine', `🔄 ${n[who]} 用身份特权换了一道新任务（照常给币）`);
          const c = pushCard(g, out, makeCard(g, oldCard?.kind ?? 'task', who, t!, who, null, '🔄身份特权换的新任务'));
          g.pending[who]!.cardId = c.id;
          break;
        }
        need(!pd.super, `超级任务不能换：做完（+${N.coinSuper}币）、买断（${N.buyoutCost}币）或跳过`);
        need(p.swapUsed < N.swapCap, `${n[who]} 本局换题次数用完了（${p.swapUsed}/${N.swapCap}），可以免费跳过`);
        const oldKey = pd.pool === 'truth' ? TRUTH_KEYS[pd.idx] : LIB_KEYS[pd.idx];
        let newCard: TaskCard;
        if (pd.pool === 'truth') {
          const tr = drawTruth(g);
          need(tr !== null && tr !== pd.idx, '换不出新真心话·原题保留');
          g.pending[who] = { ...pd, idx: tr!, cardId: 0 };
          newCard = truthCard(g, 'truth', who, tr!, `💱换的新真心话（${p.swapUsed + 1}/${N.swapCap}）`);
        } else {
          const t = drawTask(g, who);
          need(t !== null, '换不出新任务（这窗口的卡抽干了）·原任务保留');
          g.pending[who] = { ...pd, idx: t!, cardId: 0 };
          newCard = makeCard(g, oldCard?.kind === 'shame' ? 'shame' : oldCard?.kind === 'extra' ? 'extra' : 'task', who, t!, who, null, `💱换的新任务（${p.swapUsed + 1}/${N.swapCap}）`);
        }
        let cost: string;
        if (p.coins >= N.swapCost) { p.coins -= N.swapCost; g.players[other(who)].coins += N.swapCost; cost = `赔 ${n[other(who)]} ${N.swapCost}币（现${p.coins}）`; }
        else { p.swapNopay = true; cost = '没币可赔→换来的这道做完不给币（白工）'; }
        p.swapUsed += 1;
        if (!g.blocklist.includes(oldKey)) g.blocklist.push(oldKey);
        p.lastSettle = null;
        removeCard(g, pd.cardId);
        out('engine', `💱 ${n[who]} 换了一道（${p.swapUsed}/${N.swapCap}）·以后不再出原来那道·${cost}${revert}`);
        const c = pushCard(g, out, newCard);
        g.pending[who]!.cardId = c.id;
        break;
      }
      case 'buyout': {
        needPlaying();
        const who = nameOf(args[0], by && g.pending[by] ? by : defaultActor(g));
        const pd = g.pending[who];
        need(pd, `${n[who]} 现在没有悬着的任务，不用买断`);
        need(pd!.super, '这道不是🔥超级任务，不能花钱买断；不想做就免费跳过');
        need(g.players[who].coins >= N.buyoutCost, `${n[who]} 币不够买断（${g.players[who].coins}/${N.buyoutCost}），可以做，或者跳过`);
        g.players[who].coins -= N.buyoutCost;
        g.pending[who] = null;
        removeCard(g, pd!.cardId);
        out('engine', `💸 ${n[who]} 花${N.buyoutCost}币买断超级任务，剩${g.players[who].coins}币`);
        break;
      }
      case 'pay': {
        needPlaying();
        const pt = g.pendingToll;
        need(pt, '现在没有悬着的过路费，别凭空扣钱');
        const who = nameOf(args[0], pt!.who);
        need(who === pt!.who, `这笔过路费是 ${n[pt!.who]} 欠 ${n[pt!.landlord]} 的`);
        need(!pt!.serveOnly, `🍯 ${n[pt!.landlord]} 是蜜罐，地盘不收钱，只能听凭差遣（serve）`);
        need(g.players[who].coins >= pt!.fee, `${n[who]} 钱不够过路费（${g.players[who].coins}/${pt!.fee}）→ 只能听凭差遣（serve）`);
        settlePendingToll(g, out, 'pay');
        break;
      }
      case 'serve': {
        needPlaying();
        need(g.pendingToll || g.lastTollPaid, '没有悬着的过路费可用差遣抵扣');
        settlePendingToll(g, out, 'serve');
        break;
      }
      case 'duel': {
        needPlaying();
        need(g.pendingDuel, '现在没有待报赢家的对决');
        const winner = nameOf(args[0], null);
        const loser = other(winner);
        g.pendingDuel = false;
        g.cards = g.cards.filter(c => c.kind !== 'duel');
        out('engine', `🏆 ${n[winner]} 赢了对决，${n[loser]} 先破功输了！现在 ${n[loser]} 任 ${n[winner]} 处置——${n[winner]} 命令 ta 做一件事（不越红线·随时能飞鸟），做完再掷下一轮。`);
        break;
      }
      case 'buy': {
        needPlaying();
        const who = nameOf(args[0], by ?? defaultActor(g));
        const cost = cardPrice(g, who);
        const p = g.players[who];
        need(p.coins >= cost, `${n[who]} 币不够摸卡（${p.coins}/${cost}）`);
        need(p.hand.length < N.handLimit, `${n[who]} 手牌已满（${N.handLimit}张），先弃一张`);
        p.coins -= cost;
        const ci = rand(FUNCTION_CARDS.length);
        p.hand.push(ci);
        out('engine', `🎴 ${n[who]} ${cost === 0 ? '（🐰兔女郎·免费）' : `花${cost}币`}摸到【${FUNCTION_CARDS[ci].name}】：${FUNCTION_CARDS[ci].description}（剩${p.coins}币）`);
        break;
      }
      case 'card':
      case 'discard': {
        needPlaying();
        const idx = Number(args[0]);
        need(args[0] !== undefined && Number.isInteger(idx) && idx >= 0, `格式：${verb} 手牌序号 [名字]，例：${verb} 0`);
        const who = nameOf(args[1], by ?? defaultActor(g));
        const p = g.players[who];
        need(idx < p.hand.length, p.hand.length
          ? `${n[who]} 没有序号 ${idx} 这张手牌（序号从 0 起·现有 ${p.hand.map((c, i) => `[${i}]${FUNCTION_CARDS[c]?.name}`).join('、')}）`
          : `${n[who]} 手里没有功能卡`);
        const ci = p.hand[idx];
        const def = FUNCTION_CARDS[ci];
        if (verb === 'discard') {
          p.hand.splice(idx, 1);
          const got = drainPendingCards(g, who);
          out('engine', `🗑️ ${n[who]} 弃掉 ${def.name}${got.length ? ` → 📥 暂存的【${got.join('】【')}】收进手牌` : ''}`);
          break;
        }
        const opp = other(who);
        const po = g.players[opp];
        if (def.effect === 'double_roll') need(g.turnCount < g.totalRounds, `${def.name} 现在用不上了（没有下一轮），先留着`);
        p.hand.splice(idx, 1);
        let r = `🃏 ${n[who]} 使用 ${def.name}：${def.description}`;
        switch (def.effect) {
          case 'push_back': po.pos = Math.max(0, po.pos - (def.value || 3)); r += ` → ${n[opp]}后退到第${po.pos}格`; break;
          case 'steal_coins': { const t = Math.min(po.coins, def.value || 3); po.coins -= t; p.coins += t; r += ` → 偷了${n[opp]}${t}币`; break; }
          case 'send_jail': { const jm = sendToJail(g, opp); r += ` → ${n[opp]}${jm ?? `被关进监狱${N.jailTurns}轮`}`; break; }
          case 'double_roll': p.doubleNext = true; r += ' → 下一轮你再掷一次'; break;
          case 'jail_free':
            if (p.jailed > 0) { p.jailed = 0; r += ' → 🔓当场出狱！下个回合正常掷骰'; }
            else { p.jailImmune += 1; r += ` → 攒一张免狱（现${p.jailImmune}张）`; }
            break;
          case 'gamble': {
            const v = def.value || 3;
            if (Math.random() < 0.5) { const t = Math.min(po.coins, v); po.coins -= t; p.coins += t; r += ` → 🎰赢了！${n[opp]}给你${t}币`; }
            else { const t = Math.min(p.coins, v); p.coins -= t; po.coins += t; r += ` → 🎰输了！你给${n[opp]}${t}币`; }
            break;
          }
          case 'collect_rent': {
            const per = def.value || 1;
            const lands = g.owners.filter(o => o === who).length;
            const rent = Math.min(po.coins, per * lands);
            po.coins -= rent; p.coins += rent;
            r += ` → 收租：${lands}块地×${per} = 从${n[opp]}收${rent}币`;
            break;
          }
          case 'extort': { const v = def.value || 2; const t = Math.min(po.coins, v); po.coins -= t; p.coins += t; r += ` → 敲诈${n[opp]}${t}币${t < v ? '（对方没钱·改用身体抵）' : ''}`; break; }
          default: break;
        }
        const got = drainPendingCards(g, who);
        if (got.length) r += ` ｜ 📥 暂存的【${got.join('】【')}】收进手牌`;
        out('engine', r);
        break;
      }
      case 'reroll_id': {
        needPlaying();
        need(g.settings.identityMode !== 'off', '这局没开身份系统');
        const who = nameOf(args[0], by ?? null);
        const p = g.players[who];
        need(!p.identityRerolled, `${n[who]} 这局的重抽权已经用过了`);
        const old = identityOf(g, who)?.name ?? '无';
        p.identityRerolled = true;
        g.idAvoid.push(old);
        assignIdentity(g, who);
        out('engine', `🎭 ${n[who]} 弃演【${old}】→ 换上【${identityOf(g, who)?.name ?? '无'}】（每局仅1次·已用完）`);
        break;
      }
      case 'idevent': {
        needPlaying();
        const who = nameOf(args[0], null);
        const ev = args[1];
        const opp = other(who);
        const p = g.players[who];
        const e = effects(g, who).find(x => (x.type === 'id_event_reward' || x.type === 'id_event_penalty') && x.event === ev);
        need(e, `${n[who]} 身份没有【${ev ?? ''}】这个记账钩子`);
        const v = Number(e!.value) || (e!.type === 'id_event_penalty' ? 1 : 0);
        if (e!.type === 'id_event_reward') {
          if (e!.once) {
            const key = `${who}:${ev}`;
            need(!g.idEventsUsed.includes(key), `${n[who]} 的【${ev}】每局限一次·已经领过了`);
            g.idEventsUsed.push(key);
          }
          p.coins += v;
          out('engine', `✨ ${n[who]} 触发【${ev}】·+${v}币（现${p.coins}）`);
        } else if (e!.to === 'opponent') {
          const pay = Math.min(p.coins, v); p.coins -= pay; g.players[opp].coins += pay;
          out('engine', `⚠️ ${n[who]} 犯规【${ev}】·罚 ${pay}币 给 ${n[opp]}（现${p.coins}）`);
        } else {
          p.coins = Math.max(0, p.coins - v);
          out('engine', `⚠️ ${n[who]} 犯规【${ev}】·扣 ${v}币（现${p.coins}）`);
        }
        break;
      }
      case 'extra': {
        needPlaying();
        const who = nameOf(args[0], by ?? null);
        const p = g.players[who];
        const quota = effNum(g, who, 'extra_task');
        need(quota > 0, `${n[who]} 不是不知餍足·没有加餐特权`);
        need(p.extraUsed < quota, `${n[who]} 加餐次数用完了（${p.extraUsed}/${quota}）`);
        need(!g.pending[who], `${n[who]} 手上还有一道没结算，先做完或跳过再加餐`);
        const t = drawTask(g, who);
        need(t !== null, '加餐抽不出新任务（库抽干了）');
        p.extraUsed += 1;
        g.pending[who] = { pool: 'task', idx: t!, super: false, tile: p.pos, cardId: 0 };
        out('engine', `➕ ${n[who]} 意犹未尽·加抽一道（${p.extraUsed}/${quota}）`);
        const c = pushCard(g, out, makeCard(g, 'extra', who, t!, who, null, `➕不知餍足加餐（${p.extraUsed}/${quota}）·做完照常给币`));
        g.pending[who]!.cardId = c.id;
        break;
      }
      case 'mark': {
        needPlaying();
        const guesser = nameOf(args[0], null);
        const spot = args.slice(1).join('');
        const holder = other(guesser);
        const hp = g.players[holder];
        need(hp.markSpot, `${n[holder]} 不是淫纹持有者·没什么可猜的`);
        need(!hp.markFound, `${n[holder]} 的淫纹已经被找到过了`);
        need(MARK_PARTS.includes(spot), `要猜候选清单里的原词：${MARK_PARTS.join(' / ')}`);
        need(!g.players[guesser].markGuessed, `${n[guesser]} 这轮已经猜过一次了·下轮再来`);
        g.players[guesser].markGuessed = true;
        if (spot === hp.markSpot) {
          hp.markFound = true;
          g.players[guesser].coins += N.markFoundReward;
          out('engine', `💥 猜中！${n[holder]} 的淫纹就在【${spot}】·当场腿软·${n[guesser]} +${N.markFoundReward}币（现${g.players[guesser].coins}）`);
        } else {
          out('engine', `❌ ${n[guesser]} 摸了【${spot}】·没猜中·白摸（下轮再猜）`);
        }
        break;
      }
      case 'persona': {
        needPlaying();
        const who = nameOf(args[0], by ?? null);
        need(hasEffect(g, who, 'declare_persona'), `${n[who]} 不是背德者·不用宣布身份`);
        const text = args.slice(1).join(' ').trim();
        need(text, '报一个背德身份，格式：persona 名字 身份');
        g.players[who].persona = text.slice(0, 20);
        out('engine', `🎭 ${n[who]} 的背德身份定为【${g.players[who].persona}】·整局锁定用它说话和玩`);
        break;
      }
      case 'bird': {
        need(g.phase === 'playing' || g.phase === 'lock', g.phase === 'stopped' ? '已经停着了' : '现在没有进行中的局');
        const who = args[0] !== undefined ? nameOf(args[0], null) : (by ?? 'user');
        g.resumePhase = g.phase;
        g.phase = 'stopped';
        g.stoppedBy = who;
        out('engine', `🕊️ 飞鸟 —— ${n[who]} 按下了。游戏立刻停，不追问理由。`);
        break;
      }
      case 'resume': {
        need(g.phase === 'stopped', '现在没有停着的局');
        g.phase = g.resumePhase === 'lock' ? 'lock' : 'playing';
        g.stoppedBy = null;
        out('engine', '▶️ 继续这局，棋盘、金币、手牌都没动。');
        break;
      }
      case 'board':
      case 'status': {
        need(g.phase !== 'lobby', '还没开局');
        out('engine', boardArt(g));
        break;
      }
      case 'result': {
        need(g.phase === 'over', g.turnCount >= g.totalRounds ? '回合满了但最后一题还没结算：再掷一次' : `还没打满 ${g.totalRounds} 回合`);
        finalResult(g, out);
        break;
      }
      case 'tiebreak': {
        need(g.phase === 'over', '还没打满回合呢·加掷决胜是打完平局才用的');
        if (!g.finalSettled) finalResult(g, () => { /* 先结清终局收益 */ });
        need(g.players.user.coins === g.players.ta.coins, '现在不是平局，直接看赢家就行');
        g.totalRounds += N.tiebreakRounds;
        g.phase = 'playing';
        g.finalText = '';
        out('engine', `⚔️ 平局·加掷决胜！两人各再掷一轮（现在共 ${g.totalRounds} 回合），打完再比金币——还平就再加一轮。`);
        break;
      }
      default:
        throw new CommandError(verb ? `不认识的指令「${verbRaw}」` : '指令是空的');
    }
  } catch (e) {
    if (!(e instanceof CommandError)) console.error('[Monopoly] engine crash', e);
    const msg = e instanceof CommandError ? e.message : `引擎内部错误（${(e as Error)?.message ?? e}）`;
    const next: GameState = JSON.parse(JSON.stringify(prev));
    next.seq = prev.seq + 2;
    next.log = [...prev.log, { ...cmdLine, id: prev.seq + 1 },
      { id: prev.seq + 2, kind: 'error' as LogKind, text: `⚠️ 这里出错了：${msg}\n状态没有变化。`, by }].slice(-300);
    return next;
  }
  g.seq = seq;
  g.log = [...g.log, ...buffer].slice(-300);
  return g;
}

// ═══ 十、存档 / 快照 ═════════════════════════════════════════════════════════

export const gameStorageKey = (charId: string) => `yuzhou_monopoly_game_v${CONTENT_VERSION}_${charId || 'default'}`;

export function loadGame(charId: string): GameState | null {
  try {
    const raw = localStorage.getItem(gameStorageKey(charId));
    if (!raw) return null;
    const g = JSON.parse(raw) as GameState;
    if (!g || g.version !== CONTENT_VERSION || !g.players?.user || !Array.isArray(g.owners) || g.owners.length !== BOARD_SIZE) return null;
    return g;
  } catch { return null; }
}

export function saveGame(charId: string, g: GameState) {
  try {
    if (g.phase === 'lobby') localStorage.removeItem(gameStorageKey(charId));
    else localStorage.setItem(gameStorageKey(charId), JSON.stringify(g));
  } catch { /* ignore */ }
}

// 给 AI 的状态快照（原版 status 的内容；淫纹位置绝不进来）
export function aiSnapshot(g: GameState): string {
  const n = g.profiles.names;
  const s = g.settings;
  const idBlock = (w: Who) => {
    const c = identityOf(g, w);
    if (!c) return s.identityMode === 'off' ? '  └ （这局没开身份）' : '  └ 无';
    const p = g.players[w];
    const lines = (c.persona?.length ? c.persona : [c.behavior || '']).map(l => `  └ ${l}`);
    if (c.hint) lines.push(`  └ 规则：${c.hint}`);
    if (p.persona) lines.push(`  └ 背德身份：${p.persona}`);
    if (p.markSpot && !p.markFound) lines.push(`  └ 🌀对方每轮猜一处·可猜部位：${MARK_PARTS.join('/')}`);
    return lines.join('\n');
  };
  const out = [
    `${s.intensity}盘 · 回合 ${g.turnCount}/${g.totalRounds} · 下一个掷骰：${n[g.turn]} · 阶段：${g.phase}`,
    `🔒 ${safetySummary(g)}`,
    boardArt(g),
    `${n.user}（${g.profiles.sexes.user ?? '?'}·${s.roles.user}）身份：${identityOf(g, 'user')?.name ?? '无'}`,
    idBlock('user'),
    `${n.ta}（${g.profiles.sexes.ta ?? '?'}·${s.roles.ta}）身份：${identityOf(g, 'ta')?.name ?? '无'}`,
    idBlock('ta'),
  ];
  if (g.cards.length) {
    out.push('【这一轮的题】');
    g.cards.forEach(c => out.push(`#${c.id} ${CARD_LABEL[c.kind]}·${n[c.owner]}的·行动方 ${n[c.actor]}：${c.text}`));
  }
  if (g.pendingToll) out.push(`【过路费】${n[g.pendingToll.who]} 欠 ${n[g.pendingToll.landlord]} ${g.pendingToll.fee} 币（pay / serve）`);
  if (g.pendingDuel) out.push('【对决】等报赢家');
  if (g.finalText) out.push(`【终局】\n${g.finalText}`);
  return out.join('\n');
}

export const CARD_LABEL: Record<CardKind, string> = {
  task: '🎯任务', truth: '💬真心话', super: '🔥超级任务', shame: '🫣羞耻任务', extra: '➕加餐任务',
  toll: '👑地主差遣', jail: '⛓监狱处置', sleep: '😴睡美人处置', duel: '⚔️对决', expose: '🎭暴露真心话',
};

export { N as NUMBERS, DEALER_NAME as ENGINE_DEALER_NAME };
export type { LibTruth };
