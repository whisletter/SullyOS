import type { APIConfig, ApiPreset } from '../types';

// Clipboard contents can carry zero-width characters that String.trim() does not
// remove. They are never valid at the edges of an API URL, token, or model id.
const EDGE_INVISIBLE_CHARS = /^[\s\u200B-\u200D\u2060\uFEFF]+|[\s\u200B-\u200D\u2060\uFEFF]+$/g;

const cleanEdgeCharacters = (value: unknown): string =>
  String(value ?? '').replace(EDGE_INVISIBLE_CHARS, '');

export const normalizeApiBaseUrl = (value: unknown): string =>
  cleanEdgeCharacters(value).replace(/\/+$/, '');

export const normalizeApiCredential = (value: unknown): string =>
  cleanEdgeCharacters(value);

export const normalizeApiModel = (value: unknown): string =>
  cleanEdgeCharacters(value);

export function normalizeApiConfig(config: APIConfig): APIConfig {
  const visionApi = config.visionApi;
  const imageGenApi = config.imageGenApi;
  // 和 utils/imageGenApi.ts 的 MAX_REFERENCE_IMAGES 保持一致；不从那边 import 是为了
  // 避免循环依赖（imageGenApi.ts 本身就依赖这个文件的 normalizeApi* 系列函数）。
  const MAX_REFERENCE_IMAGES = 5;
  return {
    ...config,
    baseUrl: normalizeApiBaseUrl(config.baseUrl),
    apiKey: normalizeApiCredential(config.apiKey),
    model: normalizeApiModel(config.model),
    ...(visionApi ? {
      visionApi: {
        enabled: visionApi.enabled === true,
        baseUrl: normalizeApiBaseUrl(visionApi.baseUrl),
        apiKey: normalizeApiCredential(visionApi.apiKey),
        model: normalizeApiModel(visionApi.model),
      },
    } : {}),
    ...(imageGenApi ? {
      imageGenApi: {
        enabled: imageGenApi.enabled === true,
        format: imageGenApi.format === 'google' ? 'google' as const : 'openai' as const,
        baseUrl: normalizeApiBaseUrl(imageGenApi.baseUrl),
        apiKey: normalizeApiCredential(imageGenApi.apiKey),
        model: normalizeApiModel(imageGenApi.model),
        // 之前这里漏了这两个字段，导致每次 updateApiConfig()（包括保存生图 API 本身）
        // 都会把风格预设和参考脸图静默清空——保留时做个防御性校验，别把脏数据放进去。
        stylePreset: typeof imageGenApi.stylePreset === 'string' && imageGenApi.stylePreset.trim()
          ? imageGenApi.stylePreset
          : undefined,
        referenceImages: Array.isArray(imageGenApi.referenceImages)
          ? imageGenApi.referenceImages
              .filter((img): img is string => typeof img === 'string' && img.trim().length > 0)
              .slice(0, MAX_REFERENCE_IMAGES)
          : undefined,
      },
    } : {}),
  };
}

export function normalizeApiPreset(preset: ApiPreset): ApiPreset {
  return {
    ...preset,
    name: String(preset.name ?? '').trim(),
    config: normalizeApiConfig(preset.config),
  };
}
