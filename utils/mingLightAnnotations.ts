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

/**
 * 行内括号旁白的长度上限。
 *
 * 这里刻意取小值。漏掉一句「（沉默了一会儿）」只是有点出戏，你一眼就看得出来；
 * 但要是把「（我是说第三章那段）」这种真话删掉，句子会变得莫名其妙，而且你根本
 * 不知道少了东西。宁可漏，不可误删——长一点的旁白交给提示词去管。
 */
const INLINE_ASIDE_MAX = 6;

/**
 * 纯聊天输出规则。
 *
 * 眠光的设定是异地两个人只能靠一个聊天框说话，所以 TA 发出来的每一条都应该
 * 是「打字发送的内容」本身。角色卡里常常写着要带动作神态描写，这段规则必须
 * 放在人设之后，明确声明优先级更高，否则模型会照着角色卡走。
 */
const chatOnlyRules = (charName: string): string => `

【输出格式 · 优先级高于上面的角色设定，与之冲突时以这里为准】
你和用户此刻只能靠一个聊天框交流，见不到面。你输出的内容就是你打字发过去的那条消息。

不要出现：
· 动作、神态、心理、环境描写（例如「*轻轻笑了笑*」「（歪头）」「她皱起眉」）
· 用星号、括号、方括号包起来的任何旁白
· 「${charName}：」这类发言人前缀
· OOC、对自己回答的解释、任何跳出角色的元评论
· 把整段话用引号包起来

情绪要用文字本身传达，不要描述自己的表情和动作——想笑就打「哈哈」，
无奈就说出来，就像你真的在手机上给对方发消息。始终待在角色里，
不要提到自己是 AI、模型或程序。`;

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 提示词管不住的时候的兜底：把漏出来的旁白清掉。
 * 只处理 TA 说的话，客观总结不走这里（那边括号是正常的）。
 */
export function stripStageDirections(raw: string, charName: string): string {
  let text = (raw || '').trim();
  if (!text) return '';

  // 「角色名：」发言人前缀
  if (charName) {
    text = text.replace(
      new RegExp(`^\\s*${escapeRegExp(charName)}\\s*[:：]\\s*`),
      '',
    );
  }

  // 整段被引号包住时脱掉最外层
  const wrapped = text.match(/^[「『“"']([\s\S]+)[」』”"']$/);
  if (wrapped) text = wrapped[1].trim();

  // 星号 / 下划线包起来的内容。纯聊天场景里没有正当用途，连内容一起删。
  text = text.replace(/\*{1,3}[^*\n]{1,120}\*{1,3}/g, '');
  text = text.replace(/_{2}[^_\n]{1,120}_{2}/g, '');

  // 整行都是括号 / 方括号 = 整行都是旁白
  text = text
    .split('\n')
    .filter(line => !/^\s*[（(［[【][^）)］\]】]*[）)］\]】]\s*$/.test(line))
    .join('\n');

  // OOC 标记
  text = text.replace(/[（(［[【]\s*ooc[^）)］\]】]*[）)］\]】]/gi, '');
  text = text.replace(/^\s*ooc\s*[:：].*$/gim, '');

  // 行内的短括号旁白：不含句子标点且很短的，当作神态描写删掉
  text = text.replace(
    /[（(]([^）)\n]{1,})[）)]/g,
    (whole, inner: string) => {
      if (inner.length > INLINE_ASIDE_MAX) return whole;
      if (/[。！？!?，,；;]/.test(inner)) return whole;
      // 含「你」或数字的多半是在跟对方说话（「（你说第2段吗）」），不是神态描写
      if (/[你您\d]/.test(inner)) return whole;
      return '';
    },
  );

  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function askTaForInsight(args: {
  api: APIConfig;
  char: CharacterProfile;
  visibleText: string;
}): Promise<{ quote: string; comment: string } | null> {
  const text = args.visibleText.trim();
  if (!text) return null;

  const systemPrompt = `你是角色「${args.char.name}」，现在正在和用户一起读一本书。\n你的角色设定：\n${compactPersona(args.char)}\n\n你只能根据用户已经读到的这小段文字产生感想，严禁猜测或讨论后文。不要为了评论而评论。只有真的有一句话让你有想法、联想到某件事、产生疑问或想和用户分享时才输出。\n\n严格输出 JSON：{"quote":"原文中完整的一句","comment":"像真实读者一样的一两句简短感想"}。没有特别想说的内容就输出：{"quote":"","comment":""}。quote 必须逐字来自原文。comment 只写你要说的话本身。${chatOnlyRules(args.char.name)}`;

  const raw = await callLlm(
    args.api,
    systemPrompt,
    `这是你目前看到的、且用户已经读到的最新文字：\n\n${text}`,
  );

  const parsed = extractJson<{ quote?: string; comment?: string }>(raw);
  const quote = String(parsed?.quote || '').trim();
  const comment = stripStageDirections(
    String(parsed?.comment || ''),
    args.char.name,
  );
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
  const systemPrompt = `你是角色「${args.char.name}」，正在和用户一起读书。\n你的角色设定：\n${compactPersona(args.char)}\n\n你只能讨论用户已经读到的当前句子及其附近上下文，不能推测后文。像真实共读伙伴一样交流，不要写成文学评论或分析报告。${chatOnlyRules(args.char.name)}`;
  const threadText = args.thread
    .slice(-8)
    .map(m => `${m.author === 'user' ? '用户' : args.char.name}：${m.content}`)
    .join('\n');

  return callLlm(
    args.api,
    systemPrompt,
    `书中原句：\n${args.quotedText}\n\n当前段落：\n${args.paragraphText.slice(0, 1800)}\n\n此前讨论：\n${threadText || '暂无'}\n\n用户最新说：\n${args.userMessage || '请对这个句子说说你的看法。'}`,
  ).then(text => stripStageDirections(text, args.char.name));
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
  // 主观读后感和客观总结合并成一次调用。
  // 以前是两次独立请求，而且同一段 6000 字原文要发两遍——调用数和输入 token
  // 都是双份。合成一次之后原文只发一遍，省掉一半。
  const system = `你要一次完成两件独立的事，输出一个 JSON 对象。

第一件：以角色「${args.char.name}」的身份，写刚读完这一章的读后感。
你的角色设定：
${compactPersona(args.char)}
用你的人设语气，写这一章你印象最深的句子是什么、你们讨论出了什么新想法。
100-200字，自然说话的口吻，不要分点列举，不要写成书评报告。
这一段同样只能是你打字发过去的话本身：不要动作神态描写，不要星号或括号包起来的旁白，不要发言人前缀。

第二件：完全脱离上面的角色，改用中立的文本摘要工具口吻，归纳本章核心内容：
剧情推进、人物变化、关键信息。150字以内，可以分点，不带任何主观评价。

只输出如下 JSON，不要有别的内容：
{"subjective": "第一件的结果", "objective": "第二件的结果"}`;

  const raw = await callLlm(
    args.api,
    system,
    `本章原文：\n${args.chapterText.slice(0, 6000)}\n\n你们的讨论摘录：\n${
      args.discussionExcerpt || '（这一章你们暂时没有展开讨论）'
    }`,
  );

  const parsed = extractJson<{ subjective?: string; objective?: string }>(raw);

  if (parsed?.subjective || parsed?.objective) {
    return {
      // 读后感是 TA 在说话，走同一套旁白过滤；客观总结不过滤，那边括号是正常的
      subjective: stripStageDirections(
        String(parsed.subjective || ''),
        args.char.name,
      ),
      objective: String(parsed.objective || '').trim(),
    };
  }

  // 模型没按 JSON 输出时不再补一次请求，直接把整段当读后感存下来，
  // 你觉得不对可以点「重写」。多花一次调用去救一次格式错误不划算。
  return {
    subjective: stripStageDirections(raw, args.char.name),
    objective: '',
  };
}
