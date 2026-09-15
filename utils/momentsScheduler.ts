/**
 * 朋友圈「异步延时互动」离线 tick 调度器。
 *
 * 结构照抄 utils/worldHome/scheduler.ts 的 WorldScheduler，把"世界"换成"角色"：
 * 按每日固定时段（凌晨/早/午/晚）触发，网页开着时靠 visibilitychange / focus /
 * 主线程轮询三重兜底补火，不需要真正的后台服务。
 *
 * 与 WorldScheduler 的唯一语义差异：这里的"时段允不允许触发"不是看世界配置，
 * 而是看这个角色的 MomentSettings.activeSlots（未设置=四个时段都允许）——
 * 第一版先用简单布尔矩阵，不做"从人设文本推断作息"的复杂 LLM 推理。
 *
 * 只有 MomentSettings.asyncInteraction === true 的角色才会被纳入调度（见
 * toMomentsTickEntries）。没开这个开关的角色继续走 MomentsApp.tsx 里"打开 App
 * 自动生成一次"的旧机制，两套路径互斥，不会重复生成。
 *
 * 存储（localStorage，独立键，不与 world_tick_slots / vr_schedules 挤占）：
 *   - moments_tick_slots: { [charId]: { slots: slot[] } }
 *   - moments_tick_fired: { [charId]: { date: 'YYYY-MM-DD', fired: slot[] } }
 *
 * 时段判定用本机时区（不像家园按世界时区——朋友圈没有"角色所在时区"这个概念，
 * TA 的作息就是跟着用户当地时间走）。
 */

import type { MomentSettings } from './momentsDb';
import { getMomentSettings } from './momentsDb';

export type MomentTickSlot = 'latenight' | 'morning' | 'noon' | 'evening';

const SLOTS_KEY = 'moments_tick_slots';
const FIRED_KEY = 'moments_tick_fired';
const MAIN_THREAD_CHECK_INTERVAL = 60_000;

/** 各时段的起火时刻（小时，本机时间）。四个固定时段，跟家园一致。 */
const SLOT_HOUR: Record<MomentTickSlot, number> = { latenight: 2, morning: 9, noon: 14, evening: 21 };

const ALL_SLOTS: MomentTickSlot[] = ['latenight', 'morning', 'noon', 'evening'];

type SlotEntry = { slots: MomentTickSlot[] };
type SlotsMap = Record<string, SlotEntry>;
type FiredMap = Record<string, { date: string; fired: MomentTickSlot[] }>;

const sameSlots = (a: MomentTickSlot[], b: MomentTickSlot[]): boolean =>
    a.length === b.length && a.every(slot => b.includes(slot));

/**
 * 角色列表 → reconcile 的入参。只收 asyncInteraction=true 的角色；
 * activeSlots 未设置时视为四个时段都允许（跟旧版"随时可能生成"的体验最接近）。
 *
 * 调用点建议跟 toTickEntries 对齐：应用启动时对账一次 + 用户在设置页保存
 * asyncInteraction/activeSlots 时立即对账一次。
 */
export function toMomentsTickEntries(
    charIds: string[],
    settingsByCharId: Map<string, MomentSettings>,
): { charId: string; slots: MomentTickSlot[] }[] {
    const out: { charId: string; slots: MomentTickSlot[] }[] = [];
    for (const charId of charIds) {
        const s = settingsByCharId.get(charId);
        if (!s?.asyncInteraction) continue;
        const slots = s.activeSlots?.length ? s.activeSlots : ALL_SLOTS;
        out.push({ charId, slots });
    }
    return out;
}

function load<T>(key: string): T {
    try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : {};
        return (parsed && typeof parsed === 'object' ? parsed : {}) as T;
    } catch {
        return {} as T;
    }
}

function save(key: string, value: object) {
    if (Object.keys(value).length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
}

/** 本机的「今天」与「现在几点」。 */
const localNow = () => {
    const d = new Date();
    return {
        date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        hour: d.getHours(),
    };
};

let triggerCallback: ((charId: string) => void | Promise<void>) | null = null;
let visibilityListener: (() => void) | null = null;
let focusListener: (() => void) | null = null;
let mainThreadTimer: ReturnType<typeof setInterval> | null = null;

function checkDue() {
    if (!triggerCallback) return;
    const slotsMap = load<SlotsMap>(SLOTS_KEY);
    const firedMap = load<FiredMap>(FIRED_KEY);
    let changed = false;
    const { date, hour } = localNow();

    for (const [charId, entry] of Object.entries(slotsMap)) {
        const slots = entry?.slots || [];
        if (slots.length === 0) continue;
        let rec = firedMap[charId];
        if (!rec || rec.date !== date) {
            rec = { date, fired: [] };
            firedMap[charId] = rec;
            changed = true;
        }
        for (const slot of slots) {
            if (rec.fired.includes(slot)) continue;
            if (hour < SLOT_HOUR[slot]) continue;
            rec.fired.push(slot);
            changed = true;
            void triggerCallback(charId);
            // 一次 check 每个角色最多补一轮：错过的多个时段隔分钟级轮询逐个补，
            // 不在同一瞬间叠加触发（跟 WorldScheduler 同样的考虑）。
            break;
        }
    }
    if (changed) save(FIRED_KEY, firedMap);
}

function handleVisibility() {
    if (document.visibilityState !== 'visible') return;
    checkDue();
}

function attachListeners() {
    detachListeners();
    visibilityListener = handleVisibility;
    document.addEventListener('visibilitychange', visibilityListener);
    focusListener = checkDue;
    window.addEventListener('focus', focusListener);
    if (!mainThreadTimer) mainThreadTimer = setInterval(checkDue, MAIN_THREAD_CHECK_INTERVAL);
}

function detachListeners() {
    if (visibilityListener) {
        document.removeEventListener('visibilitychange', visibilityListener);
        visibilityListener = null;
    }
    if (focusListener) {
        window.removeEventListener('focus', focusListener);
        focusListener = null;
    }
    if (mainThreadTimer) {
        clearInterval(mainThreadTimer);
        mainThreadTimer = null;
    }
}

export const MomentsScheduler = {
    /** 注册触发回调（应用启动时调一次）。 */
    onTrigger(callback: (charId: string) => void | Promise<void>) {
        triggerCallback = callback;
        if (Object.keys(load<SlotsMap>(SLOTS_KEY)).length > 0) {
            attachListeners();
            checkDue();
        }
    },

    /**
     * 以角色 MomentSettings 为准重建调度表。
     * 新加入调度的角色，"今天已经过去的时段"视为已耗尽、不倒着补烧——
     * 避免用户刚打开"异步延时互动"开关就瞬间连环生成好几条动态。
     */
    reconcile(active: { charId: string; slots: MomentTickSlot[] }[]) {
        const previousSlotsMap = load<SlotsMap>(SLOTS_KEY);
        const slotsMap: SlotsMap = {};
        const firedMap = load<FiredMap>(FIRED_KEY);
        let firedChanged = false;
        const { date, hour } = localNow();

        for (const a of active) {
            if (a.slots.length === 0) continue;
            slotsMap[a.charId] = { slots: a.slots };
            const previous = previousSlotsMap[a.charId];
            const configChanged = previous === undefined || !sameSlots(previous.slots, a.slots);
            if (!firedMap[a.charId] || firedMap[a.charId].date !== date || configChanged) {
                firedMap[a.charId] = { date, fired: a.slots.filter(s => hour >= SLOT_HOUR[s]) };
                firedChanged = true;
            }
        }
        for (const id of Object.keys(firedMap)) {
            if (!slotsMap[id]) {
                delete firedMap[id];
                firedChanged = true;
            }
        }

        save(SLOTS_KEY, slotsMap);
        if (firedChanged) save(FIRED_KEY, firedMap);
        if (Object.keys(slotsMap).length > 0) attachListeners();
        else detachListeners();
    },

    /** 立刻触发一轮（设置页手动按钮用，不占用当日时段配额）。 */
    triggerNow(charId: string) {
        if (triggerCallback) void triggerCallback(charId);
    },
};

/**
 * 辅助函数：批量拿一组角色的 MomentSettings，拼成 reconcile 需要的 Map。
 * 调用点（OSContext.tsx 全局注册处）用这个组装 toMomentsTickEntries 的第二个参数。
 */
export async function loadMomentSettingsMap(charIds: string[]): Promise<Map<string, MomentSettings>> {
    const map = new Map<string, MomentSettings>();
    await Promise.all(charIds.map(async id => {
        try {
            map.set(id, await getMomentSettings(id));
        } catch {
            // 单个角色读取失败不影响其他角色对账
        }
    }));
    return map;
}
