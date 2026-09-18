/**
 * 论坛 · 长期归档的执行入口（轨道 A 接线层）
 *
 * forumArchive.ts 把"怎么判沉寂、怎么压缩、怎么写进宫殿、怎么推水位"都写完了，
 * 但没有任何地方调用它，所以论坛内容从来没进过长期记忆。这个文件补上执行入口。
 *
 * 为什么不做后台常驻定时器：一次扫描只是读一遍 IndexedDB 加比较时间戳，零 API 成本，
 * 挂在"打开论坛 App"这个天然节点上就够了；只有真扫出沉寂帖子才会入队、才会调模型。
 * 这跟朋友圈那边的取舍一致。
 *
 * 开关沿用角色身上现成的 memoryPalaceEnabled + autoArchiveEnabled——不另起一个论坛
 * 专用开关，免得用户要在两个地方各开一次、开漏一个还查不出原因。
 */

import * as db from './forumDb';
import {
  sweepDormantForumPosts,
  processForumArchiveTask,
  type ForumArchiveContext,
} from './forumArchive';
import type { LightLLMConfig } from './memoryPalace';
import type { CharacterProfile } from '../types';

/**
 * 一次进 App 最多处理几条归档任务。
 *
 * 每条要调一次轻量模型做压缩，再走一次记忆提取。压到 2 条是为了不让"打开论坛"这个
 * 动作变成一次昂贵的批量操作——剩下的任务留在队列里，下次进来接着跑，不会丢。
 */
export const MAX_ARCHIVE_TASKS_PER_PASS = 2;

type ArchiveCapableChar = CharacterProfile & {
  memoryPalaceEnabled?: boolean;
  autoArchiveEnabled?: boolean;
  embeddingConfig?: any;
};

export interface RunForumArchiveParams {
  characters: ArchiveCapableChar[];
  lightLLM?: LightLLMConfig | null;
  userName: string;
  maxTasks?: number;
  force?: boolean;
}

export interface ForumArchiveResult {
  enqueued: number;
  processed: number;
  /** 没有任何角色开启记忆宫殿+自动归档时为 true，此时整趟直接跳过。 */
  skipped: boolean;
}

/**
 * 扫一遍沉寂帖子并处理若干条归档任务。
 *
 * 全程不抛异常：归档是后台维护动作，失败了不该影响用户打开论坛。单条任务内部的
 * 失败由队列自己记录并按退避重试。
 */
export async function runForumArchivePass(params: RunForumArchiveParams): Promise<ForumArchiveResult> {
  const { characters, lightLLM, userName, maxTasks = MAX_ARCHIVE_TASKS_PER_PASS, force } = params;

  const enabled = (characters || []).filter(c => c.memoryPalaceEnabled && c.autoArchiveEnabled);
  if (enabled.length === 0) return { enqueued: 0, processed: 0, skipped: true };

  const byId = new Map(enabled.map(c => [c.id, c]));
  const ctx: ForumArchiveContext = {
    // 只认开了宫殿+自动归档的角色。没开的角色即使参与了讨论也拿不到 profile，
    // 归档会判成 no_target_char 并推进水位跳过，不会反复重扫。
    getCharacterProfile: (charId: string) => byId.get(charId) as any,
    lightLLM,
    userName,
  };

  let enqueued = 0;
  try {
    enqueued = await sweepDormantForumPosts({ force });
  } catch (e: any) {
    console.warn('[ForumArchive] 沉寂扫描失败:', e?.message || String(e));
  }

  let processed = 0;
  try {
    const pending = await db.getPendingForumAiTasks();
    const archiveTasks = pending.filter(t => t.kind === 'memory_archive').slice(0, maxTasks);
    for (const task of archiveTasks) {
      await processForumArchiveTask(task.id, ctx);
      processed++;
    }
  } catch (e: any) {
    console.warn('[ForumArchive] 归档任务处理失败:', e?.message || String(e));
  }

  return { enqueued, processed, skipped: false };
}
