import { DB } from '../../../utils/db';
import type { DeckKind } from './decks';

/**
 * 双人占卜的存档（和单人抽牌、随心抽完全分开存）。
 *
 * · 进行中的一场：系统资源表，id = tarot_duo_session_v1_<角色id>。「暂时离开」后回来接着玩。
 * · 占卜记录：tarot_duo_records_v1_<角色id>。每局结束和「结束占卜」时都会存一份，书架上的占卜记录页从这里读。
 * · 猜中次数：tarot_duo_stats_v1_<角色id>。称号以后从这里算。
 * 这三份都在系统资源表里，会进备份。
 * · TA 的接口（窗外的月亮）和「玩法说明看过没」存在浏览器本地，和大富翁的接口设置一样不进备份。
 */

export type DuoPlay = 'ta_draws' | 'user_draws';
export type DuoMode = 'basic' | 'advanced';
export type DuoRating = 'hit' | 'half' | 'miss';

export type DuoStage =
  | 'deck'          // 选牌组和张数
  | 'ta_ask'        // TA 出题、挑牌（调 API）
  | 'ta_drawing'    // TA 抽牌动画
  | 'reading'       // 我翻牌、写解读
  | 'ta_judge'      // TA 对答案（调 API）
  | 'user_drawing'  // 我抽牌
  | 'user_drawn'    // 我抽完了，等着请 TA 解读
  | 'ta_read'       // TA 解读（调 API）
  | 'feedback'      // 我告诉 TA 准不准
  | 'ta_react'      // TA 的反应（调 API）
  | 'done';

export const PLAY_LABEL: Record<DuoPlay, string> = { ta_draws: 'TA 抽我解', user_draws: '我抽 TA 解' };
export const MODE_LABEL: Record<DuoMode, string> = { basic: '基础', advanced: '进阶' };
export const COUNT_OPTIONS = [1, 3, 6, 8];

/** 猜中计分：基础模式看得到牌意，涨得慢 */
export const SCORE: Record<DuoMode, Record<DuoRating, number>> = {
  basic: { hit: 0.5, half: 0.25, miss: 0 },
  advanced: { hit: 1, half: 0.5, miss: 0 },
};

export interface DuoDeckRef { deckId: string; kind: DeckKind }

export interface DuoCard {
  id: string;
  deckId: string;
  kind: DeckKind;
  cardKey: string;
  /** 抽到时的牌名和牌组名，工坊里删了牌组，记录里也还看得到 */
  name: string;
  deckName: string;
  by: 'ta' | 'user';
  reversed: boolean;
  faceUp: boolean;
  /** 是不是后来补的 */
  extra: boolean;
  /** 「铺开看」里的位置：x 是桌面宽度的比例，y 是像素；x < 0 表示还没摆过 */
  x: number;
  y: number;
  z: number;
}

export interface DuoRound {
  id: string;
  startedAt: number;
  endedAt?: number;
  play: DuoPlay;
  mode: DuoMode;
  /** 「想问点什么？」里填的：TA 抽我解时是给 TA 的方向，我抽 TA 解时是我的问题 */
  ask: string;
  /** 留空时随机挑到的方向 */
  topic: string;
  count: number;
  decks: DuoDeckRef[];
  /** 每副牌洗好后剩下的顺序 */
  orders: Record<string, string[]>;
  cards: DuoCard[];
  zTop: number;
  /** 在「铺开看」里拖动过牌 */
  arranged: boolean;
  stage: DuoStage;
  /** TA 挑中、还没落到桌上的牌（抽牌动画中途离开，回来直接补上） */
  pendingPicks: { deckId: string; kind: DeckKind; keys: string[]; extra: boolean } | null;
  secret?: { question: string; answer: string };
  taOpening?: string;
  userReading?: string;
  taVerdict?: string;
  taReading?: string;
  feedback?: string;
  taReaction?: string;
  rating?: DuoRating;
  score?: number;
}

export interface DuoLogEntry {
  id: number;
  from: 'ta' | 'user' | 'event';
  text: string;
  t: number;
}

export interface DuoSession {
  version: 1;
  id: string;
  /** 只按角色 ID 认人，存档里不存任何名字。名字都是用的时候现查 */
  charId: string;
  startedAt: number;
  endedAt?: number;
  rounds: DuoRound[];
  log: DuoLogEntry[];
}

export function duoUid(prefix = 'd'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function newDuoSession(charId: string): DuoSession {
  return { version: 1, id: duoUid('s'), charId, startedAt: Date.now(), rounds: [], log: [] };
}

const sessionKey = (charId: string) => `tarot_duo_session_v1_${charId || 'default'}`;
const recordsKey = (charId: string) => `tarot_duo_records_v1_${charId || 'default'}`;
const statsKey = (charId: string) => `tarot_duo_stats_v1_${charId || 'default'}`;

function normalizeSession(raw: unknown, charId: string): DuoSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<DuoSession>;
  if (!r.id || !Array.isArray(r.rounds)) return null;
  return {
    version: 1,
    id: String(r.id),
    charId: r.charId || charId,
    startedAt: typeof r.startedAt === 'number' ? r.startedAt : Date.now(),
    endedAt: r.endedAt,
    rounds: r.rounds.map((x) => ({ ...x, pendingPicks: x.pendingPicks ?? null, cards: Array.isArray(x.cards) ? x.cards : [] })),
    log: Array.isArray(r.log) ? r.log : [],
  };
}

// ─── 进行中的一场 ────────────────────────────────────────────────────────

/**
 * 最近一次的数据留在内存：从对局跳去牌意之书、工坊再回来时组件会重新挂载，
 * 这时写库可能还没落盘，直接用内存里的。
 */
const sessionCache = new Map<string, DuoSession | null>();
const readOk = new Set<string>();
const saveTimers = new Map<string, number>();

// 页面订阅：存档或「TA 正在想」有变化时通知。跳去工坊再回来，旧页面没等完的回复也能落到新页面上。
type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();
const busyMap = new Map<string, string | null>();

export function subscribeDuo(charId: string, fn: Listener): () => void {
  const key = charId || 'default';
  let set = listeners.get(key);
  if (!set) { set = new Set(); listeners.set(key, set); }
  set.add(fn);
  return () => { set?.delete(fn); };
}

function notify(charId: string) {
  const set = listeners.get(charId || 'default');
  if (set) set.forEach((fn) => { try { fn(); } catch { /* 忽略 */ } });
}

/** TA 正在做什么（调 API 中），null = 空闲 */
export function getDuoBusy(charId: string): string | null {
  return busyMap.get(charId || 'default') ?? null;
}

export function setDuoBusy(charId: string, value: string | null) {
  busyMap.set(charId || 'default', value);
  notify(charId);
}

export function peekDuoSession(charId: string): { known: boolean; session: DuoSession | null } {
  const key = charId || 'default';
  return sessionCache.has(key) ? { known: true, session: sessionCache.get(key) ?? null } : { known: false, session: null };
}

export async function loadDuoSession(charId: string): Promise<DuoSession | null> {
  const key = charId || 'default';
  if (sessionCache.has(key)) return sessionCache.get(key) ?? null;
  try {
    const raw = await DB.getAssetRaw(sessionKey(charId));
    const s = normalizeSession(raw, charId);
    // 读库期间页面可能已经开了新的一场，那就以内存为准
    if (sessionCache.has(key)) return sessionCache.get(key) ?? null;
    sessionCache.set(key, s);
    readOk.add(key);
    notify(charId);
    return s;
  } catch {
    // 读失败：当作没有，但不写库，免得把真实存档盖掉
    return null;
  }
}

function writeSessionNow(charId: string) {
  const key = charId || 'default';
  const t = saveTimers.get(key);
  if (t !== undefined) { window.clearTimeout(t); saveTimers.delete(key); }
  if (!readOk.has(key)) return;
  const s = sessionCache.get(key);
  if (s) DB.saveAssetRaw(sessionKey(charId), s).catch(() => undefined);
}

/** 改完就存；400ms 内的连续修改合并成一次写库 */
export function saveDuoSession(session: DuoSession) {
  const key = session.charId || 'default';
  sessionCache.set(key, session);
  readOk.add(key);
  const old = saveTimers.get(key);
  if (old !== undefined) window.clearTimeout(old);
  saveTimers.set(key, window.setTimeout(() => writeSessionNow(session.charId), 400));
  notify(session.charId);
}

export function flushDuoSession(charId: string) {
  writeSessionNow(charId);
}

export async function clearDuoSession(charId: string) {
  const key = charId || 'default';
  const t = saveTimers.get(key);
  if (t !== undefined) { window.clearTimeout(t); saveTimers.delete(key); }
  sessionCache.set(key, null);
  readOk.add(key);
  notify(charId);
  try { await DB.deleteAsset(sessionKey(charId)); } catch { /* 删不掉就算了，下次读到空场也没关系 */ }
}

// ─── 占卜记录 / 猜中次数 ──────────────────────────────────────────────────

export interface DuoRecords { version: 1; sessions: DuoSession[] }

/** 同一个 key 的读写排队，免得两次保存互相覆盖 */
const queues = new Map<string, Promise<unknown>>();
function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  queues.set(key, next.catch(() => undefined));
  return next;
}

export async function loadDuoRecords(charId: string): Promise<DuoRecords> {
  try {
    const raw = await DB.getAssetRaw(recordsKey(charId));
    const list = raw && Array.isArray(raw.sessions) ? raw.sessions : [];
    return { version: 1, sessions: list.map((s: unknown) => normalizeSession(s, charId)).filter(Boolean) as DuoSession[] };
  } catch {
    return { version: 1, sessions: [] };
  }
}

/** 一场有没有值得记下来的内容 */
export function sessionHasContent(s: DuoSession): boolean {
  return s.rounds.some((r) => r.cards.length > 0) || s.log.some((e) => e.from !== 'event');
}

/** 把这一场存进占卜记录（同一场覆盖旧的那份） */
export function upsertDuoRecord(session: DuoSession): Promise<void> {
  const key = recordsKey(session.charId);
  return enqueue(key, async () => {
    if (!sessionHasContent(session)) return;
    let sessions: DuoSession[] = [];
    try {
      const raw = await DB.getAssetRaw(key);
      if (raw && Array.isArray(raw.sessions)) {
        // 顺手把旧存档里的名字字段清掉
        sessions = raw.sessions.map((s: unknown) => normalizeSession(s, session.charId)).filter(Boolean) as DuoSession[];
      }
    } catch {
      // 读失败时不写，免得把以前的记录覆盖成只剩这一场
      return;
    }
    const idx = sessions.findIndex((s) => s.id === session.id);
    const clean = normalizeSession(session, session.charId) ?? session;
    if (idx >= 0) sessions[idx] = clean;
    else sessions.push(clean);
    await DB.saveAssetRaw(key, { version: 1, sessions });
    notify(session.charId);
  });
}

export interface DuoStats {
  version: 1;
  /** 解牌人拿到的分：user = 你（TA 抽我解时），ta = TA（我抽 TA 解时） */
  user: Record<DuoMode, number>;
  ta: Record<DuoMode, number>;
  rounds: number;
}

/** 读猜中次数（称号页用），读失败时返回全 0 */
export async function loadDuoStats(charId: string): Promise<DuoStats> {
  try {
    return await loadDuoStatsStrict(charId);
  } catch {
    return { version: 1, user: { basic: 0, advanced: 0 }, ta: { basic: 0, advanced: 0 }, rounds: 0 };
  }
}

export function addDuoScore(charId: string, reader: 'user' | 'ta', mode: DuoMode, score: number): Promise<void> {
  const key = statsKey(charId);
  return enqueue(key, async () => {
    let stats: DuoStats;
    try {
      stats = await loadDuoStatsStrict(charId);
    } catch {
      return;
    }
    stats[reader][mode] += score;
    stats.rounds += 1;
    await DB.saveAssetRaw(key, stats);
  });
}

async function loadDuoStatsStrict(charId: string): Promise<DuoStats> {
  const raw = await DB.getAssetRaw(statsKey(charId));
  const base: DuoStats = { version: 1, user: { basic: 0, advanced: 0 }, ta: { basic: 0, advanced: 0 }, rounds: 0 };
  if (!raw || typeof raw !== 'object') return base;
  return {
    version: 1,
    user: { basic: Number(raw.user?.basic) || 0, advanced: Number(raw.user?.advanced) || 0 },
    ta: { basic: Number(raw.ta?.basic) || 0, advanced: Number(raw.ta?.advanced) || 0 },
    rounds: Number(raw.rounds) || 0,
  };
}

// ─── TA 的接口（窗外的月亮）/ 玩法说明 ─────────────────────────────────────

export interface DuoApiSetting { baseUrl: string; apiKey: string; model: string }
const API_KEY = 'yuzhou_tarot_ta_api';
const INTRO_KEY = 'yuzhou_tarot_intro_seen_v1';

export function loadDuoApi(): DuoApiSetting {
  try {
    const v = JSON.parse(localStorage.getItem(API_KEY) || '{}');
    return { baseUrl: String(v?.baseUrl || ''), apiKey: String(v?.apiKey || ''), model: String(v?.model || '') };
  } catch {
    return { baseUrl: '', apiKey: '', model: '' };
  }
}

export function saveDuoApi(v: DuoApiSetting) {
  try {
    localStorage.setItem(API_KEY, JSON.stringify({ baseUrl: v.baseUrl.trim(), apiKey: v.apiKey.trim(), model: v.model.trim() }));
  } catch { /* 存不了就算了 */ }
}

export const duoApiFilled = (v: DuoApiSetting) => !!(v.baseUrl.trim() && v.model.trim());

export function introSeen(): boolean {
  try { return localStorage.getItem(INTRO_KEY) === '1'; } catch { return true; }
}

export function markIntroSeen() {
  try { localStorage.setItem(INTRO_KEY, '1'); } catch { /* 忽略 */ }
}

// ─── 占卜记录页用 ─────────────────────────────────────────────────────────

/** 从占卜记录里删掉一场（进行中的那一场不在这里删） */
export function deleteDuoRecord(charId: string, sessionId: string): Promise<boolean> {
  const key = recordsKey(charId);
  return enqueue(key, async () => {
    const raw = await DB.getAssetRaw(key);
    const sessions: DuoSession[] = raw && Array.isArray(raw.sessions)
      ? raw.sessions.map((s: unknown) => normalizeSession(s, charId)).filter(Boolean) as DuoSession[]
      : [];
    const next = sessions.filter((s) => s.id !== sessionId);
    if (next.length === sessions.length) return false;
    await DB.saveAssetRaw(key, { version: 1, sessions: next });
    notify(charId);
    return true;
  });
}
