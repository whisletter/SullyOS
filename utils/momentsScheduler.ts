/**
 * 朋友圈「异步延时互动」离线 tick 调度器。
 *
 * === v2：改成"读日程决定今天什么时候发"，取代 v1 的固定4时段方案 ===
 *
 * 触发时机不再是写死的四个钟点，而是当天的"朋友圈发布窗口"（"今天大概几点到几点
 * 方便发朋友圈"，AI 生成日程时顺便判断，见 utils/scheduleGenerator.ts，存取和校验
 * 都在 utils/momentsWindow.ts）。这次改造踩定的四条设计决策：
 *
 *  1. 不新增 LLM 调用去解析日程——窗口是生成日程那次调用顺带输出的一个字段，
 *     调度器只读缓存（momentsWindow.ts 落的 localStorage），不再临时调 LLM。
 *  2. 区间内要有随机性："到点必发"太机械。具体触发分钟数由 charId + 日期 +
 *     窗口序号做种子算一个确定性随机值（momentsWindow.ts 的 pickFireMinute）——
 *     同一天内刷多少次页面结果都一样，跨天/换日程会自然重算。
 *  3. 不需要额外的每日重算逻辑：窗口跟日程同一次生成、按 dateKey 存，日程本来
 *     就是按天生成的，缓存天然按天刷新。
 *  4. 没日程 = 当天异步功能静默失效：不发、不报错、不回退成旧的固定时段兜底，
 *     也不会转去走"打开 App 自动生成一次"的旧路径——那条路径本身就是只在
 *     asyncInteraction=false 时才启用的，跟"今天有没有窗口"无关（见 MomentsApp.tsx）。
 *     宁可"今天没配日程就不主动发"，也不在没有依据的情况下瞎猜时间。
 *
 * 窗口数据只存 localStorage、由 momentsWindow.ts 统一读写，这里不直接碰
 * IndexedDB——一是不需要（读写都很轻量，同步 localStorage 足够），二是保持
 * "朋友圈日程窗口"跟用户可见的 DailySchedule（IndexedDB）结构上彻底分开，
 * 不给"查看角色日程"之类的界面任何意外读到它的机会（详见 momentsWindow.ts 顶部注释）。
 *
 * 与"家园" WorldScheduler 共用的部分：网页开着时靠 visibilitychange / focus /
 * 主线程轮询三重兜底补火，不需要真正的后台服务；一次 check 每个角色最多补一轮，
 * 避免错过的多个窗口在同一瞬间叠加触发。
 *
 * 只有 MomentSettings.asyncInteraction === true 的角色才会被纳入调度（见
 * toMomentsTickEntries）。没开这个开关的角色继续走 MomentsApp.tsx 里"打开 App
 * 自动生成一次"的旧机制，两套路径互斥，不会重复生成。
 *
 * 时段判定用本机时区（不像家园按世界时区——朋友圈没有"角色所在时区"这个概念，
 * TA 的作息就是跟着用户当地时间走）。
 *
 * 存储（localStorage，独立键，不与 world_tick_slots / vr_schedules / moments_schedule_windows 挤占）：
 *   - moments_active_chars: string[]（当前纳入调度的 charId 列表）
 *   - moments_window_fired: { [charId]: { date: 'YYYY-MM-DD', fired: number[] } }
 *     （fired 存的是当天已经触发过的窗口序号，不是钟点）
 */

import type { MomentSettings } from './momentsDb';
import { getMomentSettings } from './momentsDb';
import { getMomentsWindows, pickFireMinute } from './momentsWindow';

const ACTIVE_KEY = 'moments_active_chars';
const FIRED_KEY = 'moments_window_fired';
const MAIN_THREAD_CHECK_INTERVAL = 60_000;

type FiredMap = Record<string, { date: string; fired: number[] }>;

/**
 * 角色列表 → reconcile 的入参。只收 asyncInteraction=true 的角色 id；
 * 具体"今天几点发"完全由当天的朋友圈发布窗口决定，这里不再需要传递任何时段配置
 * （v1 的 activeSlots 已废弃，不参与判断）。
 *
 * 调用点建议跟旧版一致：应用启动时对账一次 + 用户在设置页保存 asyncInteraction
 * 时立即对账一次。函数签名刻意保持不变（仍接收 settingsByCharId），只是内部
 * 判断逻辑变了——调用方代码不用跟着改。
 */
export function toMomentsTickEntries(
    charIds: string[],
    settingsByCharId: Map<string, MomentSettings>,
): string[] {
    return charIds.filter(id => settingsByCharId.get(id)?.asyncInteraction === true);
}

function load<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return (parsed ?? fallback) as T;
    } catch {
        return fallback;
    }
}

function save(key: string, value: unknown) {
    const isEmpty = Array.isArray(value)
        ? value.length === 0
        : (value && typeof value === 'object' ? Object.keys(value).length === 0 : !value);
    if (isEmpty) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
}

/** 本机的「今天」（YYYY-MM-DD）与「现在是当天第几分钟」（0-1439）。 */
const localNow = () => {
    const d = new Date();
    return {
        date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        minutes: d.getHours() * 60 + d.getMinutes(),
    };
};

let triggerCallback: ((charId: string) => void | Promise<void>) | null = null;
let visibilityListener: (() => void) | null = null;
let focusListener: (() => void) | null = null;
let mainThreadTimer: ReturnType<typeof setInterval> | null = null;

function checkDue() {
    if (!triggerCallback) return;
    const activeCharIds = load<string[]>(ACTIVE_KEY, []);
    if (activeCharIds.length === 0) return;
    const firedMap = load<FiredMap>(FIRED_KEY, {});
    let changed = false;
    const { date, minutes } = localNow();

    for (const charId of activeCharIds) {
        const windows = getMomentsWindows(charId, date);
        // 今天没日程 / 日程没给窗口：静默跳过，不发也不报错（有意选择，见文件头注释）
        if (windows.length === 0) continue;

        let rec = firedMap[charId];
        if (!rec || rec.date !== date) {
            rec = { date, fired: [] };
            firedMap[charId] = rec;
            changed = true;
        }
        for (let i = 0; i < windows.length; i++) {
            if (rec.fired.includes(i)) continue;
            const fireAt = pickFireMinute(charId, date, i, windows[i]);
            if (minutes < fireAt) continue;
            rec.fired.push(i);
            changed = true;
            void triggerCallback(charId);
            // 一次 check 每个角色最多补一轮：错过的多个窗口隔分钟级轮询逐个补，
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
        if (load<string[]>(ACTIVE_KEY, []).length > 0) {
            attachListeners();
            checkDue();
        }
    },

    /**
     * 以角色 MomentSettings.asyncInteraction 为准重建"纳入调度的角色"列表。
     *
     * 新加入调度的角色，"今天已经过去的窗口"视为已耗尽、不倒着补烧——避免用户
     * 刚打开"异步延时互动"开关，若窗口恰好已经过去，就立刻补发一条动态。
     */
    reconcile(activeCharIds: string[]) {
        const previousActive = new Set(load<string[]>(ACTIVE_KEY, []));
        const unique = Array.from(new Set(activeCharIds));
        const newlyAdded = unique.filter(id => !previousActive.has(id));

        save(ACTIVE_KEY, unique);

        const firedMap = load<FiredMap>(FIRED_KEY, {});
        let changed = false;
        for (const id of Object.keys(firedMap)) {
            if (!unique.includes(id)) {
                delete firedMap[id];
                changed = true;
            }
        }

        if (newlyAdded.length > 0) {
            const { date, minutes } = localNow();
            for (const charId of newlyAdded) {
                const windows = getMomentsWindows(charId, date);
                if (windows.length === 0) continue;
                const alreadyPast: number[] = [];
                windows.forEach((w, i) => {
                    if (minutes >= pickFireMinute(charId, date, i, w)) alreadyPast.push(i);
                });
                if (alreadyPast.length > 0) {
                    firedMap[charId] = { date, fired: alreadyPast };
                    changed = true;
                }
            }
        }

        if (changed) save(FIRED_KEY, firedMap);
        if (unique.length > 0) attachListeners();
        else detachListeners();
    },

    /** 立刻触发一轮（设置页手动按钮用，不占用当日窗口配额）。 */
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
