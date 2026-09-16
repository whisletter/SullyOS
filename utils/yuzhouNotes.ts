/**
 * 与昼 · 便利贴木板（数据层）
 *
 * - 按角色存一条记录（DB.saveAsset），里面是整块木板：便利贴、木板样式、TA 今天贴过没有
 * - 木板最多 20 张，超出时撕掉最旧的；被撕掉 / 被删除的便利贴如果收藏过，交给记忆宫殿
 * - TA 的便利贴只在用户点 🔄 时生成，一天一次，一次一张，走 safeFetchJson（会进 API 调用记录）
 */
import type { CSSProperties } from 'react';
import type { APIConfig, CharacterProfile, UserProfile } from '../types';
import { DB } from './db';
import { safeFetchJson, extractContent, extractJson } from './safeApi';
import { buildPersonaBlock, buildScheduleBlock, buildTodayChatBlock, nowHHMM, toDateKey } from './yuzhouMood';

export const NOTE_MAX_CHARS = 60;
export const BOARD_MAX_NOTES = 20;
export const NOTE_MAX_STICKERS = 5;

/** 木板尺寸：高 = 宽 × BOARD_RATIO；便利贴边长 = 木板宽 × NOTE_SIZE_RATIO */
export const BOARD_RATIO = 2.3;
export const NOTE_SIZE_RATIO = 0.4;

// ==================== 纸张 ====================
// ✏️ 以后加新纸张：往这个数组里加一项就行。尺寸都用 em，大小便签上看起来一样。
export interface NotePaper {
  id: string;
  name: string;
  /** 纸面样式（背景色 / 花纹） */
  style: CSSProperties;
  /** 字的颜色 */
  ink: string;
}

export const NOTE_PAPERS: NotePaper[] = [
  { id: 'cream', name: '奶油', ink: '#6b4b45', style: { background: 'radial-gradient(circle at 50% 45%, #fffdf9 0%, #fff6ec 60%, #fde8dc 100%)' } },
  { id: 'plain', name: '白纸', ink: '#475569', style: { background: '#ffffff' } },
  { id: 'grid', name: '网格', ink: '#475569', style: { backgroundColor: '#ffffff', backgroundImage: 'linear-gradient(#e5e7eb 1px, transparent 1px), linear-gradient(90deg, #e5e7eb 1px, transparent 1px)', backgroundSize: '1.4em 1.4em' } },
  { id: 'dot', name: '点阵', ink: '#475569', style: { backgroundColor: '#fffdf5', backgroundImage: 'radial-gradient(#d1d5db 1px, transparent 1px)', backgroundSize: '1.4em 1.4em' } },
  { id: 'lined', name: '横线', ink: '#57534e', style: { backgroundColor: '#fefce8', backgroundImage: 'repeating-linear-gradient(transparent 0, transparent 1.55em, #e7e2cf 1.55em, #e7e2cf calc(1.55em + 1px))', backgroundPosition: '0 0.35em' } },
  { id: 'pink', name: '少女', ink: '#8a4a5c', style: { backgroundColor: '#fdf2f8', backgroundImage: 'radial-gradient(#fbcfe8 2px, transparent 2px)', backgroundSize: '2em 2em' } },
  { id: 'dark', name: '夜空', ink: 'rgba(255,255,255,.92)', style: { background: '#1e293b' } },
];

export const paperOf = (id?: string) => NOTE_PAPERS.find(p => p.id === id) || NOTE_PAPERS[0];

// ==================== 贴纸（和交换日记同一套默认贴纸） ====================
const TWEMOJI_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72';
const tw = (code: string) => `${TWEMOJI_BASE}/${code}.png`;

/** name 给 AI 挑选用 */
export const DEFAULT_NOTE_STICKERS: { name: string; url: string }[] = [
  { name: '闪光', url: tw('2728') }, { name: '爱心', url: tw('1f496') }, { name: '樱花', url: tw('1f338') },
  { name: '蝴蝶结', url: tw('1f380') }, { name: '蛋糕', url: tw('1f370') }, { name: '猫', url: tw('1f431') },
  { name: '狗', url: tw('1f436') }, { name: '云', url: tw('2601-fe0f') }, { name: '月亮', url: tw('1f319') },
  { name: '星星', url: tw('2b50') }, { name: '音符', url: tw('1f3b5') }, { name: '草', url: tw('1f33f') },
  { name: '草莓', url: tw('1f353') }, { name: '小熊', url: tw('1f9f8') }, { name: '气球', url: tw('1f388') },
  { name: '情书', url: tw('1f48c') }, { name: '困', url: tw('1f4a4') }, { name: '委屈', url: tw('1f97a') },
  { name: '生气', url: tw('1f621') }, { name: '大哭', url: tw('1f62d') },
];

// ==================== 数据结构 ====================

export interface NoteSticker {
  id: string;
  url: string;
  /** 贴纸中心在纸上的位置，0-100（%） */
  x: number;
  y: number;
  rotation: number;
  scale: number;
}

export interface YuZhouNote {
  id: string;
  author: 'user' | 'ta';
  text: string;
  paperId: string;
  stickers: NoteSticker[];
  /** 左上角在木板上的位置：x 占木板宽的 %，y 占木板高的 % */
  x: number;
  y: number;
  rotation: number;
  z: number;
  starred: boolean;
  createdAt: number;
  /** 用户的便利贴：TA 已经回应过 */
  replied?: boolean;
  /** TA 的便利贴：回应的是哪张（原文留一份，入记忆宫殿时用） */
  replyToId?: string;
  replyToText?: string;
}

export type BoardStyle = 'cork' | 'plaid' | 'photo';

export interface NoteBoardState {
  notes: YuZhouNote[];
  style: BoardStyle;
  /** TA 上次贴便利贴的日期（YYYY-MM-DD），等于今天就不能再点 🔄 */
  taLastDate?: string;
  taLastAt?: number;
}

const EMPTY_STATE: NoteBoardState = { notes: [], style: 'cork' };

const normCharId = (charId?: string | null) => charId || 'default';
const boardAssetId = (charId: string) => `yuzhou-notes-${normCharId(charId)}`;
export const boardPhotoAssetId = (charId: string) => `yuzhou-notes-bg-${normCharId(charId)}`;

export const newId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export async function loadBoard(charId: string): Promise<NoteBoardState> {
  try {
    const raw = await DB.getAsset(boardAssetId(charId));
    if (!raw) return { ...EMPTY_STATE };
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.notes)) return { ...EMPTY_STATE };
    return { ...EMPTY_STATE, ...parsed } as NoteBoardState;
  } catch (e) {
    console.warn('[YuZhou] loadBoard failed', e);
    return { ...EMPTY_STATE };
  }
}

// 串行写入，避免拖动保存和 TA 生成保存互相覆盖
const writeChains = new Map<string, Promise<void>>();
export function saveBoard(charId: string, state: NoteBoardState): Promise<void> {
  const id = boardAssetId(charId);
  const prev = writeChains.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => DB.saveAsset(id, JSON.stringify(state)));
  writeChains.set(id, next);
  return next;
}

/** 超过 20 张：按贴上去的时间撕掉最旧的，返回被撕掉的 */
export function trimBoard(notes: YuZhouNote[]): { kept: YuZhouNote[]; removed: YuZhouNote[] } {
  if (notes.length <= BOARD_MAX_NOTES) return { kept: notes, removed: [] };
  const byAge = [...notes].sort((a, b) => a.createdAt - b.createdAt);
  const removedIds = new Set(byAge.slice(0, notes.length - BOARD_MAX_NOTES).map(n => n.id));
  return { kept: notes.filter(n => !removedIds.has(n.id)), removed: notes.filter(n => removedIds.has(n.id)) };
}

/** 在「当前看得到的那一屏」里随机找个位置，歪一点 */
export function randomPlacement(viewTopPct: number, viewBottomPct: number) {
  const noteHeightPct = (NOTE_SIZE_RATIO / BOARD_RATIO) * 100;
  const top = Math.max(1, viewTopPct + 1);
  const bottom = Math.max(top, Math.min(100 - noteHeightPct - 1, viewBottomPct - noteHeightPct - 2));
  return {
    x: 3 + Math.random() * (100 - NOTE_SIZE_RATIO * 100 - 6),
    y: top + Math.random() * (bottom - top),
    rotation: Math.round((Math.random() * 22 - 11) * 10) / 10,
  };
}

/** 等 TA 回应的那张：TA 上次贴完之后，用户贴的最新一张 */
export function pendingUserNote(state: NoteBoardState): YuZhouNote | undefined {
  const since = state.taLastAt || 0;
  return state.notes
    .filter(n => n.author === 'user' && !n.replied && n.createdAt > since)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

// ==================== TA 的便利贴（一次调用） ====================

export async function generateTaNote(opts: {
  char: CharacterProfile;
  userProfile: UserProfile;
  apiConfig: APIConfig;
  replyTo?: YuZhouNote;
  signal?: AbortSignal;
}): Promise<{ text: string; paperId: string; stickers: string[] }> {
  const { char, userProfile, apiConfig, replyTo, signal } = opts;
  if (!apiConfig?.baseUrl || !apiConfig?.apiKey) throw new Error('请先配置 API');

  const [scheduleBlock, chatBlock] = await Promise.all([
    buildScheduleBlock(char),
    buildTodayChatBlock(char, userProfile),
  ]);
  const persona = buildPersonaBlock(char, userProfile);
  const userName = userProfile?.name || '对方';
  const d = new Date();
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];

  const taskBlock = replyTo
    ? `${userName}刚在你们家的便利贴木板上贴了一张给你：\n「${replyTo.text}」\n\n任务：以${char.name}本人的口吻，撕一张便利贴写下你的回应，贴在旁边。`
    : `任务：以${char.name}本人的口吻，在你们家的便利贴木板上给${userName}贴一张便利贴。\n内容来自你自己今天的日程和当天记忆，可以是叮嘱、提醒、分享一件小事、或一句想说的话。`;

  const prompt = `${persona}

---
现在是 ${toDateKey(d)} 星期${weekday} ${nowHHMM()}。
${scheduleBlock || '（今天没有日程记录，按你的性格和近期生活自然推断。）'}

${chatBlock || '（今天还没有聊天记录。）'}

---
${taskBlock}
要求：
1. 1～3 句话，每句都短，像随手写在便利贴上的日常口语，总共不超过 ${NOTE_MAX_CHARS} 个字。
2. 不要长句，不要引号，不要旁白和动作描写，不要署名。
3. paper 从这些纸张里选一个合你心情的：${NOTE_PAPERS.map(p => `${p.id}(${p.name})`).join('、')}
4. stickers 从这些贴纸里选 0～2 个，也可以不选：${DEFAULT_NOTE_STICKERS.map(s => s.name).join('、')}

只输出 JSON，不要任何其他内容：
{"text":"……","paper":"cream","stickers":["爱心"]}`;

  const baseUrl = apiConfig.baseUrl.replace(/\/+$/, '');
  const data = await safeFetchJson(
    `${baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
      body: JSON.stringify({
        model: apiConfig.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.9,
        max_tokens: 2000,
        stream: false,
      }),
      signal,
    },
    0,
    90000,
    { appName: '与昼', charId: char.id, charName: char.name, purpose: replyTo ? '生成TA便利贴（回应）' : '生成TA便利贴' },
  );

  const raw = extractContent(data);
  const json = extractJson(raw, { allowTruncated: true, silent: true });
  const text = String(json?.text ?? json?.note ?? '').trim().replace(/^["“「]|["”」]$/g, '').slice(0, NOTE_MAX_CHARS);
  if (!text) throw new Error('没有解析到便利贴内容，请重试');
  const paperId = NOTE_PAPERS.some(p => p.id === json?.paper) ? String(json.paper) : 'cream';
  const names: unknown[] = Array.isArray(json?.stickers) ? json.stickers : [];
  const stickers = names
    .map(n => DEFAULT_NOTE_STICKERS.find(s => s.name === String(n))?.url)
    .filter((u): u is string => !!u)
    .slice(0, 2);
  return { text, paperId, stickers };
}
