// ═══════════════════════════════════════════════════════════════════════════
// 🧩 小游戏共用 · 调用 AI（OpenAI 兼容 /chat/completions）
//   每个小游戏自己决定 system 提示词和对话历史，这里只负责发请求、去思考链。
//   做新游戏时直接 import { callGameAI } from '../shared/ai'。
// ═══════════════════════════════════════════════════════════════════════════

import { safeFetchJson, extractContent } from '../../../utils/safeApi';
import type { ApiCallMeta } from '../../../utils/apiCallLog';

export interface GameAIMessage { role: 'user' | 'assistant'; content: string }
export interface GameAIApi { baseUrl: string; apiKey: string; model: string }

export interface GameAIRequest {
  api: Partial<GameAIApi> | null | undefined;   // 一般传 useOS().apiConfig
  override?: Partial<GameAIApi>;                // 这条线路单独换接口 / 模型（空字符串 = 不换）
  system: string;
  messages: GameAIMessage[];
  temperature?: number;
  label?: string;                               // 报错时显示是谁（如「荷官」）
  meta?: ApiCallMeta;                           // 「设置 → API 调用记录」里显示的 App / 角色 / 用途
}

const pick = (v: string | undefined, fb: string | undefined) => (v && v.trim() ? v.trim() : (fb || '').trim());

export function stripThinking(text: string): string {
  return (text || '')
    .replace(/<(think|thinking|thought)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(?:think|thinking|thought)>[\s\S]*$/i, '')
    .trim();
}

// 返回 null = 没配 API（游戏应能在没有 AI 的情况下照常玩）；接口出错时抛异常
export async function callGameAI(req: GameAIRequest): Promise<string | null> {
  const baseUrl = pick(req.override?.baseUrl, req.api?.baseUrl).replace(/\/+$/, '');
  const apiKey = pick(req.override?.apiKey, req.api?.apiKey);
  const model = pick(req.override?.model, req.api?.model);
  if (!baseUrl || !model) return null;
  const body: Record<string, unknown> = {
    model,
    stream: false,
    messages: [{ role: 'system', content: req.system }, ...req.messages],
  };
  if (typeof req.temperature === 'number') body.temperature = req.temperature;
  let data: any;
  try {
    // 走项目统一的请求：调用记录里带上 App / 角色 / 用途；聊天接口不会自动重试（不重复扣费）
    data = await safeFetchJson(
      `${baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey || 'sk-none'}` },
        body: JSON.stringify(body),
      },
      0,
      120000,
      req.meta,
    );
  } catch (e: any) {
    throw new Error(`${req.label || 'AI'} 接口出错：${String(e?.message || e).slice(0, 160)}`);
  }
  return stripThinking(extractContent(data) ?? data?.choices?.[0]?.message?.content ?? '');
}

// 把同角色连续消息合并、去掉开头的 assistant（很多接口要求 user 开头、角色交替）
export function normalizeMessages(msgs: GameAIMessage[]): GameAIMessage[] {
  const out: GameAIMessage[] = [];
  msgs.forEach(m => {
    if (!m.content.trim()) return;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else out.push({ ...m });
  });
  while (out.length && out[0].role === 'assistant') out.shift();
  return out;
}
