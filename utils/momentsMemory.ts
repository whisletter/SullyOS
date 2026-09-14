/**
 * 朋友圈 → Memory Palace（轨道 B）
 *
 * 这里只负责“即时便利贴”以及发布时图片识图/关键词压缩。
 * 正式长期归档（轨道 A）不在这里处理。
 */

import type { MomentPost } from './momentsDb';
import { savePost, getPostsByCharId } from './momentsDb';
import { describeImagesWithVisionApi, isVisionApiReady } from './visionApi';
import type { VisionApiConfig } from '../types';
import { safeFetchJson, extractJson } from './safeApi';
import { MemoryNodeDB } from './memoryPalace';
import type { LightLLMConfig, MemoryNode } from './memoryPalace';
import { summarizeMomentForPin } from './messageFormat';

const PIN_DURATION_MS = 24 * 60 * 60 * 1000;

function makePinId(postId: string): string {
  return `moment_pin_${postId}`;
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

  // Vision：把所有尚未识别的图片放进同一次请求，朋友圈当前上限 9 张。
  if (isVisionApiReady(visionApiConfig)) {
    const missing: number[] = [];
    for (let i = 0; i < post.images.length; i++) {
      if (!descriptions[i]?.trim()) missing.push(i);
    }
    if (missing.length) {
      try {
        const results = await describeImagesWithVisionApi(missing.map(i => post.images![i]), visionApiConfig!);
        for (let j = 0; j < missing.length; j++) {
          if (results[j]?.trim()) { descriptions[missing[j]] = results[j].trim(); changed = true; }
        }
      } catch (e: any) {
        console.warn('[Moments] 发布时多图识别失败:', post.id, e?.message || String(e));
      }
    }
  }

  // LightLLM：所有已有描述一次性压缩，避免 9 张图产生 9 个请求。
  const canUseLight = !!lightLLM?.baseUrl && !!lightLLM.apiKey && !!lightLLM.model;
  const missingKeywordIndexes = canUseLight
    ? descriptions.map((d, i) => d?.trim() && !keywords[i]?.trim() ? i : -1).filter(i => i >= 0)
    : [];
  if (missingKeywordIndexes.length) {
    try {
      const descriptionsBlock = missingKeywordIndexes
        .map(i => `[${i}] ${descriptions[i].trim().slice(0, 1200)}`)
        .join('\n');
      const data = await safeFetchJson(
        `${lightLLM!.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${lightLLM!.apiKey}` },
          body: JSON.stringify({
            model: lightLLM!.model,
            messages: [
              { role: 'system', content: '你负责把多张图片的详细描述压缩成关键词。严格按输入的数字索引返回 JSON：{\"keywords\":[{\"index\":0,\"keywords\":[\"词1\",\"词2\"]}]}。每张图约5个中文关键词，只能使用描述中出现的信息，不要解释。' },
              { role: 'user', content: descriptionsBlock },
            ],
            temperature: 0.1, max_tokens: Math.min(80 * missingKeywordIndexes.length, 700), stream: false,
          }),
        }, 0, 30_000, { appName: '朋友圈', purpose: '朋友圈多图关键词压缩' },
      );
      const raw = String(data?.choices?.[0]?.message?.content || '').trim();
      const parsed = extractJson<{ keywords?: Array<{ index?: unknown; keywords?: unknown[] }> }>(raw);
      if (Array.isArray(parsed?.keywords)) {
        for (const item of parsed.keywords) {
          const index = Number(item?.index);
          if (!Number.isInteger(index) || !missingKeywordIndexes.includes(index)) continue;
          const words = Array.isArray(item?.keywords) ? item.keywords.map(String).map(s => s.trim()).filter(Boolean).slice(0, 6) : [];
          if (words.length) { keywords[index] = words.join('、'); changed = true; }
        }
      }
    } catch (e: any) {
      console.warn('[Moments] 多图关键词压缩失败:', post.id, e?.message || String(e));
    }
  }

  if (!changed) return post;
  return { ...post, imageDescriptions: descriptions.length ? descriptions : undefined, imageKeywords: keywords.length ? keywords : undefined, updatedAt: Date.now() };
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
