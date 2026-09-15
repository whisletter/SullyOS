/**
 * 朋友圈异步调度 · "今日发布窗口" 的存储 + 校验 + 调度算法。
 *
 * momentsWindows 是日程生成时 AI 顺便判断的一个信号（"今天大概几点方便刷/发朋友圈"，
 * 见 utils/scheduleGenerator.ts），但刻意不挂在 DailySchedule 上、也不进 IndexedDB——
 * DailySchedule 是"角色日程"这个用户可见功能的数据模型，可能有专门界面展示给用户看；
 * 这个字段只是朋友圈调度器的内部调度参数，混进 DailySchedule 里容易被那类 UI 意外
 * 渲染出来。存取都收在这一个文件里，单独用 localStorage，跟 DailySchedule 完全不
 * 共享数据结构，结构上就不存在"被日程查看界面带出来"的可能。
 *
 * 生成侧（scheduleGenerator.ts）和调度侧（momentsScheduler.ts）都只通过这里的函数
 * 读写，不直接碰 localStorage key，避免两边校验口径分叉。
 */

import type { MomentsWindow } from '../types';

export type { MomentsWindow };

/** 一天最多允许几个发布窗口——克制着来，日程 prompt 里也是按这个数字要求 AI 的。 */
export const MAX_MOMENTS_WINDOWS_PER_DAY = 2;

const STORAGE_KEY = 'moments_schedule_windows';

type WindowCacheMap = Record<string, { date: string; windows: MomentsWindow[] }>;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const toMinutes = (hhmm: string): number | null => {
    const m = TIME_RE.exec(hhmm);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
};

/**
 * 校验 + 清洗一批候选窗口：格式不对 / start>=end（含跨零点，比如 "23:30"-"01:00"）的
 * 整条丢弃，不猜怎么处理；幸存的按 start 排序，最多保留 MAX_MOMENTS_WINDOWS_PER_DAY 条。
 *
 * 写入（AI 原始 JSON 输出）和读取（localStorage 里已经存过的数据）都过这一道——
 * 已经落盘的数据也可能因为老版本 schema、手改 localStorage 等原因不干净。
 */
export function sanitizeMomentsWindows(raw: unknown): MomentsWindow[] {
    if (!Array.isArray(raw)) return [];
    const out: MomentsWindow[] = [];
    for (const item of raw) {
        const start = typeof (item as any)?.start === 'string' ? (item as any).start.trim() : '';
        const end = typeof (item as any)?.end === 'string' ? (item as any).end.trim() : '';
        const startMin = toMinutes(start);
        const endMin = toMinutes(end);
        if (startMin === null || endMin === null) continue;
        if (endMin <= startMin) continue;
        out.push({ start, end });
    }
    out.sort((a, b) => a.start.localeCompare(b.start));
    return out.slice(0, MAX_MOMENTS_WINDOWS_PER_DAY);
}

function loadCache(): WindowCacheMap {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return (parsed && typeof parsed === 'object' ? parsed : {}) as WindowCacheMap;
    } catch {
        return {};
    }
}

function saveCache(map: WindowCacheMap) {
    if (Object.keys(map).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

/**
 * 落盘"今天的朋友圈发布窗口"。由 scheduleGenerator.ts 在生成日程的同一次调用里写入，
 * 不额外调用 LLM。传入原始（未校验）数据即可，内部会过 sanitizeMomentsWindows；
 * 清洗后为空则直接清掉这个角色的缓存条目（等价于"今天没有可发布窗口"）。
 *
 * 只存 localStorage、不随备份迁移——跟同目录 momentsScheduler.ts 的
 * moments_active_chars / moments_window_fired 是同一个取舍：这是纯调度用的
 * 派生数据，丢了最多是"今天这条不发了"，不是要长期保存的内容。
 */
export function saveMomentsWindows(charId: string, dateKey: string, rawWindows: unknown): void {
    const windows = sanitizeMomentsWindows(rawWindows);
    const map = loadCache();
    if (windows.length === 0) delete map[charId];
    else map[charId] = { date: dateKey, windows };
    saveCache(map);
}

/** 读某个角色"今天"的发布窗口。缓存日期跟传入的 dateKey 不一致（隔天了/还没生成）一律当没有。 */
export function getMomentsWindows(charId: string, dateKey: string): MomentsWindow[] {
    const entry = loadCache()[charId];
    if (!entry || entry.date !== dateKey) return [];
    return sanitizeMomentsWindows(entry.windows);
}

/** 简单的字符串哈希（FNV-1a），用来给"确定性随机数"取种子。 */
function hashSeed(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/**
 * 在窗口内取一个"今天固定"的随机触发分钟数（0-1439，从当天零点起算）。
 *
 * 确定性：种子只取 charId + dateKey + windowIndex + 窗口本身的起止时刻，不掺
 * Math.random()、不掺调用时刻——同一天内不管刷新几次页面、调度器轮询检查多少次，
 * 算出来的触发时刻都一样，不会出现"同一天来回刷新，发布时刻跳来跳去"的诡异体验。
 * 跨天（dateKey 变了）或窗口内容变了（日程重新生成换了区间），种子跟着变，
 * 结果自然也换——这正是"每天重新算，不用额外的每日重算逻辑"想要的效果。
 */
export function pickFireMinute(
    charId: string,
    dateKey: string,
    windowIndex: number,
    win: MomentsWindow,
): number {
    const startMin = toMinutes(win.start);
    const endMin = toMinutes(win.end);
    if (startMin === null || endMin === null || endMin <= startMin) return startMin ?? 0;
    const span = endMin - startMin;
    const seed = hashSeed(`${charId}|${dateKey}|${windowIndex}|${win.start}|${win.end}`);
    return startMin + (seed % span);
}
