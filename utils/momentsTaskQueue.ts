/**
 * 朋友圈本地后台任务队列。
 *
 * 任务状态持久化在 SullyOS_Moments IndexedDB，因此离开朋友圈页面不会取消任务；
 * 页面重新打开时会自动继续 pending / 超时 processing 任务。API Key 不写入任务库，
 * 处理器每次从当前调用方提供的配置读取。
 */
import type { LightLLMConfig } from './memoryPalace';
import type { VisionApiConfig } from '../types';
import {
  createMomentAiTaskId,
  enqueueMomentAiTask,
  getPendingMomentAiTasks,
  claimMomentAiTask,
  finishMomentAiTask,
  deleteMomentAiTasksForPost,
  getPostsByCharId,
  savePost,
  type MomentAiTask,
  type MomentPost,
} from './momentsDb';
import { preparePublishedMomentImages, upsertMomentPin } from './momentsMemory';

export interface MomentTaskQueueConfig {
  visionApi?: VisionApiConfig | null;
  lightLLM?: LightLLMConfig | null;
}

type ConfigProvider = () => MomentTaskQueueConfig;

let provider: ConfigProvider | null = null;
let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const running = new Set<string>();
const cancelledPosts = new Set<string>();
const CONCURRENCY = 3;

export async function enqueuePublishedMomentTasks(post: MomentPost): Promise<void> {
  const now = Date.now();
  const tasks: MomentAiTask[] = [{
    id: createMomentAiTaskId('pin', post.id), kind: 'pin', postId: post.id, charId: post.charId,
    status: 'pending', attempts: 0, createdAt: now, updatedAt: now, nextRunAt: now,
  }];
  if (post.author === 'user' && post.images?.length) tasks.push({
    id: createMomentAiTaskId('image_ai', post.id), kind: 'image_ai', postId: post.id, charId: post.charId,
    status: 'pending', attempts: 0, createdAt: now, updatedAt: now, nextRunAt: now,
  });
  await Promise.all(tasks.map(enqueueMomentAiTask));
  void pumpMomentTaskQueue();
}

export async function deletePublishedMomentTasks(postId: string): Promise<void> {
  cancelledPosts.add(postId);
  await deleteMomentAiTasksForPost(postId);
}

export function startMomentTaskQueue(getConfig: ConfigProvider): void {
  provider = getConfig;
  if (started) { void pumpMomentTaskQueue(); return; }
  started = true;
  void pumpMomentTaskQueue();
}

async function runTask(task: MomentAiTask): Promise<void> {
  const claimed = await claimMomentAiTask(task.id);
  if (!claimed || running.has(claimed.id)) return;
  running.add(claimed.id);
  try {
    if (cancelledPosts.has(claimed.postId)) { await finishMomentAiTask(claimed.id, true); return; }
    const posts = await getPostsByCharId(claimed.charId);
    const post = posts.find(p => p.id === claimed.postId);
    if (!post) { await finishMomentAiTask(claimed.id, true); return; }
    const cfg = provider?.() || {};

    if (claimed.kind === 'pin') {
      // 不等待图片 AI：文字/音乐/文章及图片占位便利贴可以立即写入；图片完成后 image_ai 再刷新一次。
      if (cancelledPosts.has(claimed.postId)) { await finishMomentAiTask(claimed.id, true); return; }
      await upsertMomentPin(post);
    } else {
      const prepared = await preparePublishedMomentImages(post, cfg.visionApi || undefined, cfg.lightLLM || undefined);
      const latest = (await getPostsByCharId(post.charId)).find(p => p.id === post.id);
      if (!latest || cancelledPosts.has(claimed.postId)) { await finishMomentAiTask(claimed.id, true); return; }
      const finalPost: MomentPost = {
        ...latest,
        imageDescriptions: prepared.imageDescriptions,
        imageKeywords: prepared.imageKeywords,
        updatedAt: prepared !== post ? Date.now() : latest.updatedAt,
      };
      if (cancelledPosts.has(claimed.postId)) { await finishMomentAiTask(claimed.id, true); return; }
      if (prepared !== post) await savePost(finalPost);
      await upsertMomentPin(finalPost);
    }
    await finishMomentAiTask(claimed.id, true);
    try { window.dispatchEvent(new CustomEvent('moments-task-updated', { detail: { postId: claimed.postId, kind: claimed.kind } })); } catch {}
  } catch (e: any) {
    await finishMomentAiTask(claimed.id, false, e?.message || String(e));
  } finally {
    running.delete(claimed.id);
  }
}

export async function pumpMomentTaskQueue(): Promise<void> {
  if (!started && !provider) return;
  if (running.size < CONCURRENCY) {
    const tasks = await getPendingMomentAiTasks();
    const available = tasks.filter(t => !running.has(t.id)).slice(0, Math.max(0, CONCURRENCY - running.size));
    await Promise.all(available.map(runTask));
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void pumpMomentTaskQueue(); }, running.size ? 500 : 2500);
}

// 页面可见性恢复时立即扫一遍；浏览器后台节流时也不会丢任务，重新进入页面后会继续。
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void pumpMomentTaskQueue(); });
}
