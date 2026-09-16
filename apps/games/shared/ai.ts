// ═══════════════════════════════════════════════════════════════════════════
// 🧩 小游戏共用 · 调用 AI（OpenAI 兼容 /chat/completions）
//   每个小游戏自己决定 system 提示词和对话历史，这里只负责发请求、去思考链。
//   做新游戏时直接 import { callGameAI } from '../shared/ai'。
// ═══════════════════════════════════════════════════════════════════════════

export interface GameAIMessage { role: 'user' | 'assistant'; content: string }
export interface GameAIApi { baseUrl: string; apiKey: string; model: string }

export interface GameAIRequest {
  api: Partial<GameAIApi> | null | undefined;   // 一般传 useOS().apiConfig
  override?: Partial<GameAIApi>;                // 这条线路单独换接口 / 模型（空字符串 = 不换）
  system: string;
  messages: GameAIMessage[];
  temperature?: number;
  label?: string;                               // 报错时显示是谁（如「荷官」）
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
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey || 'sk-none'}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${req.label || 'AI'} 接口返回 ${res.status}${text ? `：${text.slice(0, 160)}` : ''}`);
  }
  const data = await res.json();
  return stripThinking(data?.choices?.[0]?.message?.content ?? '');
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
