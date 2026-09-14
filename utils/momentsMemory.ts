/**
 * 朋友圈 → Memory Palace（轨道 B）
 *
 * 这里只负责“即时便利贴”以及发布时图片识图/关键词压缩。
 * 正式长期归档（轨道 A）不在这里处理。
 */

import type { MomentPost } from './momentsDb';
import { savePost, getPostsByCharId } from './momentsDb';
import { describeImageWithVisionApi, isVisionApiReady } from './visionApi';
import type { VisionApiConfig } from '../types';
import { safeFetchJson, extractJson } from './safeApi';
import { MemoryNodeDB } from './memoryPalace';
import type { LightLLMConfig, MemoryNode } from './memoryPalace';

const PIN_DURATION_MS = 24 * 60 * 60 * 1000;

function makePinId(postId: string): string {
  return `moment_pin_${postId}`;
}

/**
 * 把一条朋友圈压缩成适合即时置顶在 prompt 里的“便利贴”。
 * 这里直接定义在 momentsMemory.ts，避免依赖 messageFormat 的导出状态。
 */
function summarizeMomentForPin(post: MomentPost, maxLen: number = 300): string {
  const name = String(post.authorName || '用户');
  const clamp = (value: string, limit: number) =>
    value.length > limit ? `${value.slice(0, limit)}…` : value;
  const text = typeof post.text === 'string' ? post.text.trim() : '';

  if (post.type === 'music' || post.music?.songName) {
    const song = String(post.music?.songName || '').trim();
    const artists = String(post.music?.artists || '').trim();
    return `${name}刚发了条朋友圈：分享了音乐《${song || '未命名歌曲'}》${artists ? ` - ${artists}` : ''}`;
  }

  if (post.type === 'article' || post.article) {
    const article = post.article || {};
    const title = String(article.title || '未命名文章').trim();
    const body =
      typeof article.body === 'string' && article.body.trim()
        ? article.body.trim()
        : typeof article.fullText === 'string'
          ? article.fullText.trim()
          : '';
    const excerpt = body ? clamp(body, 55) : '正文没有成功抓取到';
    return clamp(`${name}分享了一篇文章《${title}》，摘要：${excerpt}`, maxLen);
  }

  const images = Array.isArray(post.images) ? post.images : [];
  if (images.length) {
    const keywordList = Array.isArray(post.imageKeywords)
      ? post.imageKeywords
          .filter((k): k is string => typeof k === 'string' && !!k.trim())
          .slice(0, 2)
      : [];
    const descList = Array.isArray(post.imageDescriptions)
      ? post.imageDescriptions
          .filter((d): d is string => typeof d === 'string' && !!d.trim())
          .slice(0, 2)
      : [];
    const visual = keywordList.length
      ? `配了${images.length}张图（关键词：${keywordList.join('；')}）`
      : descList.length
        ? `配了${images.length}张图（画面：${descList.map(d => clamp(d.trim(), 70)).join('；')}）`
        : `配了${images.length}张图（图片识别暂未成功）`;
    const body = text ? `正文「${clamp(text, 100)}」` : '';
    return clamp(`${name}刚发了条朋友圈：${body}${body ? '，' : ''}${visual}`, maxLen);
  }

  if (text) {
    return clamp(`${name}刚发了条朋友圈：正文「${clamp(text, 100)}」`, maxLen);
  }

  return `${name}刚发了一条朋友圈。`;
}

/**
 * 把一条图片详细描述压成约 5 个短关键词。
 * 只使用 LightLLM，不把图片重新发给模型。
 */
async function compressImageDescriptionToKeywords(
  description: string,
  lightLLM?: LightLLMConfig | null,
): Promise<string[]> {
  if (!description.trim() || !lightLLM?.baseUrl || !lightLLM.apiKey || !lightLLM.model) return [];

  const data = await safeFetchJson(
    `${lightLLM.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${lightLLM.apiKey}`,
      },
      body: JSON.stringify({
        model: lightLLM.model,
        messages: [
          {
            role: 'system',
            content: '把给定的图片文字描述压缩成约5个最能代表画面的中文关键词。只输出关键词，用英文逗号或中文顿号分隔，不要解释，不要编造描述中没有出现的内容。',
          },
          { role: 'user', content: description.trim().slice(0, 1200) },
        ],
        temperature: 0.1,
        max_tokens: 80,
        stream: false,
      }),
    },
    0,
    30_000,
    { appName: '朋友圈', purpose: '朋友圈图片关键词压缩' },
  );

  const raw = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!raw) return [];

  // 兼容模型偶尔包一层 JSON：{"keywords":[...]}
  try {
    const parsed = extractJson<{ keywords?: unknown[] }>(raw);
    if (Array.isArray(parsed?.keywords)) {
      return parsed.keywords.map(String).map(s => s.trim()).filter(Boolean).slice(0, 6);
    }
  } catch {}

  return raw
    .replace(/^[`\[\s]+|[`\]\s]+$/g, '')
    .split(/[，,、;；\n|]+/)
    .map(s => s.trim().replace(/^[-*•]\s*/, ''))
    .filter(Boolean)
    .slice(0, 6);
}

/**
 * 发布用户动态时立即补齐 imageDescriptions + imageKeywords。
 * 已存在的缓存绝不重复调用。
 */
export async function preparePublishedMomentImages(
  post: MomentPost,
  visionApiConfig?: VisionApiConfig,
  lightLLM?: LightLLMConfig | null,
): Promise<MomentPost> {
  if (post.author !== 'user' || !post.images?.length) return post;

  const descriptions = [...(post.imageDescriptions || [])];
  const keywords = [...(post.imageKeywords || [])];
  let changed = false;

  for (let i = 0; i < post.images.length; i++) {
    if (!descriptions[i]?.trim() && isVisionApiReady(visionApiConfig)) {
      try {
        descriptions[i] = await describeImageWithVisionApi(post.images[i], visionApiConfig!);
        changed = true;
      } catch (e: any) {
        console.warn('[Moments] 发布时识别图片失败:', post.id, i, e?.message || String(e));
      }
    }

    // 只有“详细描述已经存在 + 关键词为空”才触发压缩，保证永久复用。
    if (descriptions[i]?.trim() && !keywords[i]?.trim() && lightLLM?.baseUrl && lightLLM.apiKey && lightLLM.model) {
      try {
        const result = await compressImageDescriptionToKeywords(descriptions[i], lightLLM);
        if (result.length) {
          keywords[i] = result.join('、');
          changed = true;
        }
      } catch (e: any) {
        console.warn('[Moments] 图片关键词压缩失败:', post.id, i, e?.message || String(e));
      }
    }
  }

  if (!changed) return post;
  return {
    ...post,
    imageDescriptions: descriptions.length ? descriptions : undefined,
    imageKeywords: keywords.length ? keywords : undefined,
    updatedAt: Date.now(),
  };
}

/** 创建/更新一条朋友圈即时便利贴。使用固定 ID，重复处理同一动态不会生成多条。 */
export async function upsertMomentPin(post: MomentPost, now = Date.now()): Promise<void> {
  const content = summarizeMomentForPin(post, 300);
  if (!content.trim()) return;

  const existing = await MemoryNodeDB.getById(makePinId(post.id));
  const createdAt = existing?.createdAt || post.createdAt || now;
  const node: MemoryNode = {
    id: makePinId(post.id),
    charId: post.charId,
    content,
    // 便利贴是“TA最近看到的用户动态”，先放客厅；正式长期记忆未来由轨道 A 再做语义分房。
    room: 'living_room',
    tags: ['朋友圈', '即时便利贴'],
    importance: 7,
    mood: 'neutral',
    embedded: false,
    createdAt,
    lastAccessedAt: now,
    accessCount: existing?.accessCount || 0,
    pinnedUntil: now + PIN_DURATION_MS,
    sourceId: post.id,
    origin: 'system',
    eventBoxId: existing?.eventBoxId ?? null,
    archived: false,
  };

  await MemoryNodeDB.save(node);
}

/** 删除动态时同步删除对应便利贴，避免 TA 继续被已删除内容提醒。 */
export async function deleteMomentPin(postId: string): Promise<void> {
  await MemoryNodeDB.delete(makePinId(postId));
}

/** 发布完成后的后台处理：先识图/关键词，再把最终内容写入便利贴。 */
export async function prepareAndPinPublishedMoment(
  post: MomentPost,
  visionApiConfig?: VisionApiConfig,
  lightLLM?: LightLLMConfig | null,
): Promise<MomentPost> {
  const prepared = await preparePublishedMomentImages(post, visionApiConfig, lightLLM);

  // 发布后的后台识图可能与用户的评论/编辑/删除并发发生。重新读取一次动态，
  // 只合并 imageDescriptions/imageKeywords，避免用旧快照覆盖最新评论或正文修改。
  const latest = (await getPostsByCharId(post.charId)).find(p => p.id === post.id);
  if (!latest) {
    await deleteMomentPin(post.id).catch(() => {});
    return post;
  }
  const finalPost: MomentPost = {
    ...latest,
    imageDescriptions: prepared.imageDescriptions,
    imageKeywords: prepared.imageKeywords,
    updatedAt: prepared !== post ? Date.now() : latest.updatedAt,
  };
  if (prepared !== post) await savePost(finalPost);
  await upsertMomentPin(finalPost);
  return finalPost;
}
