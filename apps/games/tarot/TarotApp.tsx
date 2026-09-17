import React, { useMemo, useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import { TAROT_DECK, SUIT_INFO } from './cards';
import { getMeaning, CardMeaning } from './meanings';
import { LENORMAND_DECK, getLenormand, LenormandMeaning } from './lenormand';
import { CardFace, CardBack, GenericCardFace } from './CardFace';
import { SpreadId, getSpread, spreadsFor, slotOfPick, fillWho } from './spreads';
import {
  useWorkshop, getActiveDeck, activeIdOf, buildDeckPool, DeckKind, CARD_RATIOS, WorkshopData, PoolCard, DECK_LABEL,
} from './decks';
import { FreeDraw, FREE_DRAW_CSS } from './FreeDraw';
import { Workshop, WORKSHOP_CSS } from './Workshop';
import { DuoTable, DUO_CSS, DuoRequest } from './DuoTable';
import { DuoRecords, DUO_RECORDS_CSS } from './DuoRecords';
import { loadDuoSession, loadDuoApi, saveDuoApi, introSeen, markIntroSeen, DuoApiSetting } from './duoStore';
import { useOS } from '../../../context/OSContext';
// 房间图和代码放在同一个文件夹，由 Vite 打包。想换背景，直接用同名图片覆盖即可。
// 平板（屏幕偏宽）用 2:3 的这两张：
import roomEmptyUrl from './room-empty.jpg';
import roomOccupiedUrl from './room-occupied.jpg';
// 手机（屏幕瘦长）用带阁楼天花板的这两张：
import roomEmptyPhoneUrl from './room-empty-phone.webp';
import roomOccupiedPhoneUrl from './room-occupied-phone.webp';

/**
 * 塔罗小屋。
 *
 * 房间场景 + 煤油灯明暗 + 首次进入的金光提示；点电话 TA 入座 / 离席。
 * 桌上三个托盘（从近到远）：神谕、塔罗、雷诺曼，点哪个抽哪副。
 * 用的是牌组工坊里「放到桌上」的那一套（decks.ts），塔罗 / 雷诺曼没设过就用基础牌组，
 * 神谕没有基础牌组，要先去工坊上传。
 *
 * 牌阵定义在 spreads.ts，按牌组区分；雷诺曼的牌意在 lenormand.ts，塔罗在 meanings.ts。
 * 牌意之书里双击可以改写塔罗 / 雷诺曼的牌意，改写存在数据库里，会进备份。
 * 墙上的画是牌组工坊（Workshop.tsx）。
 * 选牌阵列表最上面是「随心抽」（FreeDraw.tsx）：多副牌自由抽、桌上拖动叠放，桌面会保存。
 *
 * 手机 / 平板按屏幕比例自动选图，两套图各有一套点击热区（见 SCENES）。
 *
 * 和 TA 一起占卜（DuoTable.tsx）：TA 在座时点托盘进双人，不在座时还是单人抽牌，两条路分开。
 * 占卜进行中电话点不动，猫爪会问「暂时离开」还是「结束占卜」。
 * 窗外的月亮是 TA 的接口设置，壁炉边的书架是占卜记录（DuoRecords.tsx），TA 在座时可以戳他。
 * 角色名默认读当前选中的角色（useOS），也可以从 props 传进来覆盖。
 */

export interface TarotAppProps {
  /** 游戏大厅返回，由 registry 的 GameProps 传进来 */
  onBack: () => void;
  /** 角色名，不传就读当前选中的角色；都没有时显示「TA」 */
  characterName?: string;
  /** 角色头像（目前房间里不显示，保留这个参数免得调用方报错） */
  characterAvatar?: string;
}

type Phase = 'room' | 'spread' | 'needDeck' | 'shuffle' | 'fan' | 'result' | 'book' | 'workshop' | 'free' | 'records';

/** 按工坊里桌上正在用的牌组，拼出这副牌的抽牌池 */
function buildPool(data: WorkshopData, kind: DeckKind): PoolCard[] {
  return buildDeckPool(data, kind, activeIdOf(data, kind));
}

interface DrawnCard {
  card: PoolCard;
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
  { key: 'lenormand', label: '雷诺曼', left: '0%', top: '59%', width: '19%', height: '6%', ready: true },
  { key: 'tarot', label: '塔罗牌', left: '0%', top: '65%', width: '15%', height: '6.5%', ready: true },
  { key: 'oracle', label: '神谕卡', left: '0%', top: '71.5%', width: '11%', height: '10%', ready: true },
  { key: 'book', label: '牌意之书', left: '72%', top: '70%', width: '28%', height: '19%', ready: true },
  { key: 'lamp', label: '煤油灯', left: '0%', top: '36%', width: '11%', height: '22%', ready: true },
  { key: 'orrery', label: '称号', left: '76%', top: '47%', width: '13%', height: '14%', ready: false },
  { key: 'phone', label: '电话', left: '87%', top: '54%', width: '13%', height: '14%', ready: true },
  { key: 'painting', label: '牌组工坊', left: '51%', top: '2%', width: '26%', height: '24%', ready: true },
  { key: 'moon', label: '接口设置', left: '12%', top: '4%', width: '14%', height: '11%', ready: true },
  // 书架用画下面、椅子右后方那一排：图顶端在 4:3 的平板上会被裁掉，放不了东西
  { key: 'shelf', label: '占卜记录', left: '58%', top: '27%', width: '20%', height: '9%', ready: true },
];

/** 平板 · TA 在座：多一块戳 TA 的区域。放在最前面，和画、天球仪重叠的地方让给它们 */
const HOTSPOTS_TABLET_OCCUPIED: Hotspot[] = [
  { key: 'ta', label: '戳一戳', left: '18%', top: '19%', width: '60%', height: '40%', ready: true },
  ...HOTSPOTS_TABLET,
];

/** 手机 · 空座位图的热区 */
const HOTSPOTS_PHONE_EMPTY: Hotspot[] = [
  { key: 'lenormand', label: '雷诺曼', left: '0%', top: '58%', width: '20%', height: '5.5%', ready: true },
  { key: 'tarot', label: '塔罗牌', left: '0%', top: '63.5%', width: '16%', height: '5.5%', ready: true },
  { key: 'oracle', label: '神谕卡', left: '0%', top: '69%', width: '12%', height: '7%', ready: true },
  { key: 'book', label: '牌意之书', left: '73%', top: '65%', width: '27%', height: '17%', ready: true },
  { key: 'lamp', label: '煤油灯', left: '0%', top: '42%', width: '12%', height: '16%', ready: true },
  { key: 'orrery', label: '称号', left: '76%', top: '51%', width: '12%', height: '11%', ready: false },
  { key: 'phone', label: '电话', left: '88%', top: '53%', width: '12%', height: '12%', ready: true },
  { key: 'painting', label: '牌组工坊', left: '51%', top: '18%', width: '26%', height: '18%', ready: true },
  { key: 'moon', label: '接口设置', left: '12%', top: '19%', width: '14%', height: '9%', ready: true },
  { key: 'shelf', label: '占卜记录', left: '89%', top: '13%', width: '11%', height: '12%', ready: true },
];

/** 手机 · TA 在座图的热区（这张图比例更长，物件位置略有不同） */
const HOTSPOTS_PHONE_OCCUPIED: Hotspot[] = [
  { key: 'ta', label: '戳一戳', left: '17%', top: '29%', width: '62%', height: '28%', ready: true },
  { key: 'lenormand', label: '雷诺曼', left: '0%', top: '56.5%', width: '21%', height: '4.8%', ready: true },
  { key: 'tarot', label: '塔罗牌', left: '0%', top: '61.3%', width: '17%', height: '4.5%', ready: true },
  { key: 'oracle', label: '神谕卡', left: '0%', top: '65.8%', width: '12%', height: '7%', ready: true },
  { key: 'book', label: '牌意之书', left: '73%', top: '63%', width: '27%', height: '16%', ready: true },
  { key: 'lamp', label: '煤油灯', left: '0%', top: '40%', width: '12%', height: '17%', ready: true },
  { key: 'orrery', label: '称号', left: '76%', top: '49%', width: '12%', height: '11%', ready: false },
  { key: 'phone', label: '电话', left: '88%', top: '52%', width: '12%', height: '11%', ready: true },
  { key: 'painting', label: '牌组工坊', left: '52%', top: '16%', width: '25%', height: '17%', ready: true },
  { key: 'moon', label: '接口设置', left: '12%', top: '18%', width: '14%', height: '9%', ready: true },
  { key: 'shelf', label: '占卜记录', left: '89%', top: '11%', width: '11%', height: '12%', ready: true },
];

/** 一张房间图的全部配置 */
interface Scene {
  src: string;
  /** 图片高 / 宽，图片加载后会用真实尺寸覆盖，换图不用改这里 */
  ratio: number;
  hotspots: Hotspot[];
  /** 煤油灯暖光的中心位置 */
  glowAt: string;
}

const SCENES: Record<'phone' | 'tablet', { empty: Scene; occupied: Scene }> = {
  phone: {
    empty: {
      src: roomEmptyPhoneUrl,
      ratio: 2269 / 1080,
      hotspots: HOTSPOTS_PHONE_EMPTY,
      glowAt: '5% 51%',
    },
    occupied: {
      src: roomOccupiedPhoneUrl,
      ratio: 2048 / 930,
      hotspots: HOTSPOTS_PHONE_OCCUPIED,
      glowAt: '5% 49%',
    },
  },
  tablet: {
    empty: {
      src: roomEmptyUrl,
      ratio: 1.5,
      hotspots: HOTSPOTS_TABLET,
      glowAt: '6% 46%',
    },
    occupied: {
      src: roomOccupiedUrl,
      ratio: 1.5,
      hotspots: HOTSPOTS_TABLET_OCCUPIED,
      glowAt: '6% 46%',
    },
  },
};

/** 屏幕高/宽超过这个值就算手机，用瘦长图 */
const PHONE_ASPECT = 1.75;

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
  const { activeCharacterId, characters, userProfile, apiConfig } = useOS();
  const charId = activeCharacterId || '';
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
  const phaseRef = useRef<Phase>('room');
  phaseRef.current = phase;
  const [lampBright, setLampBright] = useState(false);
  const [taSeated, setTaSeated] = useState(false);

  // ── 和 TA 一起占卜 ──
  /** 有没有进行中的一场（没结束占卜）。进行中电话点不动，猫爪要先问 */
  const [duoActive, setDuoActive] = useState(false);
  const [duoRequest, setDuoRequest] = useState<DuoRequest | null>(null);
  const duoNonce = useRef(0);
  const sendDuo = useCallback((req: { type: 'tray'; kind: DeckKind } | { type: 'paw' } | { type: 'poke' }) => {
    duoNonce.current += 1;
    setDuoRequest({ ...req, nonce: duoNonce.current } as DuoRequest);
  }, []);
  /** 第一次进来弹一次玩法说明，之后在月亮里能再看 */
  const [showIntro, setShowIntro] = useState(() => !introSeen());
  const [apiOpen, setApiOpen] = useState(false);
  const [apiDraft, setApiDraft] = useState<DuoApiSetting>(() => loadDuoApi());

  // 上次「暂时离开」的占卜还在：TA 直接坐在对面
  useEffect(() => {
    let alive = true;
    setDuoActive(false);
    loadDuoSession(charId).then((s) => {
      if (alive && s) {
        setDuoActive(true);
        setTaSeated(true);
      }
    });
    return () => { alive = false; };
  }, [charId]);
  const [hintPlaying, setHintPlaying] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  const { data: workshop, update: updateWorkshop } = useWorkshop();

  // ── 抽牌状态 ──
  /** 这一轮抽的是哪副牌 */
  const [drawKind, setDrawKind] = useState<DeckKind>('tarot');
  const [deckOrder, setDeckOrder] = useState<PoolCard[]>([]);
  const [spreadId, setSpreadId] = useState<SpreadId>('single');
  /** 扇面里已经点中的牌（deckOrder 的下标），按点选顺序 */
  const [picked, setPicked] = useState<number[]>([]);
  /** 按牌阵位置摆好的牌 */
  const [drawn, setDrawn] = useState<DrawnCard[]>([]);
  const [flipped, setFlipped] = useState<boolean[]>([]);
  /** 结果页当前在看哪一张 */
  const [focus, setFocus] = useState<number | null>(null);
  /** 去工坊时先停在哪个分类 */
  const [workshopKind, setWorkshopKind] = useState<DeckKind>('tarot');
  /** 牌意之书合上后回到哪里（从随心抽进去就回随心抽） */
  const [bookReturn, setBookReturn] = useState<Phase>('room');

  const drawDeck = getActiveDeck(workshop, drawKind);
  const drawRatio = CARD_RATIOS[drawKind];
  const spread = getSpread(spreadId);

  // ── 牌意之书 ──
  const [bookKind, setBookKind] = useState<'tarot' | 'lenormand'>('tarot');
  const [bookFilter, setBookFilter] = useState<'all' | 'major' | 'minor'>('all');
  /** 正在改写的那条：塔罗是正 / 逆，雷诺曼是关键词 / 时间 */
  const [editing, setEditing] = useState<{ kind: 'tarot' | 'lenormand'; id: number; a: string; b: string } | null>(null);
  const lastTap = useRef<{ key: string; t: number } | null>(null);

  const tarotOverrides = workshop.meaningOverrides;
  const lenormandOverrides = workshop.lenormandOverrides;

  const meaningOf = useCallback(
    (id: number): CardMeaning => tarotOverrides[id] ?? getMeaning(id),
    [tarotOverrides],
  );
  const lenormandOf = useCallback(
    (id: number): LenormandMeaning => {
      const base = getLenormand(id);
      return lenormandOverrides[id] ?? { keywords: base?.keywords ?? '', time: base?.time ?? '' };
    },
    [lenormandOverrides],
  );

  const handleEntryTap = useCallback((kind: 'tarot' | 'lenormand', id: number) => {
    if (editing && editing.kind === kind && editing.id === id) return;
    const key = `${kind}${id}`;
    const now = Date.now();
    const prev = lastTap.current;
    if (prev && prev.key === key && now - prev.t < 350) {
      lastTap.current = null;
      if (kind === 'tarot') {
        const m = meaningOf(id);
        setEditing({ kind, id, a: m.up, b: m.rev });
      } else {
        const m = lenormandOf(id);
        setEditing({ kind, id, a: m.keywords, b: m.time });
      }
    } else {
      lastTap.current = { key, t: now };
    }
  }, [editing, meaningOf, lenormandOf]);

  const saveFail = useCallback(() => setToast('保存失败，可能是存储空间不够了'), []);

  const saveEdit = useCallback(() => {
    if (!editing) return;
    const { kind, id } = editing;
    const a = editing.a.trim();
    const b = editing.b.trim();
    if (kind === 'tarot') {
      const def = getMeaning(id);
      updateWorkshop((prev) => {
        const next = { ...prev.meaningOverrides };
        if (a === def.up && b === def.rev) delete next[id];
        else next[id] = { up: a || def.up, rev: b || def.rev };
        return { ...prev, meaningOverrides: next };
      }).catch(saveFail);
    } else {
      const def = getLenormand(id);
      const defK = def?.keywords ?? '';
      const defT = def?.time ?? '';
      updateWorkshop((prev) => {
        const next = { ...prev.lenormandOverrides };
        if (a === defK && b === defT) delete next[id];
        else next[id] = { keywords: a || defK, time: b || defT };
        return { ...prev, lenormandOverrides: next };
      }).catch(saveFail);
    }
    setEditing(null);
  }, [editing, updateWorkshop, saveFail]);

  const resetEdit = useCallback(() => {
    if (!editing) return;
    const { kind, id } = editing;
    updateWorkshop((prev) => {
      if (kind === 'tarot') {
        const next = { ...prev.meaningOverrides };
        delete next[id];
        return { ...prev, meaningOverrides: next };
      }
      const next = { ...prev.lenormandOverrides };
      delete next[id];
      return { ...prev, lenormandOverrides: next };
    }).catch(saveFail);
    setEditing(null);
  }, [editing, updateWorkshop, saveFail]);

  // 首次进入，物件依次闪一遍金光，之后安静下来
  useEffect(() => {
    const timer = window.setTimeout(() => setHintPlaying(false), 4200);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /** 点托盘：先检查这副牌能不能抽，再去选牌阵 */
  const openDeck = useCallback((kind: DeckKind) => {
    setDrawKind(kind);
    if (kind === 'oracle' && buildPool(workshop, 'oracle').length === 0) {
      setPhase('needDeck');
      return;
    }
    setPhase('spread');
  }, [workshop]);

  const startDraw = useCallback((id: SpreadId) => {
    const sp = getSpread(id);
    const pool = buildPool(workshop, drawKind);
    if (pool.length < sp.positions.length) {
      setToast(`这套牌只有 ${pool.length} 张，不够这个牌阵`);
      return;
    }
    setSpreadId(id);
    setDeckOrder(shuffle(pool));
    setPicked([]);
    setDrawn([]);
    setFlipped([]);
    setFocus(null);
    setPhase('shuffle');
    window.setTimeout(() => {
      if (phaseRef.current === 'shuffle') setPhase('fan');
    }, 1100);
  }, [workshop, drawKind]);

  const pickCard = useCallback((index: number) => {
    const sp = getSpread(spreadId);
    const need = sp.positions.length;
    if (picked.includes(index) || picked.length >= need) return;
    const next = [...picked, index];
    setPicked(next);
    if (next.length === need) {
      // 按抽牌顺序放进对应的位置；只有塔罗有逆位
      const cards: DrawnCard[] = new Array(need);
      next.forEach((deckIndex, k) => {
        cards[slotOfPick(sp, k)] = {
          card: deckOrder[deckIndex],
          reversed: drawKind === 'tarot' && Math.random() < 0.5,
        };
      });
      // 让最后一张被点中的动效播完再进结果页
      window.setTimeout(() => {
        if (phaseRef.current !== 'fan') return; // 中途点了「算了」
        setDrawn(cards);
        setFlipped(cards.map(() => false));
        setFocus(null);
        setPhase('result');
      }, 450);
    }
  }, [picked, spreadId, deckOrder, drawKind]);

  const tapResultCard = useCallback((i: number) => {
    if (!flipped[i]) {
      setFlipped((prev) => prev.map((v, j) => (j === i ? true : v)));
    }
    setFocus(i);
  }, [flipped]);

  const flipAll = useCallback(() => {
    setFlipped((prev) => prev.map(() => true));
    setFocus((f) => (f === null ? 0 : f));
  }, []);

  const openWorkshop = useCallback((kind: DeckKind) => {
    setWorkshopKind(kind);
    setPhase('workshop');
  }, []);

  const handleHotspot = useCallback((spot: Hotspot) => {
    if (!spot.ready) {
      setToast(`${spot.label}还没开，下一版见`);
      return;
    }
    if (spot.key === 'tarot' || spot.key === 'lenormand' || spot.key === 'oracle') {
      // TA 在对面：一起占卜；不在：自己抽
      if (taSeated) sendDuo({ type: 'tray', kind: spot.key });
      else openDeck(spot.key);
    }
    else if (spot.key === 'book') { setBookReturn('room'); setPhase('book'); }
    else if (spot.key === 'shelf') setPhase('records');
    else if (spot.key === 'lamp') setLampBright((v) => !v);
    // 电话：拨过去 TA 就坐到对面，再点一次 TA 离席；占卜进行中点不动
    else if (spot.key === 'phone') {
      if (duoActive) setToast(`占卜进行中，点猫爪结束占卜后才能挂电话`);
      else setTaSeated((v) => !v);
    }
    else if (spot.key === 'painting') openWorkshop('tarot');
    else if (spot.key === 'moon') { setApiDraft(loadDuoApi()); setApiOpen(true); }
    else if (spot.key === 'ta') sendDuo({ type: 'poke' });
  }, [openDeck, openWorkshop, taSeated, duoActive, sendDuo]);

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

  /** 房间图的位置（px），给双人占卜往桌布上摆牌 */
  const roomRect = useMemo(() => {
    const b = roomBox as { left?: unknown; top?: unknown; width?: unknown; height?: unknown };
    const num = (v: unknown, fb: number) => (typeof v === 'number' ? v : fb);
    return {
      left: num(b.left, 0),
      top: num(b.top, 0),
      width: num(b.width, frame.w),
      height: num(b.height, frame.w * imgRatio),
    };
  }, [roomBox, frame.w, imgRatio]);

  const closeIntro = () => {
    markIntroSeen();
    setShowIntro(false);
  };

  const tarotBookList = useMemo(() => {
    if (bookFilter === 'all') return TAROT_DECK;
    return TAROT_DECK.filter((c) => c.arcana === bookFilter);
  }, [bookFilter]);

  /** 结果页：一张牌的正面 */
  const renderFace = (d: DrawnCard, width: number) => {
    const c = d.card;
    if (c.tarotId !== undefined) {
      const tc = TAROT_DECK[c.tarotId];
      return <CardFace card={tc} reversed={d.reversed} width={width} image={c.image} />;
    }
    if (c.lenormandId !== undefined) {
      return (
        <GenericCardFace
          width={width}
          ratio={drawRatio}
          image={c.image}
          mark={String(c.lenormandId)}
          symbol="✧"
          title={c.name}
        />
      );
    }
    return <GenericCardFace width={width} ratio={drawRatio} image={c.image} symbol="✧" title={c.name} />;
  };

  /** 结果页：解读区 */
  const renderReading = (d: DrawnCard) => {
    const c = d.card;
    if (c.tarotId !== undefined) {
      const m = meaningOf(c.tarotId);
      return (
        <>
          <h2 style={styles.resultName}>
            {c.name}
            <span style={styles.resultPos}>{d.reversed ? '逆位' : '正位'}</span>
          </h2>
          <p style={styles.resultMeaning}>{d.reversed ? m.rev : m.up}</p>
        </>
      );
    }
    if (c.lenormandId !== undefined) {
      const m = lenormandOf(c.lenormandId);
      return (
        <>
          <h2 style={styles.resultName}>
            {c.name}
            <span style={styles.resultPos}>{c.lenormandId}</span>
          </h2>
          <div className="tarot-len-reading">
            <p><b>关键词</b>{m.keywords}</p>
            <p><b>时间</b>{m.time}</p>
          </div>
        </>
      );
    }
    const meaning = c.oracle?.meaning?.trim();
    return (
      <>
        <h2 style={styles.resultName}>{c.name}</h2>
        {meaning ? (
          <p style={styles.resultMeaning}>{meaning}</p>
        ) : (
          <p className="tarot-reading-empty">
            这张还没写牌意，
            <button className="tarot-link" onClick={() => openWorkshop('oracle')}>去工坊补上</button>
          </p>
        )}
      </>
    );
  };

  const fanCount = deckOrder.length;
  const fanAngle = fanCount > 40 ? 68 : fanCount > 12 ? 56 : Math.max(16, fanCount * 5);
  const nextSlot = picked.length < spread.positions.length ? slotOfPick(spread, picked.length) : null;
  const gridGap = spread.columns >= 5 ? '10px 6px' : '12px 14px';

  return (
    <div ref={rootRef} style={styles.root}>
      <style>{CSS + WORKSHOP_CSS + FREE_DRAW_CSS + DUO_CSS + DUO_RECORDS_CSS}</style>

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
            e.currentTarget.style.visibility = 'hidden';
          }}
        />

        {/* 暖光 / 暗角。生图是灯亮态，默认压暗一档 */}
        <div style={{ ...styles.vignette, opacity: lampBright ? 0.18 : 0.62 }} />
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
              animationDelay: hintPlaying ? `${i * 0.4}s` : undefined,
            }}
            onClick={() => handleHotspot(spot)}
            aria-label={spot.key === 'phone' ? (taSeated ? `请${who}离席` : `呼叫${who}`) : spot.label}
          >
            <span className="tarot-hotspot-label">{spot.label}</span>
          </button>
        ))}
      </div>

      {/* ── 和 TA 一起占卜（TA 在座时一直挂着，去牌意之书、占卜记录时隐藏不卸载）── */}
      {taSeated && frame.w > 0 && (phase === 'room' || phase === 'book' || phase === 'records') && (
        <DuoTable
          key={charId || 'default'}
          charId={charId}
          char={activeChar ?? null}
          userProfile={userProfile}
          apiConfig={apiConfig}
          who={who}
          workshop={workshop}
          tarotMeaning={meaningOf}
          lenormandMeaning={lenormandOf}
          variant={variant}
          room={roomRect}
          frame={frame}
          visible={phase === 'room'}
          request={duoRequest}
          onSessionChange={setDuoActive}
          onLeave={onBack}
          onToast={setToast}
          onOpenBook={(kind) => {
            setEditing(null);
            setBookKind(kind === 'lenormand' ? 'lenormand' : 'tarot');
            setBookReturn('room');
            setPhase('book');
          }}
        />
      )}

      {/* 顶部：猫爪返回。灯的明暗只靠点桌上的煤油灯；占卜进行中先问暂时离开还是结束 */}
      <div style={styles.topBar}>
        <button
          className="tarot-paw"
          onClick={() => (duoActive && taSeated && phase === 'room' ? sendDuo({ type: 'paw' }) : onBack())}
          aria-label="离开小屋"
          title="离开小屋"
          style={{ pointerEvents: 'auto' }}
        >
          <PawIcon size={20} />
        </button>
      </div>

      {toast && <div className="tarot-toast">{toast}</div>}

      {/* ── 第一次进来：隐藏按钮说明 ── */}
      {showIntro && phase === 'room' && (
        <div className="duo-mask" style={{ zIndex: 45 }} onClick={closeIntro}>
          <div className="duo-sheet" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <h3 className="duo-sheet-title">小屋里能点的地方</h3>
            <ul className="duo-intro">
              <li><b>桌上三个木托盘</b>从近到远是神谕、塔罗、雷诺曼。{who}不在时自己抽牌，{who}坐在对面时一起占卜。</li>
              <li><b>皮面书</b>牌意之书，双击牌意可以改写。</li>
              <li><b>煤油灯</b>把小屋调亮、调暗。</li>
              <li><b>墙上的画</b>牌组工坊，上传和管理你的牌。</li>
              <li><b>电话</b>请{who}坐到对面，再点一次{who}离席。占卜进行中电话点不动。</li>
              <li><b>戳一戳</b>{who}坐在对面、没在抽牌的时候，戳戳{who}。</li>
              <li><b>窗外的月亮</b>{who}的接口设置，这份说明也在里面。</li>
              <li><b>壁炉边的书架</b>占卜记录。和{who}一起占卜的每一场都收在这里，可以翻看、导出。</li>
              <li><b>天球仪</b>称号，之后开放。</li>
              <li><b>猫爪</b>离开小屋。占卜进行中会问你暂时离开，还是结束占卜。</li>
            </ul>
            <button className="tarot-chip duo-primary" onClick={closeIntro}>知道了</button>
          </div>
        </div>
      )}

      {/* ── 窗外的月亮：TA 的接口 ── */}
      {apiOpen && (
        <div className="duo-mask" style={{ zIndex: 45 }} onClick={() => setApiOpen(false)}>
          <div className="duo-sheet" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <h3 className="duo-sheet-title">{who}的接口</h3>
            <p className="duo-small">和{who}一起占卜时，出题、解牌、聊天都走这里。三项都空着，就用 App 设置里的主 API。</p>
            {([
              ['baseUrl', 'Base URL', 'https://…/v1', 'text'],
              ['apiKey', 'API Key', 'sk-…', 'password'],
              ['model', '模型', '模型名', 'text'],
            ] as const).map(([field, label, placeholder, type]) => (
              <label key={field} className="duo-field">
                <span>{label}</span>
                <input
                  className="duo-input"
                  type={type}
                  value={apiDraft[field]}
                  placeholder={placeholder}
                  autoComplete="off"
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setApiDraft({ ...apiDraft, [field]: e.target.value })}
                />
              </label>
            ))}
            <div className="duo-panel-actions">
              <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={() => { setApiOpen(false); setShowIntro(true); }}>玩法说明</button>
              <div style={{ flex: 1 }} />
              <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={() => setApiOpen(false)}>取消</button>
              <button
                className="tarot-chip tarot-chip-sm"
                onClick={() => { saveDuoApi(apiDraft); setApiOpen(false); setToast('接口存好了'); }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 神谕还没有牌 ─────────────────────── */}
      {phase === 'needDeck' && (
        <div style={styles.overlay}>
          <p style={styles.overlayHint}>神谕卡是你自己的牌</p>
          <p className="tarot-need-text">
            {workshop.decks.some((d) => d.kind === 'oracle')
              ? '桌上还没有放神谕牌组，或者这套牌还是空的。去工坊挑一套放到桌上，或者先传几张牌吧。'
              : '神谕卡没有基础牌组，去牌组工坊上传你自己的牌，牌名和牌意都由你来写。'}
          </p>
          <div style={styles.resultActions}>
            <button className="tarot-chip" onClick={() => openWorkshop('oracle')}>去牌组工坊</button>
            <button className="tarot-chip tarot-chip-ghost" onClick={() => setPhase('room')}>回到桌前</button>
          </div>
        </div>
      )}

      {/* ── 选牌阵 ───────────────────────────── */}
      {phase === 'spread' && (
        <div style={styles.overlay}>
          <p style={styles.overlayHint}>
            {DECK_LABEL[drawKind]} · {drawDeck ? drawDeck.name : drawKind === 'oracle' ? '' : '基础牌组'} · 选一个牌阵
          </p>
          <div className="tarot-spread-list">
            <button className="tarot-spread-item tarot-spread-free" onClick={() => setPhase('free')}>
              <span className="tarot-spread-icon tarot-spread-icon-free" aria-hidden="true">
                <i /><i /><i />
              </span>
              <span className="tarot-spread-text">
                <span className="tarot-spread-name">
                  随心抽
                  <em>不限张数</em>
                </span>
                <span className="tarot-spread-desc">几副牌一起摆上桌，想抽几张抽几张，牌可以随意挪动</span>
              </span>
            </button>
            {spreadsFor(drawKind).map((sp) => {
              const poolSize = buildPool(workshop, drawKind).length;
              const enough = poolSize >= sp.positions.length;
              return (
                <button
                  key={sp.id}
                  className="tarot-spread-item"
                  onClick={() => startDraw(sp.id)}
                  disabled={!enough}
                >
                  <span
                    className="tarot-spread-icon"
                    style={{ gridTemplateColumns: `repeat(${Math.min(sp.columns, 5)}, 1fr)`, width: sp.columns >= 5 ? 50 : 38 }}
                    aria-hidden="true"
                  >
                    {sp.positions.map((_, k) => <i key={k} />)}
                  </span>
                  <span className="tarot-spread-text">
                    <span className="tarot-spread-name">
                      {sp.name}
                      <em>{sp.positions.length} 张</em>
                    </span>
                    <span className="tarot-spread-desc">
                      {enough ? fillWho(sp.desc, who) : `这套牌只有 ${poolSize} 张，不够用`}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <button className="tarot-chip tarot-chip-ghost" onClick={() => setPhase('room')}>
            回到桌前
          </button>
        </div>
      )}

      {/* ── 洗牌 ─────────────────────────────── */}
      {phase === 'shuffle' && (
        <div style={styles.overlay}>
          <div className="tarot-shuffle" style={{ height: Math.round(120 * drawRatio) }}>
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
          <p style={styles.overlayHint}>
            {spread.positions.length === 1
              ? '凭感觉挑一张'
              : nextSlot !== null
                ? `凭感觉挑 ${spread.positions.length} 张 · 下一张：${fillWho(spread.positions[nextSlot].label, who)}`
                : '牌已选好'}
          </p>
          {spread.positions.length > 1 && (
            <div className="tarot-pick-dots" aria-hidden="true">
              {spread.positions.map((_, k) => (
                <i key={k} className={k < picked.length ? 'on' : ''} />
              ))}
            </div>
          )}
          <div className="tarot-fan">
            {deckOrder.map((card, i) => {
              const angle = fanCount > 1 ? -fanAngle / 2 + (fanAngle / (fanCount - 1)) * i : 0;
              const isPicked = picked.includes(i);
              return (
                <button
                  key={card.key}
                  className={isPicked ? 'tarot-fan-card tarot-fan-card-picked' : 'tarot-fan-card'}
                  style={{
                    transform: `rotate(${angle}deg)${isPicked ? ' translateY(-26px)' : ''}`,
                    zIndex: i,
                  }}
                  onClick={() => pickCard(i)}
                  disabled={isPicked}
                  aria-label={`第 ${i + 1} 张`}
                >
                  <CardBack width={66} ratio={drawRatio} image={drawDeck?.back} />
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
      {phase === 'result' && drawn.length > 0 && (
        <div style={{ ...styles.overlay, justifyContent: 'flex-start', overflowY: 'auto' }}>
          <div className="tarot-result">
            <p style={styles.overlayHint}>
              {DECK_LABEL[drawKind]} · {spread.name}
              {flipped.some((v) => !v) ? ' · 点牌翻开' : ' · 点牌看解读'}
            </p>

            <div
              className="tarot-spread-grid"
              style={{ gridTemplateColumns: `repeat(${spread.columns}, auto)`, gap: gridGap }}
            >
              {drawn.map((d, i) => (
                <div key={i} className="tarot-slot" style={{ animationDelay: `${i * 0.06}s` }}>
                  {spread.positions.length > 1 && (
                    <span className="tarot-slot-label" style={spread.columns >= 5 ? { fontSize: 10 } : undefined}>
                      {fillWho(spread.positions[i].label, who)}
                    </span>
                  )}
                  <button
                    className={'tarot-slot-card' + (focus === i && flipped[i] ? ' tarot-slot-card-on' : '')}
                    onClick={() => tapResultCard(i)}
                    aria-label={flipped[i] ? d.card.name : `翻开第 ${i + 1} 张`}
                  >
                    {flipped[i] ? (
                      <span className="tarot-flip-in">{renderFace(d, spread.cardWidth)}</span>
                    ) : (
                      <CardBack width={spread.cardWidth} ratio={drawRatio} image={drawDeck?.back} />
                    )}
                  </button>
                </div>
              ))}
            </div>

            {focus !== null && flipped[focus] && drawn[focus] ? (
              <div className="tarot-reading" key={focus}>
                {spread.positions.length > 1 && (
                  <p className="tarot-reading-pos">
                    {fillWho(spread.positions[focus].label, who)}
                    <span>{fillWho(spread.positions[focus].hint, who)}</span>
                  </p>
                )}
                {renderReading(drawn[focus])}
              </div>
            ) : (
              <p className="tarot-reading-empty">
                {flipped.some((v) => !v) ? '按顺序一张张翻开，或者一次全部翻开' : '点一张牌，看看它在说什么'}
              </p>
            )}

            <div style={styles.resultActions}>
              {flipped.some((v) => !v) && (
                <button className="tarot-chip" onClick={flipAll}>全部翻开</button>
              )}
              <button className="tarot-chip" onClick={() => startDraw(spreadId)}>再抽一次</button>
              <button className="tarot-chip tarot-chip-ghost" onClick={() => setPhase('spread')}>
                换牌阵
              </button>
              <button className="tarot-chip tarot-chip-ghost" onClick={() => setPhase('room')}>
                回到桌前
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 随心抽 ───────────────────────────── */}
      {phase === 'free' && (
        <FreeDraw
          workshop={workshop}
          entryKind={drawKind}
          who={who}
          tarotMeaning={meaningOf}
          lenormandMeaning={lenormandOf}
          onClose={() => setPhase('room')}
          onToast={setToast}
          onOpenWorkshop={openWorkshop}
          onOpenBook={(kind) => {
            setEditing(null);
            setBookKind(kind === 'lenormand' ? 'lenormand' : 'tarot');
            setBookReturn('free');
            setPhase('book');
          }}
        />
      )}

      {/* ── 牌组工坊 ─────────────────────────── */}
      {phase === 'workshop' && (
        <Workshop
          data={workshop}
          update={updateWorkshop}
          initialKind={workshopKind}
          onClose={() => setPhase('room')}
          onToast={setToast}
        />
      )}

      {/* ── 占卜记录（壁炉边的书架）──────────────── */}
      {phase === 'records' && (
        <DuoRecords
          charId={charId}
          who={who}
          userName={userProfile?.name || ''}
          workshop={workshop}
          tarotMeaning={meaningOf}
          lenormandMeaning={lenormandOf}
          closeLabel={duoActive && taSeated ? '回桌前' : '合上'}
          onClose={() => setPhase('room')}
          onToast={setToast}
        />
      )}

      {/* ── 牌意之书 ─────────────────────────── */}
      {phase === 'book' && (
        <div style={styles.overlay}>
          <div className="tarot-book">
            <div className="tarot-book-head">
              <h2 style={styles.bookTitle}>牌意之书</h2>
              <button
                className="tarot-chip tarot-chip-ghost"
                onClick={() => { setEditing(null); setPhase(bookReturn); setBookReturn('room'); }}
              >
                {bookReturn === 'free' ? '回随心抽' : duoActive && taSeated ? '回桌前' : '合上'}
              </button>
            </div>

            <div className="tarot-book-tabs tarot-book-kinds">
              {([['tarot', 'Tarot'], ['lenormand', 'Lenormand']] as const).map(([key, label]) => (
                <button
                  key={key}
                  className={bookKind === key ? 'tarot-tab tarot-tab-on' : 'tarot-tab'}
                  onClick={() => { setEditing(null); setBookKind(key); }}
                >
                  {label}
                </button>
              ))}
            </div>

            {bookKind === 'tarot' && (
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
            )}

            <p className="tarot-book-tip">双击牌意可以改写</p>

            <div className="tarot-book-body">
              {bookKind === 'tarot'
                ? tarotBookList.map((card) => {
                    const m = meaningOf(card.id);
                    const isEditing = editing?.kind === 'tarot' && editing.id === card.id;
                    const edited = tarotOverrides[card.id] !== undefined;
                    return (
                      <div
                        key={card.id}
                        className={isEditing ? 'tarot-entry tarot-entry-editing' : 'tarot-entry'}
                        onClick={() => handleEntryTap('tarot', card.id)}
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
                          <EntryEditor
                            labelA="正"
                            labelB="逆"
                            a={editing.a}
                            b={editing.b}
                            edited={edited}
                            onChange={(a, b) => setEditing({ ...editing, a, b })}
                            onSave={saveEdit}
                            onCancel={() => setEditing(null)}
                            onReset={resetEdit}
                          />
                        ) : (
                          <>
                            <p className="tarot-entry-line"><b>正</b>{m.up}</p>
                            <p className="tarot-entry-line"><b>逆</b>{m.rev}</p>
                          </>
                        )}
                      </div>
                    );
                  })
                : LENORMAND_DECK.map((card) => {
                    const m = lenormandOf(card.id);
                    const isEditing = editing?.kind === 'lenormand' && editing.id === card.id;
                    const edited = lenormandOverrides[card.id] !== undefined;
                    return (
                      <div
                        key={card.id}
                        className={isEditing ? 'tarot-entry tarot-entry-editing' : 'tarot-entry'}
                        onClick={() => handleEntryTap('lenormand', card.id)}
                      >
                        <div className="tarot-entry-head">
                          <span className="tarot-entry-mark">{card.id}</span>
                          <span className="tarot-entry-name">{card.name}</span>
                          {edited && <span className="tarot-entry-edited">已改写</span>}
                        </div>
                        {isEditing && editing ? (
                          <EntryEditor
                            labelA="关键词"
                            labelB="时间"
                            a={editing.a}
                            b={editing.b}
                            edited={edited}
                            onChange={(a, b) => setEditing({ ...editing, a, b })}
                            onSave={saveEdit}
                            onCancel={() => setEditing(null)}
                            onReset={resetEdit}
                          />
                        ) : (
                          <>
                            <p className="tarot-entry-line tarot-entry-line-wide"><b>关键词</b>{m.keywords}</p>
                            <p className="tarot-entry-line tarot-entry-line-wide"><b>时间</b>{m.time}</p>
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

/** 牌意之书里改写一条的编辑框 */
function EntryEditor({
  labelA, labelB, a, b, edited, onChange, onSave, onCancel, onReset,
}: {
  labelA: string;
  labelB: string;
  a: string;
  b: string;
  edited: boolean;
  onChange: (a: string, b: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onReset: () => void;
}) {
  return (
    <div className="tarot-edit">
      <label className="tarot-edit-row">
        <b>{labelA}</b>
        <textarea
          className="tarot-edit-input"
          value={a}
          rows={2}
          autoFocus
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value, b)}
        />
      </label>
      <label className="tarot-edit-row">
        <b>{labelB}</b>
        <textarea
          className="tarot-edit-input"
          value={b}
          rows={2}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(a, e.target.value)}
        />
      </label>
      <div className="tarot-edit-actions">
        {edited && (
          <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={onReset}>
            恢复默认
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={onCancel}>
          取消
        </button>
        <button className="tarot-chip tarot-chip-sm" onClick={onSave}>
          保存
        </button>
      </div>
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
    // 整条横栏不挡点击，只有猫爪能点（占卜时顶部中间还有「对话」按钮）
    pointerEvents: 'none',
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
    flexWrap: 'wrap',
    justifyContent: 'center',
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
  outline: none;
  -webkit-tap-highlight-color: transparent;
  transition: box-shadow 0.25s ease, background 0.25s ease;
}
/* 只有鼠标悬停和键盘选中时才描金框；手机点完不会留框 */
.tarot-hotspot:focus-visible {
  background: rgba(217,185,120,0.12);
  box-shadow: inset 0 0 0 1px rgba(217,185,120,0.55), 0 0 18px rgba(217,185,120,0.3);
}
@media (hover: hover) and (pointer: fine) {
  .tarot-hotspot:hover {
    background: rgba(217,185,120,0.12);
    box-shadow: inset 0 0 0 1px rgba(217,185,120,0.55), 0 0 18px rgba(217,185,120,0.3);
  }
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
.tarot-hotspot:focus-visible .tarot-hotspot-label { opacity: 1; }
@media (hover: hover) and (pointer: fine) {
  .tarot-hotspot:hover .tarot-hotspot-label { opacity: 1; }
}

.tarot-hint { animation: tarotShimmer 1.1s ease-in-out 1 both; }
@keyframes tarotShimmer {
  0%, 100% { box-shadow: inset 0 0 0 0 rgba(217,185,120,0); }
  50% {
    box-shadow: inset 0 0 0 1px rgba(217,185,120,0.9), 0 0 26px rgba(217,185,120,0.55);
    background: rgba(217,185,120,0.16);
  }
}

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

.tarot-fan-card:disabled { cursor: default; }
.tarot-fan-card-picked { filter: brightness(1.4) drop-shadow(0 0 10px rgba(217,185,120,0.7)); }

.tarot-pick-dots { display: flex; gap: 8px; margin-top: -8px; }
.tarot-pick-dots i {
  width: 7px; height: 7px; border-radius: 50%;
  border: 1px solid rgba(217,185,120,0.7);
  transition: background 0.2s ease;
}
.tarot-pick-dots i.on { background: #d9b978; }

/* 选牌阵 */
.tarot-spread-list {
  width: 100%;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tarot-spread-item {
  display: flex;
  align-items: center;
  gap: 14px;
  text-align: left;
  border: 1px solid rgba(217,185,120,0.35);
  background: rgba(40,22,62,0.55);
  border-radius: 14px;
  padding: 12px 14px;
  cursor: pointer;
  color: #efe3c8;
  font-family: inherit;
  transition: border-color 0.2s ease, background 0.2s ease;
}
.tarot-spread-item:hover, .tarot-spread-item:focus-visible {
  border-color: #d9b978;
  background: rgba(217,185,120,0.1);
  outline: none;
}
.tarot-spread-icon {
  display: grid;
  gap: 3px;
  width: 38px;
  flex-shrink: 0;
  justify-items: center;
}
.tarot-spread-icon i {
  width: 9px; height: 14px;
  border-radius: 2px;
  border: 1px solid #d9b978;
  background: rgba(217,185,120,0.15);
}
.tarot-spread-text { display: flex; flex-direction: column; gap: 3px; }
.tarot-spread-name { font-size: 15px; letter-spacing: 0.06em; }
.tarot-spread-name em {
  font-style: normal; font-size: 11px; color: #d9b978; margin-left: 8px;
}
.tarot-spread-desc { font-size: 12px; color: rgba(239,227,200,0.6); line-height: 1.5; }

/* 结果页牌阵 */
.tarot-spread-grid {
  display: grid;
  gap: 12px 14px;
  justify-content: center;
}
.tarot-slot {
  display: flex; flex-direction: column; align-items: center; gap: 5px;
  animation: tarotLand 0.45s cubic-bezier(.2,.8,.3,1) both;
}
.tarot-slot-label {
  font-size: 11px;
  letter-spacing: 0.08em;
  color: #d9b978;
  white-space: nowrap;
}
.tarot-slot-card {
  border: none; background: transparent; padding: 0; cursor: pointer;
  border-radius: 8px;
  line-height: 0;
  transition: box-shadow 0.2s ease, transform 0.2s ease;
}
.tarot-slot-card-on {
  box-shadow: 0 0 0 1.5px #d9b978, 0 0 18px rgba(217,185,120,0.5);
  transform: translateY(-3px);
}
.tarot-flip-in { display: inline-block; animation: tarotFlipIn 0.35s ease both; }
@keyframes tarotFlipIn {
  from { transform: rotateY(90deg); opacity: 0.4; }
  to { transform: rotateY(0deg); opacity: 1; }
}
.tarot-reading {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  animation: tarotReveal 0.3s ease both;
}
.tarot-reading-pos {
  margin: 0;
  font-size: 13px;
  color: #d9b978;
  letter-spacing: 0.08em;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
}
.tarot-reading-pos span { font-size: 11px; color: rgba(239,227,200,0.5); letter-spacing: 0.04em; }
.tarot-reading-empty {
  margin: 0; font-size: 12px; color: rgba(239,227,200,0.5); letter-spacing: 0.06em;
}

.tarot-spread-item:disabled { opacity: 0.45; cursor: default; }
.tarot-spread-free { border-color: rgba(217,185,120,0.6); background: rgba(217,185,120,0.08); }
.tarot-spread-icon-free { position: relative; height: 22px; display: block; }
.tarot-spread-icon-free i { position: absolute; top: 3px; }
.tarot-spread-icon-free i:nth-child(1) { left: 6px; transform: rotate(-14deg); }
.tarot-spread-icon-free i:nth-child(2) { left: 14px; top: 0; }
.tarot-spread-icon-free i:nth-child(3) { left: 22px; transform: rotate(12deg); }
.tarot-spread-item:disabled:hover { border-color: rgba(217,185,120,0.35); background: rgba(40,22,62,0.55); }
.tarot-need-text {
  margin: 0; max-width: 300px; text-align: center;
  font-size: 14px; line-height: 1.8; color: rgba(239,227,200,0.85);
}
.tarot-len-reading {
  max-width: 320px; display: flex; flex-direction: column; gap: 6px;
}
.tarot-len-reading p {
  margin: 0; font-size: 14px; line-height: 1.75; color: rgba(239,227,200,0.9);
}
.tarot-len-reading b {
  color: #d9b978; font-weight: 400; font-size: 12px; margin-right: 10px; letter-spacing: 0.08em;
}
.tarot-link {
  border: none; background: transparent; padding: 0; cursor: pointer;
  color: #d9b978; font: inherit; text-decoration: underline; text-underline-offset: 3px;
}
.tarot-entry-line-wide b { min-width: 3.2em; display: inline-block; }
.tarot-book-kinds .tarot-tab { font-size: 13px; letter-spacing: 0.06em; }

.tarot-flip-btn {
  border: none; background: transparent; padding: 0; cursor: pointer;
  animation: tarotLand 0.45s cubic-bezier(.2,.8,.3,1) both;
}
@keyframes tarotLand {
  from { transform: translateY(-40px) scale(0.9); opacity: 0; }
}
.tarot-result {
  display: flex; flex-direction: column; align-items: center; gap: 14px;
  width: 100%;
  margin: auto 0;
  padding: 12px 0 20px;
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
  .tarot-hint, .tarot-shuffle-card, .tarot-flip-btn, .tarot-result, .tarot-toast,
  .tarot-slot, .tarot-flip-in, .tarot-reading {
    animation: none !important;
  }
}
`;

export default TarotApp;
