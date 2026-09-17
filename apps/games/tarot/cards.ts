/**
 * 塔罗牌库 — 78 张标准韦特牌的基础定义。
 *
 * id 同时是牌面图的文件名：以后上传牌面时，第 n 张对应 `public/games/tarot/deck/NN.jpg`
 * （NN 为两位补零，00 ~ 77）。没有对应图片时由 CardFace.tsx 画出默认牌面。
 *
 * 这里只放「这张牌是什么」，牌意在 meanings.ts，两边靠 id 对上。
 */

export type TarotSuit = 'wands' | 'cups' | 'swords' | 'pentacles';

export interface TarotCard {
  /** 0 ~ 77，牌面图文件名同此编号 */
  id: number;
  /** 中文牌名，界面上显示的就是它 */
  name: string;
  arcana: 'major' | 'minor';
  /** 小阿卡纳才有 */
  suit?: TarotSuit;
  /** 大阿卡纳 0~21；小阿卡纳 1~14（11 侍从 12 骑士 13 王后 14 国王） */
  number: number;
  /** 牌面角上的标记：大阿卡纳是罗马数字，小阿卡纳是花色符号 */
  mark: string;
}

/** 四个花色的中文名与符号，牌面和牌意之书共用 */
export const SUIT_INFO: Record<TarotSuit, { name: string; symbol: string; element: string }> = {
  wands: { name: '权杖', symbol: '♣', element: '火' },
  cups: { name: '圣杯', symbol: '♥', element: '水' },
  swords: { name: '宝剑', symbol: '♠', element: '风' },
  pentacles: { name: '星币', symbol: '♦', element: '土' },
};

const ROMAN = [
  '0', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
  'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI',
];

const MAJOR_NAMES = [
  '愚者', '魔术师', '女祭司', '皇后', '皇帝', '教皇', '恋人', '战车',
  '力量', '隐者', '命运之轮', '正义', '倒吊人', '死神', '节制', '恶魔',
  '塔', '星星', '月亮', '太阳', '审判', '世界',
];

/** 小阿卡纳 1~14 的序数名 */
const RANK_NAMES = [
  '首牌', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '侍从', '骑士', '王后', '国王',
];

const SUIT_ORDER: TarotSuit[] = ['wands', 'cups', 'swords', 'pentacles'];

function buildDeck(): TarotCard[] {
  const deck: TarotCard[] = [];

  // 0 ~ 21：大阿卡纳
  for (let i = 0; i <= 21; i++) {
    deck.push({
      id: i,
      name: MAJOR_NAMES[i],
      arcana: 'major',
      number: i,
      mark: ROMAN[i],
    });
  }

  // 22 ~ 77：小阿卡纳，每个花色 14 张
  SUIT_ORDER.forEach((suit, suitIndex) => {
    for (let rank = 1; rank <= 14; rank++) {
      const id = 22 + suitIndex * 14 + (rank - 1);
      const rankName = RANK_NAMES[rank - 1];
      const suitName = SUIT_INFO[suit].name;
      // 「权杖首牌」「权杖三」「权杖国王」
      deck.push({
        id,
        name: `${suitName}${rankName}`,
        arcana: 'minor',
        suit,
        number: rank,
        mark: SUIT_INFO[suit].symbol,
      });
    }
  });

  return deck;
}

/** 完整 78 张牌，顺序固定，id 即数组下标 */
export const TAROT_DECK: TarotCard[] = buildDeck();

export function getCard(id: number): TarotCard | undefined {
  return TAROT_DECK[id];
}

/** 牌面图的约定路径，以后上传牌面后自动生效 */
export function cardImagePath(id: number): string {
  return `/games/tarot/deck/${String(id).padStart(2, '0')}.jpg`;
}
