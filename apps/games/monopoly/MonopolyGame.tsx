// ═══════════════════════════════════════════════════════════════════════════
// ⛔ 大富翁 · 页面（设置页 + 游戏页 + 文字卡片），不需要改
//   要改的内容在 content.ts（数值、文字、模型）和 prompts.ts（提示词）。
//   这个组件只依赖 App 的 useOS / DB，在游戏大厅里由 ../registry.ts 打开。
// ═══════════════════════════════════════════════════════════════════════════

import React, { useEffect, useRef, useState } from 'react';
import { useOS } from '../../../context/OSContext';
import { DB } from '../../../utils/db';
import { callGameAI } from '../shared/ai';
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
  buildDealerMessages, buildDealerSystem, buildTaMessages, buildTaSystem, isBirdWord, parseTaActions,
  type ChatEntry, type ChatFrom,
} from './prompts';
import type { MonopolySettings, Profiles, Sex, Who } from './types';

const DICE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

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

const CmdButton: React.FC<{ label: string; cmd: string; onClick: () => void; tone?: 'primary' | 'plain' | 'warn'; disabled?: boolean }> = ({ label, cmd, onClick, tone = 'plain', disabled }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`flex-1 min-w-[92px] rounded-2xl px-2 py-2 flex flex-col items-center gap-0.5 transition-transform ${disabled ? 'opacity-40' : 'active:scale-95'} ${tone === 'primary' ? 'bg-rose-400 text-white shadow-[0_6px_18px_rgba(225,110,140,.3)]' : tone === 'warn' ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-white text-rose-500 border border-rose-100'}`}
  >
    <span className="text-[12px] font-bold">{label}</span>
    <span className={`text-[8px] font-mono ${tone === 'primary' ? 'text-rose-100' : 'text-slate-400'}`}>{cmd}</span>
  </button>
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
  onSave: (s: MonopolySettings, sexOverride: SexOverride) => void;
  initial: MonopolySettings;
  profiles: Profiles;
  detected: Record<Who, { sex: Sex | null; from: string }>;
  initialSexOverride: SexOverride;
}> = ({ onBack, onSave, initial, profiles, detected, initialSexOverride }) => {
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
  const handleSave = () => { saveSettings(settings); onSave(settings, sexOverride); onBack(); };
  const activeRange = parseRange(INTENSITY_RANGES[settings.intensity]);
  const names = profiles.names;

  return (
    <div className="absolute inset-0 z-[80] bg-[#fff7f5] text-slate-800">
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_15%_10%,rgba(255,190,205,.42),transparent_28%),radial-gradient(circle_at_90%_25%,rgba(255,220,224,.5),transparent_30%),linear-gradient(180deg,#fffafa_0%,#fff4f1_100%)]" />
      <div className="relative h-full overflow-y-auto overscroll-none" style={{ paddingTop: 'var(--safe-top)' }}>
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

          <div className="mb-2"><PlayerIdTable profiles={draftProfiles} roles={settings.roles} /></div>
          <div className="text-[9px] text-rose-300 text-center">↑ 保存后下一局按这些参数开</div>
        </main>
      </div>

      <div className="absolute bottom-0 inset-x-0 px-4 pt-3 bg-white/90 backdrop-blur-xl border-t border-rose-100" style={{ paddingBottom: 'max(14px, var(--safe-bottom))' }}>
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
    <div className={`flex-1 min-w-0 rounded-[22px] p-3 border transition-colors ${active ? 'bg-white border-rose-200 shadow-[0_8px_22px_rgba(225,110,140,.14)]' : 'bg-white/60 border-white'}`}>
      <div className="flex items-center gap-2">
        <div className={`w-11 h-11 shrink-0 rounded-full overflow-hidden bg-rose-50 ring-2 ${who === 'user' ? 'ring-rose-300' : 'ring-violet-300'}`}>
          {avatar ? <img src={avatar} alt={name} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-rose-300">♡</div>}
        </div>
        <div className="min-w-0">
          <div className={`text-[12px] font-black truncate ${tint}`}>{name}{active && playing ? ' · 掷骰' : ''}</div>
          <div className="text-[10px] text-slate-400">{g.profiles.sexes[who] ?? '?'} · {g.settings.roles[who]}{g.settings.pureTop[who] ? ' · 纯top' : ''}</div>
          <div className="text-[11px] text-amber-600 font-bold">🪙 {p.coins} <span className="text-slate-400 font-semibold">· 地盘 {land} · 第{p.lap + 1}圈</span></div>
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
  return (
    <div className="rounded-[20px] bg-white border border-rose-100 shadow-[0_10px_30px_rgba(172,88,108,.12)] p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] font-black text-rose-500">
          {CARD_LABEL[c.kind]} · {LEVEL_MARKS[c.level - 1]}{LEVEL_NAMES[c.level - 1]}
          {c.pool === 'task' && <span className="ml-1 text-[10px] font-bold text-slate-400">{c.type}</span>}
        </div>
        <div className="text-[10px] text-slate-400 shrink-0">记在 {n[c.owner]} 头上</div>
      </div>
      <div className="mt-1 text-[10px] text-slate-400">
        {c.dir} · <span className={c.label.startsWith('🔄') ? 'text-amber-600 font-bold' : ''}>{c.label}</span>
        {reward !== null && ` · 做完 +${reward} 币`}
      </div>
      <div className="mt-2 text-[14px] leading-6 text-slate-700 whitespace-pre-wrap">{c.text}</div>
      {c.note && <div className="mt-1.5 text-[10px] leading-4 text-slate-400">{c.note}</div>}
      {c.actor === 'ta' && <div className="mt-2 text-[10px] text-violet-400">这道由 {n.ta} 来做；在文字卡片里看 TA 的回应。</div>}

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
  );
};

// ─── 文字卡片（荷官 / TA / 我） ─────────────────────────────────────────────

const ChatCard: React.FC<{
  g: GameState;
  chat: ChatEntry[];
  open: boolean;
  onToggle: () => void;
  onSend: (text: string, to: 'ta' | 'dealer') => void;
  typing: 'dealer' | 'ta' | null;
  aiMissing: boolean;
  avatars: Record<Who, string | null | undefined>;
  unread: number;
}> = ({ g, chat, open, onToggle, onSend, typing, aiMissing, avatars, unread }) => {
  const [draft, setDraft] = useState('');
  const [to, setTo] = useState<'ta' | 'dealer'>('ta');
  const [tab, setTab] = useState<'chat' | 'engine'>('chat');
  const endRef = useRef<HTMLDivElement | null>(null);
  const n = g.profiles.names;
  useEffect(() => { if (open) endRef.current?.scrollIntoView({ block: 'end' }); }, [open, chat.length, tab, typing]);
  const send = () => { const t = draft.trim(); if (!t) return; onSend(t, to); setDraft(''); };
  const last = [...chat].reverse().find(e => e.from === 'dealer' || e.from === 'ta');

  if (!open) {
    return (
      <div className="absolute right-3 z-[76] flex items-end gap-2 max-w-[86%]" style={{ bottom: 'max(16px, var(--safe-bottom))' }}>
        {last && unread > 0 && (
          <button onClick={onToggle} className="min-w-0 max-w-[230px] text-left rounded-2xl rounded-br-md bg-white/95 border border-rose-100 shadow-[0_8px_24px_rgba(172,88,108,.16)] px-3 py-2">
            <div className={`text-[10px] font-black ${last.from === 'ta' ? 'text-violet-500' : 'text-slate-500'}`}>{last.from === 'ta' ? `💞 ${n.ta}` : `🎩 ${DEALER_NAME}`}</div>
            <div className="text-[11px] text-slate-600 leading-4 line-clamp-2">{last.text}</div>
          </button>
        )}
        <button onClick={onToggle} aria-label="打开文字卡片" className="relative w-12 h-12 shrink-0 rounded-full bg-rose-400 text-white text-[20px] shadow-[0_8px_24px_rgba(225,110,140,.4)] active:scale-90 transition-transform">
          💬
          {unread > 0 && <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-white text-rose-500 text-[10px] font-black flex items-center justify-center border border-rose-200">{unread > 9 ? '9+' : unread}</span>}
        </button>
      </div>
    );
  }

  return (
    <div className="absolute inset-x-0 bottom-0 z-[76] px-2" style={{ paddingBottom: 'max(8px, var(--safe-bottom))' }}>
      <div className="max-w-md mx-auto h-[62vh] rounded-[26px] bg-white/97 border border-rose-100 shadow-[0_-10px_40px_rgba(172,88,108,.2)] flex flex-col overflow-hidden">
        <div className="px-3 pt-2.5 pb-2 flex items-center gap-2 border-b border-rose-50">
          <div className="flex gap-1 bg-rose-50/70 rounded-full p-0.5">
            {([['chat', '对话'], ['engine', '引擎原文']] as const).map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} className={`px-3 py-1 rounded-full text-[11px] font-bold ${tab === k ? 'bg-white text-rose-500 shadow-sm' : 'text-rose-300'}`}>{label}</button>
            ))}
          </div>
          <div className="ml-auto" />
          <button onClick={onToggle} aria-label="收起" className="w-8 h-8 rounded-full bg-slate-100 text-slate-500 text-[14px] active:scale-90">˅</button>
        </div>

        {aiMissing && (
          <div className="mx-3 mt-2 rounded-xl bg-amber-50 border border-amber-200 px-2.5 py-1.5 text-[10px] leading-4 text-amber-700">
            没读到 API 配置（App 设置里的地址或模型为空）：{DEALER_NAME}位置先显示引擎原文，{n.ta} 暂时不说话。
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
          {tab === 'engine' && g.log.map(line => (
            line.kind === 'cmd'
              ? <div key={line.id} className="text-[9px] font-mono text-slate-400 px-1">{line.text}</div>
              : <pre key={line.id} className={`rounded-xl px-2.5 py-2 text-[11px] leading-[1.55] whitespace-pre-wrap break-words font-mono ${line.kind === 'error' ? 'bg-amber-50 text-amber-800 border border-amber-200' : 'bg-slate-50 text-slate-700 border border-slate-100'}`}>{line.text}</pre>
          ))}
          {tab === 'chat' && chat.filter(e => e.from !== 'engine').map(e => {
            if (e.from === 'system') return <div key={e.id} className="text-center text-[10px] text-amber-600 bg-amber-50/70 rounded-lg px-2 py-1 whitespace-pre-wrap">{e.text}</div>;
            if (e.from === 'dealer') return (
              <div key={e.id} className="rounded-2xl bg-slate-50 border border-slate-100 px-3 py-2">
                <div className="text-[10px] font-black text-slate-500 mb-0.5">🎩 {DEALER_NAME}</div>
                <div className="text-[12px] leading-5 text-slate-700 whitespace-pre-wrap break-words">{e.text}</div>
              </div>
            );
            if (e.from === 'ta') return (
              <div key={e.id} className="flex items-start gap-2 pr-6">
                <MiniAvatar src={avatars.ta} label={n.ta} ring="ring-violet-300" />
                <div className="rounded-2xl rounded-tl-md bg-violet-50 border border-violet-100 px-3 py-2 text-[13px] leading-6 text-slate-700 whitespace-pre-wrap break-words">{e.text}</div>
              </div>
            );
            return (
              <div key={e.id} className="flex justify-end pl-8">
                <div className="rounded-2xl rounded-tr-md bg-rose-400 text-white px-3 py-2 text-[13px] leading-6 whitespace-pre-wrap break-words">
                  {e.to === 'dealer' && <span className="block text-[9px] text-rose-100">问{DEALER_NAME}</span>}
                  {e.text}
                </div>
              </div>
            );
          })}
          {tab === 'chat' && typing && (
            <div className="text-[10px] text-slate-400 px-1">{typing === 'ta' ? `💞 ${n.ta} 正在回应…` : `🎩 ${DEALER_NAME} 正在播报…`}</div>
          )}
          <div ref={endRef} />
        </div>

        <div className="px-2.5 pt-2 pb-2.5 border-t border-rose-50">
          <div className="flex gap-1 mb-1.5">
            <button onClick={() => setTo('ta')} className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold ${to === 'ta' ? 'bg-violet-100 text-violet-600' : 'text-slate-400'}`}>对{n.ta}说</button>
            <button onClick={() => setTo('dealer')} className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold ${to === 'dealer' ? 'bg-slate-200 text-slate-600' : 'text-slate-400'}`}>问{DEALER_NAME}</button>
            <span className="ml-auto text-[9px] text-slate-300 self-center">打「飞鸟」或「404」立刻停</span>
          </div>
          <div className="flex gap-2 items-end">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              rows={1}
              placeholder={to === 'ta' ? '做了什么、说了什么，写给 TA…' : '问荷官规则或现在的状态…'}
              className="flex-1 min-w-0 max-h-24 resize-none rounded-2xl bg-rose-50/60 border border-rose-100 px-3 py-2 text-[13px] leading-5 outline-none focus:border-rose-300"
            />
            <button onClick={send} className="h-9 px-4 rounded-2xl bg-rose-400 text-white text-[12px] font-bold active:scale-95 shrink-0">发送</button>
          </div>
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

  // 荷官播报（可选）→ TA 回应（可选）→ 执行 TA 的标签
  const runLines = (engineEntryId: number | null, opts: { dealer: boolean; ta: boolean }) => {
    enqueue(async () => {
      const historyExcept = () => chatRef.current.filter(e => e.id !== engineEntryId);
      const engineText = engineEntryId ? chatRef.current.find(e => e.id === engineEntryId)?.text ?? '' : '';

      if (opts.dealer) {
        setTyping('dealer');
        const g = gameRef.current;
        const reply = await callGameAI({
          api: apiConfig, override: DEALER_API, label: DEALER_NAME, temperature: AI_TEMPERATURE.dealer,
          system: buildDealerSystem(g), messages: buildDealerMessages(g, historyExcept(), engineText),
        });
        setTyping(null);
        if (reply === null) {
          setAiMissing(true);
          if (engineText) pushChat('dealer', engineText);
        } else if (reply) {
          setAiMissing(false);
          pushChat('dealer', reply);
          if (CHAT_MIRROR.dealer) mirrorSystem(`${DEALER_NAME}：${reply}`);
        }
      }

      if (opts.ta) {
        setTyping('ta');
        const g = gameRef.current;
        const reply = await callGameAI({
          api: apiConfig, override: { model: TA_MODEL }, label: g.profiles.names.ta, temperature: AI_TEMPERATURE.ta,
          system: buildTaSystem(g), messages: buildTaMessages(g, chatRef.current, ''),
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
      }
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
      const entry = pushChat('engine', engineText);
      if (!opts.quiet) runLines(entry.id, { dealer: true, ta: !opts.fromTA });
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
    if (to === 'dealer') runLines(null, { dealer: true, ta: false });
    else runLines(null, { dealer: false, ta: true });
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
    const entry = pushChat('engine', g.log.filter(l => l.kind === 'engine').map(l => l.text).join('\n'));
    runLines(entry.id, { dealer: true, ta: true });
  };
  const backToLobby = () => {
    const g = gameRef.current;
    if (g.phase !== 'lobby' && g.phase !== 'lock' && g.phase !== 'over' && g.turnCount > 0) saveSeen(charId, g);
    commitGame(createLobby(settings, profiles));
    setConfirmReset(false);
  };
  const handleSaveSettings = (s: MonopolySettings, so: SexOverride) => {
    setSettings(s);
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
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_15%_10%,rgba(255,190,205,.42),transparent_28%),radial-gradient(circle_at_90%_25%,rgba(255,220,224,.5),transparent_30%),linear-gradient(180deg,#fffafa_0%,#fff4f1_100%)]" />
      <div className="relative h-full overflow-y-auto overscroll-none" style={{ paddingTop: 'var(--safe-top)' }}>
        <header className="px-3 pt-2 pb-1">
          <div className="h-12 grid grid-cols-[auto_1fr_auto] items-center gap-2">
            <button onClick={onBack} className="w-9 h-9 shrink-0 rounded-full bg-white/80 shadow-sm text-rose-400 text-xl active:scale-90 transition-transform">‹</button>
            <div className="text-center min-w-0">
              <div className="font-black tracking-[.18em] text-rose-500 text-base">大富翁</div>
              <div className="text-[8px] tracking-[.12em] text-rose-300 mt-0.5 truncate">
                {inGame ? `回合 ${g.turnCount}/${g.totalRounds}` : '未开局'} · {shown.intensity} · 局长{inGame ? g.totalRounds : shown.rounds}
              </div>
            </div>
            <button onClick={() => setShowSettings(true)} aria-label="功能型选项" className="w-9 h-9 rounded-full bg-white/80 shadow-sm text-[18px] flex items-center justify-center active:scale-90 transition-transform">😄</button>
          </div>
          <div className="mt-1.5 flex justify-center gap-2">
            <button onClick={() => execCmd('bird 我', 'user')} disabled={!(g.phase === 'playing' || g.phase === 'lock')} aria-label="飞鸟：立刻停止游戏"
              className="h-8 px-3.5 shrink-0 rounded-full bg-sky-50 border border-sky-200 text-sky-600 text-[11px] font-black shadow-sm active:scale-90 transition-transform disabled:opacity-40">🕊️ 飞鸟</button>
            <button onClick={() => firstSkippable && execCmd(OWN_KINDS.includes(firstSkippable.kind) ? `skip ${n[firstSkippable.owner]}` : `skip #${firstSkippable.id}`, firstSkippable.owner)}
              disabled={g.phase !== 'playing' || !firstSkippable} aria-label="跳过当前的题"
              className="h-8 px-3.5 shrink-0 rounded-full bg-white/85 border border-rose-100 text-rose-400 text-[11px] font-black shadow-sm active:scale-90 transition-transform disabled:opacity-40">⏭️ 跳过</button>
          </div>
        </header>

        <main className="px-4 pt-2 pb-28 max-w-md mx-auto">
          <IssuesCard issues={CONTENT_ISSUES} />

          {g.phase === 'lobby' && (
            <section className="mt-6 rounded-[28px] bg-white/80 border border-white shadow-[0_12px_40px_rgba(172,88,108,.09)] p-5">
              <div className="text-[13px] font-black text-rose-500">准备开局</div>
              <div className="mt-1 text-[11px] text-slate-500 leading-5">{profiles.names.user} 和 {profiles.names.ta} 对局；{DEALER_NAME}只负责播报引擎。</div>
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
                <button onClick={() => setShowSettings(true)} className="flex-1 h-11 rounded-2xl bg-white border border-rose-100 text-rose-400 font-bold active:scale-95 transition-transform">改设置</button>
                <button onClick={startGame} className="flex-[1.4] h-11 rounded-2xl bg-rose-400 text-white font-bold active:scale-95 transition-transform shadow-[0_8px_24px_rgba(225,110,140,.3)]">开局</button>
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

              <section className="mt-3 rounded-[26px] bg-white/70 border border-white/90 shadow-[0_12px_40px_rgba(172,88,108,.09)] p-2.5">
                <div className="grid grid-cols-6 grid-rows-6 gap-1 aspect-square">
                  {g.board.map((kind, i) => {
                    const [row, col] = ringPos(i);
                    const owner = g.owners[i];
                    const hereU = g.players.user.pos === i;
                    const hereT = g.players.ta.pos === i;
                    const landed = g.lastMover !== null && g.players[g.lastMover].pos === i && g.turnCount > 0;
                    return (
                      <div key={i} style={{ gridRow: row, gridColumn: col }}
                        className={`relative rounded-lg border flex flex-col items-center justify-center ${owner === 'user' ? 'bg-rose-100 border-rose-300' : owner === 'ta' ? 'bg-violet-100 border-violet-300' : 'bg-white/90 border-rose-50'} ${landed ? 'ring-2 ring-amber-300' : ''}`}>
                        <span className="absolute top-0.5 left-1 text-[7px] text-slate-400 font-mono">{pad2(i)}</span>
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
                      className={`w-[70px] h-[70px] rounded-3xl bg-white shadow-[0_8px_24px_rgba(172,88,108,.18)] border-2 flex items-center justify-center text-[42px] leading-none transition-transform ${rolling ? 'animate-bounce border-rose-200' : 'border-rose-100 active:scale-90'} ${canRoll ? '' : 'opacity-50'}`}>
                      {DICE_FACES[diceFace]}
                    </button>
                    <div className="mt-2 text-[11px] font-bold text-rose-400 leading-4">{g.phase === 'lock' ? '确认锁定后开始' : status}</div>
                    {g.phase === 'playing' && g.cards.length > 0 && <div className="text-[9px] text-slate-400 mt-0.5">掷下一轮 = 上一题玩完了</div>}
                    <div className="mt-2 flex gap-2 text-[8px] text-slate-400">
                      <span className="flex items-center gap-0.5"><span className="w-2 h-2 rounded-sm bg-rose-200 border border-rose-300" />{n.user}</span>
                      <span className="flex items-center gap-0.5"><span className="w-2 h-2 rounded-sm bg-violet-200 border border-violet-300" />{n.ta}</span>
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

      <ChatCard g={g} chat={chat} open={chatOpen} onToggle={() => { setChatOpen(v => !v); setUnread(0); }} onSend={handleSend} typing={typing} aiMissing={aiMissing} avatars={avatars} unread={unread} />

      {g.phase === 'lock' && (
        <div className="absolute inset-0 z-[75] bg-black/30 flex items-end sm:items-center justify-center p-4">
          <div className="w-full max-w-md rounded-[28px] bg-white p-5 shadow-2xl">
            <div className="text-[14px] font-black text-rose-500">🔒 开局锁定 · 请确认</div>
            <div className="mt-1 text-[11px] text-slate-500 leading-5">引擎实际生效的参数如下。和你在设置里选的不一样，就是参数没填对，重开。</div>
            <pre className="mt-3 max-h-[40vh] overflow-auto rounded-2xl bg-slate-800 text-rose-100 text-[10px] leading-5 p-3 whitespace-pre-wrap break-words font-mono">{g.lockLine}</pre>
            <div className={`mt-2 text-[11px] font-bold ${settingsChanged ? 'text-amber-600' : 'text-emerald-600'}`}>{settingsChanged ? '❌ 和当前设置不一致，建议重开' : '✅ 和当前设置一致'}</div>
            <div className="mt-4 flex gap-2">
              <button onClick={backToLobby} className="flex-1 h-11 rounded-2xl bg-slate-100 text-slate-500 font-bold active:scale-95">不符，重开</button>
              <button onClick={() => execCmd('confirm', 'user', { quiet: true })} disabled={settingsChanged} className="flex-[1.4] h-11 rounded-2xl bg-rose-400 text-white font-bold active:scale-95 disabled:opacity-40">确认，开始</button>
            </div>
          </div>
        </div>
      )}

      {g.phase === 'stopped' && (
        <div className="absolute inset-0 z-[78] bg-sky-900/40 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="w-full max-w-xs rounded-[28px] bg-white p-6 text-center shadow-2xl">
            <div className="text-[44px] leading-none">🕊️</div>
            <div className="mt-3 text-[16px] font-black text-sky-700">飞鸟 · 游戏已停</div>
            <div className="mt-1 text-[11px] text-slate-400">{g.stoppedBy ? `${n[g.stoppedBy]} 按下了` : ''}</div>
            <div className="mt-3 text-[12px] leading-5 text-slate-600">{BIRD_TEXT}</div>
            <div className="mt-5 flex flex-col gap-2">
              <button onClick={() => execCmd('resume', 'user', { quiet: true })} className="h-11 rounded-2xl bg-sky-50 border border-sky-200 text-sky-700 font-bold active:scale-95">继续这局</button>
              <button onClick={backToLobby} className="h-11 rounded-2xl bg-slate-100 text-slate-500 font-bold active:scale-95">结束本局</button>
            </div>
          </div>
        </div>
      )}

      {showSettings && <GameSettingsPage initial={settings} profiles={profiles} detected={detected} initialSexOverride={sexOverride} onBack={() => setShowSettings(false)} onSave={handleSaveSettings} />}
    </div>
  );
};

export default MonopolyGame;
