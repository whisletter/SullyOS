import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaretLeft, Gear, PaperPlaneTilt, Lightbulb, Sparkle, ArrowsClockwise, Eye } from '@phosphor-icons/react';
import { useOS } from '../../../context/OSContext';
import { readNames, readPersona } from '../shared/profile';
import { createChatMirror } from '../shared/chatMirror';
import { SOUPS, type Soup, type SoupDifficulty } from './soups';
import {
  RULES, ruleOf, createGame, canAsk, canHint, isOutOfQuestions, preCheckQuestion,
  drawSoup, filterSoups, soupById, scoreTier, makeQaId,
  loadPlayed, savePlayed, loadFilter, saveFilter, loadGame, saveGame,
  loadApiSetting, saveApiSetting, apiFilled, EMPTY_API,
  KEY_HOST_API, KEY_TA_API, SHELL, VERDICT_COLORS, paletteOf, soupKind,
  type GameApiSetting, type GameState, type QaEntry, type RuleLevel, type SoupFilter,
} from './engine';
import { askHost, askTaQuestion, askTaGuess, scoreSubmission, type AiContext } from './ai';

interface Props { onBack: () => void }

type Screen = 'lobby' | 'playing' | 'settings';

const DIFFICULTIES: SoupDifficulty[] = ['简单', '中等', '困难', '抽象'];

/** 聊天流里的一条。系统条用来显示提示、驳回、结算这些非问答内容。 */
interface FlowItem {
  id: string;
  kind: 'qa' | 'system' | 'aside' | 'guess';
  text: string;
  qa?: QaEntry;
  who?: string;
}

/**
 * 海龟汤 · 共猜
 *
 * 视觉：「深夜汤馆」——近黑带棕的暖底 + 琥珀点光，整屏不随汤变。
 * 变的只有汤面那张卡片，按汤的类型换四套配色（日常暖琥珀 / 红汤暗红 /
 * 黄汤紫 / 抽象青），端起碗第一眼就对调性有预期。
 *
 * 节奏上刻意做成**头尾重、中间轻**：
 *   - 汤面卡片做足（这是唯一需要仪式感的地方）；
 *   - 问答流保持朴素（你要来回看几十次，花哨的东西看三次就烦）；
 *   - 结算页再做一次足的（第二个值得停顿的地方）。
 *
 * TA 提问是**手动触发**的：一次点击花两次调用（它想问题 + 主持人判定），
 * 什么时候花由你决定，不自动连发。
 */
const TurtleSoupGame: React.FC<Props> = ({ onBack }) => {
  const { activeCharacterId, characters, userProfile, apiConfig, addToast } = useOS();
  const charId = activeCharacterId || '';
  const char = characters.find(c => c.id === charId) || null;
  const names = readNames(userProfile, char);

  const [screen, setScreen] = useState<Screen>('lobby');
  const [game, setGame] = useState<GameState | null>(null);
  const [flow, setFlow] = useState<FlowItem[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<null | 'host' | 'ta' | 'score'>(null);
  const [played, setPlayed] = useState<Set<string>>(() => loadPlayed(charId));
  const [filter, setFilter] = useState<SoupFilter>(() => loadFilter(charId));
  const [rule, setRule] = useState<RuleLevel>('normal');
  const [hostApi, setHostApi] = useState<GameApiSetting>(() => loadApiSetting(KEY_HOST_API));
  const [taApi, setTaApi] = useState<GameApiSetting>(() => loadApiSetting(KEY_TA_API));
  const [submitting, setSubmitting] = useState(false);
  const [submitText, setSubmitText] = useState('');
  const [revealed, setRevealed] = useState(false);

  const flowEndRef = useRef<HTMLDivElement>(null);
  const mirror = useRef(createChatMirror(charId, 'turtle_soup'));
  useEffect(() => { mirror.current = createChatMirror(charId, 'turtle_soup'); }, [charId]);

  const soup = useMemo(() => (game ? soupById(game.soupId) || null : null), [game]);
  const palette = soup ? paletteOf(soup) : null;

  // 断点续玩：退出 App 再进来接着上一局
  useEffect(() => {
    const saved = loadGame(charId);
    if (saved) {
      setGame(saved);
      setRule(saved.rule);
      setScreen('playing');
      const s = soupById(saved.soupId);
      setFlow(saved.qa.map(q => ({
        id: q.id, kind: 'qa', qa: q,
        text: q.question, who: q.asker === 'user' ? names.user : names.ta,
      })));
      if (s && saved.hintsUsed > 0) {
        // 续玩时把已经掀开的提示补回流里，不然看不到自己用过什么
        setFlow(prev => [
          ...s.hints.slice(0, saved.hintsUsed).map((h, i) => ({
            id: `hint_restore_${i}`, kind: 'system' as const, text: `提示 ${i + 1}：${h}`,
          })),
          ...prev,
        ]);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charId]);

  useEffect(() => { saveGame(charId, game); }, [charId, game]);
  useEffect(() => { flowEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [flow, busy]);

  const aiCtx: AiContext = useMemo(() => ({
    hostApi, taApi, fallbackApi: apiConfig,
    charId: charId || undefined,
    taName: names.ta, userName: names.user,
    taPersona: readPersona(char),
  }), [hostApi, taApi, apiConfig, charId, names.ta, names.user, char]);

  const pushFlow = useCallback((item: Omit<FlowItem, 'id'>) => {
    setFlow(prev => [...prev, { ...item, id: `f_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` }]);
  }, []);

  // ==================== 开局 ====================

  const available = useMemo(() => filterSoups(filter, played), [filter, played]);

  const startGame = useCallback(() => {
    const picked = drawSoup(filter, played);
    if (!picked) {
      addToast('符合条件的汤都喝过了，去设置里清空记录或放宽筛选', 'info');
      return;
    }
    const g = createGame(picked.id, rule);
    setGame(g);
    setFlow([]);
    setRevealed(false);
    setSubmitText('');
    setSubmitting(false);
    setScreen('playing');
    mirror.current('system', `【海龟汤】开局：${picked.title}\n${picked.face}`);
  }, [filter, played, rule, addToast]);

  const endGame = useCallback((keepPlayed: boolean) => {
    if (game && keepPlayed) {
      const next = new Set(played);
      next.add(game.soupId);
      setPlayed(next);
      savePlayed(charId, next);
    }
    setGame(null);
    saveGame(charId, null);
    setFlow([]);
    setScreen('lobby');
  }, [game, played, charId]);

  // ==================== 提问 ====================

  /** 把一次提问送到主持人那里。user 和 ta 走的是同一条路，只有 askerName 不同。 */
  const sendToHost = useCallback(async (question: string, asker: 'user' | 'ta') => {
    if (!game || !soup) return;
    const askerName = asker === 'user' ? names.user : names.ta;

    const answer = await askHost(aiCtx, soup, game, question, askerName);
    if (!answer) {
      pushFlow({ kind: 'system', text: '主持人没有回应（检查一下 API 配置）' });
      return;
    }

    // 主持人自己判定这句没法用是/否回答：驳回，不扣次数
    if (answer.rejected) {
      pushFlow({ kind: 'system', text: `主持人驳回：这个问题没法用是/否回答，换个问法（不扣次数）` });
      return;
    }

    const entry: QaEntry = {
      id: makeQaId(), asker, question, verdict: answer.verdict, note: answer.note, at: Date.now(),
    };
    setGame(g => g ? {
      ...g,
      qa: [...g.qa, entry],
      userAsked: g.userAsked + (asker === 'user' ? 1 : 0),
      taAsked: g.taAsked + (asker === 'ta' ? 1 : 0),
      turn: asker === 'user' ? 'ta' : 'user',
    } : g);
    pushFlow({ kind: 'qa', qa: entry, text: question, who: askerName });
    mirror.current(asker === 'user' ? 'user' : 'assistant', `${question} → 主持人：${answer.verdict}`);
  }, [game, soup, aiCtx, names.user, names.ta, pushFlow]);

  const handleAsk = useCallback(async () => {
    const q = input.trim();
    if (!q || !game || busy) return;
    if (!canAsk(game, 'user')) { addToast('你的提问次数用完了', 'info'); return; }

    // 本地两道闸，挡下来不花 API
    const rejected = preCheckQuestion(game, q);
    if (rejected) {
      pushFlow({
        kind: 'system',
        text: rejected.reason === 'duplicate'
          ? `这个问题问过了：「${rejected.previous.question}」→ ${rejected.previous.verdict}（不扣次数）`
          : '这句话没法用是/否回答，换个问法（不扣次数）',
      });
      setInput('');
      return;
    }

    setInput('');
    setBusy('host');
    try { await sendToHost(q, 'user'); }
    finally { setBusy(null); }
  }, [input, game, busy, addToast, pushFlow, sendToHost]);

  /** TA 提问：一次点击两次调用（它想问题 + 主持人判定）。手动触发，不自动连发。 */
  const handleTaAsk = useCallback(async () => {
    if (!game || !soup || busy) return;
    if (!canAsk(game, 'ta')) { addToast(`${names.ta}的提问次数用完了`, 'info'); return; }

    setBusy('ta');
    try {
      const thought = await askTaQuestion(aiCtx, soup, game);
      if (!thought) {
        pushFlow({ kind: 'system', text: `${names.ta}没想出问题（检查一下 API 配置）` });
        return;
      }
      if (thought.aside) {
        pushFlow({ kind: 'aside', who: names.ta, text: thought.aside });
        mirror.current('assistant', thought.aside);
      }
      // TA 想出来的问题也过一遍本地闸：它也会重复提问
      const rejected = preCheckQuestion(game, thought.question);
      if (rejected?.reason === 'duplicate') {
        pushFlow({
          kind: 'system',
          text: `${names.ta}想问「${thought.question}」，但这个问过了 → ${rejected.previous.verdict}（不扣次数）`,
        });
        return;
      }
      await sendToHost(thought.question, 'ta');
    } finally { setBusy(null); }
  }, [game, soup, busy, aiCtx, names.ta, addToast, pushFlow, sendToHost]);

  // ==================== 提示 ====================

  const handleHint = useCallback(() => {
    if (!game || !soup) return;
    if (!canHint(game, soup)) { addToast('没有提示可用了', 'info'); return; }
    const next = game.hintsUsed + 1;
    setGame(g => g ? { ...g, hintsUsed: next } : g);
    pushFlow({ kind: 'system', text: `提示 ${next}：${soup.hints[next - 1]}` });
  }, [game, soup, addToast, pushFlow]);

  // ==================== TA 的推断 / 提交结算 ====================

  const handleTaGuess = useCallback(async () => {
    if (!game || !soup || busy) return;
    setBusy('ta');
    try {
      const guess = await askTaGuess(aiCtx, soup, game);
      if (!guess) { pushFlow({ kind: 'system', text: `${names.ta}没给出推断` }); return; }
      pushFlow({ kind: 'guess', who: names.ta, text: guess });
      mirror.current('assistant', guess);
    } finally { setBusy(null); }
  }, [game, soup, busy, aiCtx, names.ta, pushFlow]);

  const handleSubmit = useCallback(async () => {
    const text = submitText.trim();
    if (!text || !game || !soup || busy) return;
    setBusy('score');
    try {
      const result = await scoreSubmission(aiCtx, soup, text);
      if (!result) { addToast('评分失败，再试一次', 'error'); return; }
      setGame(g => g ? {
        ...g,
        result: { ...result, tier: scoreTier(result.score), submitted: text, at: Date.now() },
      } : g);
      setSubmitting(false);
      mirror.current('user', `我的还原：${text}`);
      mirror.current('system', `【海龟汤】得分 ${result.score}（${scoreTier(result.score)}）`);
    } finally { setBusy(null); }
  }, [submitText, game, soup, busy, aiCtx, addToast]);

  // ==================== 渲染 ====================

  const Shell: React.FC<{ title: string; right?: React.ReactNode; children: React.ReactNode }> =
    ({ title, right, children }) => (
      <div className="h-full flex flex-col" style={{ background: SHELL.bg, color: SHELL.text }}>
        <div className="flex items-center gap-2 px-3 py-2.5 shrink-0 border-b"
             style={{ borderColor: SHELL.border, paddingTop: 'calc(var(--safe-top, 0px) + 10px)' }}>
          <button onClick={onBack} className="p-1 active:scale-90 transition-transform"><CaretLeft size={20} /></button>
          <span className="font-bold text-[15px]">{title}</span>
          <div className="ml-auto flex items-center gap-1">{right}</div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
      </div>
    );

  // ── 大厅 ──
  if (screen === 'lobby') {
    return (
      <Shell
        title="海龟汤 · 共猜"
        right={<button onClick={() => setScreen('settings')} className="p-1.5"><Gear size={18} /></button>}
      >
        <div className="px-4 py-5 space-y-5">
          <div className="text-center py-6">
            <div className="text-[44px] leading-none mb-2">🍜</div>
            <div className="text-[13px]" style={{ color: SHELL.dim }}>
              端上来一碗怪汤，你和{names.ta}轮流向主持人提问，<br />
              一层层把底下的真相挖出来。
            </div>
          </div>

          <div>
            <div className="text-[12px] mb-2" style={{ color: SHELL.dim }}>规则难度</div>
            <div className="space-y-2">
              {RULES.map(r => (
                <button
                  key={r.id}
                  onClick={() => setRule(r.id)}
                  className="w-full text-left px-3 py-2.5 rounded-xl transition-transform active:scale-[0.99]"
                  style={{
                    background: rule === r.id ? 'rgba(217,164,65,0.14)' : SHELL.panel,
                    border: `1px solid ${rule === r.id ? SHELL.amber : 'transparent'}`,
                  }}
                >
                  <div className="text-sm font-bold" style={{ color: rule === r.id ? SHELL.amber : SHELL.text }}>
                    {r.label}
                  </div>
                  <div className="text-[11px] mt-0.5" style={{ color: SHELL.dim }}>{r.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="text-[12px] text-center" style={{ color: SHELL.dim }}>
            还有 {available.length} 碗没喝过（共 {SOUPS.length} 碗）
          </div>

          <button
            onClick={startGame}
            disabled={available.length === 0}
            className="w-full py-3 rounded-full font-bold text-sm active:scale-95 transition-transform disabled:opacity-40"
            style={{ background: SHELL.amber, color: '#1a1206' }}
          >
            盛一碗
          </button>
        </div>
      </Shell>
    );
  }

  // ── 设置 ──
  if (screen === 'settings') {
    const ApiBlock: React.FC<{
      label: string; note: string; value: GameApiSetting;
      onChange: (v: GameApiSetting) => void;
    }> = ({ label, note, value, onChange }) => (
      <div className="space-y-2">
        <div className="text-sm font-bold">{label}</div>
        <div className="text-[11px] leading-relaxed" style={{ color: SHELL.dim }}>{note}</div>
        {(['baseUrl', 'apiKey', 'model'] as const).map(field => (
          <input
            key={field}
            value={value[field]}
            type={field === 'apiKey' ? 'password' : 'text'}
            onChange={e => onChange({ ...value, [field]: e.target.value })}
            placeholder={field === 'baseUrl' ? 'Base URL' : field === 'apiKey' ? 'API Key' : 'Model'}
            className="w-full px-3 py-2 rounded-lg text-sm outline-none"
            style={{ background: SHELL.panel, color: SHELL.text, border: `1px solid ${SHELL.border}` }}
          />
        ))}
        <div className="text-[11px]" style={{ color: apiFilled(value) ? '#7fd4a0' : SHELL.dim }}>
          {apiFilled(value) ? '已配置，这一侧走这套' : '留空 = 用 App 的主 API'}
        </div>
      </div>
    );

    return (
      <Shell title="设置" right={<button onClick={() => setScreen('lobby')} className="text-[13px] px-2" style={{ color: SHELL.amber }}>完成</button>}>
        <div className="px-4 py-4 space-y-6">
          <ApiBlock
            label="主持人 API"
            note="整局里调用最频繁的一环——每问一句就是一次，干的却是最不需要脑子的活（对着汤底判是非）。挂个便宜模型完全够用，按量计费时这里最省钱。"
            value={hostApi}
            onChange={v => { setHostApi(v); saveApiSetting(KEY_HOST_API, v); }}
          />
          <ApiBlock
            label={`${names.ta} 的 API`}
            note={`${names.ta}要带人设推理，值得挂好一点的模型。它全程看不到汤底，跟你拿到的信息一样多。`}
            value={taApi}
            onChange={v => { setTaApi(v); saveApiSetting(KEY_TA_API, v); }}
          />

          <div className="space-y-2">
            <div className="text-sm font-bold">内容筛选</div>
            {([['allowRed', '红汤', '凶杀、悬疑、旧案这类'], ['allowYellow', '黄汤', '成人向']] as const).map(([k, label, desc]) => (
              <button
                key={k}
                onClick={() => { const next = { ...filter, [k]: !filter[k] }; setFilter(next); saveFilter(charId, next); }}
                className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl"
                style={{ background: SHELL.panel }}
              >
                <div className="text-left">
                  <div className="text-sm">{label}</div>
                  <div className="text-[11px]" style={{ color: SHELL.dim }}>{desc}</div>
                </div>
                <div className="relative w-11 h-6 rounded-full shrink-0"
                     style={{ background: filter[k] ? SHELL.amber : 'rgba(255,255,255,0.15)' }}>
                  <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
                        style={{ left: filter[k] ? '22px' : '2px' }} />
                </div>
              </button>
            ))}

            <div className="text-[12px] pt-2" style={{ color: SHELL.dim }}>汤的难度（不选 = 不限）</div>
            <div className="flex flex-wrap gap-2">
              {DIFFICULTIES.map(d => {
                const on = filter.difficulties.includes(d);
                return (
                  <button
                    key={d}
                    onClick={() => {
                      const next = {
                        ...filter,
                        difficulties: on ? filter.difficulties.filter(x => x !== d) : [...filter.difficulties, d],
                      };
                      setFilter(next); saveFilter(charId, next);
                    }}
                    className="text-[12px] px-3 py-1.5 rounded-full"
                    style={{
                      background: on ? 'rgba(217,164,65,0.18)' : SHELL.panel,
                      color: on ? SHELL.amber : SHELL.dim,
                    }}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
            <div className="text-[11px] pt-1" style={{ color: SHELL.dim }}>
              当前筛选下还有 {available.length} 碗没喝过
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-bold">抽取记录</div>
            <div className="text-[11px]" style={{ color: SHELL.dim }}>
              已经喝过 {played.size} 碗。清空之后这些汤会重新进入抽取池。
            </div>
            <button
              onClick={() => { setPlayed(new Set()); savePlayed(charId, new Set()); addToast('已清空', 'success'); }}
              className="text-sm px-4 py-2 rounded-full"
              style={{ background: 'rgba(224,118,126,0.15)', color: '#e0767e' }}
            >
              清空抽取记录
            </button>
          </div>

          <div className="pt-4 border-t space-y-1 text-[11px] leading-relaxed"
               style={{ borderColor: SHELL.border, color: SHELL.dim }}>
            <div className="text-[12px] font-bold pb-1" style={{ color: SHELL.text }}>关于</div>
            <div><b>玩法</b>　改编自开源项目《海龟汤 · 共猜》（AZHi-xinxin/haiguitang-coop）</div>
            <div><b>汤库</b>　{SOUPS.length} 碗，整理自「雾眠 海龟汤合集」等公开合集</div>
            <div><b>说明</b>　本地改编版：主持人与{names.ta}分别调用 API，{names.ta}全程看不到汤底</div>
          </div>
        </div>
      </Shell>
    );
  }

  // ── 对局 ──
  if (!game || !soup || !palette) {
    return <Shell title="海龟汤"><div className="text-center py-16 text-sm opacity-50">这碗汤不见了</div></Shell>;
  }

  const r = ruleOf(game.rule);
  const userLeft = r.questionsEach === null ? '∞' : `${r.questionsEach - game.userAsked}`;
  const taLeft = r.questionsEach === null ? '∞' : `${r.questionsEach - game.taAsked}`;
  const hintLeft = r.hints === null ? '∞' : `${Math.max(0, r.hints - game.hintsUsed)}`;
  const done = !!game.result;

  return (
    <Shell
      title="海龟汤"
      right={
        <button onClick={() => endGame(false)} className="text-[12px] px-2" style={{ color: SHELL.dim }}>退出</button>
      }
    >
      <div className="px-3 py-3 space-y-3 pb-4">
        {/* 汤面：整局里唯一做足的一张卡 */}
        <div
          className="rounded-2xl p-4 relative overflow-hidden"
          style={{
            background: `linear-gradient(160deg, ${palette.from}, ${palette.to})`,
            border: `1px solid ${palette.accent}44`,
            boxShadow: `0 0 40px -12px ${palette.accent}55`,
          }}
        >
          <div className="absolute -top-8 -right-6 text-[80px] opacity-[0.07] select-none">🍜</div>
          <div className="flex items-center gap-2 text-[11px] mb-2" style={{ color: `${palette.accent}` }}>
            <span className="px-2 py-0.5 rounded-full" style={{ background: `${palette.accent}22` }}>
              {palette.label}
            </span>
            <span style={{ opacity: 0.7 }}>{soup.difficulty}</span>
          </div>
          <div className="font-bold text-[18px] mb-2" style={{ color: palette.title }}>{soup.title}</div>
          <div className="text-[14px] leading-relaxed whitespace-pre-wrap" style={{ color: palette.body }}>
            {soup.face}
          </div>
        </div>

        {/* 计数条 */}
        <div className="flex items-center gap-3 text-[11px] px-1" style={{ color: SHELL.dim }}>
          <span>你 {userLeft}</span>
          <span>{names.ta} {taLeft}</span>
          <span>提示 {hintLeft}</span>
          <span className="ml-auto">{game.qa.length} 问</span>
        </div>

        {/* 问答流：朴素，因为你要来回看几十次 */}
        <div className="space-y-2">
          {flow.map(item => {
            if (item.kind === 'system') {
              return (
                <div key={item.id} className="text-[12px] px-3 py-2 rounded-lg leading-relaxed"
                     style={{ background: SHELL.panel, color: SHELL.dim }}>
                  {item.text}
                </div>
              );
            }
            if (item.kind === 'aside' || item.kind === 'guess') {
              return (
                <div key={item.id} className="text-[13px] px-3 py-2 rounded-lg leading-relaxed"
                     style={{ background: 'rgba(217,164,65,0.08)', color: SHELL.text }}>
                  <span style={{ color: SHELL.amber }}>{item.who}</span>
                  <span className="ml-1.5 whitespace-pre-wrap">{item.text}</span>
                </div>
              );
            }
            const qa = item.qa!;
            const vc = VERDICT_COLORS[qa.verdict];
            return (
              <div key={item.id} className="flex items-start gap-2">
                <div className="flex-1 min-w-0 text-[13px] leading-relaxed">
                  <span style={{ color: qa.asker === 'user' ? SHELL.text : SHELL.amber, opacity: 0.8 }}>
                    {item.who}
                  </span>
                  <span className="ml-1.5">{qa.question}</span>
                  {qa.note && <div className="text-[11px] mt-0.5" style={{ color: SHELL.dim }}>{qa.note}</div>}
                </div>
                <span
                  className="shrink-0 text-[12px] font-bold px-2 py-1 rounded-lg"
                  style={{ color: vc.fg, background: vc.bg }}
                >
                  {qa.verdict}
                </span>
              </div>
            );
          })}
          {busy && (
            <div className="text-[12px] px-1" style={{ color: SHELL.dim }}>
              {busy === 'host' ? '主持人在想…' : busy === 'ta' ? `${names.ta}在想…` : '主持人在打分…'}
            </div>
          )}
          <div ref={flowEndRef} />
        </div>

        {/* 结算：第二个值得停顿的地方 */}
        {done && game.result && (
          <div className="rounded-2xl p-4 space-y-3"
               style={{ background: SHELL.panel, border: `1px solid ${SHELL.border}` }}>
            <div className="text-center">
              <div className="text-[40px] font-bold leading-none" style={{ color: SHELL.amber }}>
                {game.result.score}
              </div>
              <div className="text-[13px] mt-1">{game.result.tier}</div>
            </div>
            <div className="flex gap-2 text-[11px]">
              {([['关键情节', game.result.breakdown.key, '40%'],
                 ['逻辑连贯', game.result.breakdown.logic, '30%'],
                 ['细节还原', game.result.breakdown.detail, '30%']] as const).map(([label, v, w]) => (
                <div key={label} className="flex-1 text-center px-2 py-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.04)' }}>
                  <div className="font-bold text-[15px]" style={{ color: SHELL.text }}>{v}</div>
                  <div style={{ color: SHELL.dim }}>{label}</div>
                  <div style={{ color: SHELL.dim, opacity: 0.6 }}>{w}</div>
                </div>
              ))}
            </div>
            <div className="text-[13px] leading-relaxed" style={{ color: SHELL.text }}>{game.result.comment}</div>

            {revealed ? (
              <div className="text-[13px] leading-relaxed p-3 rounded-xl whitespace-pre-wrap"
                   style={{ background: `${palette.from}`, color: palette.body, border: `1px solid ${palette.accent}33` }}>
                <div className="font-bold mb-1.5" style={{ color: palette.title }}>汤底</div>
                {soup.bottom}
              </div>
            ) : (
              <button onClick={() => setRevealed(true)}
                      className="w-full py-2.5 rounded-full text-sm flex items-center justify-center gap-1.5"
                      style={{ background: 'rgba(255,255,255,0.06)', color: SHELL.text }}>
                <Eye size={15} /> 揭晓汤底
              </button>
            )}

            <button onClick={() => endGame(true)}
                    className="w-full py-2.5 rounded-full font-bold text-sm"
                    style={{ background: SHELL.amber, color: '#1a1206' }}>
              再来一碗
            </button>
          </div>
        )}

        {/* 提交面板 */}
        {!done && submitting && (
          <div className="rounded-2xl p-3 space-y-2" style={{ background: SHELL.panel, border: `1px solid ${SHELL.border}` }}>
            <div className="text-[12px]" style={{ color: SHELL.dim }}>
              把你还原的完整故事写下来。<b>提交即结算</b>，之后不能再提问。
            </div>
            <textarea
              value={submitText}
              onChange={e => setSubmitText(e.target.value)}
              rows={5}
              placeholder="真相是……"
              className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-none"
              style={{ background: 'rgba(0,0,0,0.25)', color: SHELL.text, border: `1px solid ${SHELL.border}` }}
            />
            <div className="flex gap-2">
              <button onClick={handleSubmit} disabled={!submitText.trim() || !!busy}
                      className="flex-1 py-2 rounded-full font-bold text-sm disabled:opacity-40"
                      style={{ background: SHELL.amber, color: '#1a1206' }}>
                {busy === 'score' ? '打分中…' : '提交结算'}
              </button>
              <button onClick={() => setSubmitting(false)} className="px-4 py-2 rounded-full text-sm"
                      style={{ background: 'rgba(255,255,255,0.08)' }}>
                再想想
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 底部操作条 */}
      {!done && !submitting && (
        <div className="shrink-0 border-t px-3 pt-2 space-y-2"
             style={{ borderColor: SHELL.border, background: SHELL.bg, paddingBottom: 'calc(var(--safe-bottom, 0px) + 8px)' }}>
          <div className="flex items-center gap-2">
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAsk(); }}
              disabled={!!busy || !canAsk(game, 'user')}
              placeholder={canAsk(game, 'user') ? '问一个能用是/否回答的问题…' : '你的提问次数用完了'}
              className="flex-1 min-w-0 px-3 py-2 rounded-full text-sm outline-none disabled:opacity-40"
              style={{ background: SHELL.panel, color: SHELL.text, border: `1px solid ${SHELL.border}` }}
            />
            <button onClick={handleAsk} disabled={!input.trim() || !!busy}
                    className="shrink-0 p-2 rounded-full disabled:opacity-30"
                    style={{ background: SHELL.amber, color: '#1a1206' }}>
              <PaperPlaneTilt size={16} weight="fill" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleTaAsk} disabled={!!busy || !canAsk(game, 'ta')}
                    className="flex items-center gap-1 text-[12px] px-3 py-1.5 rounded-full disabled:opacity-30"
                    style={{ background: 'rgba(217,164,65,0.14)', color: SHELL.amber }}>
              <Sparkle size={13} weight="fill" /> 让{names.ta}问
            </button>
            <button onClick={handleHint} disabled={!!busy || !canHint(game, soup)}
                    className="flex items-center gap-1 text-[12px] px-3 py-1.5 rounded-full disabled:opacity-30"
                    style={{ background: SHELL.panel, color: SHELL.text }}>
              <Lightbulb size={13} /> 提示
            </button>
            <button onClick={handleTaGuess} disabled={!!busy}
                    className="flex items-center gap-1 text-[12px] px-3 py-1.5 rounded-full disabled:opacity-30"
                    style={{ background: SHELL.panel, color: SHELL.text }}>
              <ArrowsClockwise size={13} /> {names.ta}怎么想
            </button>
            <button onClick={() => setSubmitting(true)} disabled={!!busy}
                    className="ml-auto text-[12px] px-3 py-1.5 rounded-full font-bold disabled:opacity-30"
                    style={{ background: 'rgba(127,212,160,0.15)', color: '#7fd4a0' }}>
              提交
            </button>
          </div>
          {isOutOfQuestions(game) && (
            <div className="text-[11px] text-center pb-1" style={{ color: SHELL.dim }}>
              双方提问次数都用完了，只剩提交
            </div>
          )}
        </div>
      )}
    </Shell>
  );
};

export default TurtleSoupGame;
