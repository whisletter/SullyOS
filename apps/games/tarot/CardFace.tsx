import React from 'react';
import { TarotCard, SUIT_INFO } from './cards';
import { useBlobRefUrl } from '../../../utils/blobRef';

/**
 * 牌面渲染。
 *
 * 有上传的图（牌组工坊里存的 blobref 令牌）就显示图；没有就画默认牌面
 * （深紫底 + 金描边 + 标记 + 牌名）。所以一套牌可以一张一张慢慢补。
 *
 * 高宽比按实体牌尺寸（见 decks.ts 的 CARD_RATIOS），默认塔罗 12×7。
 */

const GOLD = '#d9b978';
const GOLD_DIM = '#a98c52';

/** 塔罗 12×7 */
export const CARD_RATIO = 12 / 7;

interface ShellProps {
  width: number;
  ratio: number;
  /** blobref 令牌或普通图片地址 */
  image?: string;
  reversed?: boolean;
  /** 没图时画在牌上的内容 */
  mark?: string;
  symbol?: string;
  title?: string;
  /** 没上传的牌在工坊里显示得淡一点 */
  dim?: boolean;
}

/** 通用牌面：塔罗、雷诺曼、神谕都用它 */
export function GenericCardFace({ width, ratio, image, reversed, mark, symbol, title, dim }: ShellProps) {
  const src = useBlobRefUrl(image);
  const height = Math.round(width * ratio);
  const showImage = !!image;

  return (
    <div
      style={{
        width,
        height,
        borderRadius: Math.max(5, width * 0.06),
        overflow: 'hidden',
        position: 'relative',
        background: 'linear-gradient(160deg, #3a2352 0%, #241536 55%, #1a0f28 100%)',
        border: `${Math.max(1, width * 0.012)}px solid ${GOLD}`,
        boxShadow: '0 8px 22px rgba(0,0,0,0.45)',
        transform: reversed ? 'rotate(180deg)' : undefined,
        opacity: dim ? 0.55 : 1,
        boxSizing: 'border-box',
      }}
    >
      {showImage && src && (
        <img
          src={src}
          alt={title || ''}
          draggable={false}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        />
      )}

      {!showImage && (
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
          <div style={{ color: GOLD, fontSize: width * 0.13, letterSpacing: '0.08em', lineHeight: 1, zIndex: 1 }}>
            {mark}
          </div>
          <div style={{ color: GOLD, fontSize: width * 0.34, lineHeight: 1, opacity: 0.85, zIndex: 1 }}>
            {symbol}
          </div>
          <div
            style={{
              color: '#efe3c8',
              fontSize: width * 0.13,
              letterSpacing: '0.1em',
              textAlign: 'center',
              lineHeight: 1.3,
              zIndex: 1,
              wordBreak: 'break-all',
            }}
          >
            {title}
          </div>
        </div>
      )}
    </div>
  );
}

interface CardFaceProps {
  card: TarotCard;
  reversed?: boolean;
  width?: number;
  /** 上传的牌面（blobref 令牌），不传就画默认牌面 */
  image?: string;
  dim?: boolean;
}

/** 塔罗牌面 */
export function CardFace({ card, reversed = false, width = 120, image, dim }: CardFaceProps) {
  const suitInfo = card.suit ? SUIT_INFO[card.suit] : null;
  return (
    <GenericCardFace
      width={width}
      ratio={CARD_RATIO}
      image={image}
      reversed={reversed}
      mark={card.mark}
      symbol={card.arcana === 'major' ? '✦' : suitInfo?.symbol}
      title={card.name}
      dim={dim}
    />
  );
}

/** 牌背。image 可以是令牌，也可以是已经解析好的地址（扇形里 78 张共用一个） */
export function CardBack({ width = 120, ratio = CARD_RATIO, image }: { width?: number; ratio?: number; image?: string }) {
  const src = useBlobRefUrl(image);
  const height = Math.round(width * ratio);
  return (
    <div
      style={{
        width,
        height,
        borderRadius: Math.max(5, width * 0.06),
        background: 'linear-gradient(150deg, #4a2d6b 0%, #2c1a44 50%, #1d1030 100%)',
        border: `${Math.max(1, width * 0.012)}px solid ${GOLD}`,
        boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
        position: 'relative',
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      {image && src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}

export default CardFace;
