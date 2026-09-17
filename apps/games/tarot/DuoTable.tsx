import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TAROT_DECK } from './cards';
import type { CardMeaning } from './meanings';
import type { LenormandMeaning } from './lenormand';
import { CardFace, CardBack, GenericCardFace } from './CardFace';
import {
  DeckKind, DECK_KINDS, CARD_RATIOS, BUILTIN_DECK_ID, WorkshopData, PoolCard,
  buildDeckPool, deckNameOf, activeIdOf,
} from './decks';
import { callGameAI, type GameAIApi } from '../shared/ai';
import { createChatMirror } from '../shared/chatMirror';
import { readNames, readPersona } from '../shared/profile';
import {
  DUO_MIRROR, QUESTION_DIRECTIONS, TA_TEMPERATURE, RATING_LABEL,
  TASK_ASK, OPENING_BASIC, OPENING_ADVANCED, TASK_EXTRA, TASK_JUDGE, REVEAL_QUESTION,
  TASK_READ, READ_QUESTION_BASIC, READ_QUESTION_SILENT, READ_QUESTION_ADVANCED,
  TASK_REACT, REACT_REVEAL, REACT_REVEAL_SILENT, TASK_CHAT,
  buildDuoSystem, buildDuoMessages, fillVars, parseAsk, parseExtra, parseJudge, cleanSpeech,
} from './prompts';
import { POKE_RESET_MS, POKE_BUBBLE_MS, pickPokeLine } from './pokeLines';
import {
  DuoSession, DuoRound, DuoCard, DuoDeckRef, DuoPlay, DuoMode, DuoRating, DuoStage,
  COUNT_OPTIONS, SCORE, MODE_LABEL,
  newDuoSession, peekDuoSession, loadDuoSession, saveDuoSession, flushDuoSession, clearDuoSession,
  subscribeDuo, getDuoBusy, setDuoBusy, upsertDuoRecord, addDuoScore, sessionHasContent,
  loadDuoApi, duoApiFilled, duoUid,
} from './duoStore';

/**
 * 和 TA 一起占卜（双人模式）。
 *
 * 和单人抽牌、随心抽是两条分开的路：TA 在座时点托盘才进这里，存档也分开（duoStore.ts）。
 * 房间和 TA 一直在画面里，这个组件只盖一层透明的交互层在上面：
 *   · 牌落在桌布上（房间视角），点「铺开看」可以拖动、叠放
 *   · TA 说话是头顶的气泡；打字框需要时才从底部弹出
 *   · 戳 TA、电话禁用、猫爪弹窗由 TarotApp 转过来（request）
 * 提示词在 prompts.ts，戳一戳台词在 pokeLines.ts。
 */

export type DuoRequest =
  | { nonce: number; type: 'tray'; kind: DeckKind }
  | { nonce: number; type: 'paw' }
  | { nonce: number; type: 'poke' };

export interface DuoTableProps {
  charId: string;
  char: unknown;
  userProfile: unknown;
  apiConfig: Partial<GameAIApi> | null | undefined;
  /** 角色名 */
  who: string;
  workshop: WorkshopData;
  tarotMeaning: (id: number) => CardMeaning;
  lenormandMeaning: (id: number) => LenormandMeaning;
  variant: 'phone' | 'tablet';
  /** 房间图在屏幕上的位置和大小（px） */
  room: { left: number; top: number; width: number; height: number };
  frame: { w: number; h: number };
  /** 去牌意之书时隐藏，但不卸载 */
  visible: boolean;
  request: DuoRequest | null;
  onSessionChange: (active: boolean) => void;
  /** 暂时离开：离开小屋 */
  onLeave: () => void;
  onToast: (text: string) => void;
  onOpenBook: (kind: DeckKind) => void;
}

/** 房间图上几块区域的位置（占图片宽高的比例），手机和平板的图不一样 */
const ZONES = {
  phone: {
    table: { x0: 0.21, x1: 0.75, y0: 0.6, y1: 0.86 },
    taFan: { x0: 0.27, x1: 0.71, y: 0.588 },
    bubble: { x: 0.44, bottom: 0.285 },
  },
  tablet: {
    table: { x0: 0.21, x1: 0.72, y0: 0.635, y1: 0.95 },
    taFan: { x0: 0.26, x1: 0.7, y: 0.618 },
    bubble: { x: 0.42, bottom: 0.175 },
  },
};

const KIND_CN: Record<DeckKind, string> = { tarot: '塔罗', lenormand: '雷诺曼', oracle: '神谕卡' };
const MAX_PER_KIND = 3;
const BOTTOM_BAR_H = 104;
const ROOM_CARD_MAX_W = { phone: 58, tablet: 80 };
/** 铺开看：牌的高度 */
const SPREAD_CARD_H = 104;
const SPREAD_GAP_X = 14;
const SPREAD_GAP_Y = 20;
const SPREAD_PAD = 14;
/** 我抽牌时扇形的参数，和随心抽一致 */
const FAN_CARD_W = 46;
const FAN_PIVOT = 300;
const FAN_LIFT = 20;
/** TA 面前那排牌最多画几张 */
const TA_FAN_SIZE = 21;
const INSPECT_W = 170;

type Sheet = null | 'ask' | 'decks' | 'extra' | 'paw' | 'log' | 'say';
type Panel = null | 'chat' | 'reading' | 'feedback';
type Bubble = { text: string; kind: 'say' | 'poke' | 'think'; key: number };

const sleep = (ms: number) => new Promise<void>((res) => window.setTimeout(res, ms));

function shuffleKeys(keys: string[]): string[] {
  const arr = keys.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const lastRoundOf = (s: DuoSession | null): DuoRound | null => (s && s.rounds.length ? s.rounds[s.rounds.length - 1] : null);

/** 需要调 API 的步骤 */
const API_STAGES: DuoStage[] = ['ta_ask', 'ta_judge', 'ta_read', 'ta_react'];

export function DuoTable(props: DuoTableProps) {
  const {
    charId, char, userProfile, apiConfig, who, workshop, tarotMeaning, lenormandMeaning,
    variant, room, frame, visible, request, onLeave, onToast, onOpenBook,
  } = props;

  const names = useMemo(() => {
    const n = readNames(userProfile, char);
    return { ta: who || n.ta, user: n.user };
  }, [userProfile, char, who]);
  const taPersona = useMemo(() => readPersona(char), [char]);
  const userPersona = useMemo(() => readPersona(userProfile, 2000), [userProfile]);

  // ── 存档 ──
  const [session, setSession] = useState<DuoSession | null>(() => peekDuoSession(charId).session);
  const [loaded, setLoaded] = useState<boolean>(() => peekDuoSession(charId).known);
  const [busy, setBusy] = useState<string | null>(() => getDuoBusy(charId));
  const sessionRef = useRef<DuoSession | null>(session);
  const aliveRef = useRef(true);
  const animatingRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    const unsub = subscribeDuo(charId, () => {
      const p = peekDuoSession(charId);
      sessionRef.current = p.session;
      setSession(p.session);
      if (p.known) setLoaded(true);
      setBusy(getDuoBusy(charId));
    });
    loadDuoSession(charId).then((s) => {
      if (!aliveRef.current) return;
      sessionRef.current = s;
      setSession(s);
      setLoaded(true);
    });
    return () => {
      aliveRef.current = false;
      unsub();
      flushDuoSession(charId);
    };
  }, [charId]);

  const onSessionChangeRef = useRef(props.onSessionChange);
  onSessionChangeRef.current = props.onSessionChange;
  const hasSession = !!session;
  useEffect(() => {
    if (loaded) onSessionChangeRef.current(hasSession);
  }, [loaded, hasSession]);

  const commit = useCallback((fn: (prev: DuoSession) => DuoSession) => {
    const cur = peekDuoSession(charId).session ?? sessionRef.current;
    if (!cur) return;
    const next = fn(cur);
    sessionRef.current = next;
    saveDuoSession(next);
    setSession(next);
  }, [charId]);

  const updRound = useCallback((roundId: string, fn: (r: DuoRound) => DuoRound) => {
    commit((s) => ({ ...s, rounds: s.rounds.map((r) => (r.id === roundId ? fn(r) : r)) }));
  }, [commit]);

  const addLog = useCallback((from: 'ta' | 'user' | 'event', text: string) => {
    const t = (text || '').trim();
    if (!t) return;
    commit((s) => ({ ...s, log: [...s.log, { id: (s.log[s.log.length - 1]?.id ?? 0) + 1, from, text: t, t: Date.now() }] }));
  }, [commit]);

  const curRound = () => lastRoundOf(peekDuoSession(charId).session ?? sessionRef.current);
  const round = lastRoundOf(session);

  const mirror = useMemo(() => createChatMirror(charId, 'tarot', DUO_MIRROR.enabled), [charId]);

  // ── 牌组 ──
  const poolCache = useMemo(() => new Map<string, PoolCard[]>(), [workshop]);
  const poolOf = useCallback((ref: DuoDeckRef): PoolCard[] => {
    let p = poolCache.get(ref.deckId);
    if (!p) {
      p = buildDeckPool(workshop, ref.kind, ref.deckId);
      poolCache.set(ref.deckId, p);
    }
    return p;
  }, [poolCache, workshop]);
  const pcOf = (card: DuoCard) => poolOf(card).find((p) => p.key === card.cardKey);
  const backOf = (deckId: string) => workshop.decks.find((d) => d.id === deckId)?.back;
  const deckNameOfRef = (ref: DuoDeckRef) => deckNameOf(workshop, ref.kind, ref.deckId) ?? '已删除的牌组';
  const remainingOf = (r: DuoRound, ref: DuoDeckRef): string[] => {
    const exists = new Set(poolOf(ref).map((p) => p.key));
    const onTable = new Set(r.cards.filter((c) => c.deckId === ref.deckId).map((c) => c.cardKey));
    return (r.orders[ref.deckId] ?? []).filter((k) => exists.has(k) && !onTable.has(k));
  };

  const meaningText = (card: DuoCard): string => {
    const pc = pcOf(card);
    if (!pc) return '（找不到这张牌）';
    if (pc.tarotId !== undefined) {
      const m = tarotMeaning(pc.tarotId);
      return card.reversed ? m.rev : m.up;
    }
    if (pc.lenormandId !== undefined) {
      const m = lenormandMeaning(pc.lenormandId);
      return `关键词：${m.keywords}；时间：${m.time}`;
    }
    return pc.oracle?.meaning?.trim() || '（这张没写牌意）';
  };

  // ── 气泡 ──
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const stickyRef = useRef<Bubble | null>(null);
  const pokeTimer = useRef<number | null>(null);
  const sayTa = (text: string) => {
    const t = text.trim();
    if (!t) return;
    const b: Bubble = { text: t, kind: 'say', key: Date.now() };
    stickyRef.current = b;
    if (pokeTimer.current !== null) window.clearTimeout(pokeTimer.current);
    setBubble(b);
  };
  const think = () => setBubble({ text: '……', kind: 'think', key: Date.now() });

  // TA 的每一句都从这一场的对话里取：说完、或者离开再回来，头顶显示的都是他最新的一句
  const shownLogKey = useRef('');
  const lastTaEntry = (() => {
    if (!session) return null;
    for (let i = session.log.length - 1; i >= 0; i--) if (session.log[i].from === 'ta') return session.log[i];
    return null;
  })();
  const lastTaKey = session && lastTaEntry ? `${session.id}:${lastTaEntry.id}` : '';
  useEffect(() => {
    if (!lastTaEntry || lastTaKey === shownLogKey.current) return;
    shownLogKey.current = lastTaKey;
    sayTa(lastTaEntry.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastTaKey]);
  const restoreBubble = () => setBubble(stickyRef.current ? { ...stickyRef.current, key: Date.now() } : null);

  // ── 界面状态 ──
  const [sheet, setSheet] = useState<Sheet>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [view, setView] = useState<'room' | 'spread'>('room');
  const [error, setError] = useState<string | null>(null);
  const [askForm, setAskForm] = useState<{ play: DuoPlay; mode: DuoMode; text: string; kind: DeckKind }>({
    play: 'ta_draws', mode: 'basic', text: '', kind: 'tarot',
  });
  const [deckForm, setDeckForm] = useState<{ decks: DuoDeckRef[]; count: number; warn: string }>({ decks: [], count: 3, warn: '' });
  const [chatDraft, setChatDraft] = useState('');
  const [readingDraft, setReadingDraft] = useState('');
  const [feedback, setFeedback] = useState<{ rating: DuoRating | null; text: string }>({ rating: null, text: '' });
  const [fanDeckId, setFanDeckId] = useState<string | null>(null);
  const [taFan, setTaFan] = useState<{ kind: DeckKind; back?: string; size: number; hover: number | null; lifted: number | null } | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);

  useEffect(() => () => { if (pokeTimer.current !== null) window.clearTimeout(pokeTimer.current); }, []);

  const noApi = () => {
    restoreBubble();
    setError('还没接上 TA 的接口：点窗外的月亮填写，或者去 App 设置里填主 API');
  };
  const apiFailed = (e: unknown) => {
    restoreBubble();
    setError(String((e as Error)?.message || e).slice(0, 120));
  };

  // ── 发给 TA ──
  const roundText = (r: DuoRound | null, opts: { revealUserQuestion?: boolean } = {}): string => {
    if (!r) return '';
    const { ta, user } = names;
    const lines: string[] = ['【这一局】'];
    lines.push(r.play === 'ta_draws'
      ? `玩法：${ta} 抽牌出题，${user} 解牌，解完 ${ta} 说准不准。`
      : `玩法：${user} 抽牌，${ta} 解牌，解完 ${user} 说准不准。`);
    lines.push(`模式：${r.mode === 'basic' ? '基础（问题公开，答案藏着）' : '进阶（问题和答案都藏着）'}`);
    if (r.play === 'ta_draws' && r.secret) {
      lines.push(`只有你知道：你心里的问题是「${r.secret.question}」，答案是「${r.secret.answer}」。${user} 不知道答案${r.mode === 'advanced' ? '，也不知道问题' : ''}，揭晓之前不许说漏。`);
    }
    if (r.play === 'user_draws') {
      if (r.mode === 'basic' || opts.revealUserQuestion || r.stage === 'done') {
        lines.push(r.ask ? `${user} 的问题：「${r.ask}」` : `${user} 在心里默念了一个问题，没有说出来。`);
      } else {
        lines.push(`${user} 没告诉你问题。`);
      }
    }
    if (r.cards.length) {
      lines.push('桌上的牌（按抽出来的顺序）：');
      r.cards.forEach((c, i) => {
        const byName = c.by === 'ta' ? ta : user;
        const pos = c.kind === 'tarot' ? (c.reversed ? ' 逆位' : ' 正位') : '';
        lines.push(`第${i + 1}张（${byName}抽的${c.extra ? '，后来补的' : ''}）：${KIND_CN[c.kind]}「${c.deckName}」${c.name}${pos}。牌意：${meaningText(c)}`);
      });
      const arr = arrangementText(r);
      if (arr) lines.push(arr);
    } else {
      lines.push('桌上还没有牌。');
    }
    return lines.join('\n');
  };

  const callTa = async (purpose: string, task: string, opts: { memory?: string; revealUserQuestion?: boolean } = {}) => {
    const s = peekDuoSession(charId).session ?? sessionRef.current;
    if (!s) return null;
    const own = loadDuoApi();
    const system = buildDuoSystem(names, {
      taPersona,
      userPersona,
      memory: opts.memory ?? '',
      roundText: roundText(lastRoundOf(s), { revealUserQuestion: opts.revealUserQuestion }),
    });
    const messages = buildDuoMessages(names, s.log, fillVars(task, names));
    return callGameAI({
      api: duoApiFilled(own) ? own : apiConfig,
      label: names.ta,
      temperature: TA_TEMPERATURE,
      system,
      messages,
      meta: { appName: '与昼', charId: charId || undefined, charName: names.ta, purpose: `塔罗 · ${purpose}` },
    });
  };

  /** 出题时去记忆宫殿找相关的记忆；没开记忆宫殿、没配向量接口或出错时返回空 */
  const recallMemory = async (topic: string): Promise<string> => {
    const c = char as Record<string, unknown> | null;
    if (!c || !c.memoryPalaceEnabled || !topic.trim()) return '';
    try {
      const mod = await import('../../../utils/memoryPalace/pipeline');
      const copy = { ...c, id: String(c.id ?? charId), memoryPalaceInjection: '', roomPlatesInjection: '' } as Record<string, unknown> & { id: string; memoryPalaceInjection: string; roomPlatesInjection: string };
      // 只拿方向当检索词，不读主聊天记录
      const probe = [{ id: -1, charId, role: 'user', type: 'text', content: topic, timestamp: Date.now() }];
      await Promise.race([mod.injectMemoryPalace(copy as never, probe as never, topic, names.user), sleep(15000)]);
      return [copy.roomPlatesInjection, copy.memoryPalaceInjection]
        .filter((x) => typeof x === 'string' && x.trim())
        .join('\n\n');
    } catch (e) {
      console.warn('[Tarot] 记忆宫殿取记忆失败', e);
      return '';
    }
  };

  const runBusy = async (label: string, fn: () => Promise<void>) => {
    if (getDuoBusy(charId)) return;
    setError(null);
    setDuoBusy(charId, label);
    try {
      await fn();
    } catch (e) {
      apiFailed(e);
    } finally {
      setDuoBusy(charId, null);
    }
  };

  // ── 牌落到桌上 ──
  const landCard = (roundId: string, ref: DuoDeckRef, key: string, by: 'ta' | 'user', extra: boolean) => {
    const pc = poolOf(ref).find((p) => p.key === key);
    const id = duoUid('c');
    updRound(roundId, (r) => {
      const pending = r.pendingPicks && r.pendingPicks.deckId === ref.deckId
        ? r.pendingPicks.keys.filter((k) => k !== key)
        : r.pendingPicks?.keys ?? [];
      return {
        ...r,
        zTop: r.zTop + 1,
        cards: [...r.cards, {
          id, deckId: ref.deckId, kind: ref.kind, cardKey: key,
          name: pc?.name ?? '找不到的牌', deckName: deckNameOfRef(ref),
          by, reversed: ref.kind === 'tarot' && Math.random() < 0.5, faceUp: false, extra,
          x: -1, y: 0, z: r.zTop + 1,
        }],
        orders: { ...r.orders, [ref.deckId]: (r.orders[ref.deckId] ?? []).filter((k) => k !== key) },
        pendingPicks: r.pendingPicks && pending.length ? { ...r.pendingPicks, keys: pending } : null,
      };
    });
    setLanded(id);
    window.setTimeout(() => setLanded((v) => (v === id ? null : v)), 650);
  };

  /** TA 的手在他面前那排牌上挑，挑中的落到桌上；TA 挑的位置已经换算成具体的牌存在 pendingPicks 里 */
  const animatePending = async (roundId: string, picksVisual: number[] | null) => {
    const r = curRound();
    if (!r || r.id !== roundId || !r.pendingPicks) return;
    animatingRef.current = true;
    const pp = r.pendingPicks;
    const ref = { deckId: pp.deckId, kind: pp.kind };
    const total = remainingOf(r, ref).length || pp.keys.length;
    const size = Math.max(1, Math.min(TA_FAN_SIZE, total));
    const rand = () => Math.floor(Math.random() * size);
    try {
      setTaFan({ kind: pp.kind, back: backOf(pp.deckId), size, hover: null, lifted: null });
      await sleep(450);
      for (let i = 0; i < pp.keys.length; i++) {
        if (!aliveRef.current) return;
        const target = picksVisual?.[i] ?? rand();
        for (const w of [rand(), rand()]) {
          setTaFan((f) => (f ? { ...f, hover: w } : f));
          await sleep(220);
        }
        setTaFan((f) => (f ? { ...f, hover: target } : f));
        await sleep(420);
        setTaFan((f) => (f ? { ...f, hover: null, lifted: target } : f));
        await sleep(260);
        if (!aliveRef.current) return;
        landCard(roundId, ref, pp.keys[i], 'ta', pp.extra);
        await sleep(240);
        setTaFan((f) => (f ? { ...f, lifted: null } : f));
      }
      await sleep(200);
      const after = curRound();
      if (after && after.id === roundId && after.stage === 'ta_drawing') updRound(roundId, (x) => ({ ...x, stage: 'reading' }));
    } finally {
      animatingRef.current = false;
      if (aliveRef.current) setTaFan(null);
    }
  };

  // 抽牌动画没播完就离开了（或者回复落在已经关掉的页面上）：回来直接把牌摆好
  useEffect(() => {
    if (!loaded || !round || animatingRef.current) return;
    if (round.pendingPicks && round.pendingPicks.keys.length) {
      animatePending(round.id, null);
    } else if (round.stage === 'ta_drawing') {
      updRound(round.id, (x) => ({ ...x, stage: 'reading' }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, round?.id, round?.pendingPicks?.keys.length, round?.stage]);

  // 我抽牌阶段自动拿起第一副还有牌的
  useEffect(() => {
    if (!round || round.stage !== 'user_drawing' || fanDeckId) return;
    const first = round.decks.find((d) => remainingOf(round, d).length > 0);
    if (first) setFanDeckId(first.deckId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round?.id, round?.stage]);

  // ── 开一局 ──
  const openAsk = (kind: DeckKind) => {
    setAskForm((f) => ({ ...f, text: '', kind }));
    setSheet('ask');
  };

  const defaultDecksFor = (kind: DeckKind): DuoDeckRef[] => {
    const id = activeIdOf(workshop, kind) ?? BUILTIN_DECK_ID[kind];
    if (id && buildDeckPool(workshop, kind, id).length > 0) return [{ deckId: id, kind }];
    for (const k of DECK_KINDS) {
      const bid = BUILTIN_DECK_ID[k.kind];
      if (bid && buildDeckPool(workshop, k.kind, bid).length > 0) return [{ deckId: bid, kind: k.kind }];
    }
    return [];
  };

  const startRound = () => {
    const { ta, user } = names;
    let s = peekDuoSession(charId).session ?? sessionRef.current;
    if (!s) {
      s = newDuoSession(charId);
      sessionRef.current = s;
      saveDuoSession(s);
      setSession(s);
      if (DUO_MIRROR.milestones) mirror('system', `${DUO_MIRROR.tag}${user}和${ta}在小屋里开始占卜。`);
    }
    const r: DuoRound = {
      id: duoUid('r'),
      startedAt: Date.now(),
      play: askForm.play,
      mode: askForm.mode,
      ask: askForm.text.trim(),
      topic: '',
      count: 3,
      decks: [],
      orders: {},
      cards: [],
      zTop: 1,
      arranged: false,
      stage: 'deck',
      pendingPicks: null,
    };
    commit((x) => ({ ...x, rounds: [...x.rounds, r] }));
    stickyRef.current = null;
    setBubble(null);
    setError(null);
    setView('room');
    setReadingDraft('');
    setFeedback({ rating: null, text: '' });
    setDeckForm({ decks: defaultDecksFor(askForm.kind), count: 3, warn: '' });
    setSheet('decks');
  };

  const confirmDecks = () => {
    const r = curRound();
    if (!r || r.stage !== 'deck') return;
    const decks = deckForm.decks;
    if (!decks.length) {
      setDeckForm((f) => ({ ...f, warn: '至少选一副牌' }));
      return;
    }
    const mainPool = poolOf(decks[0]);
    if (mainPool.length < deckForm.count) {
      setDeckForm((f) => ({ ...f, warn: `第一副只有 ${mainPool.length} 张，不够抽 ${f.count} 张` }));
      return;
    }
    const { ta, user } = names;
    const orders: Record<string, string[]> = {};
    decks.forEach((d) => { orders[d.deckId] = shuffleKeys(poolOf(d).map((p) => p.key)); });
    const nextStage: DuoStage = r.play === 'ta_draws' ? 'ta_ask' : 'user_drawing';
    updRound(r.id, (x) => ({ ...x, decks, orders, count: deckForm.count, stage: nextStage }));
    const modeText = `${MODE_LABEL[r.mode]}模式`;
    if (r.play === 'ta_draws') {
      addLog('event', `新的一局（${modeText}）：${ta} 抽 ${deckForm.count} 张牌出题，${user} 来解。${r.ask ? `${user} 想让 ${ta} 问的方向：${r.ask}` : ''}`);
    } else {
      const q = r.mode === 'basic' ? (r.ask ? `${user} 的问题：「${r.ask}」` : `${user} 在心里默念了一个问题。`) : `${user} 没把问题告诉 ${ta}。`;
      addLog('event', `新的一局（${modeText}）：${user} 抽 ${deckForm.count} 张牌，${ta} 来解。${q}`);
    }
    setSheet(null);
    if (r.play === 'ta_draws') {
      window.setTimeout(() => runAsk(), 60);
    } else {
      setFanDeckId(decks[0].deckId);
    }
  };

  // ── TA 抽我解 ──
  const runAsk = () => runBusy('ask', async () => {
    const r = curRound();
    if (!r || r.stage !== 'ta_ask') return;
    think();
    let topic = r.ask || r.topic;
    if (!topic) {
      topic = fillVars(QUESTION_DIRECTIONS[Math.floor(Math.random() * QUESTION_DIRECTIONS.length)] || '最近的心事', names);
      updRound(r.id, (x) => ({ ...x, topic }));
    }
    const memory = await recallMemory(topic);
    const main = r.decks[0];
    const fanKeys = remainingOf(r, main);
    const total = fanKeys.length;
    const direction = r.ask
      ? `${names.user} 想让你问的方向：${r.ask}`
      : `这次的方向（随机抽到的，${names.user} 不知道）：${topic}`;
    const task = fillVars(TASK_ASK, names, {
      方向: direction,
      总数: String(total),
      张数: String(r.count),
      开口要求: fillVars(r.mode === 'basic' ? OPENING_BASIC : OPENING_ADVANCED, names),
    });
    const reply = await callTa('出题', task, { memory });
    if (reply === null) { noApi(); return; }
    const parsed = parseAsk(reply, r.count, total);
    if (!parsed.question || !parsed.answer) {
      restoreBubble();
      setError(`${names.ta} 这次没说清楚，再叫一次`);
      return;
    }
    const now = curRound();
    if (!now || now.id !== r.id || now.stage !== 'ta_ask') return;
    const keys = parsed.picks.map((p) => fanKeys[p - 1]).filter(Boolean);
    const size = Math.max(1, Math.min(TA_FAN_SIZE, total));
    const visual = parsed.picks.map((p) => (total <= size ? p - 1 : Math.round(((p - 1) * (size - 1)) / Math.max(1, total - 1))));
    const say = parsed.say || '……';
    animatingRef.current = true;
    updRound(r.id, (x) => ({
      ...x,
      secret: { question: parsed.question, answer: parsed.answer },
      taOpening: say,
      stage: 'ta_drawing',
      pendingPicks: { deckId: main.deckId, kind: main.kind, keys, extra: false },
    }));
    addLog('ta', say);
    if (!aliveRef.current) { animatingRef.current = false; return; }
    await animatePending(r.id, visual);
  });

  const runExtraTa = (ref: DuoDeckRef) => runBusy('extra', async () => {
    const r = curRound();
    if (!r) return;
    const fanKeys = remainingOf(r, ref);
    if (!fanKeys.length) { onToast('这副牌已经抽完了'); return; }
    think();
    const task = fillVars(TASK_EXTRA, names, { 牌组: deckNameOfRef(ref), 总数: String(fanKeys.length) });
    const reply = await callTa('补牌', task);
    if (reply === null) { noApi(); return; }
    const parsed = parseExtra(reply, fanKeys.length);
    const key = fanKeys[parsed.pick - 1] ?? fanKeys[0];
    const size = Math.max(1, Math.min(TA_FAN_SIZE, fanKeys.length));
    const visual = fanKeys.length <= size ? parsed.pick - 1 : Math.round(((parsed.pick - 1) * (size - 1)) / Math.max(1, fanKeys.length - 1));
    addLog('event', `${names.user} 请 ${names.ta} 从「${deckNameOfRef(ref)}」再补一张。`);
    if (parsed.say) addLog('ta', parsed.say); else restoreBubble();
    animatingRef.current = true;
    updRound(r.id, (x) => ({ ...x, pendingPicks: { deckId: ref.deckId, kind: ref.kind, keys: [key], extra: true } }));
    await animatePending(r.id, [visual]);
  });

  const flipAll = (roundId: string) => updRound(roundId, (x) => ({ ...x, cards: x.cards.map((c) => ({ ...c, faceUp: true })) }));

  const finishRound = (roundId: string) => {
    const s = peekDuoSession(charId).session ?? sessionRef.current;
    const r = s?.rounds.find((x) => x.id === roundId);
    if (!s || !r || !r.rating) return;
    addDuoScore(charId, r.play === 'ta_draws' ? 'user' : 'ta', r.mode, r.score ?? 0).catch(() => undefined);
    mirrorRound(r);
    upsertDuoRecord(s).catch(() => undefined);
  };

  const completeJudge = (roundId: string, rating: DuoRating) => {
    const r = curRound();
    if (!r || r.id !== roundId) return;
    updRound(roundId, (x) => ({ ...x, rating, score: SCORE[x.mode][rating], stage: 'done', endedAt: Date.now() }));
    addLog('event', `${names.ta} 觉得 ${names.user} 解得${RATING_LABEL[rating]}。`);
    finishRound(roundId);
  };

  const runJudge = () => runBusy('judge', async () => {
    let r = curRound();
    if (!r) return;
    if (r.stage === 'reading') {
      const text = readingDraft.trim();
      if (!text) { onToast('先写下你的解读'); return; }
      flipAll(r.id);
      updRound(r.id, (x) => ({ ...x, userReading: text, stage: 'ta_judge' }));
      addLog('user', text);
      setPanel(null);
      setReadingDraft('');
      r = curRound();
    }
    if (!r || r.stage !== 'ta_judge' || r.taVerdict) return;
    think();
    const task = fillVars(TASK_JUDGE, names, {
      解读: r.userReading ?? '',
      揭晓问题: r.mode === 'advanced' ? fillVars(REVEAL_QUESTION, names) : '',
    });
    const reply = await callTa('对答案', task);
    if (reply === null) { noApi(); return; }
    const parsed = parseJudge(reply);
    const text = parsed.text || '……';
    updRound(r.id, (x) => ({ ...x, taVerdict: text }));
    addLog('ta', text);
    if (parsed.rating) completeJudge(r.id, parsed.rating);
  });

  // ── 我抽 TA 解 ──
  const userDraw = (key: string) => {
    const r = curRound();
    if (!r || !fanDeckId) return;
    const ref = r.decks.find((d) => d.deckId === fanDeckId);
    if (!ref) return;
    const initial = r.stage === 'user_drawing';
    landCard(r.id, ref, key, 'user', !initial);
    if (initial) {
      const drawn = r.cards.filter((c) => c.by === 'user' && !c.extra).length + 1;
      if (drawn >= r.count) {
        updRound(r.id, (x) => ({ ...x, stage: 'user_drawn' }));
        addLog('event', `${names.user} 抽好了 ${r.count} 张牌。`);
        setFanDeckId(null);
      } else if (remainingOf(r, ref).length <= 1) {
        const other = r.decks.find((d) => d.deckId !== ref.deckId && remainingOf(r, d).length > 0);
        setFanDeckId(other ? other.deckId : null);
      }
    } else {
      addLog('event', `${names.user} 从「${deckNameOfRef(ref)}」补了一张牌。`);
      setFanDeckId(null);
    }
  };

  const runRead = () => runBusy('read', async () => {
    let r = curRound();
    if (!r) return;
    if (r.stage === 'user_drawn') {
      flipAll(r.id);
      updRound(r.id, (x) => ({ ...x, stage: 'ta_read' }));
      addLog('event', `${names.user} 请 ${names.ta} 解牌。`);
      setFanDeckId(null);
      r = curRound();
    }
    if (!r || r.stage !== 'ta_read') return;
    think();
    const q = r.mode === 'advanced'
      ? READ_QUESTION_ADVANCED
      : r.ask ? fillVars(READ_QUESTION_BASIC, names, { 问题: r.ask }) : READ_QUESTION_SILENT;
    const task = fillVars(TASK_READ, names, {
      问题说明: fillVars(q, names),
      摆放提示: r.arranged ? `和 ${names.user} 摆出来的位置` : '',
    });
    const reply = await callTa('解牌', task);
    if (reply === null) { noApi(); return; }
    const text = cleanSpeech(reply) || '……';
    const now = curRound();
    if (!now || now.id !== r.id || now.stage !== 'ta_read') return;
    updRound(r.id, (x) => ({ ...x, taReading: text, stage: 'feedback' }));
    addLog('ta', text);
  });

  const runReact = () => runBusy('react', async () => {
    let r = curRound();
    if (!r) return;
    if (r.stage === 'feedback') {
      if (!feedback.rating) { onToast('先选准不准'); return; }
      const rating = feedback.rating;
      const text = feedback.text.trim();
      updRound(r.id, (x) => ({ ...x, rating, feedback: text, stage: 'ta_react' }));
      addLog('user', `${RATING_LABEL[rating]}。${text}`);
      setPanel(null);
      setFeedback({ rating: null, text: '' });
      r = curRound();
    }
    if (!r || r.stage !== 'ta_react' || !r.rating) return;
    think();
    const reveal = r.mode === 'advanced'
      ? (r.ask ? fillVars(REACT_REVEAL, names, { 问题: r.ask }) : REACT_REVEAL_SILENT)
      : '';
    const task = fillVars(TASK_REACT, names, {
      评分: RATING_LABEL[r.rating],
      反馈: r.feedback || '（没多说）',
      揭晓: fillVars(reveal, names),
    });
    const reply = await callTa('反应', task, { revealUserQuestion: true });
    if (reply === null) { noApi(); return; }
    const text = cleanSpeech(reply) || '……';
    const now = curRound();
    if (!now || now.id !== r.id || now.stage !== 'ta_react') return;
    const rating = r.rating;
    updRound(r.id, (x) => ({ ...x, taReaction: text, score: SCORE[x.mode][rating], stage: 'done', endedAt: Date.now() }));
    if (r.mode === 'advanced') {
      addLog('event', r.ask ? `${names.user} 揭晓了问题：「${r.ask}」` : `${names.user} 没说默念的问题是什么。`);
    }
    addLog('ta', text);
    finishRound(r.id);
  });

  // ── 闲聊（发出去先不回，点「让 TA 说」才调 API）──
  const sendChat = () => {
    const text = chatDraft.trim();
    if (!text) return;
    addLog('user', text);
    if (DUO_MIRROR.chat) mirror('user', text);
    setChatDraft('');
  };

  const runChat = () => runBusy('chat', async () => {
    if (chatDraft.trim()) sendChat();
    think();
    const reply = await callTa('聊天', TASK_CHAT);
    if (reply === null) { noApi(); return; }
    const text = cleanSpeech(reply);
    if (!text) { restoreBubble(); return; }
    addLog('ta', text);
    if (DUO_MIRROR.chat) mirror('assistant', text);
    setPanel(null);
  });

  // ── 写进聊天记录（一局结束后才写，问题和答案这时已经揭晓）──
  const mirrorRound = (r: DuoRound) => {
    if (!DUO_MIRROR.enabled || !DUO_MIRROR.rounds) return;
    const { ta, user } = names;
    const tag = DUO_MIRROR.tag;
    const cards = r.cards.map((c) => `${c.name}${c.kind === 'tarot' ? (c.reversed ? '（逆位）' : '（正位）') : ''}`).join('、');
    const label = r.rating ? RATING_LABEL[r.rating] : '';
    if (r.play === 'ta_draws') {
      mirror('system', `${tag}${ta}抽牌出题、${user}来解（${MODE_LABEL[r.mode]}模式）。${ta}心里的问题：「${r.secret?.question ?? ''}」，答案：「${r.secret?.answer ?? ''}」。${ta}抽到：${cards}。`);
      if (r.userReading) mirror('user', r.userReading);
      if (r.taVerdict) mirror('assistant', r.taVerdict);
      mirror('system', `${tag}${ta}觉得${user}解得${label}。`);
    } else {
      mirror('system', `${tag}${user}抽牌、${ta}来解（${MODE_LABEL[r.mode]}模式）。${user}的问题：${r.ask ? `「${r.ask}」` : '在心里默念，没有说出来'}。抽到：${cards}。`);
      if (r.taReading) mirror('assistant', r.taReading);
      mirror('user', `${label}。${r.feedback ?? ''}`);
      if (r.taReaction) mirror('assistant', r.taReaction);
    }
  };

  // ── 结束占卜 / 暂时离开 ──
  const endSession = async () => {
    const s = peekDuoSession(charId).session ?? sessionRef.current;
    if (!s) return;
    const ended: DuoSession = { ...s, endedAt: Date.now() };
    setConfirmEnd(false);
    setSheet(null);
    setPanel(null);
    setView('room');
    setFanDeckId(null);
    setError(null);
    stickyRef.current = null;
    setBubble(null);
    const worth = sessionHasContent(ended);
    try { await upsertDuoRecord(ended); } catch { /* 记录存不进去也先结束 */ }
    if (worth && DUO_MIRROR.milestones) mirror('system', `${DUO_MIRROR.tag}${names.user}和${names.ta}结束了这一场占卜。`);
    await clearDuoSession(charId);
    sessionRef.current = null;
    setSession(null);
    onToast(worth ? '这一场收进占卜记录了' : '占卜结束了');
  };

  // ── 戳一戳 ──
  const pokeRef = useRef({ count: 0, last: 0, line: '' });
  const drawingNow = !!taFan || !!fanDeckId || round?.stage === 'ta_drawing' || round?.stage === 'user_drawing';
  const canPoke = !busy && !sheet && !panel && view === 'room' && !drawingNow;

  const handlePoke = () => {
    if (!canPoke) return;
    const now = Date.now();
    const p = pokeRef.current;
    p.count = now - p.last > POKE_RESET_MS ? 1 : p.count + 1;
    p.last = now;
    const line = pickPokeLine(p.count, p.line, names);
    p.line = line;
    setBubble({ text: line, kind: 'poke', key: now });
    if (pokeTimer.current !== null) window.clearTimeout(pokeTimer.current);
    pokeTimer.current = window.setTimeout(() => { pokeTimer.current = null; restoreBubble(); }, POKE_BUBBLE_MS);
  };

  // ── TarotApp 转过来的点击 ──
  // 挂载前的点击不算（比如电话让 TA 离席再入座，旧的戳一戳不会重播）
  const lastNonce = useRef(request?.nonce ?? 0);
  useEffect(() => {
    if (!request || !loaded || request.nonce === lastNonce.current) return;
    lastNonce.current = request.nonce;
    const r = lastRoundOf(sessionRef.current);
    if (request.type === 'poke') { handlePoke(); return; }
    if (request.type === 'paw') {
      if (sessionRef.current) { setConfirmEnd(false); setPanel(null); setSheet('paw'); } else onLeave();
      return;
    }
    // 托盘
    if (getDuoBusy(charId)) { onToast(`等 ${names.ta} 说完`); return; }
    if (!r || r.stage === 'done') { openAsk(request.kind); return; }
    if (r.stage === 'deck') {
      if (!deckForm.decks.length) setDeckForm({ decks: defaultDecksFor(request.kind), count: r.count || 3, warn: '' });
      setSheet('decks');
      return;
    }
    if (r.stage === 'user_drawing' && !fanDeckId) {
      const first = r.decks.find((d) => remainingOf(r, d).length > 0);
      if (first) setFanDeckId(first.deckId);
      return;
    }
    onToast('这一局还没玩完，玩完再点托盘开下一局');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, loaded]);

  // ── 桌上的牌：点一下翻开，翻开的牌快速点两下拿到眼前 ──
  const lastTap = useRef<{ id: string; t: number } | null>(null);
  const roomEls = useRef<Record<string, HTMLElement | null>>({});
  const spreadEls = useRef<Record<string, HTMLElement | null>>({});
  const bigRef = useRef<HTMLDivElement>(null);
  const [inspect, setInspect] = useState<{ id: string; stage: 'measure' | 'from' | 'open' | 'leave'; t: string } | null>(null);

  const tapCard = (card: DuoCard) => {
    const r = curRound();
    if (!r) return;
    const now = Date.now();
    if (!card.faceUp) {
      updRound(r.id, (x) => ({ ...x, zTop: x.zTop + 1, cards: x.cards.map((c) => (c.id === card.id ? { ...c, faceUp: true, z: x.zTop + 1 } : c)) }));
      lastTap.current = { id: card.id, t: now };
      return;
    }
    const prev = lastTap.current;
    if (prev && prev.id === card.id && now - prev.t < 340) {
      lastTap.current = null;
      setInspect({ id: card.id, stage: 'measure', t: 'none' });
    } else {
      lastTap.current = { id: card.id, t: now };
    }
  };

  const transformToCard = (id: string): string | null => {
    const big = bigRef.current;
    const small = (view === 'spread' ? spreadEls.current[id] : roomEls.current[id]) ?? roomEls.current[id];
    if (!big || !small) return null;
    const b = big.getBoundingClientRect();
    const rr = small.getBoundingClientRect();
    if (b.width === 0 || rr.width === 0) return null;
    const dx = rr.left + rr.width / 2 - (b.left + b.width / 2);
    const dy = rr.top + rr.height / 2 - (b.top + b.height / 2);
    return `translate(${dx}px, ${dy}px) scale(${rr.width / b.width})`;
  };

  useLayoutEffect(() => {
    if (!inspect || inspect.stage !== 'measure') return;
    setInspect({ ...inspect, stage: 'from', t: transformToCard(inspect.id) ?? 'scale(0.6)' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspect]);

  useEffect(() => {
    if (!inspect || inspect.stage !== 'from') return;
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        setInspect((cur) => (cur && cur.stage === 'from' ? { ...cur, stage: 'open', t: 'none' } : cur));
      });
    });
    return () => { window.cancelAnimationFrame(raf1); window.cancelAnimationFrame(raf2); };
  }, [inspect]);

  const closeInspect = () => {
    if (!inspect || inspect.stage === 'leave') return;
    setInspect({ ...inspect, stage: 'leave', t: transformToCard(inspect.id) ?? 'scale(0.6)' });
    window.setTimeout(() => setInspect(null), 420);
  };

  const renderFace = (card: DuoCard, width: number) => {
    const pc = pcOf(card);
    if (!pc) return <GenericCardFace width={width} ratio={CARD_RATIOS[card.kind]} symbol="?" title={card.name || '找不到这张牌'} />;
    if (pc.tarotId !== undefined) return <CardFace card={TAROT_DECK[pc.tarotId]} reversed={card.reversed} width={width} image={pc.image} />;
    if (pc.lenormandId !== undefined) {
      return <GenericCardFace width={width} ratio={CARD_RATIOS.lenormand} image={pc.image} mark={String(pc.lenormandId)} symbol="✧" title={pc.name} />;
    }
    return <GenericCardFace width={width} ratio={CARD_RATIOS.oracle} image={pc.image} symbol="✧" title={pc.name} />;
  };

  // ── 铺开看：拖动、叠放 ──
  const spreadScrollRef = useRef<HTMLDivElement>(null);
  const spreadTableRef = useRef<HTMLDivElement>(null);
  const [spreadW, setSpreadW] = useState(360);
  const spreadWRef = useRef(360);
  useLayoutEffect(() => {
    if (view !== 'spread') return;
    const el = spreadScrollRef.current;
    if (!el) return;
    const measure = () => { const w = el.clientWidth || 360; spreadWRef.current = w; setSpreadW(w); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);

  const spreadCardW = (kind: DeckKind) => Math.round(SPREAD_CARD_H / CARD_RATIOS[kind]);

  /** 没摆过的牌按顺序排进空位 */
  const placeUnarranged = (r: DuoRound, tableW: number): DuoRound => {
    if (!r.cards.some((c) => c.x < 0)) return r;
    const cellW = Math.max(...DECK_KINDS.map((k) => spreadCardW(k.kind))) + SPREAD_GAP_X;
    const cellH = SPREAD_CARD_H + SPREAD_GAP_Y;
    const cols = Math.max(1, Math.floor((tableW - SPREAD_PAD * 2 + SPREAD_GAP_X) / cellW));
    const placed: DuoCard[] = r.cards.filter((c) => c.x >= 0);
    const taken = (sx: number, sy: number) => placed.some((c) => Math.abs(c.x * tableW - sx) < cellW * 0.6 && Math.abs(c.y - sy) < cellH * 0.6);
    const cards = r.cards.map((c) => {
      if (c.x >= 0) return c;
      for (let row = 0; row < 200; row++) {
        for (let col = 0; col < cols; col++) {
          const sx = SPREAD_PAD + col * cellW + (cellW - SPREAD_GAP_X - spreadCardW(c.kind)) / 2;
          const sy = SPREAD_PAD + row * cellH;
          if (!taken(sx, sy)) {
            const next = { ...c, x: sx / tableW, y: sy };
            placed.push(next);
            return next;
          }
        }
      }
      return { ...c, x: SPREAD_PAD / tableW, y: SPREAD_PAD };
    });
    return { ...r, cards };
  };

  const openSpread = () => {
    setPanel(null);
    setFanDeckId(null);
    setView('spread');
  };

  // 铺开看时新抽的牌也要排进空位
  useEffect(() => {
    if (view !== 'spread' || !round || !round.cards.some((c) => c.x < 0)) return;
    updRound(round.id, (x) => placeUnarranged(x, spreadWRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, round?.cards.length]);

  /** 把摆放翻译成文字给 TA：按行从上到下、从左到右，叠在一起的单独说 */
  function arrangementText(r: DuoRound): string {
    if (!r.arranged || r.cards.length < 2) return '';
    const tw = spreadWRef.current || 360;
    const rects = r.cards.map((c, i) => {
      const w = spreadCardW(c.kind);
      return { i, x: c.x * tw, y: c.y, w, h: SPREAD_CARD_H, z: c.z };
    });
    const sorted = rects.slice().sort((a, b) => (Math.abs(a.y - b.y) < SPREAD_CARD_H * 0.5 ? a.x - b.x : a.y - b.y));
    const rows: number[][] = [];
    let rowY = -Infinity;
    for (const rc of sorted) {
      if (rc.y - rowY >= SPREAD_CARD_H * 0.5 || !rows.length) { rows.push([rc.i]); rowY = rc.y; } else rows[rows.length - 1].push(rc.i);
    }
    const parent = rects.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let a = 0; a < rects.length; a++) {
      for (let b = a + 1; b < rects.length; b++) {
        const A = rects[a], B = rects[b];
        const ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
        const oy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
        if (ox > 0 && oy > 0 && ox * oy > 0.2 * Math.min(A.w * A.h, B.w * B.h)) parent[find(a)] = find(b);
      }
    }
    const groups = new Map<number, number[]>();
    rects.forEach((_, i) => { const g = find(i); groups.set(g, [...(groups.get(g) ?? []), i]); });
    const stacks = Array.from(groups.values()).filter((g) => g.length > 1)
      .map((g) => g.sort((a, b) => rects[a].z - rects[b].z).map((i) => `第${i + 1}张`).join('、'));
    const rowText = rows.map((row, k) => `第${k + 1}排：${row.map((i) => `第${i + 1}张`).join('、')}`).join('；');
    return `${names.user} 把牌摆成了这样（从上到下、从左到右）——${rowText}。${stacks.length ? `叠在一起的（从下往上）：${stacks.join('；')}。` : ''}`;
  }

  const drag = useRef<{ id: string; pointerId: number; startX: number; startY: number; offX: number; offY: number; moved: boolean } | null>(null);
  const [dragPos, setDragPos] = useState<{ id: string; x: number; y: number } | null>(null);

  const posFromPointer = (clientX: number, clientY: number, card: DuoCard | undefined) => {
    const d = drag.current;
    const table = spreadTableRef.current;
    if (!d || !table) return null;
    const rect = table.getBoundingClientRect();
    const cw = card ? spreadCardW(card.kind) : 60;
    const px = Math.min(Math.max(0, clientX - rect.left - d.offX), Math.max(0, spreadW - cw));
    const py = Math.max(0, clientY - rect.top - d.offY);
    return { x: px / spreadW, y: py };
  };

  const onSpreadDown = (e: React.PointerEvent<HTMLDivElement>, card: DuoCard) => {
    if (e.button !== undefined && e.button !== 0) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    try { el.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    drag.current = { id: card.id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, offX: e.clientX - rect.left, offY: e.clientY - rect.top, moved: false };
  };

  const onSpreadMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const r = curRound();
    if (!d || d.pointerId !== e.pointerId || !r) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 6) return;
      d.moved = true;
      updRound(r.id, (x) => ({ ...x, zTop: x.zTop + 1, cards: x.cards.map((c) => (c.id === d.id ? { ...c, z: x.zTop + 1 } : c)) }));
    }
    const pos = posFromPointer(e.clientX, e.clientY, r.cards.find((c) => c.id === d.id));
    if (pos) setDragPos({ id: d.id, ...pos });
  };

  const onSpreadUp = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = drag.current;
    const r = curRound();
    if (!d || d.pointerId !== e.pointerId || !r) return;
    drag.current = null;
    const card = r.cards.find((c) => c.id === d.id);
    if (d.moved) {
      const pos = posFromPointer(e.clientX, e.clientY, card) ?? dragPos;
      setDragPos(null);
      if (pos) updRound(r.id, (x) => ({ ...x, arranged: true, cards: x.cards.map((c) => (c.id === d.id ? { ...c, x: pos.x, y: pos.y } : c)) }));
      return;
    }
    setDragPos(null);
    if (!cancelled && card) tapCard(card);
  };

  // ── 我抽牌的扇形：按住左右滑动挑牌，松手抽出 ──
  const fanRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const scrub = useRef<{ pointerId: number } | null>(null);
  const fanRefDeck = round && fanDeckId ? round.decks.find((d) => d.deckId === fanDeckId) ?? null : null;
  const fanKeys = round && fanRefDeck ? remainingOf(round, fanRefDeck) : [];
  const fanCount = fanKeys.length;
  const fanAngle = fanCount > 40 ? 64 : fanCount > 12 ? 52 : Math.max(14, fanCount * 5);
  const fanRatio = fanRefDeck ? CARD_RATIOS[fanRefDeck.kind] : 1.7;
  const fanCardH = Math.round(FAN_CARD_W * fanRatio);

  const fanIndexAt = (clientX: number, clientY: number): number | null => {
    const el = fanRef.current;
    if (!el || fanCount === 0) return null;
    const rect = el.getBoundingClientRect();
    if (clientY < rect.top - 70 || clientY > rect.bottom + 50) return null;
    if (fanCount === 1) return 0;
    const cx = rect.left + rect.width / 2;
    const pivotY = rect.bottom - fanCardH + FAN_PIVOT;
    const angle = (Math.atan2(clientX - cx, pivotY - clientY) * 180) / Math.PI;
    const step = fanAngle / (fanCount - 1);
    return Math.min(fanCount - 1, Math.max(0, Math.round((angle + fanAngle / 2) / step)));
  };

  // ── 渲染 ──
  if (!loaded) return null;

  const { ta, user } = names;
  const zones = ZONES[variant];
  const px = (fx: number) => room.left + room.width * fx;
  const py = (fy: number) => room.top + room.height * fy;

  // 房间视角里桌上的牌：按顺序自动排好
  const roomLayout = (() => {
    if (!round || !round.cards.length) return [];
    const cards = round.cards;
    const z = zones.table;
    const x0 = px(z.x0);
    const x1 = px(z.x1);
    const y0 = py(z.y0);
    const y1 = Math.min(py(z.y1), frame.h - BOTTOM_BAR_H - 6);
    const zw = Math.max(80, x1 - x0);
    const zh = Math.max(70, y1 - y0);
    const n = cards.length;
    const cols = n <= 4 ? n : n <= 8 ? 4 : 5;
    const rows = Math.ceil(n / cols);
    const maxRatio = Math.max(...cards.map((c) => CARD_RATIOS[c.kind]));
    const gap = 7;
    const w = Math.max(16, Math.min(ROOM_CARD_MAX_W[variant], (zw - gap * (cols - 1)) / cols, (zh - gap * (rows - 1)) / rows / maxRatio));
    const h = w * maxRatio;
    const totalH = rows * h + (rows - 1) * gap;
    const startY = y0 + Math.max(0, (zh - totalH) / 2);
    return cards.map((c, i) => {
      const row = Math.floor(i / cols);
      const inRow = row === rows - 1 ? n - row * cols : cols;
      const rowW = inRow * w + (inRow - 1) * gap;
      return {
        card: c,
        left: x0 + (zw - rowW) / 2 + (i % cols) * (w + gap),
        top: startY + row * (h + gap) + (h - w * CARD_RATIOS[c.kind]),
        w: Math.round(w),
      };
    });
  })();

  const bubbleMaxW = Math.min(270, frame.w - 32);
  const bubbleAnchorX = Math.min(Math.max(px(zones.bubble.x), bubbleMaxW / 2 + 16), frame.w - bubbleMaxW / 2 - 16);
  const bubbleAnchorY = Math.max(py(zones.bubble.bottom), 150);

  const stage = round?.stage;
  const inRound = !!round && stage !== 'done';
  const unreplied = (() => {
    if (!session) return 0;
    let n = 0;
    for (let i = session.log.length - 1; i >= 0; i--) {
      const e = session.log[i];
      if (e.from === 'ta') break;
      if (e.from === 'user') n++;
    }
    return n;
  })();
  const canExtra = !!round && !busy && !drawingNow && ['reading', 'user_drawn', 'feedback', 'done'].includes(stage ?? '');

  const askExtra = () => {
    const r = curRound();
    if (!r) return;
    const decks = r.decks.filter((d) => remainingOf(r, d).length > 0);
    if (!decks.length) { onToast('这几副牌都抽完了'); return; }
    if (decks.length > 1) { setSheet('extra'); return; }
    if (r.play === 'ta_draws') runExtraTa(decks[0]);
    else setFanDeckId(decks[0].deckId);
  };

  const busyText: Record<string, string> = {
    ask: `${ta} 在想问题`,
    extra: `${ta} 在挑牌`,
    judge: `${ta} 在对答案`,
    read: `${ta} 在看牌`,
    react: `${ta} 在想怎么回你`,
    chat: `${ta} 在想怎么说`,
  };

  const hintAndActions = (): { hint: string; actions: React.ReactNode } => {
    if (!round) return { hint: '点托盘，和 TA 一起占卜'.replace('TA', ta), actions: null };
    if (busy) return { hint: `${busyText[busy] ?? `${ta} 在想`}…`, actions: null };
    if (error && API_STAGES.includes(round.stage)) {
      const retry = round.stage === 'ta_ask' ? runAsk : round.stage === 'ta_judge' ? runJudge : round.stage === 'ta_read' ? runRead : runReact;
      return { hint: error, actions: <button className="tarot-chip tarot-chip-sm" onClick={retry}>再试一次</button> };
    }
    switch (round.stage) {
      case 'deck':
        return { hint: '选好牌组和张数就开始', actions: <button className="tarot-chip tarot-chip-sm" onClick={() => setSheet('decks')}>选牌组</button> };
      case 'ta_ask':
        return { hint: `${ta} 还没出题`, actions: <button className="tarot-chip tarot-chip-sm" onClick={runAsk}>请 {ta} 出题</button> };
      case 'ta_drawing':
        return { hint: `${ta} 在挑牌…`, actions: null };
      case 'reading':
        return {
          hint: round.mode === 'basic' ? '翻开牌，双击拿起来看，想好了写下解读' : '翻开牌，想查牌意就点桌上的书',
          actions: (
            <>
              {canExtra && <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={askExtra}>请 {ta} 补一张</button>}
              <button className="tarot-chip tarot-chip-sm" onClick={() => setPanel('reading')}>写解读</button>
            </>
          ),
        };
      case 'ta_judge':
        if (round.taVerdict && !round.rating) {
          return {
            hint: `${ta} 的意思是？`,
            actions: (
              <>
                {(['hit', 'half', 'miss'] as DuoRating[]).map((k) => (
                  <button key={k} className="tarot-chip tarot-chip-sm" onClick={() => completeJudge(round.id, k)}>{RATING_LABEL[k]}</button>
                ))}
              </>
            ),
          };
        }
        return { hint: `${ta} 还没回你`, actions: <button className="tarot-chip tarot-chip-sm" onClick={runJudge}>请 {ta} 对答案</button> };
      case 'user_drawing': {
        const drawn = round.cards.filter((c) => c.by === 'user' && !c.extra).length;
        return {
          hint: `抽 ${round.count} 张，已经抽了 ${drawn} 张`,
          actions: !fanDeckId ? <button className="tarot-chip tarot-chip-sm" onClick={() => {
            const first = round.decks.find((d) => remainingOf(round, d).length > 0);
            if (first) setFanDeckId(first.deckId);
          }}>继续抽</button> : null,
        };
      }
      case 'user_drawn':
        return {
          hint: '抽好了，可以补牌，也可以摆一摆再请 TA 解'.replace('TA', ta),
          actions: (
            <>
              {canExtra && <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={askExtra}>补一张</button>}
              <button className="tarot-chip tarot-chip-sm" onClick={runRead}>请 {ta} 解牌</button>
            </>
          ),
        };
      case 'ta_read':
        return { hint: `${ta} 还没解`, actions: <button className="tarot-chip tarot-chip-sm" onClick={runRead}>请 {ta} 解牌</button> };
      case 'feedback':
        return { hint: `告诉 ${ta} 准不准`, actions: <button className="tarot-chip tarot-chip-sm" onClick={() => setPanel('feedback')}>说说准不准</button> };
      case 'ta_react':
        return { hint: `${ta} 还没回你`, actions: <button className="tarot-chip tarot-chip-sm" onClick={runReact}>再告诉 {ta} 一次</button> };
      case 'done':
      default:
        return {
          hint: round.rating ? `这一局：${RATING_LABEL[round.rating]}。点托盘再来一局` : '点托盘再来一局',
          actions: canExtra ? (
            <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={askExtra}>{round.play === 'ta_draws' ? `请 ${ta} 补一张` : '补一张'}</button>
          ) : null,
        };
    }
  };

  const bar = hintAndActions();
  const inspectCard = inspect && round ? round.cards.find((c) => c.id === inspect.id) ?? null : null;
  const showMeaning = !!round && (round.play === 'user_draws' || round.mode === 'basic' || round.stage === 'done');
  const roundNo = session ? session.rounds.length : 0;
  const playShort = round ? (round.play === 'ta_draws' ? `${ta} 抽 · 我解` : `我抽 · ${ta} 解`) : '';

  return (
    <div className="duo-root" style={{ display: visible ? undefined : 'none' }}>
      {/* TA 面前那排牌（他挑牌时出现） */}
      {taFan && (() => {
        const z = zones.taFan;
        const x0 = px(z.x0);
        const width = px(z.x1) - x0;
        const size = taFan.size;
        const cw = Math.max(12, Math.min(26, (width / Math.max(1, size)) * 1.9));
        const step = size > 1 ? (width - cw) / (size - 1) : 0;
        const ch = cw * CARD_RATIOS[taFan.kind];
        const baseY = py(z.y) - ch;
        return (
          <div className="duo-tafan" aria-hidden="true">
            {Array.from({ length: size }).map((_, i) => {
              const mid = (size - 1) / 2 || 1;
              const t = (i - (size - 1) / 2) / mid;
              const hot = taFan.hover === i;
              const up = taFan.lifted === i;
              return (
                <div
                  key={i}
                  className={'duo-tafan-card' + (hot ? ' duo-tafan-hot' : '') + (up ? ' duo-tafan-up' : '')}
                  style={{
                    left: x0 + i * step,
                    top: baseY + t * t * 6,
                    transform: `rotate(${t * 10}deg)${hot ? ' translateY(-9px)' : ''}${up ? ' translateY(-30px) scale(1.1)' : ''}`,
                    zIndex: hot || up ? 100 : i,
                  }}
                >
                  <CardBack width={cw} ratio={CARD_RATIOS[taFan.kind]} image={taFan.back} />
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* 房间视角：桌布上的牌 */}
      {view === 'room' && roomLayout.map(({ card, left, top, w }) => (
        <div
          key={card.id}
          ref={(el: HTMLDivElement | null) => { roomEls.current[card.id] = el; }}
          className={'duo-room-card' + (landed === card.id ? (card.by === 'ta' ? ' duo-land-ta' : ' duo-land-user') : '')}
          style={{ left, top, width: w, visibility: inspect?.id === card.id ? 'hidden' : undefined }}
          onClick={() => tapCard(card)}
          role="button"
          aria-label={card.faceUp ? card.name : '背面朝上的牌'}
        >
          {card.faceUp
            ? <span className="tarot-flip-in">{renderFace(card, w)}</span>
            : <CardBack width={w} ratio={CARD_RATIOS[card.kind]} image={backOf(card.deckId)} />}
          {card.by === 'ta' && <span className="duo-by">{ta.slice(0, 1)}</span>}
        </div>
      ))}

      {/* TA 的气泡 */}
      {bubble && (
        <button
          key={bubble.key}
          className={`duo-bubble duo-bubble-${bubble.kind}`}
          style={{ left: bubbleAnchorX, bottom: frame.h - bubbleAnchorY, maxWidth: bubbleMaxW }}
          onClick={() => { if (bubble.kind === 'say' && bubble.text.length > 60) setSheet('say'); }}
        >
          <span className="duo-bubble-text">{bubble.text}</span>
          {bubble.kind === 'say' && bubble.text.length > 60 && <span className="duo-bubble-more">点开看全部</span>}
        </button>
      )}

      {/* 顶部：这一局是什么，点开看这一场的对话 */}
      {session && (
        <button className="duo-status" onClick={() => setSheet('log')}>
          {round ? `第 ${roundNo} 局  ${playShort}  ${MODE_LABEL[round.mode]}` : '占卜中'}
          <span className="duo-status-log">对话</span>
        </button>
      )}

      {/* 我抽牌的扇形 */}
      {fanRefDeck && round && view === 'room' && (
        <div className="duo-fanpanel">
          {round.decks.length > 1 && (
            <div className="duo-fan-decks">
              {round.decks.map((d) => {
                const left = remainingOf(round, d).length;
                return (
                  <button
                    key={d.deckId}
                    className={d.deckId === fanDeckId ? 'fd-deck fd-deck-on' : 'fd-deck'}
                    onClick={() => left > 0 && setFanDeckId(d.deckId)}
                    disabled={left === 0}
                  >
                    <span className="fd-deck-back"><CardBack width={18} ratio={CARD_RATIOS[d.kind]} image={backOf(d.deckId)} /></span>
                    <span className="fd-deck-text">
                      <span className="fd-deck-name">{deckNameOfRef(d)}</span>
                      <span className="fd-deck-left">{left > 0 ? `剩 ${left}` : '抽完了'}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <div
            className="fd-fan"
            ref={fanRef}
            style={{ height: fanCardH + FAN_LIFT + 10 }}
            onPointerDown={(e: React.PointerEvent<HTMLDivElement>) => {
              if (e.button !== undefined && e.button !== 0) return;
              try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
              scrub.current = { pointerId: e.pointerId };
              setHoverIdx(fanIndexAt(e.clientX, e.clientY));
            }}
            onPointerMove={(e: React.PointerEvent<HTMLDivElement>) => {
              if (!scrub.current || scrub.current.pointerId !== e.pointerId) return;
              const idx = fanIndexAt(e.clientX, e.clientY);
              setHoverIdx((p) => (p === idx ? p : idx));
            }}
            onPointerUp={(e: React.PointerEvent<HTMLDivElement>) => {
              if (!scrub.current || scrub.current.pointerId !== e.pointerId) return;
              scrub.current = null;
              const idx = fanIndexAt(e.clientX, e.clientY);
              setHoverIdx(null);
              if (idx !== null && fanKeys[idx]) userDraw(fanKeys[idx]);
            }}
            onPointerCancel={() => { scrub.current = null; setHoverIdx(null); }}
          >
            {fanKeys.map((key, i) => {
              const angle = fanCount > 1 ? -fanAngle / 2 + (fanAngle / (fanCount - 1)) * i : 0;
              const hot = hoverIdx === i;
              return (
                <div
                  key={key}
                  className={hot ? 'fd-fan-card fd-fan-card-hot' : 'fd-fan-card'}
                  style={{ transform: `rotate(${angle}deg)${hot ? ` translateY(-${FAN_LIFT}px)` : ''}`, transformOrigin: `50% ${FAN_PIVOT}px`, zIndex: hot ? 500 : i }}
                >
                  <CardBack width={FAN_CARD_W} ratio={fanRatio} image={backOf(fanRefDeck.deckId)} />
                </div>
              );
            })}
          </div>
          <div className="fd-draw-actions">
            <span className="fd-draw-name">{hoverIdx !== null ? '松手抽出这张' : `${deckNameOfRef(fanRefDeck)}：按住左右滑动挑牌`}</span>
            <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={() => setFanDeckId(null)}>收起</button>
          </div>
        </div>
      )}

      {/* 铺开看 */}
      {view === 'spread' && round && (
        <div className="duo-spread" style={{ top: Math.max(frame.h * 0.4, 170), bottom: BOTTOM_BAR_H }}>
          <div className="duo-spread-head">
            <span>按住拖动、叠放，点一下翻开，翻开的牌快速点两下拿起来</span>
            <button className="tarot-chip tarot-chip-sm" onClick={() => setView('room')}>收回</button>
          </div>
          <div className="duo-spread-scroll" ref={spreadScrollRef}>
            <div
              className="duo-spread-table"
              ref={spreadTableRef}
              style={{ height: Math.max(260, ...round.cards.map((c) => (c.x >= 0 ? c.y : 0) + SPREAD_CARD_H + 120), dragPos ? dragPos.y + SPREAD_CARD_H + 120 : 0) }}
            >
              {round.cards.filter((c) => c.x >= 0).map((card) => {
                const w = spreadCardW(card.kind);
                const pos = dragPos && dragPos.id === card.id ? dragPos : card;
                return (
                  <div
                    key={card.id}
                    ref={(el: HTMLDivElement | null) => { spreadEls.current[card.id] = el; }}
                    className={'fd-card' + (dragPos?.id === card.id ? ' fd-card-dragging' : '')}
                    style={{ left: pos.x * spreadW, top: pos.y, zIndex: card.z, width: w, height: SPREAD_CARD_H, visibility: inspect?.id === card.id ? 'hidden' : undefined }}
                    onPointerDown={(e: React.PointerEvent<HTMLDivElement>) => onSpreadDown(e, card)}
                    onPointerMove={onSpreadMove}
                    onPointerUp={(e: React.PointerEvent<HTMLDivElement>) => onSpreadUp(e, false)}
                    onPointerCancel={(e: React.PointerEvent<HTMLDivElement>) => onSpreadUp(e, true)}
                    role="button"
                    aria-label={card.faceUp ? card.name : '背面朝上的牌'}
                  >
                    {card.faceUp
                      ? <span className="tarot-flip-in">{renderFace(card, w)}</span>
                      : <CardBack width={w} ratio={CARD_RATIOS[card.kind]} image={backOf(card.deckId)} />}
                    <span className="fd-card-tag">{card.by === 'ta' ? ta.slice(0, 1) : '我'}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* 底部 */}
      {session && (
        <div className="duo-bottom">
          <div className="duo-bottom-row">
            <span className="duo-hint">{bar.hint}</span>
            <div className="duo-actions">{bar.actions}</div>
          </div>
          <div className="duo-bottom-row">
            <button className="duo-say-pill" onClick={() => setPanel('chat')} disabled={!!busy}>
              对 {ta} 说…
            </button>
            {unreplied > 0 && (
              <button className="tarot-chip tarot-chip-sm" onClick={runChat} disabled={!!busy}>让 {ta} 说</button>
            )}
            {round && round.cards.length > 0 && (
              view === 'room'
                ? <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={openSpread} disabled={drawingNow}>铺开看</button>
                : <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={() => setView('room')}>收回</button>
            )}
          </div>
        </div>
      )}

      {/* 打字框：需要时才弹出来 */}
      {panel && (
        <div className="duo-mask duo-mask-clear" onClick={() => setPanel(null)}>
          <div className="duo-panel" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            {panel === 'chat' && (
              <>
                <textarea
                  className="duo-input"
                  rows={2}
                  autoFocus
                  value={chatDraft}
                  placeholder={`对 ${ta} 说点什么（发出去先不回，点「让 ${ta} 说」才回）`}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setChatDraft(e.target.value)}
                />
                <div className="duo-panel-actions">
                  <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={() => setPanel(null)}>收起</button>
                  <div style={{ flex: 1 }} />
                  <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={sendChat} disabled={!chatDraft.trim()}>发送</button>
                  <button className="tarot-chip tarot-chip-sm" onClick={runChat} disabled={!!busy || (!chatDraft.trim() && unreplied === 0)}>让 {ta} 说</button>
                </div>
              </>
            )}
            {panel === 'reading' && (
              <>
                <p className="duo-panel-title">你从牌里读到了什么？猜猜 {ta} 心里的答案</p>
                <textarea
                  className="duo-input"
                  rows={4}
                  autoFocus
                  value={readingDraft}
                  placeholder="写下你的解读"
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReadingDraft(e.target.value)}
                />
                <div className="duo-panel-actions">
                  <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={() => setPanel(null)}>收起</button>
                  <div style={{ flex: 1 }} />
                  <button className="tarot-chip tarot-chip-sm" onClick={runJudge} disabled={!readingDraft.trim() || !!busy}>交给 {ta}</button>
                </div>
              </>
            )}
            {panel === 'feedback' && (
              <>
                <p className="duo-panel-title">{ta} 解得准吗？</p>
                <div className="duo-rating">
                  {(['hit', 'half', 'miss'] as DuoRating[]).map((k) => (
                    <button
                      key={k}
                      className={feedback.rating === k ? 'duo-rate duo-rate-on' : 'duo-rate'}
                      onClick={() => setFeedback((f) => ({ ...f, rating: k }))}
                    >
                      {RATING_LABEL[k]}
                    </button>
                  ))}
                </div>
                <textarea
                  className="duo-input"
                  rows={3}
                  value={feedback.text}
                  placeholder="说说哪里准、哪里不准"
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setFeedback((f) => ({ ...f, text: e.target.value }))}
                />
                <div className="duo-panel-actions">
                  <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={() => setPanel(null)}>收起</button>
                  <div style={{ flex: 1 }} />
                  <button className="tarot-chip tarot-chip-sm" onClick={runReact} disabled={!feedback.rating || !!busy}>告诉 {ta}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── 想问点什么？ ── */}
      {sheet === 'ask' && (
        <div className="duo-mask" onClick={() => setSheet(null)}>
          <div className="duo-sheet" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <button className="duo-sheet-close" onClick={() => setSheet(null)} aria-label="关闭">×</button>
            <div className="duo-seg">
              {(['ta_draws', 'user_draws'] as DuoPlay[]).map((p) => (
                <button key={p} className={askForm.play === p ? 'duo-seg-on' : ''} onClick={() => setAskForm((f) => ({ ...f, play: p }))}>
                  {p === 'ta_draws' ? `${ta} 抽，我来解` : `我抽，${ta} 来解`}
                </button>
              ))}
            </div>
            <div className="duo-seg">
              {(['basic', 'advanced'] as DuoMode[]).map((m) => (
                <button key={m} className={askForm.mode === m ? 'duo-seg-on' : ''} onClick={() => setAskForm((f) => ({ ...f, mode: m }))}>
                  {MODE_LABEL[m]}
                </button>
              ))}
            </div>
            <p className="duo-rule">
              {askForm.play === 'ta_draws'
                ? askForm.mode === 'basic'
                  ? `${ta} 会把问题说出来，翻开的牌显示牌意。猜中了升级慢一点。`
                  : `${ta} 不说问题，也不显示牌意，想查就翻桌上的书。猜中了升级快。`
                : askForm.mode === 'basic'
                  ? `${ta} 看得到你的问题。`
                  : `${ta} 看不到你的问题，只能从牌里猜，最后才揭晓。`}
            </p>
            <h3 className="duo-sheet-title">想问点什么？</h3>
            <textarea
              className="duo-input"
              rows={2}
              value={askForm.text}
              placeholder={askForm.play === 'ta_draws' ? `想让 ${ta} 问哪方面，比如最近的工作、我们俩` : '写下你的问题'}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setAskForm((f) => ({ ...f, text: e.target.value }))}
            />
            <p className="duo-small">{askForm.play === 'ta_draws' ? `留空就让 ${ta} 随机问` : '留空就当你在心里默念'}</p>
            <button className="tarot-chip duo-primary" onClick={startRound}>开始占卜</button>
          </div>
        </div>
      )}

      {/* ── 选牌组和张数 ── */}
      {sheet === 'decks' && round && round.stage === 'deck' && (
        <div className="duo-mask">
          <div className="duo-sheet duo-sheet-tall" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <h3 className="duo-sheet-title">用哪几副牌</h3>
            <p className="duo-small">先勾的那副用来抽这一局，其余的留着补牌。每类最多 {MAX_PER_KIND} 副。</p>
            {deckForm.warn && <p className="fd-picker-warn">{deckForm.warn}</p>}
            <div className="duo-deck-list">
              {DECK_KINDS.map(({ kind, label }) => {
                const opts: { deckId: string; name: string; count: number; back?: string }[] = [];
                const builtin = BUILTIN_DECK_ID[kind];
                if (builtin) opts.push({ deckId: builtin, name: deckNameOf(workshop, kind, builtin) ?? '', count: buildDeckPool(workshop, kind, builtin).length });
                workshop.decks.filter((d) => d.kind === kind).forEach((d) => {
                  opts.push({ deckId: d.id, name: d.name, count: buildDeckPool(workshop, kind, d.id).length, back: d.back });
                });
                if (!opts.length) return null;
                return (
                  <div key={kind} className="fd-picker-group">
                    <div className="fd-picker-head"><span>{label}</span></div>
                    <div className="fd-picker-list">
                      {opts.map((o) => {
                        const idx = deckForm.decks.findIndex((d) => d.deckId === o.deckId);
                        const on = idx >= 0;
                        return (
                          <button
                            key={o.deckId}
                            className={on ? 'fd-option fd-option-on' : 'fd-option'}
                            onClick={() => setDeckForm((f) => {
                              if (on) return { ...f, warn: '', decks: f.decks.filter((d) => d.deckId !== o.deckId) };
                              if (o.count === 0) return { ...f, warn: '这副牌还没有牌，先去工坊上传' };
                              if (f.decks.filter((d) => d.kind === kind).length >= MAX_PER_KIND) return { ...f, warn: `每类最多 ${MAX_PER_KIND} 副` };
                              return { ...f, warn: '', decks: [...f.decks, { deckId: o.deckId, kind }] };
                            })}
                          >
                            <CardBack width={28} ratio={CARD_RATIOS[kind]} image={o.back} />
                            <span className="fd-option-text">
                              <span className="fd-option-name">{o.name}</span>
                              <span className="fd-option-count">{o.count} 张{idx === 0 ? '，先抽这副' : ''}</span>
                            </span>
                            <span className={on ? 'fd-check fd-check-on' : 'fd-check'}>{on ? idx + 1 : ''}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="duo-count">
              <span>{round.play === 'ta_draws' ? `${ta} 抽几张` : '我抽几张'}</span>
              {COUNT_OPTIONS.map((n) => {
                const mainCount = deckForm.decks[0] ? poolOf(deckForm.decks[0]).length : 0;
                return (
                  <button
                    key={n}
                    className={deckForm.count === n ? 'duo-rate duo-rate-on' : 'duo-rate'}
                    disabled={mainCount > 0 && mainCount < n}
                    onClick={() => setDeckForm((f) => ({ ...f, count: n, warn: '' }))}
                  >
                    {n}
                  </button>
                );
              })}
            </div>
            <div className="duo-panel-actions">
              <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={() => setSheet(null)}>等一下</button>
              <div style={{ flex: 1 }} />
              <button className="tarot-chip" onClick={confirmDecks} disabled={!deckForm.decks.length}>洗牌，开始</button>
            </div>
          </div>
        </div>
      )}

      {/* ── 补牌：选从哪副补 ── */}
      {sheet === 'extra' && round && (
        <div className="duo-mask" onClick={() => setSheet(null)}>
          <div className="duo-sheet" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <h3 className="duo-sheet-title">{round.play === 'ta_draws' ? `请 ${ta} 从哪副补` : '从哪副补'}</h3>
            <div className="fd-picker-list">
              {round.decks.map((d) => {
                const left = remainingOf(round, d).length;
                return (
                  <button
                    key={d.deckId}
                    className="fd-option"
                    disabled={left === 0}
                    onClick={() => {
                      setSheet(null);
                      if (round.play === 'ta_draws') runExtraTa(d);
                      else setFanDeckId(d.deckId);
                    }}
                  >
                    <CardBack width={28} ratio={CARD_RATIOS[d.kind]} image={backOf(d.deckId)} />
                    <span className="fd-option-text">
                      <span className="fd-option-name">{deckNameOfRef(d)}</span>
                      <span className="fd-option-count">{left > 0 ? `剩 ${left} 张` : '抽完了'}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── 猫爪：暂时离开 / 结束占卜 ── */}
      {sheet === 'paw' && (
        <div className="duo-mask" onClick={() => { setSheet(null); setConfirmEnd(false); }}>
          <div className="duo-sheet" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <h3 className="duo-sheet-title">要离开小屋吗？</h3>
            <button className="duo-choice" onClick={() => { flushDuoSession(charId); setSheet(null); onLeave(); }}>
              <b>暂时离开</b>
              <span>桌上的牌和这一场的对话都留着，回来接着玩</span>
            </button>
            <button className={confirmEnd ? 'duo-choice duo-choice-danger' : 'duo-choice'} onClick={() => (confirmEnd ? endSession() : setConfirmEnd(true))}>
              <b>{confirmEnd ? '再点一次，结束占卜' : '结束占卜'}</b>
              <span>这一场收进占卜记录，桌面和对话清空{inRound ? '。这一局还没玩完，会按没玩完记下' : ''}</span>
            </button>
            <button className="tarot-chip tarot-chip-ghost" onClick={() => { setSheet(null); setConfirmEnd(false); }}>再坐一会儿</button>
          </div>
        </div>
      )}

      {/* ── 这一场的对话 ── */}
      {sheet === 'log' && session && (
        <div className="duo-mask" onClick={() => setSheet(null)}>
          <div className="duo-sheet duo-sheet-tall" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <h3 className="duo-sheet-title">这一场的对话</h3>
            <div className="duo-log">
              {session.log.length === 0 && <p className="duo-small">还没说话</p>}
              {session.log.map((e) => (
                <div key={e.id} className={`duo-log-item duo-log-${e.from}`}>
                  {e.from !== 'event' && <b>{e.from === 'ta' ? ta : user}</b>}
                  <p>{e.text}</p>
                </div>
              ))}
            </div>
            <button className="tarot-chip tarot-chip-ghost" onClick={() => setSheet(null)}>合上</button>
          </div>
        </div>
      )}

      {/* ── 气泡全文 ── */}
      {sheet === 'say' && bubble && (
        <div className="duo-mask" onClick={() => setSheet(null)}>
          <div className="duo-sheet" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <h3 className="duo-sheet-title">{ta}</h3>
            <p className="duo-say-full">{bubble.text}</p>
            <button className="tarot-chip tarot-chip-ghost" onClick={() => setSheet(null)}>好</button>
          </div>
        </div>
      )}

      {/* ── 拿到眼前看 ── */}
      {inspect && inspectCard && (
        <div className={`fd-inspect fd-inspect-${inspect.stage} duo-inspect`} onClick={closeInspect}>
          <div className="fd-inspect-body">
            <div
              className="fd-inspect-card"
              ref={bigRef}
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
              style={{
                transform: inspect.t,
                opacity: inspect.stage === 'measure' ? 0 : 1,
                transition: inspect.stage === 'open' || inspect.stage === 'leave' ? 'transform 0.42s cubic-bezier(.2,.8,.25,1)' : 'none',
              }}
            >
              <span className="fd-magic" aria-hidden="true" />
              <span className="fd-sparkles" aria-hidden="true"><i /><i /><i /><i /><i /><i /></span>
              <span className="fd-inspect-face">{renderFace(inspectCard, INSPECT_W)}</span>
            </div>
            <div className="fd-inspect-info" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
              <p className="fd-sheet-deck">{inspectCard.deckName}，{inspectCard.by === 'ta' ? `${ta} 抽的` : '我抽的'}</p>
              <h3 className="ws-sheet-title fd-sheet-name">
                {inspectCard.name}
                {inspectCard.kind === 'tarot' && <span className="ws-badge">{inspectCard.reversed ? '逆位' : '正位'}</span>}
              </h3>
              {showMeaning ? (
                <div className="fd-sheet-meaning"><p>{meaningText(inspectCard)}</p></div>
              ) : (
                <p className="fd-muted" style={{ textAlign: 'center' }}>
                  进阶模式不显示牌意，
                  <button className="tarot-link" onClick={() => { setInspect(null); onOpenBook(inspectCard.kind); }}>去翻牌意之书</button>
                </p>
              )}
              <button className="tarot-chip fd-put-down" onClick={closeInspect}>放下</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const DUO_CSS = `
.duo-root { position: absolute; inset: 0; z-index: 12; pointer-events: none; }
.duo-root button, .duo-root textarea, .duo-room-card, .duo-spread, .duo-fanpanel, .duo-mask, .duo-bottom, .fd-inspect { pointer-events: auto; }

.duo-tafan, .duo-tafan-card { pointer-events: none; }
.duo-tafan-card { position: absolute; line-height: 0; transition: transform 0.2s ease, filter 0.2s ease, opacity 0.25s ease; transform-origin: 50% 100%; }
.duo-tafan-hot { filter: brightness(1.35) drop-shadow(0 0 8px rgba(240,205,130,0.8)); }
.duo-tafan-up { opacity: 0.15; }

.duo-room-card { position: absolute; line-height: 0; cursor: pointer; filter: drop-shadow(0 4px 6px rgba(0,0,0,0.45)); }
.duo-land-ta { animation: duoLandTa 0.55s cubic-bezier(.2,.8,.3,1) both; }
.duo-land-user { animation: duoLandUser 0.5s cubic-bezier(.2,.8,.3,1) both; }
@keyframes duoLandTa { from { transform: translateY(-46px) scale(0.6); opacity: 0; } }
@keyframes duoLandUser { from { transform: translateY(60px) scale(0.85); opacity: 0; } }
.duo-by {
  position: absolute; right: -4px; top: -4px; min-width: 14px; height: 14px; padding: 0 2px; box-sizing: border-box;
  border-radius: 7px; background: #2a1840; border: 1px solid rgba(217,185,120,0.7);
  color: #d9b978; font-size: 8px; line-height: 12px; text-align: center; pointer-events: none;
}

.duo-bubble {
  position: absolute; transform: translateX(-50%); z-index: 3;
  border: 1px solid rgba(217,185,120,0.55); border-radius: 16px;
  background: rgba(24,13,38,0.9); color: #efe3c8; font-family: inherit;
  padding: 9px 14px; text-align: left; cursor: default;
  box-shadow: 0 8px 22px rgba(0,0,0,0.45);
  animation: duoBubbleIn 0.25s ease both;
}
.duo-bubble::after {
  content: ''; position: absolute; left: 50%; bottom: -6px; width: 10px; height: 10px;
  background: rgba(24,13,38,0.9); border-right: 1px solid rgba(217,185,120,0.55); border-bottom: 1px solid rgba(217,185,120,0.55);
  transform: translateX(-50%) rotate(45deg);
}
.duo-bubble-text {
  display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden;
  font-size: 13.5px; line-height: 1.7; white-space: pre-wrap;
}
.duo-bubble-more { display: block; margin-top: 4px; font-size: 10px; color: #d9b978; }
.duo-bubble-think .duo-bubble-text { letter-spacing: 0.3em; animation: duoThink 1.2s ease-in-out infinite; }
.duo-bubble-poke { padding: 7px 12px; }
@keyframes duoBubbleIn { from { opacity: 0; transform: translateX(-50%) translateY(6px) scale(0.96); } }
@keyframes duoThink { 50% { opacity: 0.4; } }

.duo-status {
  position: absolute; left: 50%; top: calc(14px + var(--safe-top, 0px)); transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px; max-width: calc(100% - 130px);
  border: 1px solid rgba(217,185,120,0.4); border-radius: 999px; background: rgba(12,6,22,0.72);
  color: rgba(239,227,200,0.85); font: inherit; font-size: 11px; padding: 6px 6px 6px 12px; cursor: pointer;
  white-space: nowrap; overflow: hidden;
}
.duo-status-log { color: #1c1030; background: #d9b978; border-radius: 999px; padding: 2px 8px; font-size: 10px; flex-shrink: 0; }

.duo-bottom {
  position: absolute; left: 0; right: 0; bottom: 0; height: ${BOTTOM_BAR_H}px; box-sizing: border-box;
  padding: 8px 12px calc(8px + var(--safe-bottom, 0px));
  display: flex; flex-direction: column; justify-content: flex-end; gap: 7px;
  background: linear-gradient(180deg, rgba(12,6,22,0) 0%, rgba(12,6,22,0.82) 32%, rgba(12,6,22,0.94) 100%);
}
.duo-bottom-row { display: flex; align-items: center; gap: 8px; min-height: 30px; }
.duo-hint { flex: 1; min-width: 0; font-size: 12px; line-height: 1.5; color: rgba(239,227,200,0.78); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.duo-actions { display: flex; gap: 6px; flex-shrink: 0; }
.duo-say-pill {
  flex: 1; min-width: 0; text-align: left; border: 1px solid rgba(239,227,200,0.22); border-radius: 999px;
  background: rgba(239,227,200,0.07); color: rgba(239,227,200,0.55); font: inherit; font-size: 13px; padding: 7px 14px; cursor: text;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.duo-fanpanel {
  position: absolute; left: 0; right: 0; bottom: ${BOTTOM_BAR_H}px; padding: 8px 0 6px;
  background: linear-gradient(180deg, rgba(12,6,22,0) 0%, rgba(12,6,22,0.75) 26%, rgba(12,6,22,0.9) 100%);
}
.duo-fan-decks { display: flex; gap: 6px; padding: 0 12px 6px; overflow-x: auto; scrollbar-width: none; }
.duo-fan-decks::-webkit-scrollbar { display: none; }

.duo-spread {
  position: absolute; left: 0; right: 0; display: flex; flex-direction: column;
  background: linear-gradient(180deg, rgba(38,18,58,0.94) 0%, rgba(26,12,40,0.97) 100%);
  border-top: 1px solid rgba(217,185,120,0.4); box-shadow: 0 -12px 30px rgba(0,0,0,0.45);
  animation: duoRise 0.3s cubic-bezier(.2,.8,.3,1) both;
}
@keyframes duoRise { from { transform: translateY(40px); opacity: 0; } }
.duo-spread-head { display: flex; align-items: center; gap: 10px; padding: 8px 12px; font-size: 11px; color: rgba(239,227,200,0.55); }
.duo-spread-head span { flex: 1; }
.duo-spread-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; position: relative; isolation: isolate; -webkit-overflow-scrolling: touch; }
.duo-spread-table { position: relative; width: 100%; }

.duo-mask { position: absolute; inset: 0; z-index: 20; background: rgba(8,4,16,0.6); display: flex; align-items: flex-end; justify-content: center; }
.duo-mask-clear { background: rgba(8,4,16,0.25); }
.duo-sheet {
  position: relative; width: 100%; max-width: 420px; box-sizing: border-box; max-height: 86%;
  display: flex; flex-direction: column; gap: 10px; overflow-y: auto;
  background: #231536; border: 1px solid rgba(217,185,120,0.5); border-bottom: none;
  border-radius: 20px 20px 0 0; padding: 18px 18px calc(18px + var(--safe-bottom, 0px));
  color: #efe3c8; animation: duoRise 0.25s ease both;
}
.duo-sheet-tall { max-height: 90%; }
.duo-sheet-title { margin: 4px 0 0; font-size: 17px; font-weight: 500; letter-spacing: 0.1em; text-align: center; }
.duo-sheet-close {
  position: absolute; right: 12px; top: 10px; width: 30px; height: 30px; border: none; background: transparent;
  color: rgba(239,227,200,0.6); font-size: 22px; cursor: pointer;
}
.duo-seg { display: flex; gap: 6px; background: rgba(239,227,200,0.06); border-radius: 12px; padding: 4px; margin-top: 4px; }
.duo-seg:first-of-type { margin-top: 22px; }
.duo-seg button {
  flex: 1; border: none; border-radius: 9px; background: transparent; color: rgba(239,227,200,0.6);
  font: inherit; font-size: 13px; padding: 8px 6px; cursor: pointer;
}
.duo-seg .duo-seg-on { background: rgba(217,185,120,0.2); color: #f3dca4; box-shadow: inset 0 0 0 1px rgba(217,185,120,0.55); }
.duo-rule { margin: 0; font-size: 12px; line-height: 1.7; color: rgba(239,227,200,0.6); text-align: center; }
.duo-small { margin: 0; font-size: 11px; line-height: 1.6; color: rgba(239,227,200,0.5); text-align: center; }
.duo-input {
  width: 100%; box-sizing: border-box; resize: none; border-radius: 12px;
  border: 1px solid rgba(217,185,120,0.4); background: rgba(12,6,22,0.6); color: #efe3c8;
  font: inherit; font-size: 14px; line-height: 1.6; padding: 10px 12px; outline: none; user-select: text; -webkit-user-select: text;
}
.duo-input:focus { border-color: #d9b978; }
.duo-primary { align-self: center; padding: 10px 40px; font-size: 15px; letter-spacing: 0.2em; margin-top: 2px; }
.duo-panel {
  width: 100%; max-width: 480px; box-sizing: border-box; background: #231536;
  border-top: 1px solid rgba(217,185,120,0.5); border-radius: 16px 16px 0 0;
  padding: 12px 12px calc(12px + var(--safe-bottom, 0px)); display: flex; flex-direction: column; gap: 8px;
  animation: duoRise 0.2s ease both;
}
.duo-panel-title { margin: 0; font-size: 13px; color: rgba(239,227,200,0.75); text-align: center; }
.duo-panel-actions { display: flex; align-items: center; gap: 8px; }
.duo-rating, .duo-count { display: flex; align-items: center; justify-content: center; gap: 8px; }
.duo-count span { font-size: 12px; color: rgba(239,227,200,0.7); margin-right: 4px; }
.duo-rate {
  min-width: 52px; border: 1px solid rgba(217,185,120,0.4); border-radius: 999px; background: rgba(12,6,22,0.5);
  color: #efe3c8; font: inherit; font-size: 13px; padding: 6px 14px; cursor: pointer;
}
.duo-rate:disabled { opacity: 0.35; cursor: default; }
.duo-rate-on { background: #d9b978; border-color: #d9b978; color: #1c1030; }
.duo-deck-list { display: flex; flex-direction: column; gap: 14px; }
.duo-choice {
  display: flex; flex-direction: column; gap: 3px; text-align: left; border-radius: 14px;
  border: 1px solid rgba(217,185,120,0.4); background: rgba(12,6,22,0.45); color: #efe3c8;
  font: inherit; padding: 12px 14px; cursor: pointer;
}
.duo-choice b { font-weight: 500; font-size: 15px; color: #f3dca4; }
.duo-choice span { font-size: 12px; line-height: 1.6; color: rgba(239,227,200,0.6); }
.duo-choice-danger { border-color: #e39a9a; }
.duo-choice-danger b { color: #f0b0b0; }
.duo-log { display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
.duo-log-item b { display: block; font-size: 11px; font-weight: 400; color: #d9b978; margin-bottom: 2px; }
.duo-log-item p { margin: 0; font-size: 13px; line-height: 1.7; white-space: pre-wrap; user-select: text; -webkit-user-select: text; }
.duo-log-user { align-self: flex-end; text-align: right; max-width: 86%; }
.duo-log-ta { max-width: 92%; }
.duo-log-event p { font-size: 11px; color: rgba(239,227,200,0.45); text-align: center; }
.duo-say-full { margin: 0; font-size: 14px; line-height: 1.85; white-space: pre-wrap; user-select: text; -webkit-user-select: text; }
.duo-inspect { z-index: 25; }
.duo-intro { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 9px; }
.duo-intro li { font-size: 13px; line-height: 1.7; color: rgba(239,227,200,0.8); }
.duo-intro b { color: #f3dca4; font-weight: 500; margin-right: 8px; }
.duo-field { display: flex; flex-direction: column; gap: 4px; }
.duo-field span { font-size: 12px; color: rgba(239,227,200,0.65); }

@media (prefers-reduced-motion: reduce) {
  .duo-land-ta, .duo-land-user, .duo-bubble, .duo-spread, .duo-sheet, .duo-panel, .duo-bubble-think .duo-bubble-text { animation: none !important; }
}
`;

export default DuoTable;
