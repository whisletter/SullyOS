import React from 'react';
import type { GiftWrap } from './gifts';

/**
 * 三种包装的手绘 SVG。
 *
 * 用 SVG 而不是 emoji 或图片，就是为了拆开那一下——每个部件（盖子、缎带、木塞）
 * 都是独立的 <g>，可以单独做动画。emoji 动不了，位图放大也糊。
 *
 * 配色跟与昼主页一套：奶白底、粉调阴影、牛皮纸的暖棕、缎带的粉蓝（芭蕾那种）。
 */

export interface WrapProps {
  wrap: GiftWrap;
  /** 正在播拆开动画。 */
  opening?: boolean;
  /** 已经拆开了（部件停在打开的终态）。 */
  opened?: boolean;
  size?: number;
  className?: string;
}

const PALETTE = {
  kraft: '#d8b48c',
  kraftDark: '#c09a70',
  kraftLight: '#e8cfae',
  boxPink: '#fdeef0',
  boxPinkDark: '#f6d9de',
  ribbon: '#a8cfe8',      // 芭蕾粉蓝
  ribbonDark: '#8bb8d6',
  glass: '#dfeef2',
  cork: '#c9a678',
  paper: '#fffaf6',
  line: '#c9a9a4',
};

/** 小纸箱：顶盖沿后缘掀起。 */
const BoxSvg: React.FC<{ state: string }> = ({ state }) => (
  <svg viewBox="0 0 120 120" className="w-full h-full">
    <ellipse cx="60" cy="104" rx="34" ry="6" fill="rgba(172,88,108,.10)" />
    <g className={`yg-lid yg-lid-box ${state}`}>
      <path d="M26 46 L60 32 L94 46 L60 58 Z" fill={PALETTE.kraftLight} stroke={PALETTE.kraftDark} strokeWidth="1.5" strokeLinejoin="round" />
    </g>
    <path d="M28 48 L60 60 L60 100 L28 86 Z" fill={PALETTE.kraft} stroke={PALETTE.kraftDark} strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M92 48 L60 60 L60 100 L92 86 Z" fill={PALETTE.kraftDark} stroke={PALETTE.kraftDark} strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M60 60 L60 100" stroke={PALETTE.kraftLight} strokeWidth="1" opacity=".6" />
    {/* 侧面一条压痕，让盒子不那么平 */}
    <path d="M36 62 L52 68" stroke={PALETTE.kraftLight} strokeWidth="1.2" opacity=".55" />
  </svg>
);

/** 缎带礼盒：缎带从中间断开向两侧滑走，盖子上浮。 */
const RibbonSvg: React.FC<{ state: string }> = ({ state }) => (
  <svg viewBox="0 0 120 120" className="w-full h-full">
    <ellipse cx="60" cy="104" rx="34" ry="6" fill="rgba(172,88,108,.10)" />
    {/* 盒身 */}
    <rect x="28" y="56" width="64" height="44" rx="4" fill={PALETTE.boxPink} stroke={PALETTE.boxPinkDark} strokeWidth="1.5" />
    {/* 盒身上的竖缎带 */}
    <rect x="55" y="56" width="10" height="44" fill={PALETTE.ribbon} className={`yg-band ${state}`} />
    {/* 盖子 */}
    <g className={`yg-lid yg-lid-ribbon ${state}`}>
      <rect x="24" y="42" width="72" height="16" rx="4" fill="#fff6f8" stroke={PALETTE.boxPinkDark} strokeWidth="1.5" />
      <rect x="55" y="42" width="10" height="16" fill={PALETTE.ribbon} />
      {/* 蝴蝶结 */}
      <g className={`yg-bow ${state}`}>
        <path d="M60 42 C48 30, 36 34, 42 42 C46 47, 55 44, 60 42 Z" fill={PALETTE.ribbon} stroke={PALETTE.ribbonDark} strokeWidth="1.2" />
        <path d="M60 42 C72 30, 84 34, 78 42 C74 47, 65 44, 60 42 Z" fill={PALETTE.ribbon} stroke={PALETTE.ribbonDark} strokeWidth="1.2" />
        <circle cx="60" cy="42" r="4" fill={PALETTE.ribbonDark} />
        <circle cx="58.5" cy="40.5" r="1.4" fill="#fff" opacity=".75" />
      </g>
    </g>
  </svg>
);

/** 玻璃瓶：木塞向上弹出带一点旋转，纸卷从瓶口升起。 */
const BottleSvg: React.FC<{ state: string }> = ({ state }) => (
  <svg viewBox="0 0 120 120" className="w-full h-full">
    <ellipse cx="60" cy="106" rx="26" ry="5" fill="rgba(172,88,108,.10)" />
    {/* 纸卷：藏在瓶里，拆开时升起 */}
    <g className={`yg-scroll ${state}`}>
      <rect x="50" y="60" width="20" height="26" rx="3" fill={PALETTE.paper} stroke={PALETTE.line} strokeWidth="1" />
      <path d="M53 67 H67 M53 72 H65 M53 77 H67" stroke={PALETTE.line} strokeWidth="1" opacity=".55" />
    </g>
    {/* 瓶身 */}
    <path d="M52 34 L52 46 C44 52, 40 60, 40 70 L40 94 C40 100, 44 104, 50 104 L70 104 C76 104, 80 100, 80 94 L80 70 C80 60, 76 52, 68 46 L68 34 Z"
          fill={PALETTE.glass} fillOpacity=".72" stroke="#b9d4dc" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M46 62 C44 70, 44 84, 46 94" stroke="#fff" strokeWidth="2.5" opacity=".55" strokeLinecap="round" />
    {/* 瓶口细绳 */}
    <path d="M51 40 H69" stroke={PALETTE.line} strokeWidth="1.6" opacity=".7" />
    {/* 木塞 */}
    <g className={`yg-cork ${state}`}>
      <rect x="50" y="24" width="20" height="14" rx="3" fill={PALETTE.cork} stroke="#a8875a" strokeWidth="1.3" />
      <path d="M53 28 H67" stroke="#a8875a" strokeWidth="1" opacity=".5" />
    </g>
  </svg>
);

const GiftPackage: React.FC<WrapProps> = ({ wrap, opening, opened, size = 96, className }) => {
  const state = opening ? 'is-opening' : opened ? 'is-open' : '';
  return (
    <div className={className} style={{ width: size, height: size }}>
      {wrap === 'box' && <BoxSvg state={state} />}
      {wrap === 'ribbon' && <RibbonSvg state={state} />}
      {wrap === 'bottle' && <BottleSvg state={state} />}
    </div>
  );
};

/**
 * 拆开动画。
 *
 * 全部用 transform，不动布局，所以不会引起重排。约 700ms——
 * 再快就看不清部件怎么动的，再慢会让"再拆一个"变得不耐烦。
 *
 * is-opening 播动画，is-open 直接停在终态（用于已经拆过的礼物，
 * 重新打开柜子时不该再播一遍）。
 */
export const GIFT_PACKAGE_CSS = `
.yg-lid, .yg-bow, .yg-band, .yg-cork, .yg-scroll { transform-origin: center; }

/* 纸箱：顶盖沿后缘掀起 110 度 */
@keyframes yg-lid-box-open {
  0%   { transform: rotateX(0) translateY(0); }
  100% { transform: rotateX(-110deg) translateY(-6px); }
}
.yg-lid-box { transform-origin: 60px 32px; }
.yg-lid-box.is-opening { animation: yg-lid-box-open .62s cubic-bezier(.34,1.3,.5,1) forwards; }
.yg-lid-box.is-open { transform: rotateX(-110deg) translateY(-6px); }

/* 礼盒：盖子上浮淡出，缎带从中间断开向两侧滑走 */
@keyframes yg-lid-ribbon-open {
  0%   { transform: translateY(0); opacity: 1; }
  100% { transform: translateY(-34px); opacity: 0; }
}
.yg-lid-ribbon.is-opening { animation: yg-lid-ribbon-open .6s ease-out forwards; }
.yg-lid-ribbon.is-open { transform: translateY(-34px); opacity: 0; }

@keyframes yg-bow-fly {
  0%   { transform: translate(0,0) rotate(0); opacity: 1; }
  100% { transform: translate(-26px,-18px) rotate(-28deg); opacity: 0; }
}
.yg-bow.is-opening { animation: yg-bow-fly .58s ease-out forwards; }
.yg-bow.is-open { opacity: 0; }

@keyframes yg-band-split {
  0%   { transform: scaleY(1); opacity: 1; }
  100% { transform: scaleY(0); opacity: 0; }
}
.yg-band { transform-origin: 60px 56px; }
.yg-band.is-opening { animation: yg-band-split .5s ease-in forwards; }
.yg-band.is-open { transform: scaleY(0); opacity: 0; }

/* 玻璃瓶：木塞弹出带旋转，纸卷升起 */
@keyframes yg-cork-pop {
  0%   { transform: translateY(0) rotate(0); }
  45%  { transform: translateY(-26px) rotate(-14deg); }
  100% { transform: translateY(-38px) rotate(-26deg); opacity: 0; }
}
.yg-cork.is-opening { animation: yg-cork-pop .66s cubic-bezier(.3,1.5,.6,1) forwards; }
.yg-cork.is-open { transform: translateY(-38px) rotate(-26deg); opacity: 0; }

@keyframes yg-scroll-rise {
  0%   { transform: translateY(0); opacity: 0; }
  35%  { opacity: 1; }
  100% { transform: translateY(-26px); opacity: 1; }
}
.yg-scroll { opacity: 0; }
.yg-scroll.is-opening { animation: yg-scroll-rise .7s .18s ease-out forwards; }
.yg-scroll.is-open { transform: translateY(-26px); opacity: 1; }

/* 未拆的盒子轻轻呼吸，提示可以点 */
@keyframes yg-idle { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
.yg-idle { animation: yg-idle 2.8s ease-in-out infinite; }
`;

export default GiftPackage;
