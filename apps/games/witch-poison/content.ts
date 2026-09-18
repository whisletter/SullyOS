// ═══════════════════════════════════════════════════════════════════════════
// 🧪 女巫的毒药 · 文案与提示词
//   数值 / 文字 / 兜底台词改这里，组件逻辑在 WitchPoisonGame.tsx。
// ═══════════════════════════════════════════════════════════════════════════

export const TOTAL_CANDIES = 16;

/** 没配 API，或 API 出错时用的兜底反应（安全 / 命中各一组，循环不连续重复） */
export const FALLBACK_SAFE_LINES: string[] = [
  '呼～不是这颗，这次算你走运。',
  '糖太甜了，甜得我都想眨眨眼睛。',
  '还没轮到倒霉呢，慢慢来嘛。',
  '这颗糖里只有糖，没有别的秘密。',
  '锅里的药水都还没干呢，你猜得挺准。',
  '咬下去脆脆的，就是普通的糖没错。',
  '看来你的直觉还不赖……暂时。',
  '毒药还躲着呢，别高兴太早。',
  '我这边还剩不少"惊喜"没拆呢。',
  '这一口是安全的，继续玩下去吧。',
  '糖纸上沾了点星尘，味道不错。',
  '月光下的糖果，总是格外诱人。',
  '别看我笑，我心里可紧张了。',
  '这颗糖乖乖的，什么都没藏。',
  '运气这种东西，早晚会用完的。',
  '剩下的糖果越来越少了，小心点。',
];

export const FALLBACK_POISON_LINES: string[] = [
  '叮——命中了，你的脸都绿了。',
  '游戏结束，藏在糖衣下的毒发作啦。',
  '接下来，你可要接受一点小小的惩罚咯。',
  '毒药选中了你，这次算我赢。',
  '苦涩的味道蔓延开来，这局你输了。',
  '月光见证，这颗正是毒药本尊。',
];

/** 没配 API / 解析失败时，char 自己选毒药那一步的兜底"小动作"文案（不透露具体选了第几颗） */
export const FALLBACK_POISON_CHOICE_NOTES: string[] = [
  'TA神秘地笑了笑，什么都没说。',
  'TA的目光在糖堆上扫了一圈。',
  'TA悄悄用指尖点了一下某颗糖，没让你看清。',
  'TA哼着小曲，心里已经有了主意。',
  'TA眨了眨眼，像是藏了什么秘密。',
  'TA的嘴角勾起一抹意味不明的笑。',
  'TA轻轻碰了碰糖罐边缘，若无其事。',
  'TA在心里默念了一个数字，没有说出口。',
];

export const NARRATOR_START_LINES = {
  pickPoison: '两个人都悄悄把一颗毒药藏进了糖果堆里，谁也不知道对方选的是哪一颗……',
  userPicked: '你悄悄记下了自己的那一颗，藏进了心底。',
  countdownDone: '游戏开始，从你先来。',
};

export const NARRATOR_EAT = (name: string, idx: number) => `${name}拿起了第 ${idx + 1} 颗糖，一口吃了下去……`;

export const NARRATOR_RESULT_SAFE = '……没事，是安全的。';
export const NARRATOR_RESULT_POISON = (name: string) => `——是毒药！${name}中招了。`;

export const ENDING_FALLBACK = (loserName: string) => [
  `游戏结束啦，${loserName}最先吃到了毒药。`,
  '按约定，输的人要接受一点小小的惩罚哦～',
];

/**
 * 开局时让 AI 自己代入人设「决定」把毒药藏在哪一颗（而不是纯随机）。
 * 只在这一次调用里问、拿到编号后立刻锁进 state，之后整局都不会再问 AI 这件事，
 * 也不会把这次问答记进聊天记录——AI 没有任何机会在游戏中途"改答案"。
 */
export function buildPoisonPickSystem(persona: string, taName: string, userName: string): string {
  return [
    `你正在和${userName}玩一个叫"女巫的毒药"的双人小游戏。`,
    '规则：16 颗糖果排成 4x4，编号 1 到 16，你和对方各自偷偷选定 1 颗当"毒药"，藏好之后谁都不会再改。谁先吃到任意一方设下的毒药，谁就输，要接受对方的惩罚。',
    '你是这个角色：',
    persona || `一个和${userName}很熟悉的人`,
    '',
    '请完全代入这个角色的性格和小心思，自己想好要把毒药悄悄藏在哪一颗——可以考虑角色会不会有偏好的数字、会不会琢磨"对方大概率先点哪颗"之类的小心机，但不用说出来、不用解释。',
    '只输出你选定的那颗糖的编号，1 到 16 之间的一个整数，不要输出任何别的文字、不要标点、不要加引号、不要解释原因。',
  ].join('\n');
}

export const POISON_PICK_USER_PROMPT = '新的一局开始了，请现在就悄悄决定你要把毒药藏在第几颗糖里（1-16），只回复这个数字。';

/** 给 AI 的系统提示词：反应要贴人设、要短、不能出戏 */
export function buildSystemPrompt(persona: string, taName: string, userName: string): string {
  return [
    `你现在正在和${userName}玩一个叫"女巫的毒药"的双人小游戏。`,
    '规则：一共 16 颗糖果摆在一起，你和对方各自偷偷选定了 1 颗当作"毒药"，谁先吃到任意一方设下的毒药，谁就输，要接受对方的惩罚。',
    '你是这个角色：',
    persona || `一个和${userName}很熟悉的人`,
    '',
    '请完全用这个角色的口吻和习惯说话，可以带一点点心声/内心活动，但不要写成旁白、不要加引号、不要出戏解释规则、不要提到"AI"或"系统"，只输出这一句话本身，中文，不超过 40 字。',
  ].join('\n');
}

export function buildTurnPrompt(actorName: string, taName: string, idx: number, hit: boolean, remaining: number): string {
  const outcome = hit ? '踩中了毒药——游戏到这里就结束了，TA输了，要接受惩罚' : '很安全，不是毒药，游戏继续';
  return `刚才 ${actorName} 吃下了第 ${idx + 1} 颗糖（还剩 ${remaining} 颗没吃），结果：${outcome}。请说出你此刻的反应。`;
}

export function buildEndingPrompt(loserName: string, winnerIsSelf: boolean): string {
  return winnerIsSelf
    ? `${loserName}刚刚吃到了你设下的毒药，游戏结束，你赢了。说一句你此刻的感想，可以带点得意或者心疼，随你人设决定。`
    : `你自己吃到了毒药，游戏结束，你输了。说一句你此刻的反应。`;
}
