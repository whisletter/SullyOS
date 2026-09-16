/**
 * 与昼 · 一张便利贴的样子（木板和写便签页共用）
 * 所有尺寸用 em，fontSize = 边长 / 12，所以大小便签看起来一模一样，只是缩放。
 */
import React from 'react';
import { Star } from '@phosphor-icons/react';
import { paperOf, type NoteSticker } from '../../utils/yuzhouNotes';

export const NOTE_CARD_CSS = `
.yz-pin { background: radial-gradient(circle at 34% 30%, #ffffff 0 14%, #fbd3de 26%, #f3a2b8 62%, #e07f9b 100%); box-shadow: 0 .18em .3em rgba(120,50,70,.35), inset 0 -.08em .12em rgba(0,0,0,.12); }
.yz-tape { background: repeating-linear-gradient(90deg, rgba(255,255,255,.22) 0 .35em, transparent .35em .7em), rgba(183,212,242,.78); box-shadow: 0 .06em .2em rgba(80,100,140,.18); clip-path: polygon(2% 8%, 6% 0, 12% 10%, 18% 0, 25% 8%, 75% 8%, 82% 0, 88% 10%, 94% 0, 98% 8%, 100% 92%, 94% 100%, 88% 90%, 82% 100%, 76% 92%, 24% 92%, 18% 100%, 12% 90%, 6% 100%, 0 92%); }
@keyframes yz-note-in { 0% { opacity: 0; transform: translateY(-.6em) scale(1.06); } 100% { opacity: 1; transform: none; } }
.yz-note-in { animation: yz-note-in .32s ease-out; }
`;

export function relativeDay(ts: number): string {
  const start = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const diff = Math.round((start(Date.now()) - start(ts)) / 86400000);
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff < 7) return `${diff}天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

interface Props {
  size: number;
  author: 'user' | 'ta';
  text: string;
  paperId: string;
  stickers?: NoteSticker[];
  createdAt?: number;
  starred?: boolean;
  /** 用户这张还在等 TA 回应 */
  pending?: boolean;
  charName?: string;
  onToggleStar?: () => void;
  /** 写便签页：用输入框替换正文 */
  body?: React.ReactNode;
  /** 写便签页：贴纸层自己画（要能拖） */
  hideStickers?: boolean;
  /** 写便签页：不显示日期 / 收藏 */
  bare?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

const YuZhouNoteCard: React.FC<Props> = ({
  size, author, text, paperId, stickers = [], createdAt, starred, pending, charName,
  onToggleStar, body, hideStickers, bare, className = '', style,
}) => {
  const paper = paperOf(paperId);
  const isDark = paper.id === 'dark';
  return (
    <div className={`relative select-none ${className}`} style={{ width: size, height: size, fontSize: size / 12, ...style }}>
      {/* 纸 */}
      <div
        className="absolute inset-0 overflow-hidden rounded-[.15em]"
        style={{ ...paper.style, boxShadow: '0 .5em 1.1em -.3em rgba(120,72,60,.35), 0 .08em .2em rgba(120,72,60,.18)' }}
      >
        {/* 右下角轻微翘起的阴影 */}
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(135deg, transparent 72%, rgba(120,80,60,.07) 100%)' }} />
      </div>

      {/* 图钉（我）/ 胶带（TA） */}
      {author === 'user'
        ? <span className="yz-pin absolute left-1/2 rounded-full z-[2]" style={{ top: '-.45em', width: '1.25em', height: '1.25em', marginLeft: '-.625em' }} />
        : <span className="yz-tape absolute left-1/2 z-[2]" style={{ top: '-.55em', width: '4em', height: '1.15em', marginLeft: '-2em', transform: 'rotate(-4deg)' }} />}

      {!bare && (
        <div className="absolute inset-x-0 top-0 flex items-center justify-between z-[3]" style={{ padding: '.55em .6em 0 .8em' }}>
          <span style={{ fontSize: '.68em', color: paper.ink, opacity: .5 }}>{createdAt ? relativeDay(createdAt) : ''}</span>
          <button
            data-no-drag
            onClick={e => { e.stopPropagation(); onToggleStar?.(); }}
            aria-label={starred ? '取消收藏' : '收藏'}
            className="flex items-center justify-center active:scale-90 transition-transform"
            style={{ width: '1.7em', height: '1.7em', marginRight: '-.2em' }}
          >
            <Star
              weight={starred ? 'fill' : 'regular'}
              style={{ width: '1.15em', height: '1.15em', color: starred ? '#f5b53f' : paper.ink, opacity: starred ? 1 : .35 }}
            />
          </button>
        </div>
      )}

      {/* 正文 */}
      <div className="absolute z-[1]" style={{ left: '.85em', right: '.85em', top: bare ? '1.3em' : '2.05em', bottom: '1.5em' }}>
        {body ?? (
          <div className="h-full overflow-hidden whitespace-pre-wrap break-words" style={{ color: paper.ink, lineHeight: 1.55, fontSize: '.95em' }}>
            {text}
          </div>
        )}
      </div>

      {!bare && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between z-[3]" style={{ padding: '0 .8em .5em' }}>
          {pending
            ? <span className="rounded-full" style={{ fontSize: '.62em', padding: '.1em .7em', background: isDark ? 'rgba(255,255,255,.14)' : 'rgba(239,127,156,.12)', color: isDark ? '#fbcfe8' : '#e2577f' }}>未回复</span>
            : <span />}
          {author === 'ta' && charName && <span style={{ fontSize: '.66em', color: paper.ink, opacity: .6 }}>—— {charName}</span>}
        </div>
      )}

      {!hideStickers && stickers.map(s => (
        <img
          key={s.id}
          src={s.url}
          alt=""
          draggable={false}
          className="absolute pointer-events-none object-contain z-[4]"
          style={{ left: `${s.x}%`, top: `${s.y}%`, width: `${22 * s.scale}%`, transform: `translate(-50%, -50%) rotate(${s.rotation}deg)` }}
        />
      ))}
    </div>
  );
};

export default YuZhouNoteCard;
