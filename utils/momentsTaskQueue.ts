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
import { archiveMomentPost, sweepDormantMoments } from './momentsArchive';
import type { CharacterProfile } from '../types';

export interface MomentTaskQueueConfig {
  visionApi?: VisionApiConfig | null;
  lightLLM?: LightLLMConfig | null;
  /**
   * 当前上下文里的角色档案。memory_archive 任务需要它（要 memoryPalaceEnabled /
   * embeddingConfig / systemPrompt）。队列里只存 charId 不存档案，所以运行时从这里取；
   * 取不到（比如用户已经切到别的角色）就把任务放回队列，等下次扫描重新排。
   */
  char?: CharacterProfile | null;
  /** 用户昵称，进 charContext 用 */
  userName?: string;
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
  // 注意：这里刻意不做沉寂扫描。归档扫描只挂在「打开朋友圈」和「评论区产生新互动」
  // 两个节点上，站点启动本身不触发任何归档相关的读写。
  if (started) { void pumpMomentTaskQueue(); return; }
  started = true;
  void pumpMomentTaskQueue();
}

/**
 * 供页面侧调用的沉寂扫描触发器：只有两个调用点 —— 打开朋友圈时、评论区产生新互动之后。
 * 内部有 30s 节流，重复调用是安全的。
 */
export async function triggerDormancySweep(charId: string): Promise<void> {
  if (!charId) return;
  const enqueued = await sweepDormantMoments(charId);
  if (enqueued) void pumpMomentTaskQueue();
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

    if (claimed.kind === 'memory_archive') {
      // 沉寂归档：正文 + 水位之后的新评论 → 记忆宫殿。水位只在提取成功后推进，
      // 失败会抛出去走队列的指数退避，那批评论不会丢。
      const char = cfg.char && cfg.char.id === claimed.charId ? cfg.char : null;
      if (!char) {
        // 不在这个角色的上下文里，不是错误，不消耗重试次数：标完成，下次扫描会重新入队
        console.log('[Moments] 归档任务暂缺角色档案，等待下次扫描:', claimed.postId);
        await finishMomentAiTask(claimed.id, true);
        return;
      }
      const outcome = await archiveMomentPost(claimed.postId, {
        char,
        lightLLM: cfg.lightLLM,
        userName: cfg.userName || '用户',
      });
      if (outcome === 'not_ready') {
        // 宫殿没开 / lightLLM / embedding 没配好。同样不算失败，配好之后下次扫描再来。
        console.log('[Moments] 记忆宫殿未就绪，跳过归档:', claimed.postId);
      }
      await finishMomentAiTask(claimed.id, true);
      try { window.dispatchEvent(new CustomEvent('moments-task-updated', { detail: { postId: claimed.postId, kind: claimed.kind } })); } catch {}
      return;
    }

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
