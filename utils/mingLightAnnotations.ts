/**
 * 「眠光」第二步：划线 / 批注 / 共读讨论 / 记忆归档
 */
import type { APIConfig, CharacterProfile } from '../types';
import type { MingLightAnnotation, MingLightThreadMessage } from './mingLightDb';
import { MemoryNodeDB } from './memoryPalace/db';
import type { MemoryNode, MemoryRoom } from './memoryPalace/types';

export const TA_CHECK_INTERVAL = 750;

const MEMORY_ROOMS: MemoryRoom[] = [
  'living_room',
  'bedroom',
  'study',
  'user_room',
  'self_room',
  'attic',
  'windowsill',
];

const callLlm = async (
  api: Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'>,
  systemPrompt: string,
  userMessage: string,
): Promise<string> => {
  if (!api.baseUrl || !api.model) throw new Error('请先配置可用的模型 API。');
  const response = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${api.apiKey || 'sk-none'}`,
    },
    body: JSON.stringify({
      model: api.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.8,
      stream: false,
    }),
  } as RequestInit);

  if (!response.ok) {
    throw new Error(`LLM API ${response.status}`);
  }

  const data = await response.json();
  return String(data?.choices?.[0]?.message?.content || '');
};

const extractJson = <T,>(raw: string): T | null => {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as T;
  } catch {
    return null;
  }
};

const compactPersona = (char: CharacterProfile): string =>
  (char.systemPrompt || '').slice(0, 6000);

export async function askTaForInsight(args: {
  api: APIConfig;
  char: CharacterProfile;
  visibleText: string;
}): Promise<{ quote: string; comment: string } | null> {
  const text = args.visibleText.trim();
  if (!text) return null;

  const systemPrompt = `你是角色「${args.char.name}」，现在正在和用户一起读一本书。\n你的角色设定：\n${compactPersona(args.char)}\n\n你只能根据用户已经读到的这小段文字产生感想，严禁猜测或讨论后文。不要为了评论而评论。只有真的有一句话让你有想法、联想到某件事、产生疑问或想和用户分享时才输出。\n\n严格输出 JSON：{"quote":"原文中完整的一句","comment":"像真实读者一样的一两句简短感想"}。没有特别想说的内容就输出：{"quote":"","comment":""}。quote 必须逐字来自原文。`;

  const raw = await callLlm(
    args.api,
    systemPrompt,
    `这是你目前看到的、且用户已经读到的最新文字：\n\n${text}`,
  );

  const parsed = extractJson<{ quote?: string; comment?: string }>(raw);
  const quote = String(parsed?.quote || '').trim();
  const comment = String(parsed?.comment || '').trim();
  if (!quote || !comment || !text.includes(quote)) return null;
  return { quote, comment };
}

export async function askTaToReply(args: {
  api: APIConfig;
  char: CharacterProfile;
  quotedText: string;
  paragraphText: string;
  thread: MingLightThreadMessage[];
  userMessage?: string;
}): Promise<string> {
  const systemPrompt = `你是角色「${args.char.name}」，正在和用户一起读书。\n你的角色设定：\n${compactPersona(args.char)}\n\n你只能讨论用户已经读到的当前句子及其附近上下文，不能推测后文。像真实共读伙伴一样交流，不要写成文学评论或分析报告。`;
  const threadText = args.thread
    .slice(-8)
    .map(m => `${m.author === 'user' ? '用户' : args.char.name}：${m.content}`)
    .join('\n');

  return callLlm(
    args.api,
    systemPrompt,
    `书中原句：\n${args.quotedText}\n\n当前段落：\n${args.paragraphText.slice(0, 1800)}\n\n此前讨论：\n${threadText || '暂无'}\n\n用户最新说：\n${args.userMessage || '请对这个句子说说你的看法。'}`,
  ).then(text => text.trim());
}

export async function archiveAnnotationThread(args: {
  lightLLM: { baseUrl?: string; apiKey?: string; model?: string } | null | undefined;
  annotation: MingLightAnnotation;
  char: CharacterProfile;
  bookTitle: string;
}): Promise<void> {
  if (!args.lightLLM?.baseUrl || !args.lightLLM.model) {
    throw new Error('记忆宫殿副 API 尚未配置。');
  }

  const conversation = [
    `书籍：《${args.bookTitle}》`,
    `原句：${args.annotation.quotedText}`,
    `首次批注：${args.annotation.source === 'ta' ? args.char.name : '用户'}：${args.annotation.comment}`,
    ...args.annotation.thread.map(m => `${m.author === 'ta' ? args.char.name : '用户'}：${m.content}`),
  ].join('\n');

  const raw = await callLlm(
    {
      baseUrl: args.lightLLM.baseUrl,
      apiKey: args.lightLLM.apiKey || '',
      model: args.lightLLM.model,
    },
    `你正在为角色「${args.char.name}」整理一段真正值得长期记住的共读经历。只根据提供的讨论内容判断，不补充后文。\n从以下七个房间中选一个：living_room, bedroom, study, user_room, self_room, attic, windowsill。\n输出 JSON：{"room":"...","content":"一条简洁的长期记忆","importance":1到10,"mood":"neutral 或一个简短情绪词","tags":["最多3个标签"]}。content 应该是可以在未来聊天中使用的自然记忆，而不是摘要报告。`,
    conversation,
  );

  const parsed = extractJson<{
    room?: string;
    content?: string;
    importance?: number;
    mood?: string;
    tags?: string[];
  }>(raw);

  const room = MEMORY_ROOMS.includes(parsed?.room as MemoryRoom)
    ? (parsed!.room as MemoryRoom)
    : 'study';
  const createdAt = Date.now();

  const node: MemoryNode = {
    id: `ml_mem_${createdAt}_${Math.random().toString(36).slice(2, 8)}`,
    charId: args.char.id,
    content: String(parsed?.content || conversation.slice(0, 500)),
    room,
    tags: Array.isArray(parsed?.tags) ? parsed!.tags.slice(0, 3).map(String) : ['共读'],
    importance: Math.max(1, Math.min(10, Math.round(Number(parsed?.importance) || 6))),
    mood: String(parsed?.mood || 'neutral'),
    embedded: false,
    createdAt,
    lastAccessedAt: createdAt,
    accessCount: 0,
    eventBoxId: null,
    origin: 'system',
  };

  await MemoryNodeDB.save(node);
}

// ---------- 章末总结：主观读后感（带人设）+ 客观内容总结（不带人设） ----------

export async function generateChapterSummary(args: {
  api: APIConfig;
  char: CharacterProfile;
  chapterText: string;
  discussionExcerpt: string;
}): Promise<{ subjective: string; objective: string }> {
  const subjectiveSystem = `你是角色「${args.char.name}」，刚和用户一起读完了这一章。\n你的角色设定：\n${compactPersona(args.char)}\n\n用你的人设语气，写一段简短的读后感：这一章你印象最深的句子是什么、你们讨论出了什么新想法。100-200字，自然说话的口吻，不要分点列举，不要写成书评报告。`;

  const subjective = await callLlm(
    args.api,
    subjectiveSystem,
    `本章原文：\n${args.chapterText.slice(0, 6000)}\n\n你们的讨论摘录：\n${args.discussionExcerpt || '（这一章你们暂时没有展开讨论）'}`,
  );

  const objectiveSystem = `你是一个客观的文本摘要工具，不扮演任何角色、不带任何感情色彩。请归纳以下章节的核心内容：剧情推进、人物变化、关键信息。150字以内，可以分点列出，不要加入任何主观评价或感想。`;

  const objective = await callLlm(
    args.api,
    objectiveSystem,
    args.chapterText.slice(0, 6000),
  );

  return { subjective: subjective.trim(), objective: objective.trim() };
}
