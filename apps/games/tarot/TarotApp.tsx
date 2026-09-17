import React, { useMemo, useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import { TAROT_DECK, TarotCard, SUIT_INFO } from './cards';
import { getMeaning, CardMeaning } from './meanings';
import { CardFace, CardBack, CARD_RATIO } from './CardFace';
import { useOS } from '../../../context/OSContext';
// 房间图和代码放在同一个文件夹，由 Vite 打包。想换背景，直接用同名图片覆盖即可。
// 平板（屏幕偏宽）用 2:3 的这两张：
import roomEmptyUrl from './room-empty.jpg';
import roomOccupiedUrl from './room-occupied.jpg';
// 手机（屏幕瘦长）用带阁楼天花板的这两张：
import roomEmptyPhoneUrl from './room-empty-phone.webp';
import roomOccupiedPhoneUrl from './room-occupied-phone.webp';

/**
 * 塔罗 — 最小可玩版。
 *
 * 这一版做的：房间场景 + 煤油灯调亮调暗 + 首次进入的金光提示 +
 * 塔罗一副（78 张）+ 单张牌阵 + 洗牌扇形抽牌翻牌 + 牌意之书。
 *
 * 留了接口没做的：雷诺曼 / 神谕两副牌（托盘已经画好位置）、三张牌阵、
 * 牌组工坊（墙上的画）、称号（天球仪）、呼叫 TA（电话）。
 * 点这些位置现在会提示「还没开」，不会报错。
 *
 * 手机 / 平板按屏幕比例自动选图，两套图各有一套点击热区（见 SCENES）。
 * 牌意之书里双击某张牌的牌意可以改写，改动存在本机（localStorage）。
 *
 * 角色名默认读当前选中的角色（useOS），也可以从 props 传进来覆盖。
 * 代码里不写死任何具体角色。
 */

export interface TarotAppProps {
  /** 游戏大厅返回，由 registry 的 GameProps 传进来 */
  onBack: () => void;
  /** 角色名，不传就读当前选中的角色；都没有时显示「TA」 */
  characterName?: string;
  /** 角色头像（目前房间里不显示，保留这个参数免得调用方报错） */
  characterAvatar?: string;
}

type Phase = 'room' | 'shuffle' | 'fan' | 'result' | 'book';

interface DrawnCard {
  card: TarotCard;
  reversed: boolean;
}

const GOLD = '#d9b978';
const PARCHMENT = '#efe3c8';


/** 洗牌：Fisher–Yates */
function shuffle<T>(input: T[]): T[] {
  const arr = input.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 房间里可点的位置，按房间图的百分比定位 */
interface Hotspot {
  key: string;
  label: string;
  left: string;
  top: string;
  width: string;
  height: string;
  ready: boolean;
}

/** 平板 2:3 图的热区（原版，两张图共用） */
const HOTSPOTS_TABLET: Hotspot[] = [
  { key: 'tarot', label: '塔罗牌', left: '0%', top: '59%', width: '17%', height: '23%', ready: true },
  { key: 'book', label: '牌意之书', left: '72%', top: '70%', width: '28%', height: '19%', ready: true },
  { key: 'lamp', label: '煤油灯', left: '0%', top: '36%', width: '11%', height: '22%', ready: true },
  { key: 'orrery', label: '称号', left: '76%', top: '47%', width: '13%', height: '14%', ready: false },
  { key: 'phone', label: '呼叫', left: '87%', top: '54%', width: '13%', height: '14%', ready: false },
  { key: 'painting', label: '牌组工坊', left: '51%', top: '2%', width: '26%', height: '24%', ready: false },
];

/** 手机 · 空座位图的热区 */
const HOTSPOTS_PHONE_EMPTY: Hotspot[] = [
  { key: 'tarot', label: '塔罗牌', left: '0%', top: '58%', width: '20%', height: '18%', ready: true },
  { key: 'book', label: '牌意之书', left: '73%', top: '65%', width: '27%', height: '17%', ready: true },
  { key: 'lamp', label: '煤油灯', left: '0%', top: '42%', width: '12%', height: '16%', ready: true },
  { key: 'orrery', label: '称号', left: '76%', top: '51%', width: '12%', height: '11%', ready: false },
  { key: 'phone', label: '呼叫', left: '88%', top: '53%', width: '12%', height: '12%', ready: false },
  { key: 'painting', label: '牌组工坊', left: '51%', top: '18%', width: '26%', height: '18%', ready: false },
];

/** 手机 · TA 在座图的热区（这张图比例更长，物件位置略有不同） */
const HOTSPOTS_PHONE_OCCUPIED: Hotspot[] = [
  { key: 'tarot', label: '塔罗牌', left: '0%', top: '56%', width: '21%', height: '17%', ready: true },
  { key: 'book', label: '牌意之书', left: '73%', top: '63%', width: '27%', height: '16%', ready: true },
  { key: 'lamp', label: '煤油灯', left: '0%', top: '40%', width: '12%', height: '17%', ready: true },
  { key: 'orrery', label: '称号', left: '76%', top: '49%', width: '12%', height: '11%', ready: false },
  { key: 'phone', label: '呼叫', left: '88%', top: '52%', width: '12%', height: '11%', ready: false },
  { key: 'painting', label: '牌组工坊', left: '52%', top: '16%', width: '25%', height: '17%', ready: false },
];

interface Rect { left: string; top: string; width: string; height: string }

/** 一张房间图的全部配置 */
interface Scene {
  src: string;
  /** 图片高 / 宽，图片加载后会用真实尺寸覆盖，换图不用改这里 */
  ratio: number;
  hotspots: Hotspot[];
  /** 「请 TA 入座」的点击区域 */
  seat: Rect;
  /** 煤油灯暖光的中心位置 */
  glowAt: string;
}

const SCENES: Record<'phone' | 'tablet', { empty: Scene; occupied: Scene }> = {
  phone: {
    empty: {
      src: roomEmptyPhoneUrl,
      ratio: 2269 / 1080,
      hotspots: HOTSPOTS_PHONE_EMPTY,
      seat: { left: '23%', top: '40%', width: '50%', height: '17%' },
      glowAt: '5% 51%',
    },
    occupied: {
      src: roomOccupiedPhoneUrl,
      ratio: 2048 / 930,
      hotspots: HOTSPOTS_PHONE_OCCUPIED,
      seat: { left: '18%', top: '34%', width: '56%', height: '15%' },
      glowAt: '5% 49%',
    },
  },
  tablet: {
    empty: {
      src: roomEmptyUrl,
      ratio: 1.5,
      hotspots: HOTSPOTS_TABLET,
      seat: { left: '23%', top: '31%', width: '49%', height: '27%' },
      glowAt: '6% 46%',
    },
    occupied: {
      src: roomOccupiedUrl,
      ratio: 1.5,
      hotspots: HOTSPOTS_TABLET,
      seat: { left: '23%', top: '31%', width: '49%', height: '27%' },
      glowAt: '6% 46%',
    },
  },
};

/** 屏幕高/宽超过这个值就算手机，用瘦长图 */
const PHONE_ASPECT = 1.75;

/** 牌意改写存在本机 */
const MEANING_OVERRIDE_KEY = 'sullyos.tarot.meaningOverrides.v1';
type MeaningOverrides = Record<number, CardMeaning>;

function loadMeaningOverrides(): MeaningOverrides {
  try {
    const raw = window.localStorage.getItem(MEANING_OVERRIDE_KEY);
    return raw ? (JSON.parse(raw) as MeaningOverrides) : {};
  } catch {
    return {};
  }
}

function saveMeaningOverrides(data: MeaningOverrides) {
  try {
    window.localStorage.setItem(MEANING_OVERRIDE_KEY, JSON.stringify(data));
  } catch {
    // 存储满了或被禁用时，本次会话里改动仍然有效
  }
}

/** 猫爪图标，金色渐变 */
function PawIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="tarotPawGold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f3dca4" />
          <stop offset="100%" stopColor="#c89c52" />
        </linearGradient>
      </defs>
      <g fill="url(#tarotPawGold)">
        <ellipse cx="5.9" cy="10.4" rx="1.9" ry="2.4" transform="rotate(-20 5.9 10.4)" />
        <ellipse cx="9.5" cy="6.2" rx="2" ry="2.6" transform="rotate(-6 9.5 6.2)" />
        <ellipse cx="14.5" cy="6.2" rx="2" ry="2.6" transform="rotate(6 14.5 6.2)" />
        <ellipse cx="18.1" cy="10.4" rx="1.9" ry="2.4" transform="rotate(20 18.1 10.4)" />
        <path d="M12 11.4c-2.6 0-5.7 3.2-5.7 5.9 0 1.6 1.2 2.7 2.7 2.7 1.2 0 1.9-.6 3-.6s1.8.6 3 .6c1.5 0 2.7-1.1 2.7-2.7 0-2.7-3.1-5.9-5.7-5.9z" />
      </g>
    </svg>
  );
}

export function TarotApp({ characterName, onBack }: TarotAppProps) {
  const { activeCharacterId, characters } = useOS();
  const activeChar = characters.find((c) => c.id === activeCharacterId);
  const who = characterName?.trim() || activeChar?.name?.trim() || 'TA';

  // 量一下容器尺寸，决定用手机图还是平板图，以及图怎么铺
  const rootRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setFrame({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /** 图片真实比例，按 src 记录，换图后自动适配 */
  const [ratios, setRatios] = useState<Record<string, number>>({});

  const [phase, setPhase] = useState<Phase>('room');
  const [lampBright, setLampBright] = useState(false);
  const [taSeated, setTaSeated] = useState(false);
  const [hintPlaying, setHintPlaying] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  const [deckOrder, setDeckOrder] = useState<TarotCard[]>(() => shuffle(TAROT_DECK));
  const [drawn, setDrawn] = useState<DrawnCard | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [bookFilter, setBookFilter] = useState<'all' | 'major' | 'minor'>('all');

  // 牌意改写
  const [overrides, setOverrides] = useState<MeaningOverrides>(() => loadMeaningOverrides());
  const [editing, setEditing] = useState<{ id: number; up: string; rev: string } | null>(null);
  const lastTap = useRef<{ id: number; t: number } | null>(null);

  const meaningOf = useCallback(
    (id: number): CardMeaning => overrides[id] ?? getMeaning(id),
    [overrides],
  );

  const handleEntryTap = useCallback((id: number) => {
    if (editing?.id === id) return;
    const now = Date.now();
    const prev = lastTap.current;
    if (prev && prev.id === id && now - prev.t < 350) {
      lastTap.current = null;
      const m = overrides[id] ?? getMeaning(id);
      setEditing({ id, up: m.up, rev: m.rev });
    } else {
      lastTap.current = { id, t: now };
    }
  }, [editing, overrides]);

  const saveEdit = useCallback(() => {
    if (!editing) return;
    const def = getMeaning(editing.id);
    const up = editing.up.trim();
    const rev = editing.rev.trim();
    const next = { ...overrides };
    if (up === def.up && rev === def.rev) delete next[editing.id];
    else next[editing.id] = { up: up || def.up, rev: rev || def.rev };
    setOverrides(next);
    saveMeaningOverrides(next);
    setEditing(null);
  }, [editing, overrides]);

  const resetEdit = useCallback(() => {
    if (!editing) return;
    const next = { ...overrides };
    delete next[editing.id];
    setOverrides(next);
    saveMeaningOverrides(next);
    setEditing(null);
  }, [editing, overrides]);

  // 首次进入，物件依次闪一遍金光，之后安静下来
  useEffect(() => {
    const timer = window.setTimeout(() => setHintPlaying(false), 4200);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const startDraw = useCallback(() => {
    setDeckOrder(shuffle(TAROT_DECK));
    setDrawn(null);
    setFlipped(false);
    setPhase('shuffle');
    window.setTimeout(() => setPhase('fan'), 1100);
  }, []);

  const pickCard = useCallback((index: number) => {
    const card = deckOrder[index];
    if (!card) return;
    setDrawn({ card, reversed: Math.random() < 0.5 });
    setFlipped(false);
    setPhase('result');
  }, [deckOrder]);

  const handleHotspot = useCallback((spot: Hotspot) => {
    if (!spot.ready) {
      setToast(`${spot.label}还没开，下一版见`);
      return;
    }
    if (spot.key === 'tarot') startDraw();
    else if (spot.key === 'book') setPhase('book');
    else if (spot.key === 'lamp') setLampBright((v) => !v);
  }, [startDraw]);

  const variant: 'phone' | 'tablet' =
    frame.w > 0 && frame.h / frame.w >= PHONE_ASPECT ? 'phone' : 'tablet';
  const scene = SCENES[variant][taSeated ? 'occupied' : 'empty'];
  const imgRatio = ratios[scene.src] ?? scene.ratio;

  // 手机：铺满屏幕、顶部对齐（多出来的只裁桌布下沿，两张图桌面也对得最齐）
  // 平板：按宽度完整显示、贴底，上方用深紫底色补
  const roomBox: React.CSSProperties = useMemo(() => {
    if (frame.w === 0) return styles.roomWrap;
    if (variant === 'phone') {
      const w = Math.max(frame.w, frame.h / imgRatio);
      const h = w * imgRatio;
      return { position: 'absolute', lineHeight: 0, width: w, height: h, left: (frame.w - w) / 2, top: 0 };
    }
    const h = frame.w * imgRatio;
    return { position: 'absolute', lineHeight: 0, width: frame.w, height: h, left: 0, top: frame.h - h };
  }, [frame, variant, imgRatio]);

  const bookList = useMemo(() => {
    if (bookFilter === 'all') return TAROT_DECK;
    return TAROT_DECK.filter((c) => c.arcana === bookFilter);
  }, [bookFilter]);

  return (
    <div ref={rootRef} style={styles.root}>
      <style>{CSS}</style>

      {/* ── 房间 ─────────────────────────────── */}
      <div style={roomBox}>
        <img
          src={scene.src}
          alt=""
          style={styles.roomImage}
          onLoad={(e: React.SyntheticEvent<HTMLImageElement>) => {
            const img = e.currentTarget;
            if (img.naturalWidth > 0) {
              const r = img.naturalHeight / img.naturalWidth;
              const src = scene.src;
              setRatios((prev) => (prev[src] === r ? prev : { ...prev, [src]: r }));
            }
          }}
          onError={(e: React.SyntheticEvent<HTMLImageElement>) => {
            // 图片还没放进 public 时不开天窗，用底色顶着
            e.currentTarget.style.visibility = 'hidden';
          }}
        />

        {/* 暖光 / 暗角。生图是灯亮态，默认压暗一档 */}
        <div
          style={{
            ...styles.vignette,
            opacity: lampBright ? 0.18 : 0.62,
          }}
        />
        <div
          style={{
            ...styles.warmGlow,
            background: `radial-gradient(circle at ${scene.glowAt}, rgba(255,186,94,0.55) 0%, rgba(255,186,94,0) 45%)`,
            opacity: lampBright ? 0.35 : 0.12,
          }}
        />

        {/* 可点的位置 */}
        {scene.hotspots.map((spot, i) => (
          <button
            key={spot.key}
            className={hintPlaying ? 'tarot-hotspot tarot-hint' : 'tarot-hotspot'}
            style={{
              left: spot.left,
              top: spot.top,
              width: spot.width,
              height: spot.height,
              animationDelay: hintPlaying ? `${i * 0.45}s` : undefined,
            }}
            onClick={() => handleHotspot(spot)}
            aria-label={spot.label}
          >
            <span className="tarot-hotspot-label">{spot.label}</span>
          </button>
        ))}

        {/* 椅子：TA 在不在座 */}
        <button
          className="tarot-seat"
          style={scene.seat}
          onClick={() => setTaSeated((v) => !v)}
          aria-label={taSeated ? `请${who}先离席` : `请${who}入座`}
        >
          <span className="tarot-seat-label">
            {taSeated ? `${who} 坐在对面` : `请 ${who} 入座`}
          </span>
        </button>
      </div>

      {/* 顶部：猫爪返回。灯的明暗只靠点桌上的煤油灯 */}
      <div style={styles.topBar}>
        <button className="tarot-paw" onClick={onBack} aria-label="离开小屋" title="离开小屋">
          <PawIcon size={20} />
        </button>
      </div>

      {toast && <div className="tarot-toast">{toast}</div>}

      {/* ── 洗牌 ─────────────────────────────── */}
      {phase === 'shuffle' && (
        <div style={styles.overlay}>
          <div className="tarot-shuffle">
            <div className="tarot-shuffle-card" />
            <div className="tarot-shuffle-card" />
            <div className="tarot-shuffle-card" />
          </div>
          <p style={styles.overlayHint}>洗牌中，想着你的问题</p>
        </div>
      )}

      {/* ── 扇形抽牌 ─────────────────────────── */}
      {phase === 'fan' && (
        <div style={styles.overlay}>
          <p style={styles.overlayHint}>凭感觉挑一张</p>
          <div className="tarot-fan">
            {deckOrder.map((card, i) => {
              const total = deckOrder.length;
              const spread = 68; // 扇面总角度
              const angle = -spread / 2 + (spread / (total - 1)) * i;
              return (
                <button
                  key={card.id}
                  className="tarot-fan-card"
                  style={{
                    transform: `rotate(${angle}deg)`,
                    zIndex: i,
                  }}
                  onClick={() => pickCard(i)}
                  aria-label={`第 ${i + 1} 张`}
                >
                  <CardBack width={66} />
                </button>
              );
            })}
          </div>
          <button className="tarot-chip tarot-chip-ghost" onClick={() => setPhase('room')}>
            算了，先不抽
          </button>
        </div>
      )}

      {/* ── 结果 ─────────────────────────────── */}
      {phase === 'result' && drawn && (
        <div style={styles.overlay}>
          {!flipped ? (
            <>
              <p style={styles.overlayHint}>牌已经落下，点开看看</p>
              <button className="tarot-flip-btn" onClick={() => setFlipped(true)}>
                <CardBack width={150} />
              </button>
            </>
          ) : (
            <div className="tarot-result">
              <CardFace card={drawn.card} reversed={drawn.reversed} width={150} />
              <h2 style={styles.resultName}>
                {drawn.card.name}
                <span style={styles.resultPos}>{drawn.reversed ? '逆位' : '正位'}</span>
              </h2>
              <p style={styles.resultMeaning}>
                {drawn.reversed ? meaningOf(drawn.card.id).rev : meaningOf(drawn.card.id).up}
              </p>
              <div style={styles.resultActions}>
                <button className="tarot-chip" onClick={startDraw}>再抽一张</button>
                <button className="tarot-chip tarot-chip-ghost" onClick={() => setPhase('room')}>
                  回到桌前
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── 牌意之书 ─────────────────────────── */}
      {phase === 'book' && (
        <div style={styles.overlay}>
          <div className="tarot-book">
            <div className="tarot-book-head">
              <h2 style={styles.bookTitle}>牌意之书</h2>
              <button
                className="tarot-chip tarot-chip-ghost"
                onClick={() => { setEditing(null); setPhase('room'); }}
              >
                合上
              </button>
            </div>
            <div className="tarot-book-tabs">
              {([
                ['all', '全部 78'],
                ['major', '大阿卡纳'],
                ['minor', '小阿卡纳'],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  className={bookFilter === key ? 'tarot-tab tarot-tab-on' : 'tarot-tab'}
                  onClick={() => { setEditing(null); setBookFilter(key); }}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="tarot-book-tip">双击牌意可以改写，改动保存在这台设备上</p>
            <div className="tarot-book-body">
              {bookList.map((card) => {
                const m = meaningOf(card.id);
                const isEditing = editing?.id === card.id;
                const edited = overrides[card.id] !== undefined;
                return (
                  <div
                    key={card.id}
                    className={isEditing ? 'tarot-entry tarot-entry-editing' : 'tarot-entry'}
                    onClick={() => handleEntryTap(card.id)}
                  >
                    <div className="tarot-entry-head">
                      <span className="tarot-entry-mark">{card.mark}</span>
                      <span className="tarot-entry-name">{card.name}</span>
                      {card.suit && (
                        <span className="tarot-entry-suit">{SUIT_INFO[card.suit].element}</span>
                      )}
                      {edited && <span className="tarot-entry-edited">已改写</span>}
                    </div>
                    {isEditing && editing ? (
                      <div className="tarot-edit">
                        <label className="tarot-edit-row">
                          <b>正</b>
                          <textarea
                            className="tarot-edit-input"
                            value={editing.up}
                            rows={2}
                            autoFocus
                            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEditing({ ...editing, up: e.target.value })}
                          />
                        </label>
                        <label className="tarot-edit-row">
                          <b>逆</b>
                          <textarea
                            className="tarot-edit-input"
                            value={editing.rev}
                            rows={2}
                            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEditing({ ...editing, rev: e.target.value })}
                          />
                        </label>
                        <div className="tarot-edit-actions">
                          {edited && (
                            <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={resetEdit}>
                              恢复默认
                            </button>
                          )}
                          <div style={{ flex: 1 }} />
                          <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={() => setEditing(null)}>
                            取消
                          </button>
                          <button className="tarot-chip tarot-chip-sm" onClick={saveEdit}>
                            保存
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <p className="tarot-entry-line"><b>正</b>{m.up}</p>
                        <p className="tarot-entry-line"><b>逆</b>{m.rev}</p>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    // 盖在游戏大厅上面，跟大富翁同一层
    position: 'absolute',
    inset: 0,
    zIndex: 70,
    overflow: 'hidden',
    background: 'linear-gradient(180deg, #170d24 0%, #241538 40%, #1a0f28 100%)',
    color: PARCHMENT,
    fontFamily: 'inherit',
    userSelect: 'none',
  },
  roomWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    lineHeight: 0,
  },
  roomImage: {
    width: '100%',
    height: '100%',
    display: 'block',
    objectFit: 'cover',
  },
  vignette: {
    position: 'absolute',
    inset: 0,
    background:
      'radial-gradient(ellipse at 50% 62%, rgba(0,0,0,0) 30%, rgba(8,4,16,0.85) 100%)',
    transition: 'opacity 0.8s ease',
    pointerEvents: 'none',
  },
  warmGlow: {
    position: 'absolute',
    inset: 0,
    transition: 'opacity 0.8s ease',
    pointerEvents: 'none',
    mixBlendMode: 'screen',
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 12px',
    paddingTop: 'calc(10px + var(--safe-top, 0px))',
    zIndex: 20,
  },
  overlay: {
    position: 'absolute',
    inset: 0,
    zIndex: 30,
    background: 'rgba(12,6,22,0.88)',
    backdropFilter: 'blur(3px)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
    padding: 16,
    boxSizing: 'border-box',
  },
  overlayHint: {
    margin: 0,
    fontSize: 14,
    letterSpacing: '0.08em',
    color: 'rgba(239,227,200,0.75)',
  },
  resultName: {
    margin: '4px 0 0',
    fontSize: 22,
    fontWeight: 500,
    letterSpacing: '0.06em',
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
  },
  resultPos: {
    fontSize: 13,
    color: GOLD,
    border: `1px solid ${GOLD}`,
    borderRadius: 999,
    padding: '2px 10px',
    letterSpacing: '0.1em',
  },
  resultMeaning: {
    margin: 0,
    maxWidth: 300,
    textAlign: 'center',
    lineHeight: 1.85,
    fontSize: 15,
    color: 'rgba(239,227,200,0.9)',
  },
  resultActions: {
    display: 'flex',
    gap: 10,
    marginTop: 4,
  },
  bookTitle: {
    margin: 0,
    fontSize: 18,
    letterSpacing: '0.12em',
    fontWeight: 500,
  },
};

const CSS = `
.tarot-hotspot {
  position: absolute;
  border: none;
  background: transparent;
  border-radius: 12px;
  cursor: pointer;
  padding: 0;
  z-index: 10;
  transition: box-shadow 0.25s ease, background 0.25s ease;
}
.tarot-hotspot:hover, .tarot-hotspot:focus-visible {
  background: rgba(217,185,120,0.12);
  box-shadow: inset 0 0 0 1px rgba(217,185,120,0.55), 0 0 18px rgba(217,185,120,0.3);
  outline: none;
}
.tarot-hotspot-label {
  position: absolute;
  left: 50%;
  bottom: -4px;
  transform: translate(-50%, 100%);
  white-space: nowrap;
  font-size: 11px;
  letter-spacing: 0.1em;
  color: #d9b978;
  background: rgba(12,6,22,0.8);
  border-radius: 999px;
  padding: 2px 8px;
  opacity: 0;
  transition: opacity 0.2s ease;
  pointer-events: none;
}
.tarot-hotspot:hover .tarot-hotspot-label,
.tarot-hotspot:focus-visible .tarot-hotspot-label { opacity: 1; }

.tarot-hint { animation: tarotShimmer 1.1s ease-in-out 1 both; }
@keyframes tarotShimmer {
  0%, 100% { box-shadow: inset 0 0 0 0 rgba(217,185,120,0); }
  50% {
    box-shadow: inset 0 0 0 1px rgba(217,185,120,0.9), 0 0 26px rgba(217,185,120,0.55);
    background: rgba(217,185,120,0.16);
  }
}

.tarot-seat {
  position: absolute;
  border: none;
  background: transparent;
  cursor: pointer;
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  padding: 0 0 6px;
}
.tarot-seat-label {
  font-size: 11px;
  letter-spacing: 0.1em;
  color: #d9b978;
  background: rgba(12,6,22,0.72);
  border-radius: 999px;
  padding: 3px 10px;
  opacity: 0;
  transition: opacity 0.2s ease;
}
.tarot-seat:hover .tarot-seat-label,
.tarot-seat:focus-visible .tarot-seat-label { opacity: 1; }

.tarot-chip {
  border: 1px solid rgba(217,185,120,0.5);
  background: rgba(12,6,22,0.7);
  color: #d9b978;
  font-size: 13px;
  letter-spacing: 0.08em;
  border-radius: 999px;
  padding: 7px 16px;
  cursor: pointer;
  transition: background 0.2s ease, border-color 0.2s ease;
  font-family: inherit;
}
.tarot-chip:hover { background: rgba(217,185,120,0.16); border-color: #d9b978; }
.tarot-chip-ghost { border-color: rgba(239,227,200,0.28); color: rgba(239,227,200,0.7); }
.tarot-chip-sm { font-size: 12px; padding: 5px 12px; }

/* 猫爪返回：深紫圆底 + 双层细金边 */
.tarot-paw {
  position: relative;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1px solid rgba(217,185,120,0.85);
  background: radial-gradient(circle at 50% 35%, rgba(52,30,78,0.88) 0%, rgba(16,8,28,0.88) 100%);
  box-shadow: 0 0 10px rgba(217,185,120,0.18), inset 0 1px 0 rgba(243,220,164,0.18);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  cursor: pointer;
  transition: box-shadow 0.2s ease, transform 0.15s ease;
}
.tarot-paw::after {
  content: '';
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  border: 0.5px solid rgba(217,185,120,0.4);
  pointer-events: none;
}
.tarot-paw:hover, .tarot-paw:focus-visible {
  box-shadow: 0 0 16px rgba(217,185,120,0.4), inset 0 1px 0 rgba(243,220,164,0.25);
  outline: none;
}
.tarot-paw:active { transform: scale(0.94); }

.tarot-toast {
  position: absolute;
  left: 50%;
  top: 64px;
  transform: translateX(-50%);
  z-index: 40;
  background: rgba(12,6,22,0.92);
  border: 1px solid rgba(217,185,120,0.45);
  color: #efe3c8;
  font-size: 13px;
  letter-spacing: 0.06em;
  border-radius: 999px;
  padding: 8px 18px;
  animation: tarotFade 0.3s ease both;
}
@keyframes tarotFade { from { opacity: 0; transform: translate(-50%, -6px); } }

.tarot-shuffle { position: relative; width: 120px; height: 200px; }
.tarot-shuffle-card {
  position: absolute; inset: 0;
  border-radius: 8px;
  background: linear-gradient(150deg, #4a2d6b, #1d1030);
  border: 1px solid #d9b978;
  animation: tarotShuffle 0.55s ease-in-out infinite alternate;
}
.tarot-shuffle-card:nth-child(2) { animation-delay: 0.12s; }
.tarot-shuffle-card:nth-child(3) { animation-delay: 0.24s; }
@keyframes tarotShuffle {
  from { transform: translateX(-14px) rotate(-5deg); }
  to   { transform: translateX(14px) rotate(5deg); }
}

.tarot-fan {
  position: relative;
  width: 100%;
  height: 210px;
  display: flex;
  justify-content: center;
}
.tarot-fan-card {
  position: absolute;
  bottom: 0;
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
  transform-origin: 50% 300px;
  transition: transform 0.18s ease, filter 0.18s ease;
}
.tarot-fan-card:hover, .tarot-fan-card:focus-visible {
  filter: brightness(1.35) drop-shadow(0 0 12px rgba(217,185,120,0.6));
  outline: none;
  z-index: 200 !important;
}

.tarot-flip-btn {
  border: none; background: transparent; padding: 0; cursor: pointer;
  animation: tarotLand 0.45s cubic-bezier(.2,.8,.3,1) both;
}
@keyframes tarotLand {
  from { transform: translateY(-40px) scale(0.9); opacity: 0; }
}
.tarot-result {
  display: flex; flex-direction: column; align-items: center; gap: 14px;
  animation: tarotReveal 0.4s ease both;
}
@keyframes tarotReveal { from { opacity: 0; transform: scale(0.94); } }

.tarot-book {
  width: 100%;
  max-width: 420px;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.tarot-book-head { display: flex; align-items: center; justify-content: space-between; }
.tarot-book-tabs { display: flex; gap: 8px; }
.tarot-tab {
  flex: 1;
  border: 1px solid rgba(239,227,200,0.2);
  background: transparent;
  color: rgba(239,227,200,0.6);
  font-size: 12px;
  border-radius: 8px;
  padding: 7px 0;
  cursor: pointer;
  font-family: inherit;
}
.tarot-tab-on { border-color: #d9b978; color: #d9b978; background: rgba(217,185,120,0.12); }
.tarot-book-body { flex: 1; overflow-y: auto; padding-right: 4px; }
.tarot-entry {
  padding: 12px 0;
  border-bottom: 1px solid rgba(239,227,200,0.12);
}
.tarot-entry-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.tarot-entry-mark { color: #d9b978; font-size: 12px; min-width: 32px; }
.tarot-entry-name { font-size: 15px; letter-spacing: 0.06em; }
.tarot-entry-suit { font-size: 11px; color: rgba(239,227,200,0.45); }
.tarot-entry-edited {
  margin-left: auto;
  font-size: 10px;
  color: #d9b978;
  border: 1px solid rgba(217,185,120,0.45);
  border-radius: 999px;
  padding: 0 7px;
  letter-spacing: 0.08em;
}
.tarot-book-tip {
  margin: -4px 0 0;
  font-size: 11px;
  letter-spacing: 0.06em;
  color: rgba(239,227,200,0.4);
  text-align: center;
}
.tarot-entry-editing {
  background: rgba(217,185,120,0.06);
  border-radius: 10px;
  padding: 12px 10px;
}
.tarot-edit { display: flex; flex-direction: column; gap: 8px; }
.tarot-edit-row { display: flex; align-items: flex-start; gap: 8px; }
.tarot-edit-row b {
  color: #d9b978; font-weight: 400; font-size: 12px; padding-top: 8px;
}
.tarot-edit-input {
  flex: 1;
  resize: vertical;
  min-height: 52px;
  box-sizing: border-box;
  font-family: inherit;
  font-size: 16px; /* 小于 16px 时 iOS 聚焦会自动放大页面 */
  line-height: 1.6;
  color: #efe3c8;
  background: rgba(12,6,22,0.6);
  border: 1px solid rgba(217,185,120,0.4);
  border-radius: 8px;
  padding: 6px 8px;
  user-select: text;
  -webkit-user-select: text;
}
.tarot-edit-input:focus { outline: none; border-color: #d9b978; }
.tarot-edit-actions { display: flex; align-items: center; gap: 8px; }
.tarot-entry-line {
  margin: 3px 0; font-size: 13px; line-height: 1.7;
  color: rgba(239,227,200,0.82);
}
.tarot-entry-line b {
  color: #d9b978; font-weight: 400; margin-right: 8px; font-size: 12px;
}

@media (prefers-reduced-motion: reduce) {
  .tarot-hint, .tarot-shuffle-card, .tarot-flip-btn, .tarot-result, .tarot-toast {
    animation: none !important;
  }
}
`;

export default TarotApp;
