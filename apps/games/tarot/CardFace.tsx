import React, { useState } from 'react';
import { TarotCard, SUIT_INFO, cardImagePath } from './cards';

/**
 * 牌面渲染。
 *
 * 优先用 `public/games/tarot/deck/NN.jpg` 里的牌面图；文件不存在就回落到
 * 代码画出来的默认牌面（深紫底 + 金描边 + 罗马数字/花色符号 + 牌名）。
 * 所以牌面图可以一张一张慢慢补，没补的那张不会开天窗。
 */

interface CardFaceProps {
  card: TarotCard;
  /** 逆位时牌面倒过来 */
  reversed?: boolean;
  /** 牌的宽度（px），高度按 1:1.68 自动算 */
  width?: number;
}

const GOLD = '#d9b978';
const GOLD_DIM = '#a98c52';

export const CARD_RATIO = 1.68;

export function CardFace({ card, reversed = false, width = 120 }: CardFaceProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const height = Math.round(width * CARD_RATIO);
  const suitInfo = card.suit ? SUIT_INFO[card.suit] : null;

  return (
    <div
      style={{
        width,
        height,
        borderRadius: Math.max(6, width * 0.06),
        overflow: 'hidden',
        position: 'relative',
        background: 'linear-gradient(160deg, #3a2352 0%, #241536 55%, #1a0f28 100%)',
        border: `${Math.max(1, width * 0.012)}px solid ${GOLD}`,
        boxShadow: '0 8px 22px rgba(0,0,0,0.45)',
        transform: reversed ? 'rotate(180deg)' : undefined,
      }}
    >
      {!imageFailed && (
        <img
          src={cardImagePath(card.id)}
          alt={card.name}
          onError={() => setImageFailed(true)}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />
      )}

      {imageFailed && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: width * 0.09,
            boxSizing: 'border-box',
          }}
        >
          {/* 内描边 */}
          <div
            style={{
              position: 'absolute',
              inset: width * 0.045,
              border: `1px solid ${GOLD_DIM}`,
              borderRadius: Math.max(3, width * 0.035),
              opacity: 0.55,
              pointerEvents: 'none',
            }}
          />

          <div
            style={{
              color: GOLD,
              fontSize: width * 0.13,
              letterSpacing: '0.08em',
              lineHeight: 1,
              zIndex: 1,
            }}
          >
            {card.mark}
          </div>

          <div
            style={{
              color: GOLD,
              fontSize: card.arcana === 'major' ? width * 0.34 : width * 0.4,
              lineHeight: 1,
              opacity: 0.85,
              zIndex: 1,
            }}
          >
            {card.arcana === 'major' ? '✦' : suitInfo?.symbol}
          </div>

          <div
            style={{
              color: '#efe3c8',
              fontSize: width * 0.13,
              letterSpacing: '0.12em',
              textAlign: 'center',
              lineHeight: 1.3,
              zIndex: 1,
            }}
          >
            {card.name}
          </div>
        </div>
      )}
    </div>
  );
}

/** 牌背，扇形铺开时看到的就是这个 */
export function CardBack({ width = 120 }: { width?: number }) {
  const height = Math.round(width * CARD_RATIO);
  return (
    <div
      style={{
        width,
        height,
        borderRadius: Math.max(6, width * 0.06),
        background: 'linear-gradient(150deg, #4a2d6b 0%, #2c1a44 50%, #1d1030 100%)',
        border: `${Math.max(1, width * 0.012)}px solid ${GOLD}`,
        boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: width * 0.05,
          border: `1px solid ${GOLD_DIM}`,
          borderRadius: Math.max(3, width * 0.035),
          opacity: 0.6,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: GOLD,
          fontSize: width * 0.3,
          opacity: 0.75,
        }}
      >
        ✵
      </div>
    </div>
  );
}

export default CardFace;
