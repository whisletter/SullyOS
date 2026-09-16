
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowClockwise, CalendarBlank, CaretLeft, CaretRight, Camera, Check, X } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { GAMES } from './games/registry';
import {
  YUZHOU_MOOD_EVENT,
  loadDayMood,
  loadMonthMoods,
  saveDayMood,
  generateTaDailyMood,
  type MonthMoods,
  type MoodSide,
  type YuZhouMoodEventDetail,
} from '../utils/yuzhouMood';

const ANNIVERSARY_KEY = 'yuzhou_anniversary_day';
// 记录"保存天数"那天的本地日期（YYYY-MM-DD），用于之后每天自动累加
const ANNIVERSARY_BASE_DATE_KEY = 'yuzhou_anniversary_base_date';
const USER_MOOD_KEY = 'yuzhou_user_mood';
const USER_EMOJI_KEY = 'yuzhou_user_emoji';

const EMOJIS = ['😊', '🥰', '😸', '😠', '😢', '😣', '😾', '😎', '😳', '🤧', '😈', '😼'];
const USER_MOOD_MIGRATED_KEY = 'yuzhou_user_mood_migrated';
const DEFAULT_USER_EMOJI = '🥰';

// 戳一下 TA 的 emoji：只播动画，不改内容
const POKE_CSS = `
@keyframes yz-poke {
  0% { transform: scale(1) rotate(0); }
  20% { transform: scale(.82) rotate(-10deg); }
  45% { transform: scale(1.14) rotate(8deg); }
  65% { transform: scale(.96) rotate(-4deg); }
  85% { transform: scale(1.03) rotate(2deg); }
  100% { transform: scale(1) rotate(0); }
}
@keyframes yz-heart {
  0% { opacity: 0; transform: translate(-50%, 0) scale(.6); }
  25% { opacity: 1; }
  100% { opacity: 0; transform: translate(-50%, -34px) scale(1.1); }
}
.yz-poke { animation: yz-poke .55s ease-out; display: inline-block; }
.yz-heart { animation: yz-heart .8s ease-out forwards; }
`;

const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

const storageGet = (key: string, fallback = '') => {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
};
const storageSet = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
};

// ---- 纪念日自动计数 ----
const toLocalDateStr = (d: Date = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// 按本地日历日计算相差天数（用 UTC 数字比较，避免夏令时导致的 23/25 小时误差）
const diffLocalDays = (fromStr: string, to: Date = new Date()) => {
  const [y, m, d] = fromStr.split('-').map(Number);
  if (!y || !m || !d) return 0;
  const from = Date.UTC(y, m - 1, d);
  const now = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.max(0, Math.round((now - from) / 86400000));
};

const calcCurrentDay = (baseDay: string, baseDate: string) => {
  const n = parseInt(baseDay, 10) || 0;
  return String(n + diffLocalDays(baseDate));
};

// 距离下一个本地零点的毫秒数（多加 1 秒缓冲）
const msUntilNextMidnight = () => {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
  return next.getTime() - now.getTime();
};

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function cropSquare(dataUrl: string, zoom: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const side = 640;
      const canvas = document.createElement('canvas');
      canvas.width = side; canvas.height = side;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('Canvas unavailable'));
      const base = Math.max(side / img.width, side / img.height);
      const scale = base * zoom;
      const w = img.width * scale;
      const h = img.height * scale;
      const x = (side - w) / 2;
      const y = (side - h) / 2;
      ctx.drawImage(img, x, y, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

const CropModal: React.FC<{
  source: string;
  onCancel: () => void;
  onSave: (dataUrl: string) => void;
}> = ({ source, onCancel, onSave }) => {
  const [zoom, setZoom] = useState(1);
  const [saving, setSaving] = useState(false);
  const handleSave = async () => {
    setSaving(true);
    try { onSave(await cropSquare(source, zoom)); } finally { setSaving(false); }
  };
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 backdrop-blur-sm px-6">
      <div className="w-full max-w-sm rounded-[28px] bg-white p-5 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <div className="font-bold text-slate-800">裁剪头像</div>
          <button onClick={onCancel} className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center"><X size={18}/></button>
        </div>
        <div className="mx-auto w-64 h-64 rounded-full overflow-hidden bg-slate-100 ring-4 ring-pink-100 relative">
          <img src={source} alt="crop" className="absolute max-w-none left-1/2 top-1/2"
            style={{ width: `${Math.max(100, zoom * 100)}%`, height: 'auto', transform: 'translate(-50%, -50%)' }} />
        </div>
        <div className="mt-5">
          <div className="flex justify-between text-xs text-slate-400 mb-1"><span>缩小</span><span>放大</span></div>
          <input type="range" min="1" max="2.5" step="0.05" value={zoom} onChange={e => setZoom(Number(e.target.value))} className="w-full accent-pink-400" />
        </div>
        <button disabled={saving} onClick={handleSave}
          className="mt-5 w-full h-11 rounded-2xl bg-pink-400 text-white font-bold flex items-center justify-center gap-2 active:scale-[.98]">
          <Check size={18}/>{saving ? '保存中…' : '使用这个头像'}
        </button>
      </div>
    </div>
  );
};

const AvatarPicker: React.FC<{
  label: string;
  image?: string | null;
  fallback?: string;
  onChange: (dataUrl: string) => void;
}> = ({ label, image, fallback, onChange }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<string | null>(null);
  const handleFile = async (file?: File) => {
    if (!file) return;
    setPending(await fileToDataUrl(file));
  };
  return (
    <>
      <button onClick={() => inputRef.current?.click()} className="flex flex-col items-center gap-1.5 active:scale-95 transition-transform">
        <div className="relative w-[76px] h-[76px] sm:w-[84px] sm:h-[84px] rounded-full overflow-hidden bg-white ring-4 ring-white shadow-[0_6px_20px_rgba(126,65,85,.15)]">
          {image ? <img src={image} alt={label} className="w-full h-full object-cover" /> : fallback ? <img src={fallback} alt={label} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-3xl">♡</div>}
          <div className="absolute inset-0 bg-black/0 hover:bg-black/10 flex items-end justify-end p-1.5">
            <span className="w-6 h-6 rounded-full bg-white/90 text-pink-500 flex items-center justify-center shadow"><Camera size={13}/></span>
          </div>
        </div>
        <span className="text-[11px] font-semibold text-rose-500/80">{label}</span>
      </button>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={e => handleFile(e.target.files?.[0])}/>
      {pending && <CropModal source={pending} onCancel={() => setPending(null)} onSave={data => { onChange(data); setPending(null); }}/>} 
    </>
  );
};

const MoodCard: React.FC<{
  title: string;
  emoji: string;
  text: string;
  editable?: boolean;
  onEmoji?: () => void;
  onText?: (v: string) => void;
}> = ({ title, emoji, text, editable, onEmoji, onText }) => (
  <div className="flex-1 min-w-0 px-3 sm:px-5 py-2 text-center">
    <div className="text-[12px] font-bold tracking-wide text-rose-500/75">{title}</div>
    <button disabled={!editable} onClick={onEmoji} className={`mt-2 text-[52px] leading-none ${editable ? 'active:scale-90 transition-transform' : ''}`}>{emoji}</button>
    <div className="mt-2 min-h-[82px] rounded-[18px] bg-[#fffaf2] border border-[#f3dfcf] shadow-[0_3px_10px_rgba(120,80,50,.05)] p-3 text-left">
      {editable ? (
        <textarea value={text} maxLength={50} onChange={e => onText?.(e.target.value)} placeholder="写下今天的心情…"
          className="w-full h-[56px] resize-none outline-none bg-transparent text-[13px] leading-5 text-slate-700 placeholder:text-slate-300" />
      ) : (
        <div className="text-[13px] leading-5 text-slate-600 break-words">{text || '今天没有留下文字。'}</div>
      )}
    </div>
    {editable && <div className="text-[9px] text-right text-slate-300 mt-1">{text.length}/50</div>}
  </div>
);


const YuZhouGamePage: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const [openId, setOpenId] = useState<string | null>(null);
  const opened = GAMES.find(game => game.id === openId);
  const OpenedGame = opened?.component;

  return (
    <div className="absolute inset-0 z-[60] bg-[#fff7f5] text-slate-800">
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_15%_10%,rgba(255,190,205,.42),transparent_28%),radial-gradient(circle_at_90%_25%,rgba(255,220,224,.5),transparent_30%),linear-gradient(180deg,#fffafa_0%,#fff4f1_100%)]" />
      <div className="relative h-full overflow-y-auto overscroll-none" style={{ paddingTop: 'var(--safe-top)' }}>
        <header className="h-14 px-4 flex items-center justify-between">
          <button onClick={onBack} className="w-9 h-9 rounded-full bg-white/80 shadow-sm text-rose-400 text-xl active:scale-90 transition-transform">‹</button>
          <div className="text-center">
            <div className="font-black tracking-[.18em] text-rose-500 text-base">游戏</div>
            <div className="text-[8px] tracking-[.22em] text-rose-300 mt-0.5">PLAY TOGETHER</div>
          </div>
          <div className="w-9 h-9" />
        </header>

        <main className="px-5 pt-4 pb-10">
          <div className="text-center mb-7">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/75 border border-white shadow-sm text-[11px] font-bold text-rose-400">
              <span>🎮</span><span>一起玩点什么？</span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-x-4 gap-y-7 max-w-md mx-auto">
            {GAMES.map(game => (
              <button
                key={game.id}
                onClick={() => { if (game.component) setOpenId(game.id); }}
                className="flex flex-col items-center active:scale-95 transition-transform"
              >
                <div className="w-full aspect-square rounded-[22px] bg-white/85 border border-white shadow-[0_8px_24px_rgba(172,88,108,.10)] flex items-center justify-center">
                  <span className="text-[52px] leading-none">{game.icon}</span>
                </div>
                <div className="mt-2.5 text-[12px] font-bold text-slate-700 whitespace-nowrap">{game.name}</div>
              </button>
            ))}
          </div>
        </main>
      </div>

      {OpenedGame && (
        <React.Suspense fallback={<div className="absolute inset-0 z-[70] bg-[#fff7f5] flex items-center justify-center text-[12px] text-rose-300">加载中…</div>}>
          <OpenedGame onBack={() => setOpenId(null)} />
        </React.Suspense>
      )}
    </div>
  );
};

// ==================== 月度心情日历 ====================

const YuZhouMonthCalendar: React.FC<{
  charId: string;
  charName: string;
  todayKey: string;
  onBack: () => void;
}> = ({ charId, charName, todayKey, onBack }) => {
  const [ty, tm] = todayKey.split('-').map(Number);
  const [year, setYear] = useState(ty);
  const [month, setMonth] = useState(tm - 1); // 0-based
  const [moods, setMoods] = useState<MonthMoods>({});
  const [selected, setSelected] = useState<string>(todayKey);
  const touchX = useRef<number | null>(null);

  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
  const isCurrentMonth = year === ty && month === tm - 1;

  const reload = useCallback(async () => {
    setMoods(await loadMonthMoods(charId, monthKey));
  }, [charId, monthKey]);

  useEffect(() => { void reload(); }, [reload]);

  // 与朋友圈相同：监听写入事件，同步刷新
  useEffect(() => {
    const onUpdate = (e: Event) => {
      const d = (e as CustomEvent<YuZhouMoodEventDetail>).detail;
      if (!d || (d.charId !== (charId || 'default')) || !d.dateKey.startsWith(monthKey)) return;
      void reload();
    };
    window.addEventListener(YUZHOU_MOOD_EVENT, onUpdate);
    return () => window.removeEventListener(YUZHOU_MOOD_EVENT, onUpdate);
  }, [charId, monthKey, reload]);

  const shiftMonth = (delta: number) => {
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
    const inToday = d.getFullYear() === ty && d.getMonth() === tm - 1;
    setSelected(inToday ? todayKey : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`);
  };

  const goToday = () => { setYear(ty); setMonth(tm - 1); setSelected(todayKey); };

  // 固定 6 行 × 7 列，切换月份时高度不跳
  const cells = React.useMemo(() => {
    const firstWeekday = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevDays = new Date(year, month, 0).getDate();
    return Array.from({ length: 42 }, (_, i) => {
      const n = i - firstWeekday + 1;
      if (n < 1) return { day: prevDays + n, inMonth: false, key: '' };
      if (n > daysInMonth) return { day: n - daysInMonth, inMonth: false, key: '' };
      return { day: n, inMonth: true, key: `${monthKey}-${String(n).padStart(2, '0')}` };
    });
  }, [year, month, monthKey]);

  const sel = moods[selected] || {};
  const [, sm, sd] = selected.split('-').map(Number);
  const selWeek = WEEK_LABELS[new Date(year, (sm || 1) - 1, sd || 1).getDay()];

  return (
    <div className="absolute inset-0 z-[60] bg-[#fff7f5] text-slate-800 flex flex-col">
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_15%_10%,rgba(255,190,205,.42),transparent_28%),radial-gradient(circle_at_90%_25%,rgba(255,220,224,.5),transparent_30%),linear-gradient(180deg,#fffafa_0%,#fff4f1_100%)]" />

      <header className="relative h-14 px-4 flex items-center justify-between shrink-0" style={{ marginTop: 'var(--safe-top)' }}>
        <button onClick={onBack} className="w-9 h-9 rounded-full bg-white/80 shadow-sm text-rose-400 text-xl active:scale-90 transition-transform">‹</button>
        <div className="text-center">
          <div className="font-black tracking-[.18em] text-rose-500 text-base">本月心情</div>
          <div className="text-[8px] tracking-[.22em] text-rose-300 mt-0.5">MOOD CALENDAR</div>
        </div>
        <div className="w-9 h-9" />
      </header>

      {/* 内容整体垂直居中；屏幕太矮时可滚动 */}
      <div className="relative flex-1 min-h-0 overflow-y-auto overscroll-none">
        <div className="min-h-full flex flex-col justify-center px-4 py-4" style={{ paddingBottom: 'max(16px, var(--safe-bottom))' }}>
          <div
            className="w-full max-w-md mx-auto rounded-[30px] bg-white/80 border border-white shadow-[0_12px_40px_rgba(172,88,108,.10)] px-3 pt-4 pb-4"
            onTouchStart={e => { touchX.current = e.touches[0].clientX; }}
            onTouchEnd={e => {
              if (touchX.current == null) return;
              const dx = e.changedTouches[0].clientX - touchX.current;
              touchX.current = null;
              if (Math.abs(dx) > 50) shiftMonth(dx < 0 ? 1 : -1);
            }}
          >
            {/* SEP  2026 */}
            <div className="flex items-center justify-between px-1">
              <button onClick={() => shiftMonth(-1)} aria-label="上个月" className="w-9 h-9 rounded-full bg-rose-50 text-rose-400 flex items-center justify-center active:scale-90 transition-transform"><CaretLeft size={16} weight="bold" /></button>
              <div className="flex flex-col items-center">
                <div className="flex items-baseline gap-3 text-rose-500">
                  <span className="text-[26px] font-black tracking-[.08em] leading-none">{MONTH_ABBR[month]}</span>
                  <span className="text-[26px] font-black tracking-[.04em] leading-none">{year}</span>
                </div>
                <button onClick={goToday} className={`mt-1 h-4 text-[9px] font-bold tracking-wider text-rose-300 ${isCurrentMonth ? 'invisible' : ''}`}>回到本月</button>
              </div>
              <button onClick={() => shiftMonth(1)} aria-label="下个月" className="w-9 h-9 rounded-full bg-rose-50 text-rose-400 flex items-center justify-center active:scale-90 transition-transform"><CaretRight size={16} weight="bold" /></button>
            </div>

            <div className="grid grid-cols-7 mt-2 mb-1">
              {WEEK_LABELS.map((w, i) => (
                <div key={w} className={`text-center text-[10px] font-bold py-1 ${i === 0 || i === 6 ? 'text-rose-300' : 'text-slate-400'}`}>{w}</div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1">
              {cells.map((c, i) => {
                if (!c.inMonth) {
                  return (
                    <div key={`o${i}`} className="aspect-[4/5] rounded-2xl flex flex-col items-center pt-1.5">
                      <span className="text-[11px] font-semibold text-slate-200">{c.day}</span>
                    </div>
                  );
                }
                const m = moods[c.key];
                const isToday = c.key === todayKey;
                const isSel = c.key === selected;
                const isFuture = c.key > todayKey;
                return (
                  <button
                    key={c.key}
                    onClick={() => setSelected(c.key)}
                    className={`aspect-[4/5] rounded-2xl flex flex-col items-center pt-1.5 transition-colors active:scale-95
                      ${isSel ? 'bg-rose-100/80 ring-1 ring-rose-300' : m ? 'bg-rose-50/60' : 'bg-transparent'}`}
                  >
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold
                      ${isToday ? 'bg-rose-400 text-white' : isFuture ? 'text-slate-300' : 'text-slate-600'}`}>{c.day}</span>
                    <div className="mt-auto mb-1.5 flex items-center justify-center gap-px text-[13px] leading-none min-h-[14px]">
                      {m?.user && <span title="我">{m.user.emoji}</span>}
                      {m?.ta && <span title={charName}>{m.ta.emoji}</span>}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="mt-2 flex justify-center gap-4 text-[9px] text-slate-400">
              <span>左：我</span><span>右：{charName}</span>
            </div>

            {/* 选中日期详情：固定最小高度，避免切换时整体跳动 */}
            <div className="mt-3 rounded-[22px] bg-[#fffaf8] border border-[#f4d9e0] p-3 min-h-[128px]">
              <div className="text-[11px] font-bold text-rose-400 mb-2">{sm}月{sd}日 · 周{selWeek}</div>
              {!sel.user && !sel.ta ? (
                <div className="h-[80px] flex items-center justify-center text-[12px] text-slate-300">这天还没有心情记录</div>
              ) : (
                <div className="space-y-2">
                  {[
                    { label: '我', v: sel.user },
                    { label: charName, v: sel.ta },
                  ].map(({ label, v }) => (
                    <div key={label} className="flex items-start gap-2">
                      <span className="text-[22px] leading-none w-7 text-center shrink-0">{v?.emoji || '·'}</span>
                      <div className="min-w-0">
                        <div className="text-[10px] font-bold text-rose-400/80">{label}</div>
                        <div className="text-[12px] leading-5 text-slate-600 break-words">{v?.text || <span className="text-slate-300">没有留下文字</span>}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const YuZhouApp: React.FC = () => {
  const { activeCharacterId, characters, userProfile, apiConfig, closeApp, addToast } = useOS();
  const moodCharId = activeCharacterId || 'default';
  const char = characters.find(c => c.id === activeCharacterId) ?? null;
  // baseDay：用户保存时填写的天数；baseDate：保存那天的日期
  const [baseDay, setBaseDay] = useState(() => storageGet(ANNIVERSARY_KEY, '520'));
  const [baseDate, setBaseDate] = useState(() => {
    const saved = storageGet(ANNIVERSARY_BASE_DATE_KEY);
    if (saved) return saved;
    // 兼容旧数据：以前只存了天数，从今天开始计时
    const today = toLocalDateStr();
    storageSet(ANNIVERSARY_BASE_DATE_KEY, today);
    return today;
  });
  const [day, setDay] = useState(() => calcCurrentDay(baseDay, baseDate));
  const [todayKey, setTodayKey] = useState(() => toLocalDateStr());
  const [editingDay, setEditingDay] = useState(false);
  const [dayDraft, setDayDraft] = useState(day);
  const [userAvatar, setUserAvatar] = useState<string | null>(null);
  const [charAvatar, setCharAvatar] = useState<string | null>(null);
  const [userMood, setUserMood] = useState('');
  const [userEmoji, setUserEmoji] = useState(DEFAULT_USER_EMOJI);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showGamePage, setShowGamePage] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [taMood, setTaMood] = useState<MoodSide | null>(null);
  const [generatingTa, setGeneratingTa] = useState(false);
  const [pokeCount, setPokeCount] = useState(0);
  const genAbortRef = useRef<AbortController | null>(null);

  const fallbackUser = userProfile?.perCharAvatars?.[activeCharacterId || ''] || userProfile?.avatar;
  const fallbackChar = char?.avatar;

  // ==================== 今日心情：读库 / 保存 / 同步 ====================

  // 用户心情的最新值 + 防抖保存（打字时不每个字都写库）
  const userLatestRef = useRef({ emoji: DEFAULT_USER_EMOJI, text: '' });
  const userSaveTimer = useRef<number | undefined>(undefined);
  const pendingUserSave = useRef<{ charId: string; dateKey: string } | null>(null);

  const flushUserSave = useCallback(() => {
    window.clearTimeout(userSaveTimer.current);
    const target = pendingUserSave.current;
    if (!target) return;
    pendingUserSave.current = null;
    const { emoji, text } = userLatestRef.current;
    saveDayMood(target.charId, target.dateKey, 'user', { emoji, text, updatedAt: Date.now() })
      .catch(() => addToast?.('心情保存失败，可能是存储空间不足', 'error'));
  }, [addToast]);

  const scheduleUserSave = useCallback((delay: number) => {
    pendingUserSave.current = { charId: moodCharId, dateKey: todayKey };
    window.clearTimeout(userSaveTimer.current);
    userSaveTimer.current = window.setTimeout(flushUserSave, delay);
  }, [moodCharId, todayKey, flushUserSave]);

  const handleUserText = (v: string) => {
    setUserMood(v);
    userLatestRef.current = { ...userLatestRef.current, text: v };
    scheduleUserSave(600);
  };

  const handleUserEmoji = (e: string) => {
    setUserEmoji(e);
    setShowEmojiPicker(false);
    userLatestRef.current = { ...userLatestRef.current, emoji: e };
    scheduleUserSave(0);
  };

  // 切换角色 / 跨天 / 卸载前，把没写完的先落盘
  useEffect(() => () => flushUserSave(), [moodCharId, todayKey, flushUserSave]);

  // 读取今天的记录（切角色、跨零点时重新读）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rec = await loadDayMood(moodCharId, todayKey);
      if (cancelled) return;
      let user = rec.user;
      // 旧版本心情存在 localStorage：只迁移一次，放进今天
      if (!user && !storageGet(USER_MOOD_MIGRATED_KEY)) {
        const legacyText = storageGet(USER_MOOD_KEY);
        const legacyEmoji = storageGet(USER_EMOJI_KEY);
        storageSet(USER_MOOD_MIGRATED_KEY, '1');
        if (legacyText || legacyEmoji) {
          user = { emoji: legacyEmoji || DEFAULT_USER_EMOJI, text: legacyText, updatedAt: Date.now() };
          void saveDayMood(moodCharId, todayKey, 'user', user);
        }
      }
      const emoji = user?.emoji || DEFAULT_USER_EMOJI;
      const text = user?.text || '';
      userLatestRef.current = { emoji, text };
      setUserEmoji(emoji);
      setUserMood(text);
      setTaMood(rec.ta || null);
    })();
    return () => { cancelled = true; };
  }, [moodCharId, todayKey]);

  // 其他地方写入 TA 心情时同步过来（用户侧以本页输入为准，不回读，避免打字被覆盖）
  useEffect(() => {
    const onUpdate = (e: Event) => {
      const d = (e as CustomEvent<YuZhouMoodEventDetail>).detail;
      if (!d || d.charId !== moodCharId || d.dateKey !== todayKey || d.side !== 'ta') return;
      void loadDayMood(moodCharId, todayKey).then(rec => setTaMood(rec.ta || null));
    };
    window.addEventListener(YUZHOU_MOOD_EVENT, onUpdate);
    return () => window.removeEventListener(YUZHOU_MOOD_EVENT, onUpdate);
  }, [moodCharId, todayKey]);

  // ==================== TA 今日心情：手动生成（一次 API 调用） ====================

  const handleGenerateTa = useCallback(async () => {
    if (generatingTa) return;
    if (!char) { addToast?.('请先选择一个角色', 'info'); return; }
    if (!apiConfig?.apiKey || !apiConfig?.baseUrl) { addToast?.('请先配置 API', 'info'); return; }

    genAbortRef.current?.abort();
    const ac = new AbortController();
    genAbortRef.current = ac;
    const dateKey = todayKey;
    const charIdAtStart = moodCharId;
    setGeneratingTa(true);
    try {
      const result = await generateTaDailyMood({ char, userProfile, apiConfig, signal: ac.signal });
      if (ac.signal.aborted) return;
      await saveDayMood(charIdAtStart, dateKey, 'ta', result);
      setTaMood(result);
      addToast?.(`${char.name}写下了今天的心情`, 'success');
    } catch (e: any) {
      if (ac.signal.aborted) return;
      console.error('[YuZhou] generate TA mood failed', e);
      addToast?.(`生成失败: ${e?.message?.slice(0, 60) || '未知错误'}`, 'error');
    } finally {
      if (!ac.signal.aborted) setGeneratingTa(false);
    }
  }, [generatingTa, char, apiConfig, userProfile, todayKey, moodCharId, addToast]);

  // 切换角色或离开页面时取消进行中的请求
  useEffect(() => () => { genAbortRef.current?.abort(); }, [moodCharId]);

  const pokeTa = () => {
    setPokeCount(n => n + 1);
    if (!taMood && !generatingTa) addToast?.('点右上角 ↻ 让TA写下今天的心情', 'info');
  };


  useEffect(() => {
    (async () => {
      try {
        const [u, c] = await Promise.all([DB.getAsset('yuzhou-avatar-user'), DB.getAsset(`yuzhou-avatar-char-${activeCharacterId || 'default'}`)]);
        setUserAvatar(u); setCharAvatar(c);
      } catch (e) { console.warn('[YuZhou] avatar load failed', e); }
    })();
  }, [activeCharacterId]);

  const saveAvatar = useCallback(async (kind: 'user' | 'char', dataUrl: string) => {
    try {
      const id = kind === 'user' ? 'yuzhou-avatar-user' : `yuzhou-avatar-char-${activeCharacterId || 'default'}`;
      await DB.saveAsset(id, dataUrl);
      kind === 'user' ? setUserAvatar(dataUrl) : setCharAvatar(dataUrl);
      addToast?.('头像已保存', 'success');
    } catch { addToast?.('头像保存失败，可能是存储空间不足', 'error'); }
  }, [activeCharacterId, addToast]);

  const saveDay = () => {
    const cleaned = dayDraft.replace(/\D/g, '').slice(0, 7) || '0';
    const today = toLocalDateStr();
    setBaseDay(cleaned); setBaseDate(today); setDay(cleaned);
    storageSet(ANNIVERSARY_KEY, cleaned);
    storageSet(ANNIVERSARY_BASE_DATE_KEY, today);
    setEditingDay(false);
  };

  // 计时器：每到本地零点自动 +1；从后台切回 / 窗口重新聚焦时也重新计算
  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => { setDay(calcCurrentDay(baseDay, baseDate)); setTodayKey(toLocalDateStr()); };
    const schedule = () => {
      timer = window.setTimeout(() => { refresh(); schedule(); }, msUntilNextMidnight());
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      refresh();
      window.clearTimeout(timer);
      schedule(); // 手机休眠后 setTimeout 可能不准，回到前台时重新排一次
    };
    refresh();
    schedule();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [baseDay, baseDate]);


  return (
    <div className="relative h-full w-full overflow-hidden bg-[#fff7f5] text-slate-800">
      <style>{POKE_CSS}</style>
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_15%_10%,rgba(255,190,205,.42),transparent_28%),radial-gradient(circle_at_90%_25%,rgba(255,220,224,.5),transparent_30%),linear-gradient(180deg,#fffafa_0%,#fff4f1_100%)]" />
      <div className="relative h-full overflow-y-auto overscroll-none pb-[94px]" style={{ paddingTop: 'var(--safe-top)' }}>
        <header className="h-12 px-4 flex items-center justify-between">
          <button onClick={closeApp} className="w-9 h-9 rounded-full bg-white/70 shadow-sm text-rose-400 text-lg">‹</button>
          <div className="font-black tracking-[.22em] text-rose-400 text-sm">与昼</div>
          <button
            onClick={handleGenerateTa}
            disabled={generatingTa}
            aria-label="生成TA的今日心情"
            title="生成TA的今日心情（调用一次 API）"
            className={`w-9 h-9 rounded-full bg-white/80 border border-rose-100 shadow-sm flex items-center justify-center text-rose-400 active:scale-90 transition-transform disabled:opacity-70 ${generatingTa ? 'animate-spin' : ''}`}
          >
            <ArrowClockwise size={19} weight="bold" />
          </button>
        </header>

        {/* 顶部 1/3：纪念日 */}
        <section className="px-4 pt-2">
          <div className="relative min-h-[250px] rounded-[34px] bg-white/60 border border-white/90 shadow-[0_12px_40px_rgba(172,88,108,.09)] overflow-hidden">
            <div className="absolute inset-x-0 top-4 text-center z-10">
              <div className="text-[13px] tracking-[.28em] font-bold text-rose-400">纪念日</div>
            </div>
            <div className="absolute left-3 top-[68px] z-20"><AvatarPicker label="我" image={userAvatar} fallback={fallbackUser} onChange={v => saveAvatar('user', v)} /></div>
            <div className="absolute right-3 top-[68px] z-20"><AvatarPicker label={char?.name || 'TA'} image={charAvatar} fallback={fallbackChar} onChange={v => saveAvatar('char', v)} /></div>
            <div className="absolute left-1/2 top-[27px] -translate-x-1/2 w-[190px] h-[178px] flex items-center justify-center">
              <div className="absolute text-[112px] leading-none select-none drop-shadow-[0_10px_18px_rgba(239,126,153,.18)]">💗</div>
              <div className="relative mt-2 text-center text-white drop-shadow-[0_2px_2px_rgba(190,90,110,.22)]">
                <div className="text-[29px] font-black leading-none tracking-tight">第{day}天</div>
                <button onClick={() => { setDayDraft(day); setEditingDay(true); }} className="mt-2 text-[9px] px-2.5 py-1 rounded-full bg-white/35 font-semibold">点击修改天数</button>
              </div>
            </div>
            <div className="absolute bottom-4 inset-x-0 text-center text-[10px] tracking-[.16em] text-rose-300">一起走过的每一天，都值得被记住</div>
          </div>
        </section>

        {/* 中间先留白，后续接入像素小人 / 背景 */}
        <section className="mx-4 my-4 h-[250px] rounded-[30px] border border-dashed border-rose-100/80 bg-white/20 flex items-center justify-center">
          <div className="text-center text-rose-200 select-none">
            <div className="text-4xl mb-2">♡</div>
            <div className="text-[11px] tracking-[.16em]">两个人的小世界 · 待加入像素家园</div>
          </div>
        </section>

        {/* 底部 1/3：今日心情 / 心情日记 */}
        <section className="mx-4 rounded-[30px] bg-white/75 border border-white/90 shadow-[0_10px_35px_rgba(172,88,108,.08)] overflow-hidden">
          <div className="pt-5 pb-1 text-center">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-rose-50/80 border border-rose-100/70">
              <span className="text-rose-300">♡</span>
              <span className="text-[17px] font-black tracking-[.12em] text-rose-500/85">今日心情</span>
              <span className="text-rose-300">♡</span>
            </div>
            <div className="text-[8px] text-rose-300 mt-1.5 tracking-[.2em]">TODAY'S MOOD</div>
            <button
              onClick={() => { flushUserSave(); setShowCalendar(true); }}
              className="mt-2 inline-flex items-center gap-1 px-3 py-1 rounded-full bg-white border border-rose-100 shadow-sm text-[10px] font-bold text-rose-400 active:scale-95 transition-transform"
            >
              <CalendarBlank size={12} weight="bold" />本月
            </button>
          </div>

          <div className="flex mt-2 pb-5 px-2 sm:px-3">
            {/* 左：用户 */}
            <div className="flex-1 min-w-0 px-2 sm:px-4 py-2 text-center flex flex-col">
              <div className="text-[12px] font-bold tracking-wide text-rose-500/75">我的心情</div>
              <button onClick={() => setShowEmojiPicker(v => !v)} className="mt-4 text-[58px] leading-none active:scale-90 transition-transform">{userEmoji}</button>
              <div className="relative mt-8 min-h-[86px] rounded-[18px] bg-[#fffaf2] border border-[#f3dfcf] shadow-[0_3px_10px_rgba(120,80,50,.05)] p-3 text-left">
                <span className="absolute -top-2 left-4 w-10 h-4 rounded-sm bg-rose-200/80 rotate-[-8deg] shadow-sm" />
                <textarea value={userMood} maxLength={50} onChange={e => handleUserText(e.target.value)} onBlur={flushUserSave} placeholder="写下你的今日心情吧…"
                  className="w-full h-[58px] resize-none outline-none bg-transparent text-[13px] leading-5 text-slate-700 placeholder:text-slate-300" />
                <div className="text-[9px] text-right text-slate-300 mt-0.5">{userMood.length}/50</div>
              </div>
            </div>

            <div className="w-px bg-rose-100 self-stretch my-3" />

            {/* 右：TA */}
            <div className="flex-1 min-w-0 px-2 sm:px-4 py-2 text-center flex flex-col">
              <div className="text-[12px] font-bold tracking-wide text-rose-500/75">{char?.name || 'TA'}的心情</div>
              <button onClick={pokeTa} aria-label="戳一下TA" className="relative mt-4 mx-auto text-[58px] leading-none">
                <span key={pokeCount} className={pokeCount > 0 ? 'yz-poke' : 'inline-block'}>
                  {generatingTa ? '💭' : (taMood?.emoji || '🙂')}
                </span>
                {pokeCount > 0 && <span key={`h${pokeCount}`} className="yz-heart absolute left-1/2 -top-1 text-[16px] pointer-events-none">💗</span>}
              </button>
              <div className="relative mt-8 min-h-[86px] rounded-[18px] bg-[#fffaf8] border border-[#f4d9e0] shadow-[0_3px_10px_rgba(120,80,50,.05)] p-3 text-left">
                <span className="absolute -top-2 left-4 w-10 h-4 rounded-sm bg-pink-200/80 rotate-[8deg] shadow-sm" />
                <div className="min-h-[58px] flex items-center justify-center text-center text-[13px] leading-5 text-slate-600 break-words">
                  {generatingTa
                    ? <span className="text-rose-300">{char?.name || 'TA'}正在想今天的心情…</span>
                    : taMood?.text || <span className="text-slate-400">还没有写今天的心情，点右上角 ↻ 让TA写一条吧。</span>}
                </div>
              </div>
            </div>
          </div>

          {showEmojiPicker && <div className="border-t border-rose-100 bg-[#fffaf8] p-3 grid grid-cols-6 gap-2">{EMOJIS.map(e => <button key={e} onClick={() => handleUserEmoji(e)} className="text-2xl h-10 rounded-xl hover:bg-white active:scale-90">{e}</button>)}</div>}
        </section>
        <div className="h-6" />
      </div>

      {/* 五入口导航 */}
      <nav className="absolute bottom-0 inset-x-0 z-50 px-4 pt-2 bg-white/90 backdrop-blur-xl border-t border-rose-100" style={{ paddingBottom: 'max(10px, var(--safe-bottom))' }}>
        <div className="max-w-md mx-auto flex items-end justify-between">
          {[
            ['📝', '便签'], ['🎮', '游戏'], ['💍', '与昼'], ['💰', '金钱'], ['🎁', '礼物']
          ].map(([icon, label], i) => (
            <button key={label} onClick={() => { if (i === 1) setShowGamePage(true); else if (i !== 2) addToast?.(`${label}入口已预留，之后继续做`, 'info'); }} className={`w-[18%] flex flex-col items-center gap-1 py-1 rounded-2xl ${i === 2 ? 'text-rose-500' : 'text-slate-400'} active:scale-90 transition-transform`}>
              <span className={`${i === 2 ? 'text-[29px]' : 'text-[23px]'} leading-none`}>{icon}</span>
              <span className="text-[9px] font-bold">{label}</span>
            </button>
          ))}
        </div>
      </nav>

      {showGamePage && <YuZhouGamePage onBack={() => setShowGamePage(false)} />}
      {showCalendar && (
        <YuZhouMonthCalendar
          charId={moodCharId}
          charName={char?.name || 'TA'}
          todayKey={todayKey}
          onBack={() => setShowCalendar(false)}
        />
      )}

      {editingDay && <div className="absolute inset-0 z-[70] bg-black/25 flex items-center justify-center px-8">
        <div className="w-full max-w-xs rounded-[28px] bg-white p-5 shadow-2xl">
          <div className="font-bold text-slate-800">修改纪念日天数</div>
          <div className="text-xs text-slate-400 mt-1">填写今天是第几天，之后每过一天会自动 +1。</div>
          <div className="mt-4 flex items-center gap-2">
            <input autoFocus inputMode="numeric" value={dayDraft} onChange={e => setDayDraft(e.target.value.replace(/\D/g, ''))} className="flex-1 h-12 rounded-2xl bg-rose-50 px-4 text-2xl font-black text-rose-500 outline-none" />
            <span className="font-bold text-rose-300">天</span>
          </div>
          <div className="mt-4 flex gap-2"><button onClick={() => setEditingDay(false)} className="flex-1 h-11 rounded-2xl bg-slate-100 text-slate-500 font-bold">取消</button><button onClick={saveDay} className="flex-1 h-11 rounded-2xl bg-rose-400 text-white font-bold">保存</button></div>
        </div>
      </div>}
    </div>
  );
};

export default YuZhouApp;
