/**
 * 牌阵 — 和具体牌组无关，塔罗 / 雷诺曼 / 神谕以后都能用同一套结构。
 *
 * 想加新牌阵：往 SPREADS 里加一项就行。
 * 位置名里的 {who} 会替换成角色名（没有角色时是「TA」）。
 */

export type SpreadId = 'single' | 'three' | 'six';

export interface SpreadPosition {
  /** 位置名，显示在牌上方 */
  label: string;
  /** 这个位置在问什么，显示在解读区 */
  hint: string;
}

export interface Spread {
  id: SpreadId;
  name: string;
  /** 选牌阵时的一句话说明 */
  desc: string;
  positions: SpreadPosition[];
  /** 结果页排几列（位置按顺序从左到右、从上到下填） */
  columns: number;
  /** 结果页每张牌的宽度 */
  cardWidth: number;
}

export const SPREADS: Spread[] = [
  {
    id: 'single',
    name: '单张指引',
    desc: '一个问题，一张牌，直接给答案',
    positions: [{ label: '指引', hint: '此刻最需要知道的事' }],
    columns: 1,
    cardWidth: 150,
  },
  {
    id: 'three',
    name: '时间之流',
    desc: '过去、现在、未来，看一件事的来龙去脉',
    positions: [
      { label: '过去', hint: '事情是怎么走到今天的' },
      { label: '现在', hint: '眼下的状态与关键' },
      { label: '未来', hint: '照这样下去会走向哪里' },
    ],
    columns: 3,
    cardWidth: 96,
  },
  {
    id: 'six',
    name: '心之镜',
    desc: '你和 {who}，想法、感受与这段关系',
    positions: [
      { label: '你的想法', hint: '你心里怎么看这段关系' },
      { label: '{who}的想法', hint: '{who}心里怎么看这段关系' },
      { label: '你的感受', hint: '你真实的情绪与需要' },
      { label: '{who}的感受', hint: '{who}真实的情绪与需要' },
      { label: '关系现状', hint: '你们之间现在的样子' },
      { label: '未来走向', hint: '这段关系接下来的方向' },
    ],
    columns: 2,
    cardWidth: 84,
  },
];

export function getSpread(id: SpreadId): Spread {
  return SPREADS.find((s) => s.id === id) ?? SPREADS[0];
}

/** 把 {who} 换成角色名 */
export function fillWho(text: string, who: string): string {
  return text.split('{who}').join(who);
}
