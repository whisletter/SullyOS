import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DB } from '../../../utils/db';
import { TAROT_DECK } from './cards';
import type { CardMeaning } from './meanings';
import type { LenormandMeaning } from './lenormand';
import { CardFace, CardBack, GenericCardFace } from './CardFace';
import {
  DeckKind, DECK_KINDS, CARD_RATIOS, BUILTIN_DECK_ID, WorkshopData, PoolCard,
  buildDeckPool, deckNameOf,
} from './decks';

/**
 * 随心抽：拿起一副副牌，想抽几张抽几张，牌放在桌上可以拖动、叠放。
 *
 * 布局：① 牌组栏 + ② 抽牌区 固定在顶部，③ 桌面往下滚。
 * 桌上的牌、每副牌剩下的顺序都会保存（系统资源表，id = FREE_DRAW_ASSET_ID），
 * 离开再回来还在，点「清空」才收拾。
 *
 * 桌上的牌只记「哪副牌的哪一张」，图片每次从工坊的牌组里取，所以不会多存一份图。
 */

export const FREE_DRAW_ASSET_ID = 'tarot_free_draw_v1';

/** 每类最多同时摆几副 */
const MAX_PER_KIND = 3;
/** 拿到眼前时牌的宽度 */
const INSPECT_CARD_W = 170;

/**
 * 猫爪返回键，和小屋左上角那个一样（样式是 TarotApp 里的 .tarot-paw）。
 * 工坊也用这个。gradientId 每处不同，免得页面里出现重复的 SVG id。
 */
export function PawButton({ onClick, label = '回小屋', gradientId }: { onClick: () => void; label?: string; gradientId: string }) {
  return (
    <button className="tarot-paw" onClick={onClick} aria-label={label} title={label}>
      <svg width={20} height={20} viewBox="0 0 24 24" aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f3dca4" />
            <stop offset="100%" stopColor="#c89c52" />
          </linearGradient>
        </defs>
        <g fill={`url(#${gradientId})`}>
          <ellipse cx="5.9" cy="10.4" rx="1.9" ry="2.4" transform="rotate(-20 5.9 10.4)" />
          <ellipse cx="9.5" cy="6.2" rx="2" ry="2.6" transform="rotate(-6 9.5 6.2)" />
          <ellipse cx="14.5" cy="6.2" rx="2" ry="2.6" transform="rotate(6 14.5 6.2)" />
          <ellipse cx="18.1" cy="10.4" rx="1.9" ry="2.4" transform="rotate(20 18.1 10.4)" />
          <path d="M12 11.4c-2.6 0-5.7 3.2-5.7 5.9 0 1.6 1.2 2.7 2.7 2.7 1.2 0 1.9-.6 3-.6s1.8.6 3 .6c1.5 0 2.7-1.1 2.7-2.7 0-2.7-3.1-5.9-5.7-5.9z" />
        </g>
      </svg>
    </button>
  );
}

/** 金色小书图标 */
function BookIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#d9b978" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 6.5C10.2 5.2 7.6 4.6 4 4.8v13.4c3.6-.2 6.2.4 8 1.7 1.8-1.3 4.4-1.9 8-1.7V4.8c-3.6-.2-6.2.4-8 1.7z" />
      <path d="M12 6.5v13.4" />
      <path d="M7 8.6c1.2 0 2.2.2 3 .6M7 11.6c1.2 0 2.2.2 3 .6M14 9.2c.8-.4 1.8-.6 3-.6M14 12.2c.8-.4 1.8-.6 3-.6" strokeWidth="1.2" />
    </svg>
  );
}

/** 桌上每张牌的高度（px），宽度按比例算 */
const TABLE_CARD_H = 112;
const SLOT_GAP_X = 14;
const SLOT_GAP_Y = 22;
const TABLE_PAD = 14;
/** 抽牌区扇形里每张牌背的宽度，手指点得准一点 */
const FAN_CARD_W = 48;
/** 扇形的转轴在牌顶往下多少 px（越大扇面越平） */
const FAN_PIVOT = 300;
/** 被按住的那张抬起多少 */
const FAN_LIFT = 22;

interface FreeDeckState {
  deckId: string;
  kind: DeckKind;
  /** 还在牌堆里的牌，按当前顺序 */
  order: string[];
  /** 自上次洗牌后抽过几张；> 0 时再拿起来会问要不要重新洗 */
  drawnSinceShuffle: number;
}

interface TableCard {
  id: string;
  deckId: string;
  kind: DeckKind;
  cardKey: string;
  /** 左上角：x 是桌面宽度的比例（换屏幕宽度也不乱），y 是像素 */
  x: number;
  y: number;
  z: number;
  faceUp: boolean;
  reversed: boolean;
}

interface FreeDrawData {
  version: 1;
  decks: FreeDeckState[];
  cards: TableCard[];
  zTop: number;
  showMeaning: boolean;
}

function emptyFree(): FreeDrawData {
  return { version: 1, decks: [], cards: [], zTop: 1, showMeaning: true };
}

function normalizeFree(raw: unknown): FreeDrawData {
  const base = emptyFree();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<FreeDrawData>;
  return {
    version: 1,
    decks: Array.isArray(r.decks) ? r.decks : [],
    cards: Array.isArray(r.cards) ? r.cards : [],
    zTop: typeof r.zTop === 'number' ? r.zTop : 1,
    showMeaning: r.showMeaning !== false,
  };
}

function shuffleKeys(keys: string[]): string[] {
  const arr = keys.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function uid(): string {
  return `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function cardWidthOf(kind: DeckKind): number {
  return Math.round(TABLE_CARD_H / CARD_RATIOS[kind]);
}

/**
 * 牌堆里实际还剩哪些牌：
 * 保存的顺序里去掉已经不存在的牌（工坊里删了）和桌上的牌，
 * 再把后来新上传、还没进过牌堆的牌接在后面（点「洗牌」时一起洗进去）。
 * 这里不能随机，否则每次重新渲染扇形的顺序都会变。
 */
function remainingOf(state: FreeDeckState, pool: PoolCard[], table: TableCard[]): string[] {
  const exists = new Set(pool.map((p) => p.key));
  const onTable = new Set(table.filter((c) => c.deckId === state.deckId).map((c) => c.cardKey));
  const kept = state.order.filter((k) => exists.has(k) && !onTable.has(k));
  const known = new Set(state.order);
  const fresh = pool.map((p) => p.key).filter((k) => !known.has(k) && !onTable.has(k));
  return fresh.length ? [...kept, ...fresh] : kept;
}

/**
 * 最近一次的数据留在内存里：从随心抽跳去牌意之书再回来时，组件会重新挂载，
 * 这时写库可能还没落盘，直接用内存里的就不会读到旧数据。
 */
let freeCache: FreeDrawData | null = null;

function useFreeDrawStore() {
  const [data, setData] = useState<FreeDrawData>(() => freeCache ?? emptyFree());
  const [loaded, setLoaded] = useState(freeCache !== null);
  const ref = useRef<FreeDrawData>(data);
  const readOk = useRef(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (freeCache) {
      readOk.current = true;
      return;
    }
    let alive = true;
    (async () => {
      let next = emptyFree();
      let ok = false;
      try {
        const raw = await DB.getAssetRaw(FREE_DRAW_ASSET_ID);
        if (raw) next = normalizeFree(raw);
        ok = true;
      } catch {
        // 读失败：先空着显示，不写库
      }
      if (!alive) return;
      readOk.current = ok;
      if (ok) freeCache = next;
      ref.current = next;
      setData(next);
      setLoaded(true);
    })();
    return () => { alive = false; };
  }, []);

  const flush = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (!readOk.current) return;
    DB.saveAssetRaw(FREE_DRAW_ASSET_ID, ref.current).catch(() => undefined);
  }, []);

  // 离开页面时把没存的存掉
  useEffect(() => () => flush(), [flush]);

  /** 改数据；写库做了 400ms 合并，拖动时不会每一帧都写 */
  const update = useCallback((fn: (prev: FreeDrawData) => FreeDrawData) => {
    const next = fn(ref.current);
    ref.current = next;
    setData(next);
    if (!readOk.current) return;
    freeCache = next;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 400);
  }, [flush]);

  return { data, loaded, update };
}

interface FreeDrawProps {
  workshop: WorkshopData;
  /** 从哪个托盘进来的，第一次用时默认勾上这类桌上正在用的牌组 */
  entryKind: DeckKind;
  who: string;
  tarotMeaning: (id: number) => CardMeaning;
  lenormandMeaning: (id: number) => LenormandMeaning;
  onClose: () => void;
  onToast: (text: string) => void;
  onOpenWorkshop: (kind: DeckKind) => void;
  /** 跳去牌意之书（看完回到随心抽） */
  onOpenBook: (kind: DeckKind) => void;
}

type AskState = { deckId: string } | null;

export function FreeDraw({
  workshop, entryKind, tarotMeaning, lenormandMeaning, onClose, onToast, onOpenWorkshop, onOpenBook,
}: FreeDrawProps) {
  const { data, loaded, update } = useFreeDrawStore();

  const [picking, setPicking] = useState(false);
  const [activeDeckId, setActiveDeckId] = useState<string | null>(null);
  const [ask, setAsk] = useState<AskState>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [justDropped, setJustDropped] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  /** 上一次点桌上牌的时间，用来认双击 */
  const lastTap = useRef<{ id: string; t: number } | null>(null);
  /** 桌上每张牌的 DOM，放大动画要知道它在哪 */
  const cardEls = useRef<Record<string, HTMLDivElement | null>>({});

  // ── 放大看牌 ──
  // measure：大牌先按最终位置排好（看不见）→ from：瞬间挪回桌上那张牌的位置和大小
  // → open：带动画飞到眼前 → leave：飞回去，结束后卸载
  const bigRef = useRef<HTMLDivElement>(null);
  const [inspect, setInspect] = useState<{ id: string; stage: 'measure' | 'from' | 'open' | 'leave'; t: string } | null>(null);

  // 第一次进来还没选过牌组 → 直接打开选牌页
  useEffect(() => {
    if (loaded && data.decks.length === 0) setPicking(true);
  }, [loaded, data.decks.length]);

  // ── 桌面尺寸 ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const [tableW, setTableW] = useState(360);
  const [viewH, setViewH] = useState(500);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setTableW(el.clientWidth || 360);
      setViewH(el.clientHeight || 500);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // 加载完、从选牌页回来时桌面才出现，要重新量
  }, [picking, loaded]);

  // ── 每副牌的池子 ──
  const pools = useMemo(() => {
    const map: Record<string, PoolCard[]> = {};
    for (const d of data.decks) map[d.deckId] = buildDeckPool(workshop, d.kind, d.deckId);
    // 桌上可能有已经从牌组栏移除的牌组，也要能画出来
    for (const c of data.cards) {
      if (!map[c.deckId]) map[c.deckId] = buildDeckPool(workshop, c.kind, c.deckId);
    }
    return map;
  }, [data.decks, data.cards, workshop]);

  const remaining = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const d of data.decks) map[d.deckId] = remainingOf(d, pools[d.deckId] ?? [], data.cards);
    return map;
  }, [data.decks, data.cards, pools]);

  const nameOf = (kind: DeckKind, deckId: string) => deckNameOf(workshop, kind, deckId) ?? '已删除的牌组';

  const activeDeck = activeDeckId ? data.decks.find((d) => d.deckId === activeDeckId) ?? null : null;
  const activeUserDeck = activeDeck ? workshop.decks.find((d) => d.id === activeDeck.deckId) ?? null : null;

  // ── 拿起一副牌 ──
  const pickUpDeck = (deckId: string) => {
    if (activeDeckId === deckId) return;
    const st = data.decks.find((d) => d.deckId === deckId);
    if (!st) return;
    if ((remaining[deckId] ?? []).length === 0) {
      onToast('这副牌已经抽完了');
      return;
    }
    if (st.drawnSinceShuffle > 0) {
      setAsk({ deckId });
      return;
    }
    setActiveDeckId(deckId);
  };

  const reshuffleDeck = (deckId: string) => {
    update((prev) => ({
      ...prev,
      decks: prev.decks.map((d) =>
        d.deckId === deckId
          ? { ...d, order: shuffleKeys(remainingOf(d, pools[deckId] ?? [], prev.cards)), drawnSinceShuffle: 0 }
          : d,
      ),
    }));
  };

  // ── 选牌组 ──
  const applyDeckPick = (chosen: { deckId: string; kind: DeckKind }[]) => {
    update((prev) => {
      const decks: FreeDeckState[] = chosen.map(({ deckId, kind }) => {
        const old = prev.decks.find((d) => d.deckId === deckId);
        if (old) return old;
        const pool = buildDeckPool(workshop, kind, deckId);
        const onTable = new Set(prev.cards.filter((c) => c.deckId === deckId).map((c) => c.cardKey));
        return {
          deckId,
          kind,
          order: shuffleKeys(pool.map((p) => p.key).filter((k) => !onTable.has(k))),
          drawnSinceShuffle: 0,
        };
      });
      return { ...prev, decks };
    });
    if (activeDeckId && !chosen.some((c) => c.deckId === activeDeckId)) setActiveDeckId(null);
    setPicking(false);
  };

  // ── 自动找空位 ──
  const findSlot = useCallback((kind: DeckKind, cards: TableCard[]) => {
    const cw = cardWidthOf(kind);
    const cellW = Math.max(...DECK_KINDS.map((k) => cardWidthOf(k.kind))) + SLOT_GAP_X;
    const cellH = TABLE_CARD_H + SLOT_GAP_Y;
    const cols = Math.max(1, Math.floor((tableW - TABLE_PAD * 2 + SLOT_GAP_X) / cellW));
    const occupied = (sx: number, sy: number) =>
      cards.some((c) => {
        const px = c.x * tableW;
        return Math.abs(px - sx) < cellW * 0.6 && Math.abs(c.y - sy) < cellH * 0.6;
      });
    for (let row = 0; row < 400; row++) {
      for (let col = 0; col < cols; col++) {
        const sx = TABLE_PAD + col * cellW + (cellW - SLOT_GAP_X - cw) / 2;
        const sy = TABLE_PAD + row * cellH;
        if (!occupied(sx, sy)) return { x: sx / tableW, y: sy };
      }
    }
    return { x: TABLE_PAD / tableW, y: TABLE_PAD };
  }, [tableW]);

  // ── 抽一张 ──
  const drawCard = (cardKey: string) => {
    if (!activeDeck) return;
    const deckId = activeDeck.deckId;
    const kind = activeDeck.kind;
    const id = uid();
    let dropY = 0;
    update((prev) => {
      const slot = findSlot(kind, prev.cards);
      dropY = slot.y;
      const card: TableCard = {
        id,
        deckId,
        kind,
        cardKey,
        x: slot.x,
        y: slot.y,
        z: prev.zTop + 1,
        faceUp: false,
        reversed: kind === 'tarot' && Math.random() < 0.5,
      };
      return {
        ...prev,
        zTop: prev.zTop + 1,
        cards: [...prev.cards, card],
        decks: prev.decks.map((d) =>
          d.deckId === deckId
            ? { ...d, order: d.order.filter((k) => k !== cardKey), drawnSinceShuffle: d.drawnSinceShuffle + 1 }
            : d,
        ),
      };
    });
    setJustDropped(id);
    window.setTimeout(() => setJustDropped((v) => (v === id ? null : v)), 500);
    // 落点在屏幕外就滚过去
    const sc = scrollRef.current;
    if (sc) {
      const top = sc.scrollTop;
      if (dropY < top || dropY + TABLE_CARD_H > top + sc.clientHeight) {
        sc.scrollTo({ top: Math.max(0, dropY - 40), behavior: 'smooth' });
      }
    }
    if ((remaining[deckId] ?? []).length <= 1) {
      setActiveDeckId(null);
      onToast('这副牌抽完了');
    }
  };

  // ── 拖动 ──
  const drag = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    offX: number;
    offY: number;
    moved: boolean;
    lastClientX: number;
    lastClientY: number;
    raf: number | null;
  } | null>(null);
  const [dragPos, setDragPos] = useState<{ id: string; x: number; y: number } | null>(null);

  const positionFromPointer = (clientX: number, clientY: number) => {
    const d = drag.current;
    const table = tableRef.current;
    if (!d || !table) return null;
    const rect = table.getBoundingClientRect();
    const card = data.cards.find((c) => c.id === d.id);
    const cw = card ? cardWidthOf(card.kind) : 64;
    const px = Math.min(Math.max(0, clientX - rect.left - d.offX), Math.max(0, tableW - cw));
    const py = Math.max(0, clientY - rect.top - d.offY);
    return { x: px / tableW, y: py };
  };

  const autoScrollLoop = () => {
    const d = drag.current;
    const sc = scrollRef.current;
    if (!d || !sc || !d.moved) return;
    const rect = sc.getBoundingClientRect();
    const edge = 56;
    let dy = 0;
    if (d.lastClientY > rect.bottom - edge) dy = Math.min(14, (d.lastClientY - (rect.bottom - edge)) / 3);
    else if (d.lastClientY < rect.top + edge) dy = -Math.min(14, ((rect.top + edge) - d.lastClientY) / 3);
    if (dy !== 0) {
      sc.scrollTop += dy;
      const pos = positionFromPointer(d.lastClientX, d.lastClientY);
      if (pos) setDragPos({ id: d.id, ...pos });
    }
    d.raf = window.requestAnimationFrame(autoScrollLoop);
  };

  const onCardPointerDown = (e: React.PointerEvent<HTMLDivElement>, card: TableCard) => {
    if (e.button !== undefined && e.button !== 0) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    try { el.setPointerCapture(e.pointerId); } catch { /* 个别浏览器不支持 */ }
    drag.current = {
      id: card.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      offX: e.clientX - rect.left,
      offY: e.clientY - rect.top,
      moved: false,
      lastClientX: e.clientX,
      lastClientY: e.clientY,
      raf: null,
    };
  };

  const onCardPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    d.lastClientX = e.clientX;
    d.lastClientY = e.clientY;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 6) return;
      d.moved = true;
      // 被拖的牌浮到最上面
      update((prev) => ({
        ...prev,
        zTop: prev.zTop + 1,
        cards: prev.cards.map((c) => (c.id === d.id ? { ...c, z: prev.zTop + 1 } : c)),
      }));
      d.raf = window.requestAnimationFrame(autoScrollLoop);
    }
    const pos = positionFromPointer(e.clientX, e.clientY);
    if (pos) setDragPos({ id: d.id, ...pos });
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (d.raf !== null) window.cancelAnimationFrame(d.raf);
    drag.current = null;
    if (d.moved) {
      const pos = positionFromPointer(e.clientX, e.clientY) ?? dragPos;
      setDragPos(null);
      if (pos) {
        update((prev) => ({
          ...prev,
          cards: prev.cards.map((c) => (c.id === d.id ? { ...c, x: pos.x, y: pos.y } : c)),
        }));
      }
      return;
    }
    setDragPos(null);
    if (cancelled) return;
    // 没拖动 = 点了一下：牌背朝上就翻开；已经翻开的牌快速点两下，拿到眼前看
    const card = data.cards.find((c) => c.id === d.id);
    if (!card) return;
    const now = Date.now();
    const prevTap = lastTap.current;
    if (!card.faceUp) {
      update((prev) => ({
        ...prev,
        zTop: prev.zTop + 1,
        cards: prev.cards.map((c) => (c.id === card.id ? { ...c, faceUp: true, z: prev.zTop + 1 } : c)),
      }));
      lastTap.current = { id: card.id, t: now };
      return;
    }
    if (prevTap && prevTap.id === card.id && now - prevTap.t < 340) {
      lastTap.current = null;
      setInspect({ id: card.id, stage: 'measure', t: 'none' });
    } else {
      lastTap.current = { id: card.id, t: now };
    }
  };

  /** 大牌从 bigRef 的最终位置变到桌上那张牌的位置，需要的 transform */
  const transformToTableCard = (id: string): string | null => {
    const big = bigRef.current;
    const small = cardEls.current[id];
    if (!big || !small) return null;
    const b = big.getBoundingClientRect();
    const r = small.getBoundingClientRect();
    if (b.width === 0 || r.width === 0) return null;
    const dx = r.left + r.width / 2 - (b.left + b.width / 2);
    const dy = r.top + r.height / 2 - (b.top + b.height / 2);
    return `translate(${dx}px, ${dy}px) scale(${r.width / b.width})`;
  };

  useLayoutEffect(() => {
    if (!inspect || inspect.stage !== 'measure') return;
    const t = transformToTableCard(inspect.id) ?? 'scale(0.6)';
    setInspect({ ...inspect, stage: 'from', t });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspect]);

  useEffect(() => {
    if (!inspect || inspect.stage !== 'from') return;
    // 等浏览器先画出「在桌上」的那一帧，再开始飞
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        setInspect((cur) => (cur && cur.stage === 'from' ? { ...cur, stage: 'open', t: 'none' } : cur));
      });
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [inspect]);

  const closeInspect = () => {
    if (!inspect || inspect.stage === 'leave') return;
    const t = transformToTableCard(inspect.id) ?? 'scale(0.6)';
    setInspect({ ...inspect, stage: 'leave', t });
    window.setTimeout(() => setInspect(null), 420);
  };

  // ── 清空 ──
  const clearAll = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      window.setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    update((prev) => ({
      ...prev,
      cards: [],
      zTop: 1,
      decks: prev.decks.map((d) => ({
        ...d,
        order: shuffleKeys((pools[d.deckId] ?? []).map((p) => p.key)),
        drawnSinceShuffle: 0,
      })),
    }));
    setConfirmClear(false);
    setActiveDeckId(null);
    setInspect(null);
    onToast('桌子收拾干净了，牌都回到牌堆');
  };

  // ── 渲染 ──
  const tableHeight = Math.max(
    viewH,
    ...data.cards.map((c) => c.y + TABLE_CARD_H + 160),
    dragPos ? dragPos.y + TABLE_CARD_H + 160 : 0,
  );

  const renderCardFace = (card: TableCard, width: number, pc: PoolCard | undefined, withReverse: boolean) => {
    if (!pc) {
      return <GenericCardFace width={width} ratio={CARD_RATIOS[card.kind]} symbol="?" title="找不到这张牌" />;
    }
    if (pc.tarotId !== undefined) {
      return <CardFace card={TAROT_DECK[pc.tarotId]} reversed={withReverse && card.reversed} width={width} image={pc.image} />;
    }
    if (pc.lenormandId !== undefined) {
      return (
        <GenericCardFace width={width} ratio={CARD_RATIOS.lenormand} image={pc.image} mark={String(pc.lenormandId)} symbol="✧" title={pc.name} />
      );
    }
    return <GenericCardFace width={width} ratio={CARD_RATIOS.oracle} image={pc.image} symbol="✧" title={pc.name} />;
  };

  const inspectCard = inspect ? data.cards.find((c) => c.id === inspect.id) ?? null : null;
  const inspectPool = inspectCard ? (pools[inspectCard.deckId] ?? []).find((p) => p.key === inspectCard.cardKey) : undefined;

  // ── 扇形：按住左右滑动挑牌，松手抽出 ──
  const fanRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const scrub = useRef<{ pointerId: number } | null>(null);

  /** 手指位置 → 扇形里第几张。按手指相对转轴的角度算，和牌的实际旋转一致 */
  const fanIndexAt = (clientX: number, clientY: number, count: number, angleSpan: number, cardH: number): number | null => {
    const el = fanRef.current;
    if (!el || count === 0) return null;
    const rect = el.getBoundingClientRect();
    // 手指离开扇形区域太远就算放弃
    if (clientY < rect.top - 70 || clientY > rect.bottom + 50) return null;
    if (count === 1) return 0;
    const cx = rect.left + rect.width / 2;
    const pivotY = rect.bottom - cardH + FAN_PIVOT;
    const angle = (Math.atan2(clientX - cx, pivotY - clientY) * 180) / Math.PI;
    const step = angleSpan / (count - 1);
    const idx = Math.round((angle + angleSpan / 2) / step);
    return Math.min(count - 1, Math.max(0, idx));
  };

  const userDeckOf = (deckId: string) => workshop.decks.find((d) => d.id === deckId) ?? null;

  if (!loaded) {
    return (
      <div className="fd-root">
        <p className="fd-loading">正在摆桌子…</p>
      </div>
    );
  }

  if (picking) {
    return (
      <DeckPicker
        workshop={workshop}
        entryKind={entryKind}
        current={data.decks.map((d) => ({ deckId: d.deckId, kind: d.kind }))}
        onCancel={() => (data.decks.length ? setPicking(false) : onClose())}
        onConfirm={applyDeckPick}
        onOpenWorkshop={onOpenWorkshop}
      />
    );
  }

  const fanKeys = activeDeck ? remaining[activeDeck.deckId] ?? [] : [];
  const fanCount = fanKeys.length;
  const fanAngle = fanCount > 40 ? 64 : fanCount > 12 ? 52 : Math.max(14, fanCount * 5);
  const fanRatio = activeDeck ? CARD_RATIOS[activeDeck.kind] : 1.7;
  const fanCardH = Math.round(FAN_CARD_W * fanRatio);

  return (
    <div className="fd-root">
      {/* ① 顶部 + 牌组栏 */}
      <div className="fd-top">
        <PawButton onClick={onClose} gradientId="fdPawGold" />
        <h2 className="fd-title">随心抽</h2>
        <div className="fd-top-right">
          <button
            className={menuOpen ? 'fd-icon-btn fd-icon-btn-on' : 'fd-icon-btn'}
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="牌意设置"
            aria-expanded={menuOpen}
          >
            <BookIcon size={18} />
          </button>
          <button
            className={confirmClear ? 'tarot-chip tarot-chip-sm ws-danger' : 'tarot-chip tarot-chip-ghost tarot-chip-sm'}
            onClick={clearAll}
            disabled={data.cards.length === 0}
          >
            {confirmClear ? '再点一次' : '清空'}
          </button>
        </div>
      </div>

      <div className="fd-decks">
        {data.decks.map((d) => {
          const on = d.deckId === activeDeckId;
          const left = (remaining[d.deckId] ?? []).length;
          return (
            <button
              key={d.deckId}
              className={on ? 'fd-deck fd-deck-on' : 'fd-deck'}
              onClick={() => (on ? setActiveDeckId(null) : pickUpDeck(d.deckId))}
            >
              <span className="fd-deck-back">
                <CardBack width={22} ratio={CARD_RATIOS[d.kind]} image={userDeckOf(d.deckId)?.back} />
              </span>
              <span className="fd-deck-text">
                <span className="fd-deck-name">{nameOf(d.kind, d.deckId)}</span>
                <span className="fd-deck-left">{left > 0 ? `剩 ${left}` : '抽完了'}</span>
              </span>
            </button>
          );
        })}
        <button className="fd-deck fd-deck-add" onClick={() => setPicking(true)} aria-label="选牌组">+</button>
      </div>

      {/* ② 抽牌区 */}
      {activeDeck ? (
        <div className="fd-draw">
          <div
            className="fd-fan"
            ref={fanRef}
            style={{ height: fanCardH + FAN_LIFT + 12 }}
            onPointerDown={(e: React.PointerEvent<HTMLDivElement>) => {
              if (e.button !== undefined && e.button !== 0) return;
              try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
              scrub.current = { pointerId: e.pointerId };
              setHoverIdx(fanIndexAt(e.clientX, e.clientY, fanCount, fanAngle, fanCardH));
            }}
            onPointerMove={(e: React.PointerEvent<HTMLDivElement>) => {
              if (!scrub.current || scrub.current.pointerId !== e.pointerId) return;
              const idx = fanIndexAt(e.clientX, e.clientY, fanCount, fanAngle, fanCardH);
              setHoverIdx((prev) => (prev === idx ? prev : idx));
            }}
            onPointerUp={(e: React.PointerEvent<HTMLDivElement>) => {
              if (!scrub.current || scrub.current.pointerId !== e.pointerId) return;
              scrub.current = null;
              const idx = fanIndexAt(e.clientX, e.clientY, fanCount, fanAngle, fanCardH);
              setHoverIdx(null);
              if (idx !== null && fanKeys[idx]) drawCard(fanKeys[idx]);
            }}
            onPointerCancel={() => {
              scrub.current = null;
              setHoverIdx(null);
            }}
          >
            {fanKeys.map((key, i) => {
              const angle = fanCount > 1 ? -fanAngle / 2 + (fanAngle / (fanCount - 1)) * i : 0;
              const hot = hoverIdx === i;
              return (
                <div
                  key={key}
                  className={hot ? 'fd-fan-card fd-fan-card-hot' : 'fd-fan-card'}
                  style={{
                    transform: `rotate(${angle}deg)${hot ? ` translateY(-${FAN_LIFT}px)` : ''}`,
                    transformOrigin: `50% ${FAN_PIVOT}px`,
                    zIndex: hot ? 500 : i,
                  }}
                >
                  <CardBack width={FAN_CARD_W} ratio={fanRatio} image={activeUserDeck?.back} />
                </div>
              );
            })}
          </div>
          <div className="fd-draw-actions">
            <span className="fd-draw-name">
              {hoverIdx !== null ? `第 ${hoverIdx + 1} 张 · 松手抽出` : `${nameOf(activeDeck.kind, activeDeck.deckId)} · 按住左右滑动挑牌`}
            </span>
            <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={() => reshuffleDeck(activeDeck.deckId)}>
              洗牌
            </button>
            <button className="tarot-chip tarot-chip-sm" onClick={() => setActiveDeckId(null)}>收起</button>
          </div>
        </div>
      ) : (
        <div className="fd-draw-collapsed">
          {data.decks.length ? '点上面的牌组，把它拿起来抽' : '先点「+」选几副牌'}
        </div>
      )}

      {/* ③ 桌面 */}
      <div className="fd-scroll" ref={scrollRef}>
        <div className="fd-table" ref={tableRef} style={{ height: tableHeight }}>
          {data.cards.length === 0 && (
            <p className="fd-empty">抽出来的牌会落在这里<br />按住牌拖动、叠放，点一下翻开<br />翻开的牌快速点两下，拿到眼前看</p>
          )}
          {data.cards.map((card) => {
            const pc = (pools[card.deckId] ?? []).find((p) => p.key === card.cardKey);
            const w = cardWidthOf(card.kind);
            const pos = dragPos && dragPos.id === card.id ? dragPos : card;
            const deckName = nameOf(card.kind, card.deckId);
            return (
              <div
                key={card.id}
                ref={(el: HTMLDivElement | null) => { cardEls.current[card.id] = el; }}
                className={
                  'fd-card' +
                  (dragPos?.id === card.id ? ' fd-card-dragging' : '') +
                  (justDropped === card.id ? ' fd-card-drop' : '')
                }
                style={{
                  left: pos.x * tableW,
                  top: pos.y,
                  zIndex: card.z,
                  width: w,
                  height: TABLE_CARD_H,
                  visibility: inspect?.id === card.id ? 'hidden' : undefined,
                }}
                onPointerDown={(e: React.PointerEvent<HTMLDivElement>) => onCardPointerDown(e, card)}
                onPointerMove={onCardPointerMove}
                onPointerUp={(e: React.PointerEvent<HTMLDivElement>) => endDrag(e, false)}
                onPointerCancel={(e: React.PointerEvent<HTMLDivElement>) => endDrag(e, true)}
                role="button"
                aria-label={card.faceUp && pc ? pc.name : '牌背朝上的牌'}
              >
                {card.faceUp ? (
                  <span className="tarot-flip-in">{renderCardFace(card, w, pc, true)}</span>
                ) : (
                  <CardBack width={w} ratio={CARD_RATIOS[card.kind]} image={userDeckOf(card.deckId)?.back} />
                )}
                <span className="fd-card-tag">{deckName.replace(/^基础/, '').slice(0, 1)}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 拿起抽过的牌：接着抽还是重新洗 */}
      {ask && (
        <div className="ws-mask" onClick={() => setAsk(null)}>
          <div className="ws-sheet" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <h3 className="ws-sheet-title">{nameOf(data.decks.find((d) => d.deckId === ask.deckId)?.kind ?? 'tarot', ask.deckId)}</h3>
            <p className="ws-hint" style={{ textAlign: 'center' }}>
              这副牌上次抽到一半，剩下 {(remaining[ask.deckId] ?? []).length} 张
            </p>
            <div className="ws-sheet-actions">
              <button
                className="tarot-chip"
                onClick={() => { setActiveDeckId(ask.deckId); setAsk(null); }}
              >
                接着抽
              </button>
              <button
                className="tarot-chip"
                onClick={() => { reshuffleDeck(ask.deckId); setActiveDeckId(ask.deckId); setAsk(null); }}
              >
                重新洗牌
              </button>
              <button className="tarot-chip tarot-chip-ghost" onClick={() => setAsk(null)}>算了</button>
            </div>
          </div>
        </div>
      )}

      {/* 📖 牌意菜单 */}
      {menuOpen && (
        <div className="fd-menu-mask" onClick={() => setMenuOpen(false)}>
          <div className="fd-menu" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <button
              className="fd-menu-row"
              onClick={() => update((prev) => ({ ...prev, showMeaning: !prev.showMeaning }))}
              role="switch"
              aria-checked={data.showMeaning}
            >
              <span>显示牌意</span>
              <span className={data.showMeaning ? 'fd-switch fd-switch-on' : 'fd-switch'}><i /></span>
            </button>
            <button
              className="fd-menu-row"
              onClick={() => {
                setMenuOpen(false);
                onOpenBook(activeDeck?.kind ?? data.decks[0]?.kind ?? entryKind);
              }}
            >
              <span>查找一下？</span>
              <span className="fd-menu-go">牌意之书 ›</span>
            </button>
          </div>
        </div>
      )}

      {/* 拿到眼前看一张牌 */}
      {inspect && inspectCard && (
        <div
          className={`fd-inspect fd-inspect-${inspect.stage}`}
          onClick={closeInspect}
        >
          <div className="fd-inspect-body">
            <div
              className="fd-inspect-card"
              ref={bigRef}
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
              style={{
                transform: inspect.t,
                opacity: inspect.stage === 'measure' ? 0 : 1,
                transition: inspect.stage === 'open' || inspect.stage === 'leave'
                  ? 'transform 0.42s cubic-bezier(.2,.8,.25,1)'
                  : 'none',
              }}
            >
              <span className="fd-magic" aria-hidden="true" />
              <span className="fd-sparkles" aria-hidden="true">
                <i /><i /><i /><i /><i /><i />
              </span>
              <span className="fd-inspect-face">
                {renderCardFace(inspectCard, INSPECT_CARD_W, inspectPool, true)}
              </span>
            </div>

            <div className="fd-inspect-info" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
              <p className="fd-sheet-deck">{nameOf(inspectCard.kind, inspectCard.deckId)}</p>
              {inspectPool && (
                <h3 className="ws-sheet-title fd-sheet-name">
                  {inspectPool.name}
                  {inspectCard.kind === 'tarot' && <span className="ws-badge">{inspectCard.reversed ? '逆位' : '正位'}</span>}
                  {inspectPool.lenormandId !== undefined && <span className="ws-badge">{inspectPool.lenormandId}</span>}
                </h3>
              )}

              {data.showMeaning && inspectPool ? (
                <div className="fd-sheet-meaning">
                  {inspectPool.tarotId !== undefined && (
                    <p>{inspectCard.reversed ? tarotMeaning(inspectPool.tarotId).rev : tarotMeaning(inspectPool.tarotId).up}</p>
                  )}
                  {inspectPool.lenormandId !== undefined && (
                    <>
                      <p><b>关键词</b>{lenormandMeaning(inspectPool.lenormandId).keywords}</p>
                      <p><b>时间</b>{lenormandMeaning(inspectPool.lenormandId).time}</p>
                    </>
                  )}
                  {inspectPool.oracle && (
                    inspectPool.oracle.meaning.trim()
                      ? <p>{inspectPool.oracle.meaning}</p>
                      : <p className="fd-muted" style={{ textAlign: 'center' }}>这张还没写牌意</p>
                  )}
                </div>
              ) : (
                inspectPool && <p className="fd-muted" style={{ textAlign: 'center' }}>牌意已隐藏，点右上角 📖 可以去牌意之书找找</p>
              )}

              <button className="tarot-chip fd-put-down" onClick={closeInspect}>放下</button>

              <div className="fd-inspect-more">
                {inspectCard.kind === 'tarot' && (
                  <button
                    className="tarot-chip tarot-chip-ghost tarot-chip-sm"
                    onClick={() => update((prev) => ({
                      ...prev,
                      cards: prev.cards.map((c) => (c.id === inspectCard.id ? { ...c, reversed: !c.reversed } : c)),
                    }))}
                  >
                    转一下
                  </button>
                )}
                <button
                  className="tarot-chip tarot-chip-ghost tarot-chip-sm"
                  onClick={() => {
                    const id = inspectCard.id;
                    closeInspect();
                    window.setTimeout(() => {
                      update((prev) => ({
                        ...prev,
                        cards: prev.cards.map((c) => (c.id === id ? { ...c, faceUp: false } : c)),
                      }));
                    }, 420);
                  }}
                >
                  盖回去
                </button>
                <button
                  className="tarot-chip tarot-chip-ghost tarot-chip-sm"
                  onClick={() => {
                    // 收回牌堆：放到那副牌的最底下
                    const card = inspectCard;
                    setInspect(null);
                    update((prev) => ({
                      ...prev,
                      cards: prev.cards.filter((c) => c.id !== card.id),
                      decks: prev.decks.map((d) =>
                        d.deckId === card.deckId ? { ...d, order: [...d.order, card.cardKey] } : d,
                      ),
                    }));
                  }}
                >
                  收回牌堆
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 选牌组：按分类勾选，每类最多 3 副 */
function DeckPicker({
  workshop, entryKind, current, onCancel, onConfirm, onOpenWorkshop,
}: {
  workshop: WorkshopData;
  entryKind: DeckKind;
  current: { deckId: string; kind: DeckKind }[];
  onCancel: () => void;
  onConfirm: (chosen: { deckId: string; kind: DeckKind }[]) => void;
  onOpenWorkshop: (kind: DeckKind) => void;
}) {
  const [chosen, setChosen] = useState<{ deckId: string; kind: DeckKind }[]>(() => {
    if (current.length) return current;
    // 第一次：默认勾上进来的那类桌上正在用的牌组
    const activeId = workshop.active[entryKind] ?? BUILTIN_DECK_ID[entryKind];
    const exists = activeId && (activeId === BUILTIN_DECK_ID[entryKind] || workshop.decks.some((d) => d.id === activeId));
    return exists ? [{ deckId: activeId!, kind: entryKind }] : [];
  });
  const [warn, setWarn] = useState<string | null>(null);

  const optionsOf = (kind: DeckKind) => {
    const list: { deckId: string; name: string; count: number; back?: string }[] = [];
    const builtin = BUILTIN_DECK_ID[kind];
    if (builtin) list.push({ deckId: builtin, name: deckNameOf(workshop, kind, builtin) ?? '', count: buildDeckPool(workshop, kind, builtin).length });
    for (const d of workshop.decks.filter((x) => x.kind === kind)) {
      list.push({ deckId: d.id, name: d.name, count: buildDeckPool(workshop, kind, d.id).length, back: d.back });
    }
    return list;
  };

  const toggle = (deckId: string, kind: DeckKind, count: number) => {
    setWarn(null);
    const on = chosen.some((c) => c.deckId === deckId);
    if (on) {
      setChosen(chosen.filter((c) => c.deckId !== deckId));
      return;
    }
    if (count === 0) {
      setWarn('这副牌还没有牌，先去工坊上传');
      return;
    }
    if (chosen.filter((c) => c.kind === kind).length >= MAX_PER_KIND) {
      setWarn(`每类最多同时摆 ${MAX_PER_KIND} 副`);
      return;
    }
    setChosen([...chosen, { deckId, kind }]);
  };

  return (
    <div className="fd-root">
      <div className="fd-top">
        <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={onCancel}>‹ 返回</button>
        <h2 className="fd-title">选牌</h2>
        <button className="tarot-chip tarot-chip-sm" onClick={() => onConfirm(chosen)} disabled={chosen.length === 0}>
          摆上桌
        </button>
      </div>
      <p className="fd-picker-tip">勾选想用的牌组，每类最多 {MAX_PER_KIND} 副。取消勾选的牌组，桌上已经抽出来的牌会留着。</p>
      {warn && <p className="fd-picker-warn">{warn}</p>}
      <div className="fd-picker-body">
        {DECK_KINDS.map(({ kind, label }) => {
          const opts = optionsOf(kind);
          const n = chosen.filter((c) => c.kind === kind).length;
          return (
            <div key={kind} className="fd-picker-group">
              <div className="fd-picker-head">
                <span>{label}</span>
                <em>{n}/{MAX_PER_KIND}</em>
              </div>
              {opts.length === 0 ? (
                <p className="fd-muted fd-picker-none">
                  还没有牌组，
                  <button className="tarot-link" onClick={() => onOpenWorkshop(kind)}>去工坊上传</button>
                </p>
              ) : (
                <div className="fd-picker-list">
                  {opts.map((o) => {
                    const on = chosen.some((c) => c.deckId === o.deckId);
                    return (
                      <button
                        key={o.deckId}
                        className={on ? 'fd-option fd-option-on' : 'fd-option'}
                        onClick={() => toggle(o.deckId, kind, o.count)}
                      >
                        <CardBack width={30} ratio={CARD_RATIOS[kind]} image={o.back} />
                        <span className="fd-option-text">
                          <span className="fd-option-name">{o.name}</span>
                          <span className="fd-option-count">{o.count} 张</span>
                        </span>
                        <span className={on ? 'fd-check fd-check-on' : 'fd-check'}>{on ? '✓' : ''}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const FREE_DRAW_CSS = `
.fd-root {
  position: absolute; inset: 0; z-index: 34;
  display: flex; flex-direction: column;
  background: linear-gradient(180deg, #1c1030 0%, #150b24 100%);
  color: #efe3c8;
  padding-top: var(--safe-top, 0px);
}
.fd-loading { margin: auto; font-size: 13px; color: rgba(239,227,200,0.6); }
.fd-top {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 12px 14px 8px;
}
.fd-title { margin: 0; font-size: 17px; font-weight: 500; letter-spacing: 0.14em; }
.fd-top-right { display: flex; align-items: center; gap: 8px; }
.fd-icon-btn {
  width: 34px; height: 34px; border-radius: 50%;
  border: 1px solid rgba(217,185,120,0.55); background: rgba(12,6,22,0.6);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; padding: 0;
}
.fd-icon-btn-on { background: rgba(217,185,120,0.18); border-color: #d9b978; }

.fd-decks {
  display: flex; gap: 8px; padding: 2px 14px 10px;
  overflow-x: auto; scrollbar-width: none;
  border-bottom: 1px solid rgba(217,185,120,0.25);
}
.fd-decks::-webkit-scrollbar { display: none; }
.fd-deck {
  flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
  border: 1px solid rgba(217,185,120,0.3); background: rgba(40,22,62,0.55);
  border-radius: 10px; padding: 5px 10px 5px 6px; cursor: pointer;
  color: #efe3c8; font-family: inherit; max-width: 150px;
}
.fd-deck-on { border-color: #d9b978; background: rgba(217,185,120,0.14); box-shadow: 0 0 10px rgba(217,185,120,0.25); }
.fd-deck-back { line-height: 0; flex-shrink: 0; }
.fd-deck-text { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; }
.fd-deck-name { font-size: 12px; max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fd-deck-left { font-size: 10px; color: #d9b978; }
.fd-deck-add {
  justify-content: center; min-width: 40px; font-size: 20px; color: #d9b978;
  border-style: dashed; padding: 5px 12px;
}

.fd-draw { border-bottom: 1px solid rgba(217,185,120,0.25); padding: 4px 0 8px; }
.fd-fan {
  position: relative; width: 100%; display: flex; justify-content: center; overflow: hidden;
  touch-action: none; user-select: none; -webkit-user-select: none; cursor: pointer;
}
.fd-fan-card {
  position: absolute; bottom: 0; line-height: 0; pointer-events: none;
  transition: transform 0.12s ease, filter 0.12s ease;
}
.fd-fan-card-hot { filter: brightness(1.35) drop-shadow(0 0 10px rgba(240,205,130,0.75)); }
.fd-draw-actions { display: flex; align-items: center; gap: 8px; padding: 6px 14px 0; }
.fd-draw-name { flex: 1; font-size: 11px; color: rgba(239,227,200,0.6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fd-draw-collapsed {
  padding: 7px 14px; font-size: 11px; text-align: center; letter-spacing: 0.06em;
  color: rgba(239,227,200,0.45); border-bottom: 1px solid rgba(217,185,120,0.25);
}

.fd-scroll {
  flex: 1; overflow-y: auto; overflow-x: hidden; -webkit-overflow-scrolling: touch;
  position: relative; z-index: 0; isolation: isolate; /* 桌上牌的层级只在桌面里比，不会盖住弹窗 */
}
.fd-table { position: relative; width: 100%; }
.fd-empty {
  position: absolute; left: 0; right: 0; top: 38%; margin: 0; text-align: center;
  font-size: 12px; line-height: 1.9; color: rgba(239,227,200,0.35); letter-spacing: 0.06em;
  pointer-events: none;
}
.fd-card {
  position: absolute; line-height: 0; cursor: grab;
  touch-action: none; user-select: none; -webkit-user-select: none;
  transition: filter 0.15s ease;
}
.fd-card-dragging { cursor: grabbing; filter: drop-shadow(0 10px 18px rgba(0,0,0,0.55)) brightness(1.08); }
.fd-card-drop { animation: fdDrop 0.42s cubic-bezier(.2,.8,.3,1) both; }
@keyframes fdDrop { from { transform: translateY(-40px) scale(0.85); opacity: 0; } }
.fd-card-tag {
  position: absolute; right: -5px; top: -5px;
  min-width: 16px; height: 16px; padding: 0 3px; box-sizing: border-box;
  border-radius: 8px; background: #2a1840; border: 1px solid rgba(217,185,120,0.7);
  color: #d9b978; font-size: 9px; line-height: 14px; text-align: center;
  pointer-events: none;
}

.fd-menu-mask { position: absolute; inset: 0; z-index: 40; }
.fd-menu {
  position: absolute; right: 14px; top: calc(56px + var(--safe-top, 0px));
  width: 210px; background: #251639; border: 1px solid rgba(217,185,120,0.5);
  border-radius: 14px; padding: 6px; box-shadow: 0 12px 30px rgba(0,0,0,0.5);
  animation: tarotReveal 0.18s ease both;
}
.fd-menu-row {
  width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 10px;
  border: none; background: transparent; color: #efe3c8; font-family: inherit; font-size: 14px;
  padding: 11px 10px; border-radius: 10px; cursor: pointer; text-align: left;
}
.fd-menu-row + .fd-menu-row { border-top: 1px solid rgba(217,185,120,0.18); border-radius: 0 0 10px 10px; }
.fd-menu-row:active { background: rgba(217,185,120,0.1); }
.fd-menu-go { font-size: 12px; color: #d9b978; }
.fd-switch {
  position: relative; width: 38px; height: 22px; border-radius: 11px; flex-shrink: 0;
  background: rgba(239,227,200,0.18); transition: background 0.2s ease;
}
.fd-switch i {
  position: absolute; left: 3px; top: 3px; width: 16px; height: 16px; border-radius: 50%;
  background: #efe3c8; transition: transform 0.2s ease;
}
.fd-switch-on { background: #d9b978; }
.fd-switch-on i { transform: translateX(16px); background: #1c1030; }

/* 拿到眼前看 */
.fd-inspect {
  position: absolute; inset: 0; z-index: 50;
  background: rgba(8,4,16,0.78);
  transition: background 0.4s ease;
}
.fd-inspect-measure, .fd-inspect-from, .fd-inspect-leave { background: rgba(8,4,16,0); }
.fd-inspect-body {
  position: absolute; inset: 0; overflow-y: auto;
  display: flex; flex-direction: column; align-items: center;
  padding: calc(56px + var(--safe-top, 0px)) 20px 32px; box-sizing: border-box;
}
.fd-inspect-card { position: relative; line-height: 0; transform-origin: 50% 50%; will-change: transform; margin-top: 12px; }
.fd-inspect-face {
  position: relative; display: inline-block; border-radius: 10px;
  box-shadow: 0 0 0 1px rgba(240,205,130,0.6), 0 0 26px rgba(240,200,120,0.55), 0 0 60px rgba(217,185,120,0.25);
}
.fd-magic {
  position: absolute; inset: -34px; border-radius: 40px; pointer-events: none;
  background: radial-gradient(ellipse at center, rgba(255,220,150,0.42) 0%, rgba(217,185,120,0.16) 45%, rgba(217,185,120,0) 72%);
  animation: fdMagic 2.6s ease-in-out infinite;
  opacity: 0; transition: opacity 0.5s ease;
}
.fd-inspect-open .fd-magic { opacity: 1; }
@keyframes fdMagic {
  0%, 100% { transform: scale(0.96); filter: brightness(1); }
  50% { transform: scale(1.04); filter: brightness(1.25); }
}
.fd-sparkles { position: absolute; inset: -26px; pointer-events: none; opacity: 0; transition: opacity 0.6s ease 0.15s; }
.fd-inspect-open .fd-sparkles { opacity: 1; }
.fd-sparkles i {
  position: absolute; width: 6px; height: 6px; border-radius: 50%;
  background: #fbe3a8; box-shadow: 0 0 8px 2px rgba(251,227,168,0.8);
  animation: fdTwinkle 2.2s ease-in-out infinite;
}
.fd-sparkles i:nth-child(1) { left: 6%; top: 12%; animation-delay: 0s; }
.fd-sparkles i:nth-child(2) { right: 4%; top: 22%; animation-delay: 0.5s; }
.fd-sparkles i:nth-child(3) { left: 0; top: 58%; animation-delay: 1.1s; width: 4px; height: 4px; }
.fd-sparkles i:nth-child(4) { right: 8%; bottom: 10%; animation-delay: 0.8s; }
.fd-sparkles i:nth-child(5) { left: 30%; bottom: 0; animation-delay: 1.5s; width: 4px; height: 4px; }
.fd-sparkles i:nth-child(6) { right: 30%; top: 0; animation-delay: 1.8s; width: 4px; height: 4px; }
@keyframes fdTwinkle {
  0%, 100% { opacity: 0; transform: scale(0.4) translateY(4px); }
  50% { opacity: 1; transform: scale(1) translateY(-4px); }
}
.fd-inspect-info {
  width: 100%; max-width: 360px; margin-top: 26px;
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  opacity: 0; transform: translateY(10px); transition: opacity 0.35s ease 0.18s, transform 0.35s ease 0.18s;
}
.fd-inspect-open .fd-inspect-info { opacity: 1; transform: none; }
.fd-inspect-leave .fd-inspect-info { transition-delay: 0s; transition-duration: 0.18s; }
.fd-put-down { margin-top: 8px; padding: 9px 34px; font-size: 14px; letter-spacing: 0.2em; }
.fd-inspect-more { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
.fd-sheet-deck { margin: -4px 0 0; text-align: center; font-size: 11px; color: rgba(239,227,200,0.5); }
.fd-sheet-name { display: flex; align-items: center; justify-content: center; gap: 8px; }
.fd-sheet-meaning { display: flex; flex-direction: column; gap: 6px; }
.fd-sheet-meaning p { margin: 0; font-size: 14px; line-height: 1.8; color: rgba(239,227,200,0.9); text-align: center; }
.fd-sheet-meaning b { color: #d9b978; font-weight: 400; font-size: 12px; margin-right: 10px; }
.fd-muted { margin: 0; font-size: 12px; color: rgba(239,227,200,0.5); }

.fd-picker-tip { margin: 0 14px 8px; font-size: 11px; line-height: 1.7; color: rgba(239,227,200,0.5); }
.fd-picker-warn { margin: 0 14px 8px; font-size: 12px; color: #f0a8a8; }
.fd-picker-body { flex: 1; overflow-y: auto; padding: 4px 14px 24px; display: flex; flex-direction: column; gap: 18px; }
.fd-picker-head {
  display: flex; align-items: baseline; justify-content: space-between;
  padding-bottom: 6px; margin-bottom: 8px; border-bottom: 1px solid rgba(217,185,120,0.35);
  font-size: 14px; letter-spacing: 0.06em; color: #d9b978;
}
.fd-picker-head em { font-style: normal; font-size: 11px; color: rgba(239,227,200,0.5); }
.fd-picker-none { padding: 6px 0; }
.fd-picker-list { display: flex; flex-direction: column; gap: 8px; }
.fd-option {
  display: flex; align-items: center; gap: 12px; text-align: left;
  border: 1px solid rgba(217,185,120,0.25); background: rgba(40,22,62,0.45);
  border-radius: 12px; padding: 8px 12px; cursor: pointer; color: #efe3c8; font-family: inherit;
}
.fd-option-on { border-color: #d9b978; background: rgba(217,185,120,0.1); }
.fd-option-text { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.fd-option-name { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fd-option-count { font-size: 11px; color: rgba(239,227,200,0.5); }
.fd-check {
  width: 22px; height: 22px; border-radius: 50%; flex-shrink: 0;
  border: 1px solid rgba(217,185,120,0.5); color: #1c1030;
  display: flex; align-items: center; justify-content: center; font-size: 13px;
}
.fd-check-on { background: #d9b978; border-color: #d9b978; }
`;

export default FreeDraw;
