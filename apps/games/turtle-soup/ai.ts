/**
 * 海龟汤 · AI 层
 *
 * ══ 这个文件最重要的一条：信息分层 ══
 *
 * 汤底（soup.bottom）和关键情节（soup.keyElements）**只出现在主持人和评分的提示词里**。
 * 给 TA 的提示词里一个字都没有——TA 看到的只有汤面和公开的问答记录，
 * 跟你看到的完全一样。
 *
 * 为什么这么较真：一旦让同一次调用既当主持人又当 TA，TA 就知道答案了，
 * 它提的"问题"会变成照着答案倒推的表演，你和它一起猜这件事当场失去意义。
 * 所以主持人和 TA 是两次独立调用，而且分别用两套 API 配置——
 * 主持人只做是非判定，用便宜模型就够；TA 要有人设，值得用好一点的。
 *
 * ══ TA 读到的上下文，就这么多 ══
 *
 * 人设（shared/profile.ts 读出来的那份）+ 汤面 + 本局的公开问答记录 + 已放出的提示。
 * **不带主线聊天记录、不带记忆宫殿、不带日程。** 一是这局游戏跟你们平时聊什么没关系，
 * 带进来只会让每次提问的输入变贵；二是海龟汤要的是它的推理方式，不是它的回忆。
 * 它只需要"是它自己"，不需要"记得一切"。
 *
 * 大富翁那边的荷官是不调 API 的（引擎算出结果、原文整理一下就出字）。
 * 海龟汤做不到同一件事：主持人要理解一句自由文本的提问、再对照汤底给出判断，
 * 这是语义活，没有 LLM 做不了。本地能挡掉的只有"重复提问"和"非是否句"，
 * 那两道闸在 engine.ts 里，已经挡掉相当一部分调用了。
 */

import { callGameAI } from '../shared/ai';
import type { Soup } from './soups';
import {
  HOST_VERDICTS, ruleOf,
  type GameApiSetting, type GameState, type HostVerdict, type QaEntry,
} from './engine';

export interface AiContext {
  /** 主持人用的 API（完整一套）。没配就退回主 API。 */
  hostApi: GameApiSetting;
  /** TA 用的 API（完整一套）。没配就退回主 API。 */
  taApi: GameApiSetting;
  /** App 的主 API，两边各自的兜底。 */
  fallbackApi: any;
  charId?: string;
  taName: string;
  userName: string;
  /** TA 的人设，让它提问像它自己。由 shared/profile.ts 读出来。 */
  taPersona: string;
}

/**
 * 挑 API。主持人和 TA 各有一套完整配置，各自独立生效：
 * 配了就用自己那套，没配就退回 App 的主 API。两边可以是完全不同的服务商。
 *
 * 为什么值得分开配（按量计费时尤其）：主持人是全局调用最频繁的一环——每问一句
 * 就是一次——而它干的是最不需要脑子的活，对着给定的汤底判个是非。挂便宜模型
 * 完全够用。TA 那边要人设、要推理，那才是值得花钱的地方。
 */
function pickApi(ctx: AiContext, role: 'host' | 'ta'): any {
  const own = role === 'host' ? ctx.hostApi : ctx.taApi;
  return (own && own.baseUrl.trim() && own.model.trim()) ? own : ctx.fallbackApi;
}

/** 公开的问答记录。这是 TA 和主持人都能看到的那一份，不含汤底。 */
function renderQaLog(g: GameState, taName: string, userName: string): string {
  if (g.qa.length === 0) return '（还没有人提问）';
  return g.qa.map((q, i) => {
    const who = q.asker === 'user' ? userName : taName;
    return `${i + 1}. ${who}问：${q.question}\n   主持人：${q.verdict}${q.note ? `（${q.note}）` : ''}`;
  }).join('\n');
}

function renderHints(g: GameState, soup: Soup): string {
  if (g.hintsUsed === 0) return '（还没用提示）';
  return soup.hints.slice(0, g.hintsUsed).map((h, i) => `提示${i + 1}：${h}`).join('\n');
}

// ==================== 一、主持人判定 ====================

export interface HostAnswer {
  verdict: HostVerdict;
  note?: string;
  /** 主持人认为这句话没法用是/否回答，驳回（不扣次数）。 */
  rejected?: boolean;
}

/**
 * 主持人对一句提问给出判定。
 *
 * 只输出四个词之一，外加一句可选的补充。这是整局里调用最频繁的一环，
 * 所以提示词刻意压得很短——汤面 + 汤底 + 关键情节 + 已问过的问题，没有别的。
 * 不带 TA 的人设，不带聊天记录，主持人是个没有性格的裁判。
 */
export async function askHost(
  ctx: AiContext,
  soup: Soup,
  g: GameState,
  question: string,
  askerName: string,
): Promise<HostAnswer | null> {
  const system = `你是海龟汤的主持人。你知道完整的汤底，但**绝对不能直接说出任何情节**。

【汤面】（所有人都看得到）
${soup.face}

【汤底】（只有你知道）
${soup.bottom}

【关键情节点】
${soup.keyElements.map((k, i) => `${i + 1}. ${k}`).join('\n')}

你的工作：对玩家的一句提问，只给出下面四个判定之一。
- 「是」：按汤底，这句话成立。
- 「否」：按汤底，这句话不成立。
- 「是也不是」：部分成立、或者这个说法在某种理解下成立在另一种下不成立。
- 「无关」：这件事在汤底里根本没提到，或者跟真相无关，问下去是死路。

判定纪律：
- 严格照汤底判，不要为了让玩家好过而放水，也不要故意误导。
- 提问用词可能不精确，按它想表达的意思判，不要抠字眼。
- 如果这句话没法用是/否回答（比如问"为什么""是谁"），把 rejected 设为 true，
  judgement 随便给个"无关"，玩家这次不扣提问次数。
- note 是可选的一句极短补充，**只在能防止玩家彻底走偏时才给**，而且绝不能透露新情节。
  多数时候留空。绝对不要在 note 里解释汤底、不要给提示、不要夸奖或安慰。

只返回 JSON：
{"verdict":"是|否|是也不是|无关","note":"可选，留空就不要这个字段","rejected":false}`;

  // 刻意**不把问答记录喂给主持人**。它是对着汤底判，不是对着历史判——带上历史
  // 既不提高准确率，又让这个"每问一句调一次"的高频调用每轮都更贵一点。
  // 重复提问已经在 engine.ts 本地拦掉了，不需要主持人再认一遍。
  const user = `${askerName} 问：${question}`;

  const reply = await callGameAI({
    api: pickApi(ctx, 'host'),
    label: '主持人',
    temperature: 0.2, // 判定要稳，同一个问题问两次不该给出相反答案
    system,
    messages: [{ role: 'user', content: user }],
    meta: { appName: '与昼', charId: ctx.charId, purpose: '海龟汤 · 主持人判定' },
  });
  if (reply === null) return null;

  try {
    const raw = reply.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const verdict = HOST_VERDICTS.includes(parsed?.verdict) ? parsed.verdict as HostVerdict : '无关';
    const note = typeof parsed?.note === 'string' && parsed.note.trim()
      ? parsed.note.trim().slice(0, 40) : undefined;
    return { verdict, note, rejected: parsed?.rejected === true };
  } catch {
    // 解析不出来时，从原文里捞那四个词。捞不到就当"无关"，不要因为格式问题卡住一局。
    for (const v of HOST_VERDICTS) if (reply.includes(v)) return { verdict: v };
    return { verdict: '无关' };
  }
}

// ==================== 二、TA 提问 ====================

/**
 * TA 想一个问题。
 *
 * **这个函数的提示词里没有汤底。** 它拿到的和你拿到的一模一样：汤面、
 * 公开的问答记录、已经放出来的提示。所以它会猜错、会问到死胡同、会被你带偏——
 * 那正是"一起猜"该有的样子。
 *
 * 它的提问要像它自己：较真的角色会一层层排除，跳脱的角色会问奇怪的方向。
 * 所以这里带人设，跟主持人那个没有性格的裁判正好相反。
 */
export async function askTaQuestion(
  ctx: AiContext,
  soup: Soup,
  g: GameState,
): Promise<{ question: string; aside?: string } | null> {
  const rule = ruleOf(g.rule);
  const left = rule.questionsEach === null ? '不限' : `${rule.questionsEach - g.taAsked} 次`;

  const system = `${ctx.taPersona}

现在你在和${ctx.userName}一起玩海龟汤。你们轮流向主持人提问，一起把真相拼出来。

**你不知道答案。** 你看到的和${ctx.userName}看到的完全一样——汤面、已经问过的问题和主持人的回答、
以及已经放出来的提示。你要靠这些自己推。猜错很正常，走死胡同也很正常。

规则：
- 只能问主持人用「是/否/是也不是/无关」能回答的问题。不要问"为什么""是谁"。
- 不要重复已经问过的问题。
- 顺着已有的线索往下挖，不要东一榔头西一棒子。主持人回「是」的方向值得继续，
  回「无关」的方向就别再碰了。
- 你还剩 ${left} 提问机会。

说话就按你自己的性格来，不要变成一个标准的推理机器。
aside 是你问问题时顺口说的一句话（比如"我怀疑这人根本不是人"），可以带情绪、可以吐槽、
可以跟${ctx.userName}说话。不想说就留空。

只返回 JSON：
{"question":"你要问的那一句","aside":"可选的一句嘴碎，留空就不要这个字段"}`;

  const user = `【汤面】
${soup.face}

【已经问过的】
${renderQaLog(g, ctx.taName, ctx.userName)}

【已经放出来的提示】
${renderHints(g, soup)}

轮到你问了。`;

  const reply = await callGameAI({
    api: pickApi(ctx, 'ta'),
    label: ctx.taName,
    temperature: 0.9,
    system,
    messages: [{ role: 'user', content: user }],
    meta: { appName: '与昼', charId: ctx.charId, charName: ctx.taName, purpose: '海龟汤 · TA提问' },
  });
  if (reply === null) return null;

  try {
    const raw = reply.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const question = String(parsed?.question || '').trim();
    if (!question) return null;
    const aside = typeof parsed?.aside === 'string' && parsed.aside.trim()
      ? parsed.aside.trim().slice(0, 100) : undefined;
    return { question: question.slice(0, 200), aside };
  } catch {
    // 没按格式返回：把整段当问题用，总比这一轮卡死强
    const fallback = reply.trim().split('\n')[0].slice(0, 200);
    return fallback ? { question: fallback } : null;
  }
}

// ==================== 三、TA 参与讨论最终答案 ====================

/**
 * 提交之前，让 TA 说说它觉得真相是什么 [用户确认]。
 * 同样**不带汤底**——它给的是它自己的推断，可能跟你想的不一样，也可能是错的。
 * 你看完再决定提交什么，最终按哪个版本提交由你定。
 */
export async function askTaGuess(
  ctx: AiContext,
  soup: Soup,
  g: GameState,
): Promise<string | null> {
  const system = `${ctx.taPersona}

你在和${ctx.userName}一起玩海龟汤，现在你们准备提交答案了。
**你依然不知道正确答案**，下面说的是你自己根据已有线索的推断。

把你认为的完整故事讲一遍，200 字以内，就按你平时说话的样子。
哪里你自己也没想通就直说，不要硬圆。如果你觉得某个环节${ctx.userName}可能想岔了，也可以提出来。
不要用列表，就正常说话。`;

  const user = `【汤面】
${soup.face}

【问答记录】
${renderQaLog(g, ctx.taName, ctx.userName)}

【提示】
${renderHints(g, soup)}

你觉得真相是什么？`;

  const reply = await callGameAI({
    api: pickApi(ctx, 'ta'),
    label: ctx.taName,
    temperature: 0.9,
    system,
    messages: [{ role: 'user', content: user }],
    meta: { appName: '与昼', charId: ctx.charId, charName: ctx.taName, purpose: '海龟汤 · TA的推断' },
  });
  return reply ? reply.trim().slice(0, 600) : null;
}

// ==================== 四、评分 ====================

/**
 * 结算。三个维度：关键情节命中 40% + 逻辑连贯 30% + 细节还原 30%。
 * 这一环要看汤底，所以走主持人那套 API。
 */
export async function scoreSubmission(
  ctx: AiContext,
  soup: Soup,
  submission: string,
): Promise<{ score: number; breakdown: { key: number; logic: number; detail: number }; comment: string } | null> {
  const system = `你是海龟汤的主持人，现在给玩家提交的还原打分。

【汤底】
${soup.bottom}

【关键情节点】
${soup.keyElements.map((k, i) => `${i + 1}. ${k}`).join('\n')}

三个维度，各自打 0-100：
- key（关键情节命中，占 40%）：上面几个情节点，玩家说中了几个。这是最硬的一档，按命中比例给。
- logic（逻辑连贯，占 30%）：玩家讲的这个故事自己能不能自洽，各环节衔接得上吗。
  注意：即使猜错了方向，只要故事本身自洽，这一项也该给分。
- detail（细节还原，占 30%）：具体的人物关系、动机、场景细节还原得怎么样。

comment 是给玩家看的一段讲评，120 字以内：先说他猜对了什么，再说漏了或者偏了什么。
语气正常一点，不要打官腔，也不要为了鼓励而虚夸。

只返回 JSON：
{"key":0,"logic":0,"detail":0,"comment":"讲评"}`;

  const user = `玩家提交的还原：\n${submission}`;

  const reply = await callGameAI({
    api: pickApi(ctx, 'host'),
    label: '主持人',
    temperature: 0.3,
    system,
    messages: [{ role: 'user', content: user }],
    meta: { appName: '与昼', charId: ctx.charId, purpose: '海龟汤 · 评分' },
  });
  if (reply === null) return null;

  try {
    const raw = reply.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const clamp = (v: any) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    const key = clamp(parsed?.key), logic = clamp(parsed?.logic), detail = clamp(parsed?.detail);
    return {
      score: Math.round(key * 0.4 + logic * 0.3 + detail * 0.3),
      breakdown: { key, logic, detail },
      comment: String(parsed?.comment || '').trim().slice(0, 300) || '（主持人没给讲评）',
    };
  } catch {
    return null;
  }
}

export type { QaEntry };
