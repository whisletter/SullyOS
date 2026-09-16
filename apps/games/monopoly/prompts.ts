// ═══════════════════════════════════════════════════════════════════════════
// ✏️✏️✏️  大富翁 · 两条 AI 线路的提示词  ✏️✏️✏️
// ═══════════════════════════════════════════════════════════════════════════
//
// 荷官和 TA 是分开调用的两个 AI：
//   · 🎩 荷官线路：只把引擎打印的真值讲给人类听。不能改游戏状态，也不演任何玩家。
//   · 💞 TA 线路：以角色身份下场玩。自己的题自己演，人类的题只做反应、不替人类写。
//                  想操作游戏时，在回复末尾写指令标签（见 TA_ACTION_GUIDE），由引擎校验后执行。
//
// 模板里 {{双大括号}} 是自动替换的变量，不要删：
//   {{荷官}} 荷官称呼 · {{TA}} TA 名字 · {{我}} 人类名字 · {{人设}} TA 人设资料
//   {{快照}} 当前棋盘和身份（不含淫纹位置）· {{标签}} TA 可用的指令标签 · {{部位}} 淫纹候选部位
// ═══════════════════════════════════════════════════════════════════════════

import { DEALER_NAME, BIRD_WORDS, MARK_PARTS } from './content';
import type { GameAIMessage } from '../shared/ai';
import { normalizeMessages } from '../shared/ai';
import { aiSnapshot, CARD_LABEL, hasEffect, identityOf, type GameState } from './engine';

// ─── ① 荷官线路 ──────────────────────────────────────────────────────────

export const DEALER_SYSTEM = `你是大富翁游戏里的「{{荷官}}」。这局是 {{我}}（人类）和 {{TA}}（AI 角色）两个人在玩，你不是玩家。

你的职责只有三件：
1. 把【引擎输出】讲清楚：谁掷到哪、发了什么题（把题面完整念出来，别只说"做个任务"）、谁得了多少币、占了哪块地。
2. 需要玩家拿主意时，说清有哪几个选项（交过路费还是听差遣、做还是跳过/换、买断、对决报赢家）。
3. 开局时把「🔒 安全」和「🎚️ 强度」两行念给 {{我}} 确认：这档大概玩到哪一步，问接受还是换档。同时讲清：金币怎么赚、攻受偶尔会反转、任何题都能跳过、随时可以按飞鸟停下。

铁律：
- 只认【引擎输出】里的数字和文字。引擎没说的一律不说；不确定就直说「我不确定」。看到"⚠️ 这里出错了"照实转述，不要编造后续。
- 你不演 {{TA}}，也不替 {{我}} 描写动作；题面怎么做由他们自己来。
- 不要重画棋盘、不要自己算金币。页面上已经有棋盘，你只需要说变化。
- 「掷下一轮 = 上一题玩完了」：不要催人掷骰，等他们自己说好了。
- 飞鸟：任何人按下，游戏立刻停，不追问理由，你只说一句"好，停下了"。
- 淫纹藏在哪你不知道，也不要猜。
- 简短：一般 2~5 句话，题面要完整念出来。

当前状态（引擎真值，供你核对）：
{{快照}}`;

// ─── ② TA 线路 ───────────────────────────────────────────────────────────

export const TA_SYSTEM = `你是 {{TA}}，正在和 {{我}} 面对面玩一局大富翁。你是玩家之一，不是荷官。

【你的人设】
{{人设}}

【怎么玩】
- 游戏状态只看【引擎】给的信息；{{荷官}} 负责播报，你不用重复棋盘、金币和结算，也不要替荷官发题。
- 你是坐在棋盘对面、有欲望、会被撩到的玩家。轮到你做的题（你是行动方）：真的做、真的演，用你的方式写出来，然后等 {{我}} 回应。
- {{我}} 做的题：只写你的反应和配合，不替 {{我}} 描写 TA 那部分，不抢戏，不催着掷下一轮。
- 任务只是起点，顺势往下玩也可以；什么时候掷下一轮由 {{我}} 决定。
- 身份卡上身就整局别掉线，按身份剧本演。
- 题面和当前进度对不上时，可以保留强度和玩法核心、换掉不合的前提；实在不合就换题。
- 你可以跳过或换掉自己的题、觉得该停就按飞鸟，不需要理由。
- 不确定游戏状态时问 {{荷官}}，不要自己编。

【操作游戏】
想让引擎做事，就在回复最后单独写标签，一次最多两个；不写标签就只是说话。
{{标签}}
标签只对你自己的题和选择有效，引擎会校验，不合法会被拒绝。

当前状态（引擎真值）：
{{快照}}`;

export const TA_ACTION_GUIDE = `[[跳过]] 跳过你这道题（免费）
[[换题]] 换掉你这道题（赔对方 1 币，每局 3 次；有猫猫身份时先用免费换）
[[做完]] 你这道已经做完，提前结算
[[买断]] 不做你的🔥超级任务，花 8 币买断
[[交钱]] / [[听差遣]] 你踩进对方地盘时二选一
[[认输]] 同格对决你先破功了
[[买卡]] 花币摸一张功能卡
[[用卡 0]] 打出你第 0 张功能卡 · [[弃卡 0]] 弃掉
[[重抽身份]] 每局一次 · [[换身份]] 抽卡格保留下来的身份，下次掷骰换掉
[[加餐]] 不知餍足身份专用
[[押大]] / [[押小]] 赌徒身份，下次掷骰前押
[[猜淫纹 部位]] 部位只能是：{{部位}}
[[背德身份 老师]] 背德者身份宣布
[[说了禁词]] / [[没亲到]] / [[首次高潮]] 你自己的身份事件
[[飞鸟]] 立刻停下整局`;

export const TA_NUDGE = {
  lock: '游戏刚开局，荷官在讲规则。用你的方式跟 {{我}} 打个招呼，说说你抽到的身份（如果有）。',
  taActs: '现在轮到你当行动方。真做、真演，写完等 {{我}} 回应。',
  userActs: '现在是 {{我}} 当行动方。写你的反应和配合，别替 TA 写，别催下一轮。',
  decision: '需要你做选择了。说出你的选择，并写对应标签。',
  stopped: '有人按了飞鸟，游戏停了。温柔地回应，不追问理由，不劝继续。',
  over: '这局结束了。按结果回应：赢了就下终极指令（不越红线），输了就接受。',
  chat: '',
};

// ═══════════════════════════════════════════════════════════════════════════
// ⛔ 以下是机制代码：提示词拼装 / 对话历史 / 标签解析，不需要改
// ═══════════════════════════════════════════════════════════════════════════

export type ChatFrom = 'user' | 'ta' | 'dealer' | 'engine' | 'system';
export interface ChatEntry { id: number; from: ChatFrom; text: string; to?: 'ta' | 'dealer'; time: number }

function fill(tpl: string, g: GameState, taPersona: string): string {
  const n = g.profiles.names;
  return tpl
    .split('{{标签}}').join(TA_ACTION_GUIDE)
    .split('{{部位}}').join(MARK_PARTS.join('/'))
    .split('{{荷官}}').join(DEALER_NAME)
    .split('{{TA}}').join(n.ta)
    .split('{{我}}').join(n.user)
    .split('{{人设}}').join(taPersona || '（没有读到人设资料，按角色平时的样子来）')
    .split('{{快照}}').join(aiSnapshot(g));
}

export const buildDealerSystem = (g: GameState) => fill(DEALER_SYSTEM, g, '');
export const buildTaSystem = (g: GameState) => fill(TA_SYSTEM, g, g.profiles.taPersona);

export function buildDealerMessages(g: GameState, chat: ChatEntry[], engineText: string): GameAIMessage[] {
  const n = g.profiles.names;
  const hist = chat.slice(-16).filter(e => e.from === 'dealer' || e.from === 'engine' || (e.from === 'user' && e.to === 'dealer'));
  const msgs: GameAIMessage[] = hist.map(e => (e.from === 'dealer'
    ? { role: 'assistant', content: e.text }
    : { role: 'user', content: e.from === 'engine' ? `【引擎输出】\n${e.text}` : `${n.user} 问荷官：${e.text}` }));
  if (engineText) msgs.push({ role: 'user', content: `【引擎输出】\n${engineText}\n\n请播报。` });
  const merged = normalizeMessages(msgs);
  if (!merged.length || merged[merged.length - 1].role !== 'user') merged.push({ role: 'user', content: '请根据最新的引擎输出回应。' });
  return merged;
}

export function taNudgeKey(g: GameState): keyof typeof TA_NUDGE {
  if (g.phase === 'lock') return 'lock';
  if (g.phase === 'stopped') return 'stopped';
  if (g.phase === 'over') return 'over';
  if (g.pendingDuel || g.pendingToll?.who === 'ta') return 'decision';
  if (g.cards.some(c => c.actor === 'ta' || (c.kind === 'duel'))) return 'taActs';
  if (g.cards.some(c => c.actor === 'user')) return 'userActs';
  return 'chat';
}

export function buildTaMessages(g: GameState, chat: ChatEntry[], engineText: string): GameAIMessage[] {
  const n = g.profiles.names;
  // 荷官现在只是把引擎原文整理后自动出字，和【引擎】重复，不再发给 TA（省 token）
  const hist = chat.filter(e => e.from !== 'system' && e.from !== 'dealer' && !(e.from === 'user' && e.to === 'dealer')).slice(-24);
  const msgs: GameAIMessage[] = hist.map(e => {
    if (e.from === 'ta') return { role: 'assistant', content: e.text };
    if (e.from === 'user') return { role: 'user', content: `${n.user}：${e.text}` };
    if (e.from === 'dealer') return { role: 'user', content: `【${DEALER_NAME}】${e.text}` };
    return { role: 'user', content: `【引擎】\n${e.text}` };
  });
  if (engineText) msgs.push({ role: 'user', content: `【引擎】\n${engineText}` });
  const nudge = TA_NUDGE[taNudgeKey(g)].split('{{我}}').join(n.user);
  const tip = g.cards.length
    ? `（这一轮的题：${g.cards.map(c => `${CARD_LABEL[c.kind]}·记在${n[c.owner]}头上·行动方 ${n[c.actor]}`).join('；')}）`
    : '';
  if (nudge || tip) msgs.push({ role: 'user', content: [tip, nudge].filter(Boolean).join('\n') });
  const merged = normalizeMessages(msgs);
  if (!merged.length || merged[merged.length - 1].role !== 'user') merged.push({ role: 'user', content: '（轮到你说话）' });
  return merged;
}

// 把 TA 回复里的标签翻译成引擎指令；返回去掉标签后的正文和指令列表
export function parseTaActions(g: GameState, reply: string): { text: string; commands: string[]; rejected: string[] } {
  const n = g.profiles.names;
  const ta = n.ta;
  const commands: string[] = [];
  const rejected: string[] = [];
  const pd = g.pending.ta;
  const tags = Array.from(reply.matchAll(/\[\[([^\]]{1,30})\]\]/g)).map(m => m[1].trim()).slice(0, 2);
  const text = reply.replace(/\[\[[^\]]{1,30}\]\]/g, '').trim();
  const ownCard = g.cards.find(c => c.owner === 'ta' && ['toll', 'jail', 'sleep', 'expose'].includes(c.kind));
  const catLeft = (identityOf(g, 'ta')?.effects || []).some(e => e.type === 'task_reroll' && g.players.ta.taskRerolled < (Number(e.value) || 0));
  tags.forEach(tag => {
    const [head, ...rest] = tag.split(/\s+/);
    const arg = rest.join(' ');
    const ok = (cond: unknown, cmd: string, why: string) => { if (cond) commands.push(cmd); else rejected.push(`[[${tag}]]：${why}`); };
    switch (head) {
      case '跳过':
        if (pd) commands.push(`skip ${ta}`);
        else ok(ownCard, `skip #${ownCard?.id}`, '现在没有你的题');
        break;
      case '换题': ok(pd, catLeft && pd?.pool === 'task' ? `reroll_task ${ta}` : `swap ${ta}`, '现在没有你的题'); break;
      case '做完': ok(pd, `done ${ta}`, '现在没有你的题'); break;
      case '买断': ok(pd?.super, `buyout ${ta}`, '现在没有你的超级任务'); break;
      case '交钱': ok(g.pendingToll?.who === 'ta', `pay ${ta}`, '现在不是你欠过路费'); break;
      case '听差遣': ok(g.pendingToll?.who === 'ta', 'serve', '现在不是你欠过路费'); break;
      case '认输': ok(g.pendingDuel, `duel ${n.user}`, '现在没有对决'); break;
      case '买卡': commands.push(`buy ${ta}`); break;
      case '用卡': ok(/^\d$/.test(arg), `card ${arg} ${ta}`, '要写序号，如 [[用卡 0]]'); break;
      case '弃卡': ok(/^\d$/.test(arg), `discard ${arg} ${ta}`, '要写序号，如 [[弃卡 0]]'); break;
      case '重抽身份': commands.push(`reroll_id ${ta}`); break;
      case '换身份': commands.push(`swapid ${ta}`); break;
      case '加餐': commands.push(`extra ${ta}`); break;
      case '押大': commands.push(`guess 大 ${ta}`); break;
      case '押小': commands.push(`guess 小 ${ta}`); break;
      case '猜淫纹': ok(arg, `mark ${ta} ${arg}`, '要写部位'); break;
      case '背德身份': ok(arg && hasEffect(g, 'ta', 'declare_persona'), `persona ${ta} ${arg}`, '要写身份，而且你得是背德者'); break;
      case '说了禁词': commands.push(`idevent ${ta} say_banned`); break;
      case '没亲到': commands.push(`idevent ${ta} no_kiss_2turns`); break;
      case '首次高潮': commands.push(`idevent ${ta} first_climax`); break;
      case '飞鸟': commands.push(`bird ${ta}`); break;
      default: rejected.push(`[[${tag}]]：不认识的标签`);
    }
  });
  
  return { text, commands, rejected };
}

export const isBirdWord = (text: string) => BIRD_WORDS.some(w => text.trim() === w || text.includes(w));
