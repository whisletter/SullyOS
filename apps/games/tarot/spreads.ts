/**
 * 牌阵 — 和具体牌组无关，塔罗 / 雷诺曼 / 神谕共用同一套结构。
 *
 * 想加新牌阵：往 SPREADS 里加一项，decks 写上它能用在哪几副牌。
 * 位置名里的 {who} 会替换成角色名（没有角色时是「TA」）。
 */

import type { DeckKind } from './decks';

export type SpreadId =
  | 'single' | 'three' | 'six'
  | 'l-single' | 'l-three' | 'l-five' | 'l-nine';

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
  /** 能用在哪几副牌 */
  decks: DeckKind[];
  /** 位置按结果页的摆放顺序：从左到右、从上到下 */
  positions: SpreadPosition[];
  /**
   * 抽牌顺序：第 k 张抽到的牌放在 positions 的第几个位置。
   * 不写就是按摆放顺序。雷诺曼习惯先抽中间的核心牌。
   */
  pickOrder?: number[];
  /** 结果页排几列 */
  columns: number;
  /** 结果页每张牌的宽度（px） */
  cardWidth: number;
}

export const SPREADS: Spread[] = [
  // ── 塔罗 / 神谕 ──
  {
    id: 'single',
    name: '单张指引',
    desc: '一个问题，一张牌，直接给答案',
    decks: ['tarot', 'oracle'],
    positions: [{ label: '指引', hint: '此刻最需要知道的事' }],
    columns: 1,
    cardWidth: 140,
  },
  {
    id: 'three',
    name: '时间之流',
    desc: '过去、现在、未来，看一件事的来龙去脉',
    decks: ['tarot', 'oracle'],
    positions: [
      { label: '过去', hint: '事情是怎么走到今天的' },
      { label: '现在', hint: '眼下的状态与关键' },
      { label: '未来', hint: '照这样下去会走向哪里' },
    ],
    columns: 3,
    cardWidth: 90,
  },
  {
    id: 'six',
    name: '心之镜',
    desc: '你和 {who}，想法、感受与这段关系',
    decks: ['tarot'],
    positions: [
      { label: '你的想法', hint: '你心里怎么看这段关系' },
      { label: '{who}的想法', hint: '{who}心里怎么看这段关系' },
      { label: '你的感受', hint: '你真实的情绪与需要' },
      { label: '{who}的感受', hint: '{who}真实的情绪与需要' },
      { label: '关系现状', hint: '你们之间现在的样子' },
      { label: '未来走向', hint: '这段关系接下来的方向' },
    ],
    columns: 2,
    cardWidth: 72,
  },

  // ── 雷诺曼：牌连起来读成一句话 ──
  {
    id: 'l-single',
    name: '今日提示',
    desc: '抽一张，看看今天要留意什么',
    decks: ['lenormand'],
    positions: [{ label: '提示', hint: '今天值得留意的事' }],
    columns: 1,
    cardWidth: 130,
  },
  {
    id: 'l-three',
    name: '三张线',
    desc: '先抽现状（指示牌），再看根源与结果',
    decks: ['lenormand'],
    positions: [
      { label: '根源', hint: '事情从哪里来' },
      { label: '现状', hint: '指示牌：问题本身、眼下的样子' },
      { label: '结果', hint: '会走向哪里' },
    ],
    pickOrder: [1, 0, 2],
    columns: 3,
    cardWidth: 88,
  },
  {
    id: 'l-five',
    name: '五张线',
    desc: '一句更完整的话，适合具体的问题',
    decks: ['lenormand'],
    positions: [
      { label: '过去', hint: '较早的影响' },
      { label: '近因', hint: '最近推动这件事的因素' },
      { label: '核心', hint: '问题的中心' },
      { label: '发展', hint: '接下来的变化' },
      { label: '结果', hint: '最后的走向' },
    ],
    pickOrder: [2, 1, 3, 0, 4],
    columns: 5,
    cardWidth: 58,
  },
  {
    id: 'l-nine',
    name: '九宫格',
    desc: '看一件事的全貌：中间是核心，横竖斜都能读',
    decks: ['lenormand'],
    positions: [
      { label: '过去·心里', hint: '过去心里的想法' },
      { label: '现在·心里', hint: '现在心里的想法' },
      { label: '未来·心里', hint: '未来心里会怎么想' },
      { label: '过去', hint: '过去发生的事' },
      { label: '核心', hint: '问题的中心' },
      { label: '未来', hint: '接下来会发生的事' },
      { label: '过去·暗处', hint: '过去没被看见的因素' },
      { label: '现在·暗处', hint: '现在藏在底下的因素' },
      { label: '未来·暗处', hint: '未来潜伏的变数' },
    ],
    pickOrder: [4, 0, 1, 2, 3, 5, 6, 7, 8],
    columns: 3,
    cardWidth: 78,
  },
];

export function getSpread(id: SpreadId): Spread {
  return SPREADS.find((s) => s.id === id) ?? SPREADS[0];
}

export function spreadsFor(kind: DeckKind): Spread[] {
  return SPREADS.filter((s) => s.decks.includes(kind));
}

/** 第 k 张抽到的牌放在哪个位置 */
export function slotOfPick(spread: Spread, k: number): number {
  return spread.pickOrder?.[k] ?? k;
}

/** 把 {who} 换成角色名 */
export function fillWho(text: string, who: string): string {
  return text.split('{who}').join(who);
}
