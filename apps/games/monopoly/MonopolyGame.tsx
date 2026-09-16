// ═══════════════════════════════════════════════════════════════════════════
// ⛔ 大富翁 · 页面（设置页 + 游戏页 + 文字卡片），不需要改
//   要改的内容在 content.ts（数值、文字、模型）和 prompts.ts（提示词）。
//   这个组件只依赖 App 的 useOS / DB，在游戏大厅里由 ../registry.ts 打开。
// ═══════════════════════════════════════════════════════════════════════════

import React, { useEffect, useRef, useState } from 'react';
import { useOS } from '../../../context/OSContext';
import { DB } from '../../../utils/db';
import { callGameAI } from '../shared/ai';
import { extractModelIds } from '../../../utils/modelList';
import { createChatMirror } from '../shared/chatMirror';
import { detectSex, readNames, readPersona } from '../shared/profile';
import {
  AI_TEMPERATURE, BIRD_TEXT, CHAT_MIRROR, DEALER_API, DEALER_NAME, DUEL_HINT, FUNCTION_CARDS, GAME_NUMBERS,
  INTENSITY_NOTES, INTENSITY_RANGES, LEVEL_NAMES, LEVEL_STEPS, LEVELS_FOOTER, MARK_PARTS, OPENING_REMINDER,
  SETTING_HINTS, CONTENT_VERSION, TA_MODEL,
} from './content';
import {
  BACKDOOR_LABEL, BACKDOOR_MODES, CARD_LABEL, CELL_ICON, CONTENT_ISSUES, IDENTITY_MODES, INTENSITIES, LEVEL_MARKS,
  RED_LINES, REVERSALS, ROLES, ROUND_OPTIONS, buildOpeningCommand, cardPrice, createGame, createLobby, hasEffect,
  identityOf, loadGame, loadSeen, loadSettings, pad2, parseRange, rewardPreview, runCommand, saveGame,
  saveSeen, saveSettings, tollOf, type GameState, type TaskCard,
} from './engine';
import {
  buildTaMessages, buildTaSystem, isBirdWord, parseTaActions, taNudgeKey,
  type ChatEntry, type ChatFrom,
} from './prompts';
import type { MonopolySettings, Profiles, Sex, Who } from './types';

const DICE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

// ─── TA 专用 API（设置页里填；三项都空 = 用 App 设置里的主 API）────────────────
export interface TaApiSetting { baseUrl: string; apiKey: string; model: string }
const TA_API_KEY = 'yuzhou_monopoly_ta_api';
function loadTaApi(): TaApiSetting {
  try {
    const v = JSON.parse(localStorage.getItem(TA_API_KEY) || '{}');
    return { baseUrl: String(v?.baseUrl || ''), apiKey: String(v?.apiKey || ''), model: String(v?.model || '') };
  } catch { return { baseUrl: '', apiKey: '', model: '' }; }
}
function saveTaApi(v: TaApiSetting) {
  try { localStorage.setItem(TA_API_KEY, JSON.stringify({ baseUrl: v.baseUrl.trim(), apiKey: v.apiKey.trim(), model: v.model.trim() })); } catch { /* ignore */ }
}
const taApiFilled = (v: TaApiSetting) => !!(v.baseUrl.trim() && v.model.trim());

// ─── 荷官：不调 API，把引擎原文整理一下直接出字 ──────────────────────────────
const BOARD_ART_LINE = /^(［|🙋.*@\d|💞.*@\d|🚩地盘：)/;
function dealerText(texts: string[]): string {
  return texts
    .map(t => t
      .split('\n')
      .filter(line => !BOARD_ART_LINE.test(line.trim()))
      .join('\n')
      .replace(/📋 〔([^｜〕]*)｜([^｜〕]*)｜([^｜〕]*)｜([^〕]*)〕/g, (_m, lv, _type, label) => `📋 新题 · ${label}（${lv}）`)
      .replace(/（念给人类[^）]*）/g, '')
      .trim())
    .filter(Boolean)
    .join('\n\n');
}

/** 首页同款小光线 */
const SparkLines: React.FC<{ flip?: boolean; className?: string }> = ({ flip, className = '' }) => (
  <svg viewBox="0 0 18 18" className={`${className} ${flip ? '-scale-x-100' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <path d="M5 3.5 L9 7" /><path d="M2.5 9.5 L8.5 9.5" /><path d="M5 15.5 L9 12" />
  </svg>
);
const HeartBadge: React.FC<{ className?: string; color?: string }> = ({ className = '', color = '#f9a8c0' }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden>
    <path d="M12 21 C6 16.5 2.5 13.4 2.5 9.2 C2.5 6.3 4.7 4 7.4 4 C9.4 4 11 5.1 12 6.8 C13 5.1 14.6 4 16.6 4 C19.3 4 21.5 6.3 21.5 9.2 C21.5 13.4 18 16.5 12 21 Z"
      fill={color} stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
  </svg>
);

const GAME_CSS = `
@keyframes mono-pulse { 0% { box-shadow: 0 0 0 0 rgba(167,139,250,.55); } 70% { box-shadow: 0 0 0 12px rgba(167,139,250,0); } 100% { box-shadow: 0 0 0 0 rgba(167,139,250,0); } }
.mono-pulse { animation: mono-pulse 1.6s ease-out infinite; }
@keyframes mono-bubble { 0% { opacity: 0; transform: translateY(8px) scale(.96); } 12% { opacity: 1; transform: none; } 85% { opacity: 1; } 100% { opacity: 0; transform: translateY(-4px); } }
.mono-bubble { animation: mono-bubble 4.8s ease-out forwards; }
`;

// ─── 小件 ─────────────────────────────────────────────────────────────────

const SegButton: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode; className?: string; disabled?: boolean }> = ({ active, onClick, children, className = '', disabled }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`px-3.5 py-1.5 rounded-full text-[12px] font-bold transition-all active:scale-95 disabled:opacity-40 ${active ? 'bg-rose-400 text-white shadow-[0_4px_14px_rgba(225,110,140,.35)]' : 'bg-white/80 text-rose-400 border border-rose-100'} ${className}`}
  >{children}</button>
);

const SettingCard: React.FC<{ title: string; icon?: string; hint?: string; children: React.ReactNode }> = ({ title, icon, hint, children }) => (
  <section className="rounded-[24px] bg-white/80 border border-white shadow-[0_8px_26px_rgba(172,88,108,.08)] p-4 mb-4">
    <div className="flex items-center gap-1.5 mb-3">
      {icon && <span className="text-[15px]">{icon}</span>}
      <span className="text-[13px] font-black text-rose-500 tracking-wide">{title}</span>
    </div>
    {hint && <div className="text-[10px] text-rose-300 mb-2.5 leading-4">{hint}</div>}
    {children}
  </section>
);

const IssuesCard: React.FC<{ issues: string[] }> = ({ issues }) => (issues.length ? (
  <details className="rounded-[18px] bg-amber-50 border border-amber-200 px-3 py-2 mb-3">
    <summary className="text-[11px] font-black text-amber-700">⚠️ 内容检查：{issues.length} 处待修（monopoly/content.ts 或 data/）</summary>
    <ul className="mt-1 text-[10px] leading-4 text-amber-700 list-disc pl-4 space-y-0.5">
      {issues.slice(0, 30).map((m, i) => <li key={i}>{m}</li>)}
    </ul>
  </details>
) : null);

const MiniAvatar: React.FC<{ src?: string | null; label: string; ring: string }> = ({ src, label, ring }) => (
  <span className={`w-4 h-4 rounded-full overflow-hidden bg-white ring-2 ${ring} flex items-center justify-center text-[7px] font-black text-rose-400`}>
    {src ? <img src={src} alt={label} className="w-full h-full object-cover" /> : Array.from(label)[0]}
  </span>
);

const CmdButton: React.FC<{ label: string; cmd: string; onClick: () => void; tone?: 'primary' | 'plain' | 'warn'; disabled?: boolean }> = ({ label, onClick, tone = 'plain', disabled }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`flex-1 min-w-[88px] h-10 rounded-full px-3 text-[12px] font-bold transition-transform ${disabled ? 'opacity-40' : 'active:scale-95'} ${tone === 'primary'
      ? 'bg-gradient-to-br from-[#fb9fb6] to-[#f37c9c] text-white shadow-[0_6px_14px_rgba(240,110,145,.3)]'
      : tone === 'warn' ? 'bg-[#fff4e0] text-[#c7852a] border border-[#f7dcae]' : 'bg-white/90 text-rose-500 border border-rose-100'}`}
  >{label}</button>
);

// 开局卡片 / 设置页底部：用户、TA 各一行
const PlayerIdTable: React.FC<{ profiles: Pick<Profiles, 'names' | 'sexes'>; roles: MonopolySettings['roles'] }> = ({ profiles, roles }) => (
  <div className="rounded-2xl bg-rose-50/60 border border-rose-100 px-3.5 py-2.5 grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1.5 text-[12px]">
    {([['user', '用户ID'], ['ta', '角色ID']] as const).map(([w, label]) => (
      <React.Fragment key={w}>
        <span className="text-slate-400 font-bold">{label}</span>
        <span className="font-black text-slate-700 truncate">{profiles.names[w]}</span>
        <span className={profiles.sexes[w] ? 'text-slate-600' : 'text-amber-600 font-bold'}>{profiles.sexes[w] ?? '性别?'}</span>
        <span className="min-w-[2.2em] text-center rounded-full bg-rose-400 text-white text-[11px] font-black px-2 py-0.5">{roles[w]}</span>
      </React.Fragment>
    ))}
  </div>
);

function ringPos(i: number): [number, number] {
  if (i <= 5) return [1, i + 1];
  if (i <= 10) return [i - 4, 6];
  if (i <= 15) return [6, 6 - (i - 10)];
  return [6 - (i - 15), 1];
}

// ─── 设置页 ───────────────────────────────────────────────────────────────

const GameSettingsPage: React.FC<{
  onBack: () => void;
  onSave: (s: MonopolySettings, sexOverride: SexOverride, taApi: TaApiSetting) => void;
  initialTaApi: TaApiSetting;
  initial: MonopolySettings;
  profiles: Profiles;
  detected: Record<Who, { sex: Sex | null; from: string }>;
  initialSexOverride: SexOverride;
}> = ({ initialTaApi, onBack, onSave, initial, profiles, detected, initialSexOverride }) => {
  const [settings, setSettings] = useState<MonopolySettings>(initial);
  const [sexOverride, setSexOverride] = useState<SexOverride>(initialSexOverride);
  const draftProfiles = { names: profiles.names, sexes: { user: sexOverride.user ?? detected.user.sex, ta: sexOverride.ta ?? detected.ta.sex } };
  const patch = (p: Partial<MonopolySettings>) => setSettings(prev => ({ ...prev, ...p }));
  const setPer = <K extends 'roles' | 'pureTop' | 'backdoor'>(key: K, who: Who, value: MonopolySettings[K][Who]) =>
    setSettings(prev => ({ ...prev, [key]: { ...prev[key], [who]: value } }));
  const toggleRedLine = (idx: number) => {
    if (!RED_LINES[idx]) return;
    setSettings(prev => { const next = [...prev.redLineActive]; next[idx] = !next[idx]; return { ...prev, redLineActive: next }; });
  };
  const [taApi, setTaApi] = useState<TaApiSetting>(initialTaApi);
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelMsg, setModelMsg] = useState('');
  const fetchModels = async () => {
    const base = taApi.baseUrl.trim().replace(/\/+$/, '');
    if (!base) { setModelMsg('先填 URL'); return; }
    setModelMsg('正在获取…');
    try {
      const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${taApi.apiKey.trim()}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = extractModelIds(await res.json());
      setModels(list);
      setModelMsg(list.length ? `获取到 ${list.length} 个模型，点一个选上` : '没有读到模型，直接手填也行');
    } catch (e: any) {
      setModelMsg(`获取失败：${e?.message || '网络错误'}，可以直接手填模型名`);
    }
  };
  const handleSave = () => { saveSettings(settings); onSave(settings, sexOverride, taApi); onBack(); };
  const activeRange = parseRange(INTENSITY_RANGES[settings.intensity]);
  const names = profiles.names;

  return (
    <div className="absolute inset-0 z-[80] bg-[#fff7f5] text-slate-800">
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_15%_10%,rgba(255,190,205,.42),transparent_28%),radial-gradient(circle_at_90%_25%,rgba(255,220,224,.5),transparent_30%),linear-gradient(180deg,#fffafa_0%,#fff4f1_100%)]" />
      <div className="relative h-full overflow-y-auto overscroll-none" style={{ paddingTop: 'var(--safe-top, 0px)' }}>
        <header className="h-14 px-4 flex items-center justify-between">
          <button onClick={onBack} className="w-9 h-9 rounded-full bg-white/80 shadow-sm text-rose-400 text-xl active:scale-90 transition-transform">‹</button>
          <div className="text-center">
            <div className="font-black tracking-[.18em] text-rose-500 text-base">功能型选项</div>
            <div className="text-[8px] tracking-[.22em] text-rose-300 mt-0.5">🎚️ GAME SETTINGS</div>
          </div>
          <div className="w-9 h-9" />
        </header>

        <main className="px-4 pb-32 max-w-md mx-auto">
          <IssuesCard issues={CONTENT_ISSUES} />

          <SettingCard title="两个人" icon="👥" hint={SETTING_HINTS.roles}>
            {(['user', 'ta'] as const).map(who => (
              <div key={who} className="rounded-2xl bg-white/60 border border-rose-50 px-3 py-2.5 mb-2 last:mb-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[12px] font-black text-slate-700 truncate">{names[who]}</div>
                    <div className={`text-[10px] ${draftProfiles.sexes[who] ? 'text-slate-400' : 'text-amber-600 font-bold'}`}>
                      {sexOverride[who]
                        ? `性别：${sexOverride[who]}（手动指定）`
                        : detected[who].sex ? `性别：${detected[who].sex}（读自${detected[who].from}）` : '性别未识别：只会抽到不限性别的题'}
                    </div>
                    <div className="flex gap-1 mt-1.5">
                      {([null, '男', '女'] as const).map(v => (
                        <SegButton key={String(v)} className="!px-2.5 !py-1 !text-[11px]" active={sexOverride[who] === v}
                          onClick={() => setSexOverride(prev => ({ ...prev, [who]: v }))}>{v ?? '自动'}</SegButton>
                      ))}
                    </div>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    {ROLES.map(r => <SegButton key={r} active={settings.roles[who] === r} onClick={() => setPer('roles', who, r)}>{r}</SegButton>)}
                  </div>
                </div>
                <label className="mt-2 flex items-center gap-2 text-[11px] text-slate-500">
                  <input type="checkbox" checked={settings.pureTop[who]} onChange={e => setPer('pureTop', who, e.target.checked)} className="accent-rose-400" />
                  纯top（任何孔都不被插）
                </label>
              </div>
            ))}
          </SettingCard>

          <SettingCard title="强度" icon="🎚️">
            <div className="flex gap-2 mb-3">
              {INTENSITIES.map(k => <SegButton key={k} active={settings.intensity === k} onClick={() => patch({ intensity: k })}>{k}</SegButton>)}
            </div>
            <div className="space-y-2">
              {INTENSITIES.map(k => (
                <div key={k} className={`rounded-2xl px-3 py-2 border ${settings.intensity === k ? 'border-rose-200 bg-rose-50/60' : 'border-rose-50 bg-white/50'}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-bold text-rose-400 w-14 shrink-0">{k}</span>
                    <span className="text-[11px] text-slate-300 shrink-0">尺 1-6 落在</span>
                    <span className="ml-auto h-7 px-2.5 rounded-xl bg-white border border-rose-100 text-[12px] font-bold text-rose-500 flex items-center">{INTENSITY_RANGES[k] || '—'}</span>
                  </div>
                  {INTENSITY_NOTES[k] && <div className="mt-1.5 text-[11px] leading-4 text-slate-500">{INTENSITY_NOTES[k]}</div>}
                </div>
              ))}
            </div>
          </SettingCard>

          <SettingCard title="1-6 尺 · 每级碰到哪一步" icon="📏" hint={SETTING_HINTS.levels}>
            <div className="space-y-2">
              {LEVEL_MARKS.map((mark, i) => {
                const level = i + 1;
                const inRange = !!activeRange && level >= activeRange[0] && level <= activeRange[1];
                return (
                  <div key={mark} className={`flex items-start gap-2 rounded-xl px-2.5 py-2 border transition-colors ${inRange ? 'bg-rose-50/70 border-rose-200' : 'bg-[#fffaf2] border-[#f3dfcf] opacity-60'}`}>
                    <span className="text-[16px] w-5 shrink-0 leading-5">{mark}</span>
                    <span className="flex-1 min-w-0 text-[12px] leading-5 break-words text-slate-700">{LEVEL_STEPS[i]}</span>
                  </div>
                );
              })}
            </div>
            {LEVELS_FOOTER && <div className="mt-3 text-[10px] text-rose-300 leading-4">{LEVELS_FOOTER}</div>}
          </SettingCard>

          {OPENING_REMINDER && (
            <div className="rounded-[22px] bg-amber-50/70 border border-amber-100 p-3.5 mb-4 text-[11px] leading-5 text-amber-700 font-semibold">{OPENING_REMINDER}</div>
          )}

          <SettingCard title="后门" icon="🚪" hint={SETTING_HINTS.backdoor}>
            {(['user', 'ta'] as const).map(who => (
              <div key={who} className="flex items-center justify-between mb-2 last:mb-0 gap-2">
                <span className="text-[12px] font-bold text-slate-600 truncate">{names[who]}</span>
                <div className="flex gap-1.5 shrink-0">
                  {BACKDOOR_MODES.map(m => <SegButton key={m} active={settings.backdoor[who] === m} onClick={() => setPer('backdoor', who, m)}>{BACKDOOR_LABEL[m]}</SegButton>)}
                </div>
              </div>
            ))}
          </SettingCard>

          <SettingCard title="红线 · 引擎全程自动避开" icon="🚫" hint={SETTING_HINTS.redLines}>
            <div className="grid grid-cols-4 gap-2">
              {RED_LINES.map((label, i) => (
                <button key={i} onClick={() => toggleRedLine(i)} disabled={!label}
                  className={`h-10 rounded-xl text-[12px] font-bold transition-all ${!label ? 'bg-white/40 border border-dashed border-rose-100 text-rose-200 cursor-default' : settings.redLineActive[i] ? 'bg-rose-400 text-white shadow-[0_4px_12px_rgba(225,110,140,.35)] active:scale-90' : 'bg-white/80 border border-rose-100 text-rose-300 active:scale-90'}`}>
                  {label || i + 1}
                </button>
              ))}
            </div>
          </SettingCard>

          <SettingCard title="反转" icon="🔄" hint={SETTING_HINTS.reversal}>
            <div className="flex gap-2 flex-wrap">
              {REVERSALS.map(v => <SegButton key={v} active={settings.reversal === v} onClick={() => patch({ reversal: v })}>{v}</SegButton>)}
            </div>
          </SettingCard>

          <SettingCard title="局长（两人合计回合数）" icon="⏱️" hint={SETTING_HINTS.rounds}>
            <div className="flex gap-2">
              {ROUND_OPTIONS.map(v => <SegButton key={v} active={settings.rounds === v} onClick={() => patch({ rounds: v })}>{v} 回合</SegButton>)}
            </div>
          </SettingCard>

          <SettingCard title="身份模式" icon="🎭" hint={SETTING_HINTS.identity}>
            <div className="flex gap-2 flex-wrap">
              {IDENTITY_MODES.map(m => <SegButton key={m} active={settings.identityMode === m} onClick={() => patch({ identityMode: m })}>{m}</SegButton>)}
            </div>
          </SettingCard>

          <SettingCard title="谁先手" icon="🎲" hint={SETTING_HINTS.firstMove}>
            <div className="flex gap-2">
              <SegButton active={settings.firstMove === 'default'} onClick={() => patch({ firstMove: 'default' })}>默认</SegButton>
              <SegButton active={settings.firstMove === 'user'} onClick={() => patch({ firstMove: 'user' })}>我先</SegButton>
              <SegButton active={settings.firstMove === 'ta'} onClick={() => patch({ firstMove: 'ta' })}>{names.ta}先</SegButton>
            </div>
          </SettingCard>

          <SettingCard title="TA 专用 API" icon="💞" hint="只给大富翁里的 TA 接话用。三项都留空 = 用 App 设置里的主 API。TA 一次只看人设和这局游戏，输入不多，适合按量计费的便宜模型。">
            <label className="block text-[10px] font-bold text-rose-300 mb-1 pl-1">URL</label>
            <input value={taApi.baseUrl} onChange={e => setTaApi(v => ({ ...v, baseUrl: e.target.value }))} placeholder="https://api.example.com/v1" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              className="w-full h-10 rounded-xl bg-rose-50/60 border border-rose-100 px-3 text-[12px] font-mono text-slate-700 outline-none focus:border-rose-300" />
            <label className="block text-[10px] font-bold text-rose-300 mt-3 mb-1 pl-1">Key</label>
            <div className="flex gap-1.5">
              <input value={taApi.apiKey} onChange={e => setTaApi(v => ({ ...v, apiKey: e.target.value }))} type={showKey ? 'text' : 'password'} placeholder="sk-..." autoCapitalize="off" autoCorrect="off" spellCheck={false}
                className="flex-1 min-w-0 h-10 rounded-xl bg-rose-50/60 border border-rose-100 px-3 text-[12px] font-mono text-slate-700 outline-none focus:border-rose-300" />
              <button onClick={() => setShowKey(v => !v)} className="shrink-0 w-10 h-10 rounded-xl bg-white border border-rose-100 text-[14px]" aria-label={showKey ? '隐藏 Key' : '显示 Key'}>{showKey ? '🙈' : '👀'}</button>
            </div>
            <div className="flex items-center justify-between mt-3 mb-1 pl-1">
              <label className="text-[10px] font-bold text-rose-300">Model</label>
              <button onClick={fetchModels} className="text-[10px] font-bold text-rose-400">获取模型列表</button>
            </div>
            <input value={taApi.model} onChange={e => setTaApi(v => ({ ...v, model: e.target.value }))} placeholder="模型名" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              className="w-full h-10 rounded-xl bg-rose-50/60 border border-rose-100 px-3 text-[12px] font-mono text-slate-700 outline-none focus:border-rose-300" />
            {modelMsg && <div className="mt-1.5 text-[10px] text-rose-300 pl-1">{modelMsg}</div>}
            {models.length > 0 && (
              <div className="mt-2 max-h-36 overflow-y-auto flex flex-wrap gap-1.5">
                {models.map(m => (
                  <button key={m} onClick={() => setTaApi(v => ({ ...v, model: m }))}
                    className={`px-2.5 py-1 rounded-full text-[10px] font-mono border ${taApi.model === m ? 'bg-rose-400 text-white border-rose-400' : 'bg-white text-slate-500 border-rose-100'}`}>{m}</button>
                ))}
              </div>
            )}
            <div className="mt-3 flex items-center justify-between">
              <span className={`text-[10px] font-bold ${taApiFilled(taApi) ? 'text-emerald-500' : 'text-slate-400'}`}>{taApiFilled(taApi) ? '✓ TA 用这个 API' : '现在用主 API'}</span>
              {(taApi.baseUrl || taApi.apiKey || taApi.model) && <button onClick={() => { setTaApi({ baseUrl: '', apiKey: '', model: '' }); setModels([]); setModelMsg(''); }} className="text-[10px] text-slate-400 underline underline-offset-2">清空，改回主 API</button>}
            </div>
          </SettingCard>

          <div className="mb-2"><PlayerIdTable profiles={draftProfiles} roles={settings.roles} /></div>
          <div className="text-[9px] text-rose-300 text-center">↑ 保存后下一局按这些参数开</div>
        </main>
      </div>

      <div className="absolute bottom-0 inset-x-0 px-4 pt-3 bg-white/90 backdrop-blur-xl border-t border-rose-100" style={{ paddingBottom: 'max(14px, var(--safe-bottom, 0px))' }}>
        <button onClick={handleSave} className="w-full h-12 rounded-2xl bg-rose-400 text-white font-bold active:scale-[.98] transition-transform shadow-[0_8px_24px_rgba(225,110,140,.3)]">保存并返回</button>
      </div>
    </div>
  );
};

// ─── 玩家面板 ─────────────────────────────────────────────────────────────

const PlayerPanel: React.FC<{
  g: GameState; who: Who; avatar?: string | null; active: boolean; exec: (cmd: string, by?: Who) => void;
}> = ({ g, who, avatar, active, exec }) => {
  const p = g.players[who];
  const [showId, setShowId] = useState(false);
  const playing = g.phase === 'playing';
  const land = g.owners.filter(o => o === who).length;
  const id = identityOf(g, who);
  const name = g.profiles.names[who];
  const tint = who === 'user' ? 'text-rose-500' : 'text-violet-500';
  const catQuota = Number((id?.effects || []).find(e => e.type === 'task_reroll')?.value) || 0;
  const extraQuota = Number((id?.effects || []).find(e => e.type === 'extra_task')?.value) || 0;
  return (
    <div className={`flex-1 min-w-0 rounded-[24px] p-3 border-2 transition-all ${active
      ? `bg-white/95 ${who === 'user' ? 'border-[#f7c2cf] shadow-[0_10px_26px_rgba(240,110,145,.18)]' : 'border-[#d9c8f5] shadow-[0_10px_26px_rgba(150,110,220,.16)]'}`
      : 'bg-white/60 border-white'}`}>
      <div className="flex items-center gap-2">
        <div className="relative shrink-0">
          <div className={`rounded-full p-[2px] bg-gradient-to-br ${who === 'user' ? 'from-rose-200 to-pink-100' : 'from-violet-200 to-fuchsia-100'}`}>
            <div className="rounded-full p-[2px] bg-white">
              <div className="w-10 h-10 rounded-full overflow-hidden bg-rose-50">
                {avatar ? <img src={avatar} alt={name} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-rose-300">♡</div>}
              </div>
            </div>
          </div>
          <HeartBadge className="absolute -right-1 -bottom-0.5 w-4 h-4" color={who === 'user' ? '#f9a8c0' : '#c4b0f2'} />
        </div>
        <div className="min-w-0">
          <div className={`text-[12px] font-black truncate ${tint}`}>{name}{active && playing ? <span className="ml-1 text-[9px] px-1.5 py-[1px] rounded-full bg-[#fff1c9] text-[#c28a1c] align-middle">🎲 该我了</span> : null}</div>
          <div className="text-[10px] text-slate-400">{g.profiles.sexes[who] ?? '?'} · {g.settings.roles[who]}{g.settings.pureTop[who] ? ' · 纯top' : ''}</div>
          <div className="text-[11px] text-[#d0901f] font-bold whitespace-nowrap">🪙 {p.coins}<span className="ml-1.5 text-[10px] text-slate-400 font-semibold">🚩{land} · 第{p.lap + 1}圈</span></div>
        </div>
      </div>

      {g.settings.identityMode !== 'off' && (
        <div className="mt-2 flex items-center gap-1.5">
          <button onClick={() => setShowId(v => !v)} className="min-w-0 flex-1 text-left text-[10px] px-2 py-1 rounded-lg bg-rose-50 text-rose-500 font-bold truncate">
            {id?.name ?? '无身份'}{p.persona ? `·${p.persona}` : ''}
          </button>
          <button onClick={() => exec(`reroll_id ${name}`, who)} disabled={!playing || p.identityRerolled}
            className={`shrink-0 text-[9px] px-1.5 py-1 rounded-lg border ${playing && !p.identityRerolled ? 'border-rose-200 text-rose-400 active:scale-90' : 'border-slate-100 text-slate-300'}`}>
            重抽 {p.identityRerolled ? 0 : 1}
          </button>
        </div>
      )}
      {showId && id && (
        <div className="mt-1.5 text-[10px] leading-4 text-slate-600 bg-[#fffaf2] rounded-lg p-2 border border-[#f3dfcf] space-y-1">
          {id.hint && <div className="font-bold text-rose-500">{id.hint}</div>}
          {(id.persona?.length ? id.persona : [id.behavior || '']).map((line, i) => <div key={i}>· {line}</div>)}
        </div>
      )}

      <div className="mt-2 text-[9px] text-slate-400 flex flex-wrap gap-x-2">
        <span>💱 换题 {GAME_NUMBERS.swapCap - p.swapUsed}</span>
        {catQuota > 0 && <span>🐱 免费换 {catQuota - p.taskRerolled}</span>}
        {extraQuota > 0 && <span>➕ 加餐 {extraQuota - p.extraUsed}</span>}
        {p.jailed > 0 && <span className="text-slate-600 font-bold">🔒 关着</span>}
        {p.jailImmune > 0 && <span className="text-emerald-500">🔓 免狱 {p.jailImmune}</span>}
        {p.doubleNext && <span className="text-amber-500">⏩ 再掷一次</span>}
        {p.guessNext && <span className="text-amber-500">🎰 押{p.guessNext}</span>}
        {p.markSpot && !p.markFound && <span className="text-violet-500">🌀 藏着淫纹</span>}
      </div>
      {(p.hand.length > 0 || p.pendingCards.length > 0) && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {p.hand.map((ci, i) => (
            <span key={`${ci}-${i}`} className="inline-flex rounded-md overflow-hidden border border-violet-100">
              <button onClick={() => exec(`card ${i} ${name}`, who)} disabled={!playing} title={FUNCTION_CARDS[ci]?.description}
                className="text-[9px] px-1.5 py-0.5 bg-violet-50 text-violet-500 active:scale-90">{FUNCTION_CARDS[ci]?.name ?? '?'}</button>
              <button onClick={() => exec(`discard ${i} ${name}`, who)} disabled={!playing} aria-label="弃掉"
                className="text-[9px] px-1 py-0.5 bg-white text-slate-300">×</button>
            </span>
          ))}
          {p.pendingCards.map((ci, i) => <span key={`p${i}`} className="text-[9px] px-1.5 py-0.5 rounded-md border border-dashed border-violet-200 text-violet-300">暂存 {FUNCTION_CARDS[ci]?.name}</span>)}
        </div>
      )}
    </div>
  );
};

// ─── 题卡 ─────────────────────────────────────────────────────────────────

const OWN_KINDS = ['task', 'truth', 'super', 'shame', 'extra'];

const TaskCardView: React.FC<{ g: GameState; c: TaskCard; exec: (cmd: string, by?: Who) => void }> = ({ g, c, exec }) => {
  const n = g.profiles.names;
  const pend = g.pending[c.owner];
  const isPending = !!pend && pend.cardId === c.id && OWN_KINDS.includes(c.kind);
  const p = g.players[c.owner];
  const reward = isPending ? rewardPreview(g, c.owner) : null;
  const catLeft = (identityOf(g, c.owner)?.effects || []).some(e => e.type === 'task_reroll' && p.taskRerolled < (Number(e.value) || 0));
  const mine = c.owner === 'user';
  return (
    <div className="relative pt-2" style={{ filter: 'drop-shadow(0 8px 14px rgba(172,88,108,.14))' }}>
    <span className={`absolute top-0 left-5 z-[1] w-14 h-5 rotate-[-8deg] rounded-[3px] opacity-90 shadow-sm ${mine ? 'bg-[#f7b8c6]' : 'bg-[#b9d3f2]'}`} />
    <div className={`relative p-4 pt-5 ${mine ? 'bg-[#fdebef]' : 'bg-[#fff6e6]'}`}
      style={{ borderRadius: '6px 14px 8px 12px', clipPath: 'polygon(0 1%, 3% 0, 97% 1%, 100% 0, 99% 50%, 100% 99%, 96% 100%, 4% 99%, 0 100%, 1% 50%)' }}>
      <div className="flex items-center justify-between gap-2">
        <div className={`text-[12px] font-black ${mine ? 'text-[#e2577f]' : 'text-[#b8804a]'}`}>
          {CARD_LABEL[c.kind]} · {LEVEL_MARKS[c.level - 1]}{LEVEL_NAMES[c.level - 1]}
          {c.pool === 'task' && <span className="ml-1 text-[10px] font-bold text-slate-400">{c.type}</span>}
        </div>
        <div className="text-[10px] text-slate-400 shrink-0">记在 {n[c.owner]} 头上</div>
      </div>
      <div className="mt-1 text-[10px] text-slate-400">
        {c.dir} · <span className={c.label.startsWith('🔄') ? 'text-amber-600 font-bold' : ''}>{c.label}</span>
        {reward !== null && ` · 做完 +${reward} 币`}
      </div>
      <div className="mt-2 text-[14px] leading-7 text-[#5b4a4e] whitespace-pre-wrap">{c.text}</div>
      {c.note && <div className="mt-1.5 text-[10px] leading-4 text-slate-400">{c.note}</div>}
      {c.actor === 'ta' && <div className="mt-2 text-[10px] text-violet-400">这道由 {n.ta} 来做，想看 TA 怎么做就点右下角「💞 让TA接话」。</div>}

      {g.phase === 'playing' && (
        <div className="mt-3 flex gap-2 flex-wrap">
          {isPending && <>
            <CmdButton label="跳过" cmd="skip" onClick={() => exec(`skip ${n[c.owner]}`, c.owner)} />
            {!pend!.super && catLeft && pend!.pool === 'task' && <CmdButton label="🐱 免费换" cmd="reroll_task" onClick={() => exec(`reroll_task ${n[c.owner]}`, c.owner)} />}
            {!pend!.super && <CmdButton label={`换一道 · ${GAME_NUMBERS.swapCap - p.swapUsed}`} cmd="swap" disabled={p.swapUsed >= GAME_NUMBERS.swapCap} onClick={() => exec(`swap ${n[c.owner]}`, c.owner)} />}
            {pend!.super && <CmdButton label={`买断 ${GAME_NUMBERS.buyoutCost}`} cmd="buyout" tone="warn" onClick={() => exec(`buyout ${n[c.owner]}`, c.owner)} />}
            <CmdButton label="做完了·结算" cmd="done" tone="primary" onClick={() => exec(`done ${n[c.owner]}`, c.owner)} />
          </>}
          {c.kind === 'toll' && g.pendingToll && <>
            {!g.pendingToll.serveOnly && <CmdButton label={`交过路费 ${tollOf(g, g.pendingToll.landlord)}`} cmd="pay" disabled={g.players[c.owner].coins < g.pendingToll.fee} onClick={() => exec(`pay ${n[c.owner]}`, c.owner)} />}
            <CmdButton label="做完差遣" cmd="serve" tone="primary" onClick={() => exec('serve', c.owner)} />
            <CmdButton label="不做" cmd="skip" onClick={() => exec(`skip #${c.id}`, c.owner)} />
          </>}
          {c.kind === 'duel' && g.pendingDuel && <>
            <CmdButton label={`${n.user} 赢了`} cmd={`duel ${n.user}`} onClick={() => exec(`duel ${n.user}`, 'user')} />
            <CmdButton label={`${n.ta} 赢了`} cmd={`duel ${n.ta}`} onClick={() => exec(`duel ${n.ta}`, 'user')} />
            <CmdButton label="不比了" cmd="skip" onClick={() => exec(`skip #${c.id}`, 'user')} />
          </>}
          {['jail', 'sleep', 'expose'].includes(c.kind) && <CmdButton label="跳过" cmd="skip" onClick={() => exec(`skip #${c.id}`, c.owner)} />}
        </div>
      )}
    </div>
    </div>
  );
};

// ─── 文字卡片（荷官 / TA / 我） ─────────────────────────────────────────────

const ChatCard: React.FC<{
  g: GameState;
  chat: ChatEntry[];
  open: boolean;
  onToggle: () => void;
  onSend: (text: string, to: 'ta' | 'dealer') => void;
  onAskTa: () => void;
  taHint: boolean;
  typing: 'dealer' | 'ta' | null;
  aiMissing: boolean;
  avatars: Record<Who, string | null | undefined>;
  unread: number;
  height: number;
  onHeight: (h: number) => void;
}> = ({ g, chat, open, onToggle, onSend, onAskTa, taHint, typing, aiMissing, avatars, unread, height, onHeight }) => {
  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState<'chat' | 'engine'>('chat');
  const endRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ y: number; h: number } | null>(null);
  const n = g.profiles.names;
  useEffect(() => { if (open) endRef.current?.scrollIntoView({ block: 'end' }); }, [open, chat.length, tab, typing]);
  const send = () => { const t = draft.trim(); if (!t) return; onSend(t, 'ta'); setDraft(''); };
  const last = [...chat].reverse().find(e => e.from === 'dealer' || e.from === 'ta');
  // 收起时新消息飘一个气泡，几秒后消失（消失后不占位置、不挡点击）
  const [bubbleId, setBubbleId] = useState<number | null>(null);
  useEffect(() => {
    if (open || !last || unread === 0) { setBubbleId(null); return; }
    setBubbleId(last.id);
    const t = window.setTimeout(() => setBubbleId(null), 4800);
    return () => window.clearTimeout(t);
  }, [last?.id, open]);

  // 把手：上下拖改高度（屏幕的 28% ~ 85%）
  const clampH = (h: number) => Math.round(Math.min(window.innerHeight * 0.85, Math.max(window.innerHeight * 0.28, h)));
  const onHandleDown = (e: React.PointerEvent) => { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); dragRef.current = { y: e.clientY, h: height }; };
  const onHandleMove = (e: React.PointerEvent) => { const d = dragRef.current; if (d) onHeight(clampH(d.h + (d.y - e.clientY))); };
  const onHandleUp = () => { dragRef.current = null; };

  const askBtn = (compact: boolean) => (
    <button
      onClick={onAskTa}
      disabled={typing === 'ta'}
      aria-label={`让${n.ta}接话`}
      className={`relative shrink-0 rounded-full bg-gradient-to-br from-[#d9c6fa] to-[#f4b3c8] text-white font-bold flex items-center justify-center gap-1 active:scale-90 transition-transform shadow-[0_6px_16px_rgba(170,120,220,.35)] disabled:opacity-80 ${taHint && typing !== 'ta' ? 'mono-pulse' : ''} ${compact ? 'h-9 px-3 text-[12px]' : 'h-12 px-4 text-[13px]'}`}
    >
      <span className={typing === 'ta' ? 'animate-pulse' : ''}>💞</span>
      {typing === 'ta' ? '在想…' : compact ? '接话' : `让${n.ta}接话`}
    </button>
  );

  if (!open) {
    return (
      <div className="absolute right-3 left-3 z-[76] flex flex-col items-end gap-2 pointer-events-none" style={{ bottom: 'max(16px, var(--safe-bottom, 0px))' }}>
        {last && unread > 0 && bubbleId === last.id && (
          <button key={last.id} onClick={onToggle}
            className="mono-bubble pointer-events-auto max-w-[80%] text-left rounded-[20px] rounded-br-md bg-[rgba(255,250,251,.92)] backdrop-blur-xl border border-white shadow-[0_10px_26px_rgba(172,88,108,.16)] px-3.5 py-2.5">
            <div className={`text-[10px] font-black ${last.from === 'ta' ? 'text-violet-500' : 'text-rose-400'}`}>{last.from === 'ta' ? `💞 ${n.ta}` : `🎩 ${DEALER_NAME}`}</div>
            <div className="text-[12px] text-slate-600 leading-5 line-clamp-3 whitespace-pre-wrap">{last.text}</div>
          </button>
        )}
        <div className="pointer-events-auto flex items-center gap-2">
          {g.phase !== 'lobby' && askBtn(false)}
          <button onClick={onToggle} aria-label="打开对话" className="relative w-12 h-12 shrink-0 rounded-full bg-gradient-to-br from-[#fb9fb6] to-[#f37c9c] text-white text-[20px] shadow-[0_8px_20px_rgba(240,110,145,.38)] active:scale-90 transition-transform">
            💬
            {unread > 0 && <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-white text-rose-500 text-[10px] font-black flex items-center justify-center border border-rose-200">{unread > 9 ? '9+' : unread}</span>}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-x-0 bottom-0 z-[76] px-2" style={{ paddingBottom: 'max(8px, var(--safe-bottom, 0px))' }}>
      <div className="max-w-md mx-auto rounded-[28px] bg-[rgba(255,250,251,.9)] backdrop-blur-2xl border-2 border-white/80 shadow-[0_-10px_40px_rgba(172,88,108,.18)] flex flex-col overflow-hidden" style={{ height }}>
        <div className="pt-1.5 pb-0.5 flex justify-center cursor-ns-resize touch-none" onPointerDown={onHandleDown} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp} aria-label="拖动调整高度">
          <span className="w-10 h-1.5 rounded-full bg-rose-200" />
        </div>
        <div className="px-3 pb-2 flex items-center gap-2">
          <div className="flex gap-1 bg-white/70 rounded-full p-0.5">
            {([['chat', '对话'], ['engine', '引擎原文']] as const).map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} className={`px-3 py-1 rounded-full text-[11px] font-bold ${tab === k ? 'bg-rose-400 text-white' : 'text-rose-300'}`}>{label}</button>
            ))}
          </div>
          <div className="ml-auto" />
          <button onClick={onToggle} aria-label="收起" className="w-8 h-8 rounded-full bg-white/80 text-rose-400 text-[14px] active:scale-90">˅</button>
        </div>

        {aiMissing && (
          <div className="mx-3 mb-1 rounded-xl bg-[#fff4e0]/90 border border-[#f7dcae] px-2.5 py-1.5 text-[10px] leading-4 text-[#b07a28]">
            没读到 API 配置：{n.ta} 暂时接不了话。可以在 😈 设置里填「TA 专用 API」，或检查 App 设置里的主 API。
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2.5">
          {tab === 'engine' && g.log.map(line => (
            line.kind === 'cmd'
              ? <div key={line.id} className="text-[9px] font-mono text-slate-400 px-1">{line.text}</div>
              : <pre key={line.id} className={`rounded-xl px-2.5 py-2 text-[11px] leading-[1.55] whitespace-pre-wrap break-words font-mono ${line.kind === 'error' ? 'bg-amber-50/90 text-amber-800 border border-amber-200' : 'bg-white/70 text-slate-600 border border-white'}`}>{line.text}</pre>
          ))}
          {tab === 'chat' && chat.filter(e => e.from !== 'engine').map(e => {
            if (e.from === 'system') return <div key={e.id} className="text-center text-[10px] text-[#b07a28] bg-[#fff4e0]/80 rounded-lg px-2 py-1 whitespace-pre-wrap">{e.text}</div>;
            if (e.from === 'dealer') return (
              <div key={e.id} className="mx-3 rounded-[18px] bg-white/65 border border-white px-3 py-2">
                <div className="text-[10px] font-black text-rose-300 mb-0.5">🎩 {DEALER_NAME}</div>
                <div className="text-[12px] leading-5 text-slate-600 whitespace-pre-wrap break-words">{e.text}</div>
              </div>
            );
            if (e.from === 'ta') return (
              <div key={e.id} className="flex items-start gap-2 pr-6">
                <MiniAvatar src={avatars.ta} label={n.ta} ring="ring-violet-300" />
                <div className="rounded-[20px] rounded-tl-md bg-[#f1eafd]/95 border border-white px-3 py-2 text-[13px] leading-6 text-slate-700 whitespace-pre-wrap break-words">{e.text}</div>
              </div>
            );
            return (
              <div key={e.id} className="flex justify-end pl-8">
                <div className="rounded-[20px] rounded-tr-md bg-gradient-to-br from-[#fb9fb6] to-[#f37c9c] text-white px-3 py-2 text-[13px] leading-6 whitespace-pre-wrap break-words">{e.text}</div>
              </div>
            );
          })}
          {tab === 'chat' && typing === 'ta' && <div className="text-[11px] text-violet-400 px-1">💞 {n.ta} 正在想…</div>}
          <div ref={endRef} />
        </div>

        <div className="px-2.5 pt-2 pb-2.5 border-t border-white/80 bg-white/40">
          <div className="flex gap-2 items-end">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              rows={1}
              placeholder={`对${n.ta}说点什么（不会马上回）`}
              className="flex-1 min-w-0 max-h-24 resize-none rounded-[18px] bg-white/85 border border-rose-100 px-3 py-2 text-[13px] leading-5 outline-none focus:border-rose-300"
            />
            <button onClick={send} className="h-9 px-3.5 rounded-full bg-white border border-rose-200 text-rose-500 text-[12px] font-bold active:scale-95 shrink-0">发送</button>
            {askBtn(true)}
          </div>
          <div className="mt-1 text-[9px] text-rose-300 text-center">打「飞鸟」或「404」立刻停 · 点💞才会调用一次 API</div>
        </div>
      </div>
    </div>
  );
};

// ─── 游戏页 ───────────────────────────────────────────────────────────────

const chatStorageKey = (charId: string) => `yuzhou_monopoly_chat_v${CONTENT_VERSION}_${charId || 'default'}`;
function loadChat(charId: string): ChatEntry[] {
  try { const raw = localStorage.getItem(chatStorageKey(charId)); const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v : []; } catch { return []; }
}

// 手动指定性别：null = 自动读人设。按角色分开存，换角色不串
type SexOverride = Record<Who, Sex | null>;
const sexOverrideKey = (charId: string) => `yuzhou_monopoly_sex_${charId || 'default'}`;
function loadSexOverride(charId: string): SexOverride {
  const ok = (v: unknown): Sex | null => (v === '男' || v === '女' ? v : null);
  try { const p = JSON.parse(localStorage.getItem(sexOverrideKey(charId)) || '{}'); return { user: ok(p?.user), ta: ok(p?.ta) }; } catch { return { user: null, ta: null }; }
}

const MonopolyGame: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const { activeCharacterId, characters, userProfile, apiConfig } = useOS();
  const charId = activeCharacterId || '';
  const char = characters.find(c => c.id === activeCharacterId) ?? null;
  const [userAvatar, setUserAvatar] = useState<string | null>(null);
  const [charAvatar, setCharAvatar] = useState<string | null>(null);
  const avatars: Record<Who, string | null | undefined> = {
    user: userAvatar || userProfile?.perCharAvatars?.[charId] || userProfile?.avatar,
    ta: charAvatar || char?.avatar,
  };

  const [sexOverride, setSexOverride] = useState<SexOverride>(() => loadSexOverride(charId));
  useEffect(() => { setSexOverride(loadSexOverride(charId)); }, [charId]);
  const names = readNames(userProfile, char);
  const detected: Record<Who, { sex: Sex | null; from: string }> = {
    user: detectSex(userProfile, { selfName: names.user, otherName: names.ta }),
    ta: detectSex(char, { selfName: names.ta, otherName: names.user }),
  };
  const profiles: Profiles = {
    names,
    sexes: { user: sexOverride.user ?? detected.user.sex, ta: sexOverride.ta ?? detected.ta.sex },
    taPersona: readPersona(char),
  };

  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<MonopolySettings>(() => loadSettings());
  const [game, setGame] = useState<GameState>(() => loadGame(charId) ?? createLobby(loadSettings(), profiles));
  const [chat, setChat] = useState<ChatEntry[]>(() => loadChat(charId));
  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [typing, setTyping] = useState<'dealer' | 'ta' | null>(null);
  const [aiMissing, setAiMissing] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [diceFace, setDiceFace] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);
  const [markPick, setMarkPick] = useState('');
  const [personaDraft, setPersonaDraft] = useState('');
  const [taHint, setTaHint] = useState(false);
  const [taApi, setTaApi] = useState<TaApiSetting>(() => loadTaApi());
  const [sheetH, setSheetH] = useState(() => Math.round((typeof window !== 'undefined' ? window.innerHeight : 800) * 0.46));

  const gameRef = useRef<GameState>(game);
  const chatRef = useRef<ChatEntry[]>(chat);
  const chatOpenRef = useRef(chatOpen);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const rollTimer = useRef<number | null>(null);
  const mirrorRef = useRef(createChatMirror(charId, 'monopoly', CHAT_MIRROR.enabled));
  chatOpenRef.current = chatOpen;

  useEffect(() => { mirrorRef.current = createChatMirror(charId, 'monopoly', CHAT_MIRROR.enabled); }, [charId]);
  useEffect(() => {
    (async () => {
      try {
        const [u, c] = await Promise.all([DB.getAsset('yuzhou-avatar-user'), DB.getAsset(`yuzhou-avatar-char-${charId || 'default'}`)]);
        setUserAvatar(u); setCharAvatar(c);
      } catch (e) { console.warn('[Monopoly] avatar load failed', e); }
    })();
  }, [charId]);
  useEffect(() => () => { if (rollTimer.current) window.clearInterval(rollTimer.current); }, []);
  useEffect(() => { saveGame(charId, game); }, [game, charId]);
  useEffect(() => { try { localStorage.setItem(chatStorageKey(charId), JSON.stringify(chat.slice(-200))); } catch { /* ignore */ } }, [chat, charId]);
  useEffect(() => { if (game.lastRoll) setDiceFace(game.lastRoll - 1); }, [game.lastRoll]);

  const mirror = (role: 'user' | 'assistant' | 'system', text: string) => mirrorRef.current(role, text);
  const mirrorSystem = (text: string) => mirror('system', `${CHAT_MIRROR.tag}${text}`);

  const commitGame = (next: GameState) => { gameRef.current = next; setGame(next); };
  const pushChat = (from: ChatFrom, text: string, extra: Partial<ChatEntry> = {}): ChatEntry => {
    const list = chatRef.current;
    const entry: ChatEntry = { id: (list[list.length - 1]?.id ?? 0) + 1, from, text, time: Date.now(), ...extra };
    chatRef.current = [...list, entry].slice(-200);
    setChat(chatRef.current);
    if (!chatOpenRef.current && (from === 'dealer' || from === 'ta' || from === 'system')) setUnread(u => u + 1);
    return entry;
  };
  const enqueue = (task: () => Promise<void>) => {
    queueRef.current = queueRef.current.then(task).catch(err => {
      console.error('[Monopoly] AI queue', err);
      pushChat('system', `⚠️ 这里出错了：${(err as Error)?.message ?? err}`);
      setTyping(null);
    });
  };

  // 新题 / 飞鸟 / 结束 → 聊天记录里各记一条
  function mirrorGameEvents(prev: GameState, next: GameState) {
    const nm = next.profiles.names;
    if (CHAT_MIRROR.tasks) {
      next.cards.filter(c => c.id > prev.cardSeq).forEach(c => mirrorSystem(`${nm[c.owner]}的${CARD_LABEL[c.kind]}（行动方 ${nm[c.actor]}）：${c.text}`));
    }
    if (!CHAT_MIRROR.milestones || prev.phase === next.phase) return;
    if (next.phase === 'stopped') mirrorSystem('有人按了飞鸟，游戏停下了。');
    if (next.phase === 'over') mirrorSystem(`这局结束了：${nm.user} ${next.players.user.coins} 币，${nm.ta} ${next.players.ta.coins} 币。`);
  }

  // TA 接话：只有点「💞 让TA接话」才调用一次 API，TA 会看到上次回复之后发生的所有事
  const askTa = () => {
    if (typing) return;
    setTaHint(false);
    enqueue(async () => {
      setTyping('ta');
      const g = gameRef.current;
      const own = taApiFilled(taApi);
      const reply = await callGameAI({
        api: own ? taApi : apiConfig,
        override: own ? undefined : { model: TA_MODEL },
        label: g.profiles.names.ta,
        temperature: AI_TEMPERATURE.ta,
        system: buildTaSystem(g),
        messages: buildTaMessages(g, chatRef.current, ''),
        meta: { appName: '与昼', charId: charId || undefined, charName: g.profiles.names.ta, purpose: '大富翁 · TA接话' },
      });
      setTyping(null);
      if (reply === null) { setAiMissing(true); return; }
      setAiMissing(false);
      const parsed = parseTaActions(gameRef.current, reply);
      if (parsed.text) {
        pushChat('ta', parsed.text);
        if (CHAT_MIRROR.dialogue) mirror('assistant', parsed.text);
      }
      if (parsed.rejected.length) pushChat('system', `引擎没有执行 ${g.profiles.names.ta} 的标签：\n${parsed.rejected.join('\n')}`);
      parsed.commands.forEach(cmd => execCmd(cmd, 'ta', { fromTA: true }));
    });
  };

  function execCmd(cmd: string, by?: Who, opts: { fromTA?: boolean; quiet?: boolean } = {}) {
    const prev = gameRef.current;
    const next = runCommand(prev, cmd, by);
    commitGame(next);
    mirrorGameEvents(prev, next);
    if (prev.phase !== 'over' && next.phase === 'over') saveSeen(charId, next);
    const fresh = next.log.filter(l => l.id > prev.seq);
    const errors = fresh.filter(l => l.kind === 'error').map(l => l.text);
    const engineText = fresh.filter(l => l.kind === 'engine').map(l => l.text).join('\n\n');
    if (errors.length) pushChat('system', errors.join('\n'));
    const verb = cmd.trim().split(/\s+/)[0];
    if (engineText && !['board', 'status'].includes(verb)) {
      pushChat('engine', engineText);
      if (!opts.quiet) {
        const say = dealerText(fresh.filter(l => l.kind === 'engine').map(l => l.text));
        if (say) {
          pushChat('dealer', say);
          if (CHAT_MIRROR.dealer) mirrorSystem(`${DEALER_NAME}：${say}`);
        }
      }
      if (!opts.fromTA) {
        const key = taNudgeKey(next);
        setTaHint(key === 'taActs' || (key === 'decision' && (next.pendingDuel || next.pendingToll?.who === 'ta')) || key === 'over');
      }
    }
    return next;
  }

  const handleSend = (text: string, to: 'ta' | 'dealer') => {
    if (isBirdWord(text) && (gameRef.current.phase === 'playing' || gameRef.current.phase === 'lock')) {
      pushChat('user', text);
      execCmd('bird 我', 'user');
      return;
    }
    pushChat('user', text, { to });
    if (to === 'ta' && CHAT_MIRROR.dialogue) mirror('user', text);
    // 不自动回：想看 TA 反应时点「💞 让TA接话」
  };

  const handleRoll = () => {
    if (rolling) return;
    setRolling(true);
    let ticks = 0;
    rollTimer.current = window.setInterval(() => {
      setDiceFace(Math.floor(Math.random() * 6));
      ticks += 1;
      if (ticks >= 8) {
        if (rollTimer.current) window.clearInterval(rollTimer.current);
        setRolling(false);
        execCmd('roll', gameRef.current.turn);
      }
    }, 70);
  };

  const startGame = () => {
    const g = createGame(settings, profiles, loadSeen(charId));
    commitGame(g);
    chatRef.current = [];
    setChat([]);
    if (CHAT_MIRROR.milestones) mirrorSystem(`${profiles.names.user}和${profiles.names.ta}开了一局大富翁。`);
    const openTexts = g.log.filter(l => l.kind === 'engine').map(l => l.text);
    pushChat('engine', openTexts.join('\n'));
    const say = dealerText(openTexts);
    if (say) pushChat('dealer', say);
    setTaHint(true);
  };
  const backToLobby = () => {
    const g = gameRef.current;
    if (g.phase !== 'lobby' && g.phase !== 'lock' && g.phase !== 'over' && g.turnCount > 0) saveSeen(charId, g);
    commitGame(createLobby(settings, profiles));
    setConfirmReset(false);
  };
  const handleSaveSettings = (s: MonopolySettings, so: SexOverride, api: TaApiSetting) => {
    setSettings(s);
    setTaApi(api);
    saveTaApi(api);
    setSexOverride(so);
    try { localStorage.setItem(sexOverrideKey(charId), JSON.stringify(so)); } catch { /* ignore */ }
    const nextProfiles: Profiles = { ...profiles, sexes: { user: so.user ?? detected.user.sex, ta: so.ta ?? detected.ta.sex } };
    if (gameRef.current.phase === 'lobby') commitGame(createLobby(s, nextProfiles));
  };

  const g = game;
  const n = g.profiles.names;
  const inGame = g.phase !== 'lobby';
  const settingsChanged = inGame && buildOpeningCommand(g.settings, g.profiles) !== buildOpeningCommand(settings, g.profiles);
  const canRoll = g.phase === 'playing' && !g.pendingDuel && !rolling;
  const shown = inGame ? g.settings : settings;
  const me = g.players.user;
  const hasEff = (w: Who, type: string) => hasEffect(g, w, type);
  const firstSkippable = g.cards.find(c => (OWN_KINDS.includes(c.kind) && g.pending[c.owner]?.cardId === c.id) || ['jail', 'sleep', 'expose', 'toll', 'duel'].includes(c.kind));
  const shopWho = g.lastMover && g.board[g.players[g.lastMover].pos] === 'shop' && g.phase === 'playing' ? g.lastMover : null;

  let status = '';
  if (g.phase === 'over') status = '回合已满 · 看结果';
  else if (g.pendingDuel) status = '同格对决 · 比完报赢家';
  else if (g.turnCount >= g.totalRounds) status = '再掷一次结算最后一题';
  else if (g.cards.length) status = `做完再掷 · 下一个 ${n[g.turn]}`;
  else status = `轮到${n[g.turn]}掷骰子`;

  return (
    <div className="absolute inset-0 z-[70] bg-[#fff7f5] text-slate-800 overflow-hidden">
      <style>{GAME_CSS}</style>
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_15%_10%,rgba(255,190,205,.42),transparent_28%),radial-gradient(circle_at_90%_25%,rgba(255,220,224,.5),transparent_30%),linear-gradient(180deg,#fffafa_0%,#fff4f1_100%)]" />
      <div className="relative h-full overflow-y-auto overscroll-none" style={{ paddingTop: 'var(--safe-top, 0px)' }}>
        <header className="px-3 pt-2 pb-1">
          <div className="h-12 grid grid-cols-[auto_1fr_auto] items-center gap-2">
            <button onClick={onBack} className="w-9 h-9 shrink-0 rounded-full bg-white/80 shadow-sm text-rose-400 text-xl active:scale-90 transition-transform">‹</button>
            <div className="text-center min-w-0">
              <div className="flex items-center justify-center gap-1.5 text-rose-400">
                <SparkLines className="w-3.5 h-3.5" />
                <span className="font-black tracking-[.3em] pl-[.3em] text-[#e2577f] text-[19px]">大富翁</span>
                <SparkLines flip className="w-3.5 h-3.5" />
              </div>
              <div className="text-[10px] text-rose-300 mt-0.5 truncate">
                {inGame ? `回合 ${g.turnCount}/${g.totalRounds}` : '未开局'} · {shown.intensity} · 局长{inGame ? g.totalRounds : shown.rounds}
              </div>
            </div>
            <button onClick={() => setShowSettings(true)} aria-label="功能型选项" className="w-10 h-10 rounded-full bg-gradient-to-br from-[#fde4ea] to-[#fbd0dc] ring-2 ring-white shadow-[0_6px_14px_rgba(240,110,145,.22)] text-[20px] flex items-center justify-center active:scale-90 transition-transform">😈</button>
          </div>
          <div className="mt-1.5 flex justify-center gap-2">
            <button onClick={() => execCmd('bird 我', 'user')} disabled={!(g.phase === 'playing' || g.phase === 'lock')} aria-label="飞鸟：立刻停止游戏"
              className="h-8 px-3.5 shrink-0 rounded-full bg-[#eaf3fc] border border-[#c9def4] text-[#5b8fc7] text-[11px] font-black shadow-sm active:scale-90 transition-transform disabled:opacity-40">🕊️ 飞鸟</button>
            <button onClick={() => firstSkippable && execCmd(OWN_KINDS.includes(firstSkippable.kind) ? `skip ${n[firstSkippable.owner]}` : `skip #${firstSkippable.id}`, firstSkippable.owner)}
              disabled={g.phase !== 'playing' || !firstSkippable} aria-label="跳过当前的题"
              className="h-8 px-3.5 shrink-0 rounded-full bg-white/85 border border-rose-100 text-rose-400 text-[11px] font-black shadow-sm active:scale-90 transition-transform disabled:opacity-40">⏭️ 跳过</button>
          </div>
        </header>

        <main className="px-4 pt-2 max-w-md mx-auto" style={{ paddingBottom: chatOpen ? sheetH + 24 : 112 }}>
          <IssuesCard issues={CONTENT_ISSUES} />

          {g.phase === 'lobby' && (
            <section className="mt-6 rounded-[28px] bg-white/80 border border-white shadow-[0_12px_40px_rgba(172,88,108,.09)] p-5">
              <div className="text-[13px] font-black text-rose-500">准备开局</div>
              <div className="mt-1 text-[11px] text-slate-500 leading-5">{profiles.names.user} 和 {profiles.names.ta} 的一局；{DEALER_NAME}会自动播报每一步。</div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {(['user', 'ta'] as const).map(w => (
                  <div key={w} className="rounded-2xl bg-rose-50/60 border border-rose-100 px-3 py-2">
                    <div className="text-[11px] font-black text-slate-700 truncate">{profiles.names[w]}</div>
                    <div className={`text-[10px] ${profiles.sexes[w] ? 'text-slate-500' : 'text-amber-600 font-bold'}`}>{profiles.sexes[w] ?? '性别未识别'} · {settings.roles[w]}</div>
                  </div>
                ))}
              </div>
              <div className="mt-3 rounded-2xl bg-rose-50/70 border border-rose-100 p-3">
                <div className="text-[11px] font-bold text-rose-500">🎚️ {settings.intensity}（{INTENSITY_RANGES[settings.intensity]}）</div>
                <div className="text-[11px] leading-5 text-slate-600 mt-0.5">{INTENSITY_NOTES[settings.intensity]}</div>
              </div>
              {OPENING_REMINDER && <div className="mt-3 rounded-2xl bg-amber-50/70 border border-amber-100 p-3 text-[11px] leading-5 text-amber-700 font-semibold">{OPENING_REMINDER}</div>}
              <div className="mt-3"><PlayerIdTable profiles={profiles} roles={settings.roles} /></div>
              <div className="mt-4 flex gap-2">
                <button onClick={() => setShowSettings(true)} className="flex-1 h-11 rounded-full bg-white border border-rose-100 text-rose-400 font-bold active:scale-95 transition-transform">改设置</button>
                <button onClick={startGame} className="flex-[1.4] h-11 rounded-full bg-gradient-to-br from-[#fb9fb6] to-[#f37c9c] text-white font-bold active:scale-95 transition-transform shadow-[0_8px_20px_rgba(240,110,145,.32)]">开局</button>
              </div>
            </section>
          )}

          {inGame && (
            <>
              {settingsChanged && (
                <div className="rounded-[18px] bg-sky-50 border border-sky-200 px-3 py-2 mb-3 text-[10px] leading-4 text-sky-700">设置已改，但这局还按开局锁定的参数进行。想用新设置，点下方「重开一局」。</div>
              )}

              <div className="flex gap-2.5">
                <PlayerPanel g={g} who="user" avatar={avatars.user} active={g.turn === 'user'} exec={execCmd} />
                <PlayerPanel g={g} who="ta" avatar={avatars.ta} active={g.turn === 'ta'} exec={execCmd} />
              </div>

              <section className="mt-3 rounded-[30px] bg-white/75 border-2 border-white shadow-[0_14px_40px_rgba(172,88,108,.10)] p-2.5">
                <div className="grid grid-cols-6 grid-rows-6 gap-1 aspect-square">
                  {g.board.map((kind, i) => {
                    const [row, col] = ringPos(i);
                    const owner = g.owners[i];
                    const hereU = g.players.user.pos === i;
                    const hereT = g.players.ta.pos === i;
                    const landed = g.lastMover !== null && g.players[g.lastMover].pos === i && g.turnCount > 0;
                    return (
                      <div key={i} style={{ gridRow: row, gridColumn: col }}
                        className={`relative rounded-[12px] border flex flex-col items-center justify-center ${owner === 'user' ? 'bg-[#fde2e8] border-[#f7bccb]' : owner === 'ta' ? 'bg-[#ece3fb] border-[#d3c1f3]' : 'bg-[#fffaf6] border-[#f6e4dc]'} ${landed ? 'ring-2 ring-[#f9c86b] ring-offset-1 ring-offset-white' : ''}`}>
                        <span className="absolute top-0.5 left-1 text-[7px] text-rose-200">{i}</span>
                        <span className="text-[16px] leading-none">{CELL_ICON[kind]}</span>
                        {(hereU || hereT) && (
                          <span className="absolute -bottom-1 flex -space-x-1">
                            {hereU && <MiniAvatar src={avatars.user} label={n.user} ring="ring-rose-400" />}
                            {hereT && <MiniAvatar src={avatars.ta} label={n.ta} ring="ring-violet-400" />}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  <div style={{ gridRow: '2 / span 4', gridColumn: '2 / span 4' }} className="flex flex-col items-center justify-center text-center px-1">
                    <button onClick={handleRoll} disabled={!canRoll} aria-label="掷骰子"
                      className={`w-[72px] h-[72px] rounded-[24px] bg-gradient-to-br from-white to-[#fdeef2] shadow-[0_10px_24px_rgba(240,110,145,.22),inset_0_-3px_0_rgba(247,184,198,.45)] border-2 flex items-center justify-center text-[44px] leading-none text-[#e2577f] transition-transform ${rolling ? 'animate-bounce border-rose-200' : 'border-white active:scale-90'} ${canRoll ? '' : 'opacity-50'}`}>
                      {DICE_FACES[diceFace]}
                    </button>
                    <div className="mt-2 text-[11px] font-bold text-rose-400 leading-4">{g.phase === 'lock' ? '确认锁定后开始' : status}</div>
                    {g.phase === 'playing' && g.cards.length > 0 && <div className="text-[9px] text-slate-400 mt-0.5">掷下一轮 = 上一题玩完了</div>}
                    <div className="mt-2 flex gap-2 text-[8px] text-slate-400">
                      <span className="flex items-center gap-0.5"><span className="w-2 h-2 rounded-full bg-[#fde2e8] border border-[#f7bccb]" />{n.user}的地盘</span>
                      <span className="flex items-center gap-0.5"><span className="w-2 h-2 rounded-full bg-[#ece3fb] border border-[#d3c1f3]" />{n.ta}的地盘</span>
                    </div>
                  </div>
                </div>
              </section>

              {g.cards.length > 0 && <div className="mt-3 space-y-3">{g.cards.map(c => <TaskCardView key={c.id} g={g} c={c} exec={execCmd} />)}</div>}

              {g.phase === 'playing' && g.pendingDuel && !g.cards.some(c => c.kind === 'duel') && (
                <section className="mt-3 rounded-[24px] bg-white border border-rose-100 p-4">
                  <div className="text-[12px] font-black text-rose-500">⚔️ 同格对决</div>
                  <div className="mt-1 text-[11px] leading-5 text-slate-500">{DUEL_HINT}</div>
                  <div className="mt-3 flex gap-2 flex-wrap">
                    <CmdButton label={`${n.user} 赢了`} cmd={`duel ${n.user}`} onClick={() => execCmd(`duel ${n.user}`, 'user')} />
                    <CmdButton label={`${n.ta} 赢了`} cmd={`duel ${n.ta}`} onClick={() => execCmd(`duel ${n.ta}`, 'user')} />
                  </div>
                </section>
              )}

              {g.phase === 'playing' && g.pendingToll && !g.cards.some(c => c.kind === 'toll') && (
                <section className="mt-3 rounded-[24px] bg-white border border-rose-100 p-4">
                  <div className="text-[12px] font-black text-rose-500">🚩 {n[g.pendingToll.who]} 欠 {n[g.pendingToll.landlord]} 过路费 {g.pendingToll.fee} 币</div>
                  <div className="mt-1 text-[10px] text-slate-400">不管它的话，下次掷骰默认交钱（钱不够不扣）。</div>
                  <div className="mt-3 flex gap-2 flex-wrap">
                    {!g.pendingToll.serveOnly && <CmdButton label="交钱" cmd="pay" onClick={() => execCmd('pay', g.pendingToll!.who)} />}
                    <CmdButton label="做了差遣" cmd="serve" onClick={() => execCmd('serve', g.pendingToll!.who)} />
                  </div>
                </section>
              )}

              {shopWho && (
                <section className="mt-3 rounded-[22px] bg-white/80 border border-white p-3">
                  <div className="text-[12px] font-black text-rose-500">🛒 {n[shopWho]} 在商店</div>
                  <div className="mt-2 flex gap-2">
                    <CmdButton label={`随机摸一张 · ${cardPrice(g, shopWho)} 币`} cmd="buy" onClick={() => execCmd(`buy ${n[shopWho]}`, shopWho)} />
                  </div>
                </section>
              )}

              {g.phase === 'playing' && g.chanceSwapOffer === 'user' && (
                <section className="mt-3 rounded-[22px] bg-white/80 border border-white p-3">
                  <div className="text-[11px] text-slate-500">🎴 身份才玩了没几轮，默认保留。就是想换：</div>
                  <div className="mt-2 flex gap-2">
                    <CmdButton label={me.swapIdentityNext ? '下次掷骰换身份 ✓' : '下次掷骰换掉'} cmd="swapid" disabled={me.swapIdentityNext} onClick={() => execCmd(`swapid ${n.user}`, 'user')} />
                  </div>
                </section>
              )}

              {/* 我的身份技能 */}
              {g.phase === 'playing' && (hasEff('user', 'gamble_guess') || hasEff('user', 'extra_task') || hasEff('user', 'declare_persona') || hasEff('user', 'id_event_reward') || hasEff('user', 'id_event_penalty') || (g.players.ta.markSpot && !g.players.ta.markFound)) && (
                <section className="mt-3 rounded-[22px] bg-white/80 border border-white p-3">
                  <div className="text-[11px] font-black text-rose-500 mb-2">🎭 {n.user} 的身份技能</div>
                  <div className="flex gap-2 flex-wrap">
                    {hasEff('user', 'gamble_guess') && <>
                      <CmdButton label={me.guessNext === '大' ? '押大 ✓' : '押大'} cmd="guess 大" disabled={g.turn !== 'user'} onClick={() => execCmd(`guess 大 ${n.user}`, 'user')} />
                      <CmdButton label={me.guessNext === '小' ? '押小 ✓' : '押小'} cmd="guess 小" disabled={g.turn !== 'user'} onClick={() => execCmd(`guess 小 ${n.user}`, 'user')} />
                    </>}
                    {hasEff('user', 'extra_task') && <CmdButton label="加餐" cmd="extra" disabled={!!g.pending.user} onClick={() => execCmd(`extra ${n.user}`, 'user')} />}
                    {(identityOf(g, 'user')?.effects || []).filter(e => e.type === 'id_event_reward' || e.type === 'id_event_penalty').map(e => (
                      <CmdButton key={String(e.event)} label={e.event === 'first_climax' ? '首次高潮' : e.event === 'say_banned' ? '说了禁词' : e.event === 'no_kiss_2turns' ? '两轮没亲到' : String(e.event)} cmd={`idevent ${e.event}`}
                        disabled={e.type === 'id_event_reward' && !!e.once && g.idEventsUsed.includes(`user:${e.event}`)} onClick={() => execCmd(`idevent ${n.user} ${e.event}`, 'user')} />
                    ))}
                  </div>
                  {hasEff('user', 'declare_persona') && (
                    <div className="mt-2 flex gap-2">
                      <input value={personaDraft} onChange={e => setPersonaDraft(e.target.value)} placeholder="宣布背德身份，如 老师" className="flex-1 min-w-0 h-9 rounded-xl bg-rose-50/60 border border-rose-100 px-3 text-[12px] outline-none" />
                      <button onClick={() => { if (personaDraft.trim()) { execCmd(`persona ${n.user} ${personaDraft.trim()}`, 'user'); setPersonaDraft(''); } }} className="h-9 px-3 rounded-xl bg-rose-400 text-white text-[12px] font-bold">宣布</button>
                    </div>
                  )}
                  {g.players.ta.markSpot && !g.players.ta.markFound && (
                    <div className="mt-2">
                      <div className="text-[10px] text-slate-400 mb-1">🌀 {n.ta} 身上藏着淫纹，每轮猜一处{me.markGuessed ? '（这轮猜过了）' : ''}：</div>
                      <div className="flex gap-1.5 flex-wrap">
                        {MARK_PARTS.map(part => (
                          <button key={part} onClick={() => setMarkPick(part)} className={`px-2 py-1 rounded-lg text-[11px] font-bold ${markPick === part ? 'bg-violet-400 text-white' : 'bg-violet-50 text-violet-500 border border-violet-100'}`}>{part}</button>
                        ))}
                        <button disabled={!markPick || me.markGuessed} onClick={() => { execCmd(`mark ${n.user} ${markPick}`, 'user'); setMarkPick(''); }} className="px-3 py-1 rounded-lg text-[11px] font-bold bg-rose-400 text-white disabled:opacity-40">摸这里</button>
                      </div>
                    </div>
                  )}
                </section>
              )}

              {g.phase === 'over' && (
                <section className="mt-3 rounded-[24px] bg-white border border-rose-100 p-4">
                  <div className="text-[13px] font-black text-rose-500 text-center">🏁 {g.totalRounds} 回合结束</div>
                  {g.finalText && <div className="mt-2 text-[12px] leading-6 text-slate-700 whitespace-pre-wrap">{g.finalText}</div>}
                  <div className="mt-3 flex gap-2 flex-wrap">
                    {g.players.user.coins === g.players.ta.coins && <CmdButton label="加掷决胜" cmd="tiebreak" onClick={() => execCmd('tiebreak', 'user')} />}
                    <CmdButton label="再开一局" cmd="新局" tone="primary" onClick={backToLobby} />
                  </div>
                </section>
              )}

              <div className="mt-4 text-center">
                {confirmReset ? (
                  <div className="inline-flex items-center gap-2 text-[11px]">
                    <span className="text-slate-500">这局会作废，确定？</span>
                    <button onClick={backToLobby} className="px-3 py-1 rounded-full bg-rose-400 text-white font-bold">重开</button>
                    <button onClick={() => setConfirmReset(false)} className="px-3 py-1 rounded-full bg-slate-100 text-slate-500 font-bold">算了</button>
                  </div>
                ) : (
                  <button onClick={() => setConfirmReset(true)} className="text-[11px] text-rose-300 underline underline-offset-2">重开一局</button>
                )}
              </div>
            </>
          )}
        </main>
      </div>

      <ChatCard g={g} chat={chat} open={chatOpen} onToggle={() => { setChatOpen(v => !v); setUnread(0); }} onSend={handleSend} onAskTa={askTa} taHint={taHint && inGame} typing={typing} aiMissing={aiMissing} avatars={avatars} unread={unread} height={sheetH} onHeight={setSheetH} />

      {g.phase === 'lock' && (
        <div className="absolute inset-0 z-[79] bg-[#fbe3ea]/55 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="w-full max-w-md rounded-[30px] bg-white/95 border-2 border-white p-5 shadow-[0_20px_50px_rgba(200,100,130,.25)]">
            <div className="flex items-center gap-1.5 text-rose-400"><SparkLines className="w-3.5 h-3.5" /><span className="text-[15px] font-black text-[#e2577f]">开局前确认一下</span><SparkLines flip className="w-3.5 h-3.5" /></div>
            <div className="mt-1 text-[11px] text-slate-500 leading-5">引擎实际生效的参数如下。和你在设置里选的不一样，就是参数没填对，重开。</div>
            <div className="mt-3 max-h-[40vh] overflow-auto rounded-[20px] bg-[#fff7f3] border border-[#f6e1d8] text-[#6b5357] text-[12px] leading-6 p-3.5 whitespace-pre-wrap break-words">{dealerText([g.lockLine])}</div>
            <div className={`mt-2 text-[11px] font-bold ${settingsChanged ? 'text-amber-600' : 'text-emerald-600'}`}>{settingsChanged ? '❌ 和当前设置不一致，建议重开' : '✅ 和当前设置一致'}</div>
            <div className="mt-4 flex gap-2">
              <button onClick={backToLobby} className="flex-1 h-11 rounded-full bg-white border border-rose-100 text-rose-400 font-bold active:scale-95">不符，重开</button>
              <button onClick={() => execCmd('confirm', 'user', { quiet: true })} disabled={settingsChanged} className="flex-[1.4] h-11 rounded-full bg-gradient-to-br from-[#fb9fb6] to-[#f37c9c] text-white font-bold shadow-[0_6px_14px_rgba(240,110,145,.3)] active:scale-95 disabled:opacity-40">确认，开始</button>
            </div>
          </div>
        </div>
      )}

      {g.phase === 'stopped' && (
        <div className="absolute inset-0 z-[79] bg-[#cfe2f5]/60 backdrop-blur-md flex items-center justify-center p-6">
          <div className="w-full max-w-xs rounded-[30px] bg-white/95 border-2 border-white p-6 text-center shadow-[0_20px_50px_rgba(90,130,180,.25)]">
            <div className="text-[44px] leading-none">🕊️</div>
            <div className="mt-3 text-[16px] font-black text-[#5b8fc7]">游戏停下了</div>
            <div className="mt-1 text-[11px] text-slate-400">{g.stoppedBy ? `${n[g.stoppedBy]} 按下了` : ''}</div>
            <div className="mt-3 text-[12px] leading-5 text-slate-600">{BIRD_TEXT}</div>
            <div className="mt-5 flex flex-col gap-2">
              <button onClick={() => execCmd('resume', 'user', { quiet: true })} className="h-11 rounded-2xl bg-sky-50 border border-sky-200 text-sky-700 font-bold active:scale-95">继续这局</button>
              <button onClick={backToLobby} className="h-11 rounded-2xl bg-slate-100 text-slate-500 font-bold active:scale-95">结束本局</button>
            </div>
          </div>
        </div>
      )}

      {showSettings && <GameSettingsPage initialTaApi={taApi} initial={settings} profiles={profiles} detected={detected} initialSexOverride={sexOverride} onBack={() => setShowSettings(false)} onSave={handleSaveSettings} />}
    </div>
  );
};

export default MonopolyGame;
