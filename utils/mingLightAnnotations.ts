/**
 * 「眠光」第二步：划线 / 批注 / 共读讨论 / 记忆归档
 */
import type { CharacterProfile, Message } from '../types';
import type {
  MingLightAnnotation,
  MingLightThreadMessage,
} from './mingLightDb';
import {
  extractMemoriesFromBuffer,
} from './memoryPalace/extraction';
import {
  vectorizeAndStore,
} from './memoryPalace/vectorStore';
import type { LightLLMConfig } from './memoryPalace/pipeline';

export const TA_REVIEW_INTERVAL = 750;
export const TA_REVIEW_WINDOW = 900;

type ChatApiConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export function makeAnnotationId() {
  return `mla_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeThreadId() {
  return `mlt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function callChatApi(
  config: ChatApiConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  if (!config?.baseUrl || !config?.apiKey || !config?.model) {
    throw new Error('聊天 API 尚未配置完整');
  }

  const response = await fetch(
    `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'system',
            content: systemPrompt,
          },
          {
            role: 'user',
            content: userPrompt,
          },
        ],
        temperature: 0.7,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`API Error ${response.status}`);
  }

  const data = await response.json();
  const text =
    data?.choices?.[0]?.message?.content?.trim() || '';

  if (!text) {
    throw new Error('AI 没有返回内容');
  }

  return text;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function buildCharacterContext(
  char: CharacterProfile,
  userName: string,
): string {
  let context =
    `你的名字：${char.name}\n` +
    `你的角色设定：\n${char.systemPrompt || '无'}\n`;

  if (char.worldview?.trim()) {
    context += `你的世界观：\n${char.worldview}\n`;
  }

  if (userName?.trim()) {
    context += `用户称呼：${userName}\n`;
  }

  return context;
}

/**
 * TA 主动阅读：
 * 只接收用户已经看到的最后一小段文字。
 * 绝不发送 visibleEnd 之后的任何内容。
 */
export async function askTaForSpontaneousComment(
  config: ChatApiConfig,
  char: CharacterProfile,
  userName: string,
  bookTitle: string,
  chapterTitle: string,
  excerpt: string,
): Promise<{
  hasComment: boolean;
  quote: string;
  comment: string;
}> {
  const systemPrompt = `
你现在正在和用户一起读一本书。
你不是旁观者，也不能提前看书。
你只能根据用户已经读到的这段文字产生真实、自然的个人感想。

${buildCharacterContext(char, userName)}

严格规则：
1. 只能理解下面提供的文字。
2. 不允许使用这段文字之后的任何剧情、人物信息或伏笔。
3. 不要假装每一段都必须有感想。
4. 只有真的有想说的话时，才返回 hasComment=true。
5. 如果有感想，必须选择下面原文中的一句完整句子作为 quote，不能改写。
6. comment 像一个正在一起读书的人说的话，可以有理解、联想、疑问、共鸣或不同意见。
7. 不要总结整本书或预测后文。
8. 只输出 JSON：

{
  "hasComment": true/false,
  "quote": "原文中的完整句子",
  "comment": "一句到三句自然的感想"
}

当前书名：${bookTitle}
当前章节：${chapterTitle || '未知'}

用户已经读到这里，以下文字就是你目前唯一能看到的内容：
---BEGIN---
${excerpt}
---END---
`;

  const raw = await callChatApi(
    config,
    systemPrompt,
    '请判断你现在有没有真的想对其中一句话说点什么。',
  );

  const parsed = parseJsonObject(raw);

  if (!parsed) {
    return {
      hasComment: false,
      quote: '',
      comment: '',
    };
  }

  const hasComment =
    parsed.hasComment === true &&
    typeof parsed.quote === 'string' &&
    typeof parsed.comment === 'string';

  if (!hasComment) {
    return {
      hasComment: false,
      quote: '',
      comment: '',
    };
  }

  return {
    hasComment: true,
    quote: String(parsed.quote).trim(),
    comment: String(parsed.comment).trim(),
  };
}

/**
 * 用户主动批注后，TA 回复。
 */
export async function askTaToReplyToUserAnnotation(
  config: ChatApiConfig,
  char: CharacterProfile,
  userName: string,
  bookTitle: string,
  quote: string,
  userComment: string,
  thread: MingLightThreadMessage[],
): Promise<string> {
  const threadText = thread
    .slice(-10)
    .map(
      m =>
        `${m.role === 'user' ? userName || '用户' : char.name}：${m.text}`,
    )
    .join('\n');

  const systemPrompt = `
你正在和用户一起读书。

${buildCharacterContext(char, userName)}

这是书中的一句原文：
「${quote}」

用户对它的感想：
${userComment}

之前这句话下面的讨论：
${threadText || '暂无'}

请像一个真实的共读伙伴一样回复。
不要提前谈论用户尚未读到的内容。
不要主动总结后文。
回复自然一些，不必每次都很长。
`;

  return callChatApi(
    config,
    systemPrompt,
    '请回应用户刚才对这句话的感想。',
  );
}

/**
 * 批注讨论继续进行。
 */
export async function askTaToContinueDiscussion(
  config: ChatApiConfig,
  char: CharacterProfile,
  userName: string,
  bookTitle: string,
  quote: string,
  thread: MingLightThreadMessage[],
): Promise<string> {
  const threadText = thread
    .slice(-12)
    .map(
      m =>
        `${m.role === 'user' ? userName || '用户' : char.name}：${m.text}`,
    )
    .join('\n');

  const systemPrompt = `
你正在和用户一起读《${bookTitle}》。

${buildCharacterContext(char, userName)}

当前讨论的原句：
「${quote}」

你们刚才的讨论：
${threadText}

只根据这句话和已经发生的讨论回答。
不要读取、猜测或暗示后面的剧情。
像真实的朋友一起讨论一本书一样继续聊。
`;

  return callChatApi(
    config,
    systemPrompt,
    '继续这场讨论。',
  );
}

/**
 * 用户点击「收藏进记忆宫殿」时才调用。
 * 不点击按钮绝不会进入记忆宫殿。
 */
export async function archiveAnnotationDiscussion(
  char: CharacterProfile,
  userName: string,
  quote: string,
  annotationComment: string,
  thread: MingLightThreadMessage[],
  memoryPalaceConfig: any,
): Promise<void> {
  const lightLLM =
    memoryPalaceConfig?.lightLLM as
      | LightLLMConfig
      | undefined;

  const embeddingConfig =
    char.embeddingConfig as any;

  if (
    !char.memoryPalaceEnabled ||
    !lightLLM?.baseUrl ||
    !lightLLM?.apiKey ||
    !embeddingConfig?.baseUrl ||
    !embeddingConfig?.apiKey
  ) {
    throw new Error(
      '请先在记忆宫殿设置中配置好 API',
    );
  }

  const discussion = [
    `书中原句：「${quote}」`,
    annotationComment
      ? `最初批注：${annotationComment}`
      : '',
    ...thread.map(
      m =>
        `${m.role === 'user' ? userName || '用户' : char.name}：${m.text}`,
    ),
  ]
    .filter(Boolean)
    .join('\n');

  const fakeMessage = {
    id: -Math.floor(Math.random() * 1e9),
    charId: char.id,
    role: 'user',
    type: 'text',
    content:
      `【眠光共读讨论】\n${discussion}`,
    timestamp: Date.now(),
  } as Message;

  const charContext =
    `[来源说明]\n这是用户主动从「眠光」共读讨论中收藏的一段内容。\n` +
    `[角色档案]\n名字：${char.name}\n角色设定：${char.systemPrompt || '无'}\n` +
    (char.worldview
      ? `[世界观]\n${char.worldview}\n`
      : '');

  const extracted =
    await extractMemoriesFromBuffer(
      [fakeMessage],
      char.id,
      char.name,
      lightLLM,
      charContext,
      userName || '用户',
      [],
      [],
    );

  if (!extracted.memories.length) {
    throw new Error(
      '这次讨论没有被提取为可归档的记忆',
    );
  }

  for (const node of extracted.memories) {
    node.origin = 'system';
    node.createdAt = Date.now();
    node.lastAccessedAt = Date.now();
  }

  await vectorizeAndStore(
    extracted.memories,
    embeddingConfig,
  );
}
