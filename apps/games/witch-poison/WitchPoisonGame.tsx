// ═══════════════════════════════════════════════════════════════════════════
// 🍬 女巫的毒药 · 页面
//   两人各偷偷选 1 颗糖当"毒药"，轮流吃，先中毒的人输。
//   台词优先实时调 AI（贴角色人设），没配 API / 出错时用 content.ts 里的兜底台词。
//   游戏内对话记录只存进聊天记录给记忆宫殿收编（source: 'witch_poison'），
//   不会出现在外面的消息聊天框里（apps/Chat.tsx 的 HIDDEN_FROM_MAIN_CHAT_SOURCES 里已加）。
// ═══════════════════════════════════════════════════════════════════════════

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useOS } from '../../../context/OSContext';
import { callGameAI } from '../shared/ai';
import { createChatMirror } from '../shared/chatMirror';
import { readNames, readPersona } from '../shared/profile';
import {
  ENDING_FALLBACK, FALLBACK_POISON_CHOICE_NOTES, FALLBACK_POISON_LINES, FALLBACK_SAFE_LINES, NARRATOR_EAT,
  NARRATOR_RESULT_POISON, NARRATOR_RESULT_SAFE, NARRATOR_START_LINES, POISON_PICK_USER_PROMPT, TOTAL_CANDIES,
  buildEndingPrompt, buildPoisonPickSystem, buildSystemPrompt, buildTurnPrompt,
} from './content';

export interface WitchPoisonGameProps { onBack: () => void }

type Phase = 'intro' | 'deciding' | 'pickPoison' | 'countdown' | 'playing' | 'result';
type Who = 'user' | 'char';

interface Bubble {
  id: number;
  from: 'narrator' | 'user' | 'char';
  text: string;
}

const GAME_CSS = `
@keyframes wp-twinkle { 0%, 100% { opacity: .25; transform: scale(.8); } 50% { opacity: 1; transform: scale(1.15); } }
.wp-star { animation: wp-twinkle 3.2s ease-in-out infinite; }
@keyframes wp-pop-in { 0% { opacity: 0; transform: translateY(10px) scale(.9); } 100% { opacity: 1; transform: none; } }
.wp-pop-in { animation: wp-pop-in .28s ease-out both; }
@keyframes wp-vanish { 0% { opacity: 1; transform: scale(1) rotate(0deg); } 100% { opacity: 0; transform: scale(.3) rotate(20deg); } }
.wp-vanish { animation: wp-vanish .45s ease-in forwards; }
@keyframes wp-glow-pulse { 0% { box-shadow: 0 0 0 0 rgba(216,180,254,.65); } 70% { box-shadow: 0 0 0 14px rgba(216,180,254,0); } 100% { box-shadow: 0 0 0 0 rgba(216,180,254,0); } }
.wp-glow { animation: wp-glow-pulse 1.1s ease-out 2; }
@keyframes wp-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
.wp-float { animation: wp-float 4s ease-in-out infinite; }
@keyframes wp-count { 0% { opacity: 0; transform: scale(.4); } 25% { opacity: 1; transform: scale(1.1); } 40% { transform: scale(1); } 80% { opacity: 1; } 100% { opacity: 0; transform: scale(.8); } }
.wp-count { animation: wp-count 1s ease-out forwards; }
`;

/** 背景里飘的小星星，位置固定生成一次就好，不用每次渲染都换 */
function useStars(n: number): Star[] {
  return useMemo(() => Array.from({ length: n }, (_, i) => ({
    id: i,
    left: `${(i * 37 + 5) % 100}%`,
    top: `${(i * 53 + 8) % 100}%`,
    size: 3 + ((i * 7) % 4),
    delay: `${(i % 10) * 0.32}s`,
  })), [n]);
}

/** 从一个兜底文案数组里挑一句，尽量不和上一句重复 */
function pickFallback(pool: string[], lastRef: React.MutableRefObject<string | null>): string {
  if (pool.length <= 1) return pool[0] || '……';
  let pick = pool[Math.floor(Math.random() * pool.length)];
  let guard = 0;
  while (pick === lastRef.current && guard++ < 6) pick = pool[Math.floor(Math.random() * pool.length)];
  lastRef.current = pick;
  return pick;
}

interface Star { id: number; left: string; top: string; size: number; delay: string }

// ── 下面几个都是纯展示组件，放在组件外面，避免每次父组件 re-render 都被整个重新挂载
//    （挂在里面会导致糖果格子/对话气泡每次状态更新都重新走一遍入场动画、还会跳滚动条）。

const Sky: React.FC<{ stars: Star[]; children: React.ReactNode }> = ({ stars, children }) => (
  <div className="absolute inset-0 overflow-hidden" style={{ background: 'linear-gradient(160deg,#efe3ff 0%,#fbe4f0 55%,#f6d9ec 100%)' }}>
    {stars.map(s => (
      <span key={s.id} className="wp-star absolute rounded-full bg-white/90" style={{ left: s.left, top: s.top, width: s.size, height: s.size, animationDelay: s.delay, boxShadow: '0 0 6px rgba(255,255,255,.9)' }} />
    ))}
    <div className="wp-float absolute text-[34px] opacity-90" style={{ right: '6%', top: '5%' }}>🌙</div>
    {children}
  </div>
);

const BubbleLog: React.FC<{ bubbles: Bubble[]; charAvatar?: string | null; logEndRef: React.RefObject<HTMLDivElement | null> }> = ({ bubbles, charAvatar, logEndRef }) => (
  <div className="rounded-[22px] bg-[rgba(250,244,255,.72)] backdrop-blur-2xl border border-white/70 shadow-[0_10px_30px_rgba(150,110,190,.18)] px-3 py-2.5 max-h-[30vh] overflow-y-auto space-y-2">
    {bubbles.map(b => {
      if (b.from === 'narrator') return (
        <div key={b.id} className="text-center text-[11px] text-[#8a6fae] px-2 py-1 whitespace-pre-wrap">{b.text}</div>
      );
      if (b.from === 'char') return (
        <div key={b.id} className="wp-pop-in flex items-start gap-2 pr-8">
          {charAvatar
            ? <img src={charAvatar} alt="" className="w-7 h-7 rounded-full object-cover ring-2 ring-[#e6cffb] shrink-0" />
            : <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#d9c6fa] to-[#f4b3c8] shrink-0 flex items-center justify-center text-[12px]">🔮</div>}
          <div className="rounded-[18px] rounded-tl-md bg-white/85 border border-white px-3 py-1.5 text-[12.5px] leading-5 text-[#5c4a72] whitespace-pre-wrap break-words">{b.text}</div>
        </div>
      );
      return (
        <div key={b.id} className="wp-pop-in flex justify-end pl-8">
          <div className="rounded-[18px] rounded-tr-md bg-gradient-to-br from-[#d9c6fa] to-[#f4b3c8] text-white px-3 py-1.5 text-[12.5px] leading-5 whitespace-pre-wrap break-words">{b.text}</div>
        </div>
      );
    })}
    <div ref={logEndRef} />
  </div>
);

const CandyGrid: React.FC<{
  eaten: Set<number>;
  vanishing: Set<number>;
  charPickHint: number | null;
  clickableCheck: (idx: number) => boolean;
  onPick: (idx: number) => void;
}> = ({ eaten, vanishing, charPickHint, clickableCheck, onPick }) => (
  <div className="grid grid-cols-4 gap-2.5 sm:gap-3">
    {Array.from({ length: TOTAL_CANDIES }, (_, i) => i).map(i => {
      const gone = eaten.has(i);
      const isVanishing = vanishing.has(i);
      const isCharHint = charPickHint === i;
      const clickable = clickableCheck(i);
      if (gone && !isVanishing) return <div key={i} className="aspect-square" />;
      return (
        <button
          key={i}
          disabled={!clickable}
          onClick={() => onPick(i)}
          className={[
            'aspect-square rounded-2xl flex items-center justify-center text-[22px] sm:text-[26px]',
            'bg-white/80 border border-white shadow-[0_6px_16px_rgba(170,130,210,.16)] transition-transform',
            clickable ? 'active:scale-90 hover:-translate-y-0.5 cursor-pointer' : 'opacity-90 cursor-default',
            isVanishing ? 'wp-vanish' : '',
            isCharHint ? 'wp-glow ring-2 ring-[#d9b8fb]' : '',
          ].join(' ')}
        >
          🍬
        </button>
      );
    })}
  </div>
);

const WitchPoisonGame: React.FC<WitchPoisonGameProps> = ({ onBack }) => {
  const { activeCharacterId, characters, userProfile, apiConfig } = useOS();
  const charId = activeCharacterId || '';
  const char = characters.find(c => c.id === activeCharacterId) ?? null;
  const names = readNames(userProfile, char);
  const persona = readPersona(char);
  const charAvatar = char?.avatar;

  const [phase, setPhase] = useState<Phase>('intro');
  const [eaten, setEaten] = useState<Set<number>>(new Set());
  const [userPoison, setUserPoison] = useState<number | null>(null);
  const [charPoison, setCharPoison] = useState<number | null>(null);
  const [turn, setTurn] = useState<Who>('user');
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [busy, setBusy] = useState(false);
  const [vanishing, setVanishing] = useState<Set<number>>(new Set());
  const [charPickHint, setCharPickHint] = useState<number | null>(null);
  const [countdownN, setCountdownN] = useState(3);
  const [loser, setLoser] = useState<Who | null>(null);
  const [decidingNote, setDecidingNote] = useState(() => FALLBACK_POISON_CHOICE_NOTES[Math.floor(Math.random() * FALLBACK_POISON_CHOICE_NOTES.length)]);

  const bubbleIdRef = useRef(0);
  const lastSafeLine = useRef<string | null>(null);
  const lastPoisonLine = useRef<string | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const mirrorRef = useRef(createChatMirror(charId, 'witch_poison', true));
  useEffect(() => { mirrorRef.current = createChatMirror(charId, 'witch_poison', true); }, [charId]);

  const stars = useStars(22);

  useEffect(() => { logEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [bubbles.length]);

  const addBubble = (from: Bubble['from'], text: string) => {
    setBubbles(prev => [...prev, { id: ++bubbleIdRef.current, from, text }]);
    const mirror = mirrorRef.current;
    if (from === 'narrator') mirror('system', text);
    else if (from === 'char') mirror('assistant', text);
    else mirror('user', text);
  };

  const remaining = useMemo(
    () => Array.from({ length: TOTAL_CANDIES }, (_, i) => i).filter(i => !eaten.has(i)),
    [eaten],
  );

  // ── 开局：让 char 自己代入人设「决定」毒药藏在哪一颗 ──────────────────────
  //   只在这里问一次 AI，拿到编号后用 setCharPoison 锁死；resolvePick 等其余
  //   所有地方都只读这个 state、再也不会重新调 AI 问这件事——AI 没有回头改答案的入口。
  async function decideCharPoison(): Promise<number> {
    try {
      const reply = await callGameAI({
        api: apiConfig,
        temperature: 1,
        label: names.ta,
        system: buildPoisonPickSystem(persona, names.ta, names.user),
        messages: [{ role: 'user', content: POISON_PICK_USER_PROMPT }],
        meta: { appName: '女巫的毒药', charId: charId || undefined, charName: names.ta, purpose: '女巫的毒药 · 选毒药' },
      });
      const m = (reply || '').match(/\d{1,2}/);
      if (m) {
        const n = parseInt(m[0], 10);
        if (n >= 1 && n <= TOTAL_CANDIES) return n - 1;
      }
    } catch (e) { console.warn('[witch_poison] AI 选毒药失败，改用随机', e); }
    return Math.floor(Math.random() * TOTAL_CANDIES);
  }

  const startGame = async () => {
    setUserPoison(null);
    setEaten(new Set());
    setVanishing(new Set());
    setCharPickHint(null);
    setBusy(false);
    setBubbles([]);
    setLoser(null);
    setTurn('user');
    setPhase('deciding');
    setDecidingNote(FALLBACK_POISON_CHOICE_NOTES[Math.floor(Math.random() * FALLBACK_POISON_CHOICE_NOTES.length)]);
    const secret = await decideCharPoison();
    setCharPoison(secret);
    setPhase('pickPoison');
    addBubble('narrator', NARRATOR_START_LINES.pickPoison);
  };

  const handlePickPoisonTile = (idx: number) => {
    if (phase !== 'pickPoison' || userPoison !== null) return;
    setUserPoison(idx);
    addBubble('narrator', NARRATOR_START_LINES.userPicked);
    setPhase('countdown');
    setCountdownN(3);
  };

  // ── 321 倒数 ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'countdown') return;
    if (countdownN <= 0) {
      setPhase('playing');
      addBubble('narrator', NARRATOR_START_LINES.countdownDone);
      return;
    }
    const t = window.setTimeout(() => setCountdownN(n => n - 1), 750);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, countdownN]);

  // ── 获取角色反应：实时 AI，失败/没配置就用兜底 ──────────────────────────
  async function getCharLine(actorName: string, idx: number, hit: boolean): Promise<string> {
    try {
      const reply = await callGameAI({
        api: apiConfig,
        temperature: 0.95,
        label: names.ta,
        system: buildSystemPrompt(persona, names.ta, names.user),
        messages: [{ role: 'user', content: buildTurnPrompt(actorName, names.ta, idx, hit, remaining.length - 1) }],
        meta: { appName: '女巫的毒药', charId: charId || undefined, charName: names.ta, purpose: '女巫的毒药 · 反应' },
      });
      const t = (reply || '').trim().replace(/^["“'‘]+|["”'’]+$/g, '');
      if (t) return t;
    } catch (e) { console.warn('[witch_poison] AI 反应出错', e); }
    return hit ? pickFallback(FALLBACK_POISON_LINES, lastPoisonLine) : pickFallback(FALLBACK_SAFE_LINES, lastSafeLine);
  }

  async function getEndingLine(loserIsUser: boolean): Promise<string> {
    try {
      const reply = await callGameAI({
        api: apiConfig,
        temperature: 0.95,
        label: names.ta,
        system: buildSystemPrompt(persona, names.ta, names.user),
        messages: [{ role: 'user', content: buildEndingPrompt(loserIsUser ? names.user : names.ta, loserIsUser) }],
        meta: { appName: '女巫的毒药', charId: charId || undefined, charName: names.ta, purpose: '女巫的毒药 · 结局' },
      });
      const t = (reply || '').trim().replace(/^["“'‘]+|["”'’]+$/g, '');
      if (t) return t;
    } catch (e) { console.warn('[witch_poison] AI 结局出错', e); }
    return ENDING_FALLBACK(loserIsUser ? names.user : names.ta)[1];
  }

  // ── 落子：不管是 user 点的还是 char 自动选的，都走这里 ───────────────────
  const resolvePick = async (who: Who, idx: number) => {
    if (busy || eaten.has(idx)) return;
    setBusy(true);
    const actorName = who === 'user' ? names.user : names.ta;
    const hit = idx === userPoison || idx === charPoison;

    addBubble('narrator', NARRATOR_EAT(actorName, idx));
    setVanishing(prev => new Set(prev).add(idx));
    await new Promise(r => setTimeout(r, 420));
    setEaten(prev => new Set(prev).add(idx));
    setVanishing(prev => { const n = new Set(prev); n.delete(idx); return n; });
    setCharPickHint(null);

    const line = await getCharLine(actorName, idx, hit);
    addBubble('narrator', hit ? NARRATOR_RESULT_POISON(actorName) : NARRATOR_RESULT_SAFE);
    addBubble('char', line);

    if (hit) {
      setLoser(who);
      const closing = await getEndingLine(who === 'user');
      addBubble('char', closing);
      setPhase('result');
      setBusy(false);
      return;
    }

    setBusy(false);
    setTurn(who === 'user' ? 'char' : 'user');
  };

  // ── char 轮到自己：随机挑一颗剩下的糖（先给个提示光效，再吃） ─────────────
  useEffect(() => {
    if (phase !== 'playing' || turn !== 'char' || busy) return;
    const pool = remaining;
    if (!pool.length) return;
    const idx = pool[Math.floor(Math.random() * pool.length)];
    const t1 = window.setTimeout(() => setCharPickHint(idx), 550);
    const t2 = window.setTimeout(() => resolvePick('char', idx), 1300);
    return () => { window.clearTimeout(t1); window.clearTimeout(t2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, turn, busy]);

  const candyClickable = (idx: number): boolean => {
    if (phase === 'pickPoison') return userPoison === null;
    if (phase === 'playing') return turn === 'user' && !busy && !eaten.has(idx);
    return false;
  };
  const onCandyPick = (idx: number) => (phase === 'pickPoison' ? handlePickPoisonTile(idx) : resolvePick('user', idx));

  return (
    <div className="absolute inset-0 flex flex-col" style={{ fontFamily: 'inherit' }}>
      <style>{GAME_CSS}</style>
      <Sky stars={stars}>
        {/* 顶栏 */}
        <div className="relative z-10 flex items-center gap-2 px-4 pt-[max(14px,var(--safe-top,0px))] pb-2">
          <button onClick={onBack} aria-label="返回" className="w-9 h-9 rounded-full bg-white/70 backdrop-blur border border-white text-[#8a6fae] active:scale-90">‹</button>
          <div className="text-[15px] font-bold text-[#6b4f8c] flex items-center gap-1">🧙‍♀️ 女巫的毒药</div>
        </div>

        <div className="relative z-10 flex-1 overflow-y-auto px-4 pb-[max(16px,var(--safe-bottom,0px))] flex flex-col gap-3">
          {phase === 'intro' && (
            <div className="flex-1 flex flex-col items-center justify-center text-center gap-4 py-8">
              <div className="text-[52px] wp-float">🍬🔮🕯️</div>
              <div className="text-[19px] font-black text-[#6b4f8c]">女巫的糖果毒药</div>
              <div className="text-[12.5px] text-[#8a6fae] leading-6 max-w-[280px]">
                16 颗糖果，你和{names.ta}各自悄悄藏了一颗毒药。
                轮流吃糖，谁先咬到任意一颗毒药，谁就要接受惩罚。
              </div>
              <button
                onClick={startGame}
                className="mt-2 px-8 py-3 rounded-full bg-gradient-to-br from-[#c9a2f5] to-[#f4a8c8] text-white font-bold text-[14px] shadow-[0_10px_24px_rgba(180,120,220,.35)] active:scale-95"
              >开始游戏</button>
            </div>
          )}

          {phase === 'deciding' && (
            <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 py-8">
              <div className="text-[46px] wp-float">🔮</div>
              <div className="text-[13px] text-[#8a6fae] font-bold">{names.ta} 正在悄悄决定要把毒药藏在哪一颗……</div>
              <div className="text-[11px] text-[#a98bc9]">{decidingNote}</div>
            </div>
          )}

          {phase === 'pickPoison' && (
            <>
              <div className="wp-pop-in mx-auto max-w-[300px] text-center rounded-2xl bg-white/80 backdrop-blur border border-white px-4 py-3 text-[12.5px] text-[#6b4f8c] leading-5">
                悄悄点一颗糖，把它当成你的"毒药"——{names.ta}不会知道是哪一颗哦。
              </div>
              <CandyGrid eaten={eaten} vanishing={vanishing} charPickHint={charPickHint} clickableCheck={candyClickable} onPick={onCandyPick} />
            </>
          )}

          {phase === 'countdown' && (
            <div className="flex-1 flex items-center justify-center">
              <div key={countdownN} className="wp-count text-[72px] font-black text-[#a179df]">
                {countdownN > 0 ? countdownN : '开始'}
              </div>
            </div>
          )}

          {(phase === 'playing' || phase === 'result') && (
            <>
              <div className="text-center text-[12px] text-[#8a6fae] font-bold">
                {phase === 'playing' ? (turn === 'user' ? '轮到你了，选一颗糖吧' : `${names.ta} 正在挑糖……`) : '游戏结束'}
              </div>
              <CandyGrid eaten={eaten} vanishing={vanishing} charPickHint={charPickHint} clickableCheck={candyClickable} onPick={onCandyPick} />
              <BubbleLog bubbles={bubbles} charAvatar={charAvatar} logEndRef={logEndRef} />
            </>
          )}
        </div>

        {phase === 'result' && (
          <div className="absolute inset-0 z-20 bg-[#efe3ff]/70 backdrop-blur-md flex items-center justify-center p-6">
            <div className="wp-pop-in w-full max-w-[300px] rounded-[26px] bg-[rgba(255,250,255,.92)] backdrop-blur-2xl border-2 border-white shadow-[0_16px_40px_rgba(150,100,200,.3)] px-5 py-6 text-center">
              <div className="text-[34px] mb-1">{loser === 'user' ? '🧪' : '🎉'}</div>
              <div className="text-[15px] font-black text-[#6b4f8c] mb-1">
                {loser === 'user' ? `${names.user} 中毒了！` : `${names.ta} 中毒了！`}
              </div>
              <div className="text-[12px] text-[#8a6fae] leading-5 mb-4">
                {ENDING_FALLBACK(loser === 'user' ? names.user : names.ta)[1]}
              </div>
              <div className="flex gap-2">
                <button onClick={startGame} className="flex-1 py-2.5 rounded-full bg-gradient-to-br from-[#c9a2f5] to-[#f4a8c8] text-white text-[13px] font-bold active:scale-95">再来一局</button>
                <button onClick={onBack} className="flex-1 py-2.5 rounded-full bg-white/85 border border-white text-[#8a6fae] text-[13px] font-bold active:scale-95">返回大厅</button>
              </div>
            </div>
          </div>
        )}
      </Sky>
    </div>
  );
};

export default WitchPoisonGame;
