/**
 * 与昼 · 心情数据（今日心情 + 月度日历共用）
 *
 * 同步机制对齐朋友圈：
 *   1. 写入 IndexedDB（复用 DB.saveAsset，按「角色 + 月份」分桶，一个月一条记录）
 *   2. 写完后在 window 上广播 YUZHOU_MOOD_EVENT
 *   3. 今日心情 / 月度日历各自监听事件，收到后重新读库刷新
 *
 * TA 的心情只在用户点「生成」按钮时调用一次 API，不会自动触发。
 * 请求走 safeFetchJson 并带 meta，会出现在「设置 → API 调用记录」里。
 */
import type { APIConfig, CharacterProfile, UserProfile, Message, Emoji, ScheduleSlot } from '../types';
import { DB } from './db';
import { safeFetchJson, extractContent, extractJson } from './safeApi';
import { ContextBuilder } from './context';
import { getDailyScheduleForChar } from './dailySchedule';
import { isScheduleFeatureOn, formatChatHistoryForSchedule } from './scheduleGenerator';

export const YUZHOU_MOOD_EVENT = 'yuzhou-mood-updated';

export const TA_EMOJIS = ['😊', '🥰', '😸', '😠', '😢', '😣', '😾', '😎', '😳', '🤧', '😈', '😼'];

export interface MoodSide {
  emoji: string;
  text: string;
  updatedAt: number;
}

export interface DayMood {
  user?: MoodSide;
  ta?: MoodSide;
}

/** key = YYYY-MM-DD */
export type MonthMoods = Record<string, DayMood>;

export interface YuZhouMoodEventDetail {
  charId: string;
  dateKey: string;
  side: 'user' | 'ta';
}

// ==================== 日期工具 ====================

export const toDateKey = (d: Date = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export const monthKeyOf = (dateKey: string) => dateKey.slice(0, 7);

const normCharId = (charId?: string | null) => charId || 'default';
const assetIdOf = (charId: string, monthKey: string) => `yuzhou-mood-${normCharId(charId)}-${monthKey}`;

// ==================== 读写 ====================

export async function loadMonthMoods(charId: string, monthKey: string): Promise<MonthMoods> {
  try {
    const raw = await DB.getAsset(assetIdOf(charId, monthKey));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as MonthMoods : {};
  } catch (e) {
    console.warn('[YuZhou] loadMonthMoods failed', e);
    return {};
  }
}

export async function loadDayMood(charId: string, dateKey: string): Promise<DayMood> {
  const month = await loadMonthMoods(charId, monthKeyOf(dateKey));
  return month[dateKey] || {};
}

// 同一个月份桶的写入串行执行，避免「用户打字保存」和「TA 生成保存」同时读改写互相覆盖
const writeChains = new Map<string, Promise<void>>();

export function saveDayMood(charId: string, dateKey: string, side: 'user' | 'ta', value: MoodSide): Promise<void> {
  const id = assetIdOf(charId, monthKeyOf(dateKey));
  const prev = writeChains.get(id) || Promise.resolve();
  const next = prev.catch(() => { /* 上一次失败不影响这次 */ }).then(async () => {
    const month = await loadMonthMoods(charId, monthKeyOf(dateKey));
    month[dateKey] = { ...month[dateKey], [side]: value };
    await DB.saveAsset(id, JSON.stringify(month));
  });
  writeChains.set(id, next);
  return next.then(() => {
    const detail: YuZhouMoodEventDetail = { charId: normCharId(charId), dateKey, side };
    window.dispatchEvent(new CustomEvent(YUZHOU_MOOD_EVENT, { detail }));
  });
}

// ==================== TA 今日心情生成（一次调用） ====================

export const nowHHMM = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 读今天已有的日程（只读，不会为此额外生成日程） */
export async function buildScheduleBlock(char: CharacterProfile): Promise<string> {
  try {
    if (!isScheduleFeatureOn(char)) return '';
    const schedule = await getDailyScheduleForChar(char, new Date());
    if (!schedule?.slots?.length) return '';
    const now = nowHHMM();
    const lines = schedule.slots.map((s: ScheduleSlot) => {
      const done = s.startTime <= now ? '（已过）' : '（未到）';
      const desc = s.description ? `：${s.description}` : '';
      const where = s.location ? ` @${s.location}` : '';
      return `- ${s.startTime}${done} ${s.emoji || ''}${s.activity}${desc}${where}`;
    });
    let block = `【你今天的日程】\n${lines.join('\n')}`;
    // 意识流：取当前时间之前最近的一段
    const flow = schedule.flowNarrative;
    if (flow) {
      const key = Object.keys(flow).filter(k => k <= now).sort().pop();
      if (key && flow[key]) block += `\n\n【截至现在的内心独白】\n${String(flow[key]).slice(-600)}`;
    }
    return block;
  } catch (e) {
    console.warn('[YuZhou] read schedule failed (non-fatal)', e);
    return '';
  }
}

/** 今天的聊天记录（当天记忆的一部分） */
export async function buildTodayChatBlock(char: CharacterProfile, user: UserProfile): Promise<string> {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const recent = await DB.getRecentMessagesByCharId(char.id, 60, true);
    const today = recent.filter((m: Message) => m.timestamp >= startOfToday.getTime());
    if (today.length === 0) return '';
    const emojis = await DB.getEmojis().catch(() => [] as Emoji[]);
    let text = '';
    try {
      text = formatChatHistoryForSchedule(today, char, user, emojis);
    } catch {
      text = today
        .filter(m => typeof m.content === 'string' && !m.content.startsWith('data:'))
        .map(m => `${m.role === 'user' ? (user.name || '用户') : char.name}：${m.content}`)
        .join('\n');
    }
    if (!text) return '';
    return `【今天和${user.name || '用户'}的聊天（节选）】\n${text.slice(-3000)}`;
  } catch (e) {
    console.warn('[YuZhou] read today chat failed (non-fatal)', e);
    return '';
  }
}

/** 角色人设 + 记忆：优先复用全项目统一的上下文构建器 */
export function buildPersonaBlock(char: CharacterProfile, user: UserProfile): string {
  try {
    const ctx = (ContextBuilder as any).buildCoreContext(char, user, true);
    if (typeof ctx === 'string' && ctx.trim()) return ctx;
  } catch (e) {
    console.warn('[YuZhou] buildCoreContext failed, fallback to basic persona', e);
  }
  const mem = (char.memories || []).slice(-5).map(m => `- ${m.date}：${m.summary}`).join('\n');
  return [
    `你是${char.name}。`,
    char.systemPrompt || char.description || '',
    mem ? `【近期记忆】\n${mem}` : '',
  ].filter(Boolean).join('\n\n');
}

export async function generateTaDailyMood(opts: {
  char: CharacterProfile;
  userProfile: UserProfile;
  apiConfig: APIConfig;
  signal?: AbortSignal;
}): Promise<MoodSide> {
  const { char, userProfile, apiConfig, signal } = opts;
  if (!apiConfig?.baseUrl || !apiConfig?.apiKey) throw new Error('请先配置 API');

  const [scheduleBlock, chatBlock] = await Promise.all([
    buildScheduleBlock(char),
    buildTodayChatBlock(char, userProfile),
  ]);
  const persona = buildPersonaBlock(char, userProfile);
  const d = new Date();
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];

  const prompt = `${persona}

---
现在是 ${toDateKey(d)} 星期${weekday} ${nowHHMM()}。
${scheduleBlock || '（今天没有日程记录，按你的性格和近期生活自然推断。）'}

${chatBlock || '（今天还没有聊天记录。）'}

---
任务：以${char.name}本人的第一人称，写下你「今天此刻」的心情，就像在情侣 App 的心情栏里随手记一笔。
要求：
1. 心情来自你自己今天的日程经历和当天记忆，是你自己的生活，不要围绕"等对方/想对方"打转。
2. mood 不超过 45 个字，口语化，符合你的说话习惯，不要加引号、不要旁白。
3. emoji 必须从下面列表里选一个最贴合的：${TA_EMOJIS.join(' ')}

只输出 JSON，不要任何其他内容：
{"emoji":"😊","mood":"……"}`;

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
    // 「设置 → API 调用记录」里的标签
    { appName: '与昼', charId: char.id, charName: char.name, purpose: '生成TA今日心情' },
  );

  const raw = extractContent(data);
  const json = extractJson(raw, { allowTruncated: true, silent: true });
  const text = String(json?.mood ?? json?.text ?? '').trim().replace(/^["“]|["”]$/g, '').slice(0, 50);
  if (!text) throw new Error('没有解析到心情内容，请重试');
  const emoji = TA_EMOJIS.includes(String(json?.emoji)) ? String(json.emoji) : '😊';

  return { emoji, text, updatedAt: Date.now() };
}
