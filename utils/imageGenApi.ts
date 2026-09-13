import type { ImageGenApiConfig } from '../types';
import { safeFetchJson } from './safeApi';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from './apiConfigNormalize';
import type { ApiCallMeta } from './apiCallLog';

/** 设置页「测试生图」用的默认 prompt，出图便宜、好判断成败。 */
export const IMAGE_GEN_API_TEST_PROMPT = '一只可爱的橘猫坐在窗边晒太阳，插画风格';

const DEFAULT_OPENAI_BASE = 'https://api.openai.com';
const DEFAULT_GOOGLE_BASE = 'https://generativelanguage.googleapis.com';

export interface ImageGenResult {
  /** data URL（base64）或直接可用的图片 URL，看具体 provider 返回什么。 */
  src: string;
  mimeType?: string;
}

export interface GenerateImageOptions {
  /** 图片尺寸，仅 OpenAI 格式使用；默认 '1024x1024'。 */
  size?: string;
  /** 生成张数；默认 1。 */
  n?: number;
  /** 补充「哪个 App / 哪个角色 / 用途」到 API 调用记录（设置 → API 调用记录）。 */
  meta?: ApiCallMeta;
}

export const isImageGenApiReady = (config?: ImageGenApiConfig | null): config is ImageGenApiConfig =>
  config?.enabled === true
  && !!config.apiKey?.trim()
  && !!config.model?.trim();

/**
 * 统一入口：根据 config.format 分发到 OpenAI 兼容格式或 Google 格式。
 * 聊天、朋友圈、Moments 等所有需要生图的场景都调这一个函数。
 */
export async function generateImage(
  config: ImageGenApiConfig,
  prompt: string,
  options: GenerateImageOptions = {},
): Promise<ImageGenResult[]> {
  if (!isImageGenApiReady(config)) {
    throw new Error('生图 API 已开启，但 Key 或 Model 尚未填写完整');
  }
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    throw new Error('生图 prompt 不能为空');
  }

  // 自动拼接风格预设（锁脸 / 画风 / 色调等用户自定义提示词）
  const finalPrompt = config.stylePreset?.trim()
    ? `${trimmedPrompt}\n\n${config.stylePreset.trim()}`
    : trimmedPrompt;

  const { size = '1024x1024', n = 1, meta } = options;

  if (config.format === 'google') {
    return googleImageGen(config, finalPrompt, { n, meta });
  }
  return openaiImageGen(config, finalPrompt, { size, n, meta });
}

/** model 名带 'agnes' → Agnes 系列，走 generations + extra_body.image（而非标准 edits 端点）。 */
const isAgnesModel = (model: string): boolean => /agnes/i.test(model);

/** 参考图最多 5 张（edits 端点本身支持到 16 张，这里按产品需要收紧上限）。 */
export const MAX_REFERENCE_IMAGES = 5;

/** data URL 转 { blob, filename }，供 multipart/form-data 上传（/v1/images/edits）用。 */
async function dataUrlToBlob(dataUrl: string): Promise<{ blob: Blob; filename: string }> {
  const match = /^data:([^;]+);base64,/.exec(dataUrl);
  const mimeType = match?.[1] || 'image/png';
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const ext = mimeType.split('/')[1]?.split('+')[0] || 'png';
  return { blob: new Blob([blob], { type: mimeType }), filename: `reference.${ext}` };
}

// ─── OpenAI 兼容格式 ─────────────────────────────────────────────────────────
// 覆盖：gpt-image-2 / Grok(xAI) / GLM CogView(智谱) / DALL·E / 中转站

async function openaiImageGen(
  config: ImageGenApiConfig,
  prompt: string,
  { size, n, meta }: { size: string; n: number; meta?: ApiCallMeta },
): Promise<ImageGenResult[]> {
  // 不少第三方文档把 "Base URL" 写成已经带 /v1 的完整前缀（如 Agnes AI：
  // https://apihub.agnes-ai.com/v1），但下面统一会自己拼接 /v1/images/generations，
  // 直接原样使用会变成 .../v1/v1/images/generations 导致 404。这里做一次去重。
  const baseUrl = (normalizeApiBaseUrl(config.baseUrl) || DEFAULT_OPENAI_BASE).replace(/\/v1$/i, '');
  const apiKey = normalizeApiCredential(config.apiKey);
  const model = normalizeApiModel(config.model);

  const parse = (data: any): ImageGenResult[] => {
    const items = Array.isArray(data?.data) ? data.data : [];
    if (items.length === 0) throw new Error('生图 API 没有返回图片');
    return items.map((item: any) => (
      item.b64_json
        ? { src: `data:image/png;base64,${item.b64_json}`, mimeType: 'image/png' }
        : { src: item.url || '' }
    ));
  };

  const referenceImages = (config.referenceImages || [])
    .map(img => img?.trim())
    .filter((img): img is string => !!img)
    .slice(0, MAX_REFERENCE_IMAGES);

  // 有参考脸图 → 切走图生图调用方式。
  if (referenceImages.length > 0) {
    if (isAgnesModel(model)) {
      // Agnes 系列：仍是 /v1/images/generations，但参考图放 extra_body.image 数组；
      // response_format 也必须在 extra_body 里，放顶层会 400。图生图不需要 tags: ["img2img"]。
      const data = await safeFetchJson(`${baseUrl}/v1/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          prompt,
          n,
          size,
          extra_body: {
            image: referenceImages,
            response_format: 'b64_json',
          },
        }),
      }, 1, 90_000, meta);
      return parse(data);
    }

    // 标准 OpenAI 格式：/v1/images/edits，multipart/form-data，image 参数传参考图。
    // 单图字段名用 'image'，多图（OpenAI 官方约定）要用 'image[]' 否则部分 server 只取到最后一张。
    const blobs = await Promise.all(referenceImages.map(dataUrlToBlob));
    const imageFieldName = blobs.length > 1 ? 'image[]' : 'image';
    const buildForm = (withResponseFormat: boolean) => {
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', prompt);
      form.append('n', String(n));
      form.append('size', size);
      for (const { blob, filename } of blobs) {
        form.append(imageFieldName, blob, filename);
      }
      if (withResponseFormat) form.append('response_format', 'b64_json');
      return form;
    };

    try {
      const data = await safeFetchJson(`${baseUrl}/v1/images/edits`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: buildForm(true),
      }, 1, 90_000, meta);
      return parse(data);
    } catch (error: any) {
      // 部分中转站不接受 response_format 字段；降级重试。
      const message = String(error?.message || '');
      if (!/response_format|400|422|invalid/i.test(message)) throw error;
      const data = await safeFetchJson(`${baseUrl}/v1/images/edits`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: buildForm(false),
      }, 1, 90_000, meta);
      return parse(data);
    }
  }

  const requestBody = (responseFormat?: 'b64_json') => JSON.stringify({
    model,
    prompt,
    n,
    size,
    ...(responseFormat ? { response_format: responseFormat } : {}),
  });

  try {
    // 优先要 b64_json：省一次跨域取图，也方便直接存 IndexedDB。
    const data = await safeFetchJson(`${baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: requestBody('b64_json'),
    }, 1, 90_000, meta);
    return parse(data);
  } catch (error: any) {
    // 部分 provider（如 Grok）不接受 response_format 字段，会直接报错；
    // 降级成不带该字段的请求，退回接受 url 返回。
    const message = String(error?.message || '');
    if (!/response_format|400|422|invalid/i.test(message)) throw error;
    const data = await safeFetchJson(`${baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: requestBody(),
    }, 1, 90_000, meta);
    return parse(data);
  }
}

// ─── Google 格式 ──────────────────────────────────────────────────────────────
// model 以 'imagen' 开头 → Imagen 3 :predict；其余 → Gemini 原生 :generateContent

async function googleImageGen(
  config: ImageGenApiConfig,
  prompt: string,
  { n, meta }: { n: number; meta?: ApiCallMeta },
): Promise<ImageGenResult[]> {
  const baseUrl = normalizeApiBaseUrl(config.baseUrl) || DEFAULT_GOOGLE_BASE;
  const apiKey = normalizeApiCredential(config.apiKey);
  const model = normalizeApiModel(config.model);

  if (model.toLowerCase().startsWith('imagen')) {
    const data = await safeFetchJson(
      `${baseUrl}/v1beta/models/${model}:predict?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: { sampleCount: n },
        }),
      },
      1, 90_000, meta,
    );
    const predictions = Array.isArray(data?.predictions) ? data.predictions : [];
    if (predictions.length === 0) throw new Error('生图 API 没有返回图片');
    return predictions.map((p: any) => ({
      src: `data:${p.mimeType || 'image/png'};base64,${p.bytesBase64Encoded}`,
      mimeType: p.mimeType || 'image/png',
    }));
  }

  // Gemini 原生生图：generateContent + responseModalities: ['TEXT','IMAGE']
  const data = await safeFetchJson(
    `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
    },
    1, 90_000, meta,
  );

  const results: ImageGenResult[] = [];
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const inline = part?.inlineData;
      if (inline?.data) {
        results.push({
          src: `data:${inline.mimeType || 'image/png'};base64,${inline.data}`,
          mimeType: inline.mimeType || 'image/png',
        });
      }
    }
  }
  if (results.length === 0) throw new Error('生图 API 没有返回图片（模型可能只输出了文字）');
  return results;
}
