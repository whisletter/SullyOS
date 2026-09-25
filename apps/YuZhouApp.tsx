
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowClockwise, CalendarBlank, CaretLeft, CaretRight, Camera, Check, Coins, GameController, Gift, NotePencil, Plus, X } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { processImage } from '../utils/file';
import { GAMES } from './games/registry';
import { loadWallet, award, type Wallet, type WalletEntry } from './games/shared/wallet';
import {
  COUPONS, COUPON_CATEGORIES, categoryOf, addCoupon, loadCoupons, heldCount,
  type CouponCategory, type CouponWallet,
} from './games/shared/coupons';
import YuZhouNoteBoard from './yuzhou/YuZhouNoteBoard';
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
const DEFAULT_USER_EMOJI = ''; // 空 = 今天还没选，显示虚线圆圈 +

// 戳一下 TA 的 emoji：只播动画，不改内容
/**
 * 券的票形。
 *
 * 两侧一对半圆缺口 + 中间一道虚线撕口——这是整个商店唯一值得花视觉的地方。
 * 缺口用背景同色的小圆盖在边框上做出来（不是 mask），因为页面背景是渐变的，
 * mask 抠出来的透明洞会露出渐变的另一段，看着像脏点。这里的 #fff6f4 跟卡片
 * 所在位置的背景色接近，肉眼分不出来。
 */
const TICKET_CSS = `
.yz-ticket{position:relative;background:rgba(255,255,255,.88);border:1px solid;
  border-radius:16px;padding:13px 15px;box-shadow:0 6px 18px rgba(172,88,108,.08)}
.yz-notch{position:absolute;width:14px;height:14px;border-radius:50%;
  background:#fff6f4;top:50%;transform:translateY(-50%)}
.yz-notch.left{left:-8px}
.yz-notch.right{right:-8px}
.yz-tear{border-top:1px dashed;margin:11px -15px 9px;padding:0}
`;

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
      <button onClick={() => inputRef.current?.click()} aria-label={`更换${label}的头像`} className="relative active:scale-95 transition-transform">
        <div className="rounded-full p-[3px] bg-gradient-to-br from-rose-200 to-pink-100 shadow-[0_6px_18px_rgba(226,120,150,.22)]">
          <div className="rounded-full p-[3px] bg-white">
            <div className="w-[74px] h-[74px] sm:w-[82px] sm:h-[82px] rounded-full overflow-hidden bg-rose-50">
              {image ? <img src={image} alt={label} className="w-full h-full object-cover" /> : fallback ? <img src={fallback} alt={label} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-3xl text-rose-200">♡</div>}
            </div>
          </div>
        </div>
        <HeartBadge className="absolute -right-0.5 bottom-1 w-6 h-6" />
      </button>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={e => handleFile(e.target.files?.[0])}/>
      {pending && <CropModal source={pending} onCancel={() => setPending(null)} onSave={data => { onChange(data); setPending(null); }}/>} 
    </>
  );
};

// ==================== 首页装饰（纯 SVG / CSS，不依赖图片） ====================

/** 小光线：三条短线，flip=true 朝右 */
const SparkLines: React.FC<{ flip?: boolean; className?: string }> = ({ flip, className = '' }) => (
  <svg viewBox="0 0 18 18" className={`${className} ${flip ? '-scale-x-100' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <path d="M5 3.5 L9 7" /><path d="M2.5 9.5 L8.5 9.5" /><path d="M5 15.5 L9 12" />
  </svg>
);

const HeartBadge: React.FC<{ className?: string }> = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden>
    <path d="M12 21 C6 16.5 2.5 13.4 2.5 9.2 C2.5 6.3 4.7 4 7.4 4 C9.4 4 11 5.1 12 6.8 C13 5.1 14.6 4 16.6 4 C19.3 4 21.5 6.3 21.5 9.2 C21.5 13.4 18 16.5 12 21 Z"
      fill="#f9a8c0" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
  </svg>
);

/** 纪念日大爱心 */
const AnniversaryHeart: React.FC<{ day: string; onClick: () => void }> = ({ day, onClick }) => {
  const size = day.length <= 2 ? 'text-[38px]' : day.length <= 4 ? 'text-[28px]' : 'text-[21px]';
  return (
    <button onClick={onClick} aria-label="修改纪念日天数" className="relative w-[156px] h-[142px] sm:w-[176px] sm:h-[160px] shrink-0 active:scale-95 transition-transform">
      <svg viewBox="0 0 200 180" className="absolute inset-0 w-full h-full drop-shadow-[0_10px_16px_rgba(236,120,150,.28)]" aria-hidden>
        <defs>
          <radialGradient id="yz-heart-fill" cx="38%" cy="30%" r="80%">
            <stop offset="0%" stopColor="#ffe3ea" />
            <stop offset="55%" stopColor="#fbb9cb" />
            <stop offset="100%" stopColor="#f58fae" />
          </radialGradient>
        </defs>
        <path d="M100 170 C40 125 8 92 8 55 C8 26 30 8 56 8 C76 8 92 20 100 36 C108 20 124 8 144 8 C170 8 192 26 192 55 C192 92 160 125 100 170 Z"
          fill="url(#yz-heart-fill)" stroke="#f38aa9" strokeWidth="3.5" strokeLinejoin="round" />
        <ellipse cx="52" cy="42" rx="20" ry="11" fill="#fff" opacity=".55" transform="rotate(-32 52 42)" />
        <path d="M150 30 L153 40 L163 43 L153 46 L150 56 L147 46 L137 43 L147 40 Z" fill="#fff" opacity=".9" />
        <circle cx="166" cy="62" r="2.5" fill="#fff" opacity=".8" />
      </svg>
      <div className="absolute inset-x-0 top-[34%] flex items-baseline justify-center gap-1.5 text-[#e2577f]">
        <span className="text-[19px] font-black">第</span>
        <span className={`${size} font-black leading-none italic`}>{day}</span>
        <span className="text-[19px] font-black">天</span>
      </div>
    </button>
  );
};

/** 底栏中间的钻戒 */
const RingIcon: React.FC<{ className?: string }> = ({ className = '' }) => (
  <svg viewBox="0 0 64 64" className={className} fill="none" aria-hidden>
    <circle cx="32" cy="40" r="16" stroke="#ee6f93" strokeWidth="5" />
    <circle cx="32" cy="40" r="16" stroke="#fff" strokeWidth="1.2" opacity=".55" />
    <path d="M22 13 L27 7 H37 L42 13 L32 25 Z" fill="#fcc3d2" stroke="#ee6f93" strokeWidth="2.4" strokeLinejoin="round" />
    <path d="M22 13 H42 M27 7 L32 13 L37 7 M32 13 V25" stroke="#ee6f93" strokeWidth="1.4" strokeLinejoin="round" />
    <path d="M11 12 L12 15 L15 16 L12 17 L11 20 L10 17 L7 16 L10 15 Z" fill="#f9a8c0" />
    <path d="M53 10 L54 13 L57 14 L54 15 L53 18 L52 15 L49 14 L52 13 Z" fill="#f9a8c0" />
  </svg>
);

/** 伪随机毛边：固定种子，每次渲染形状一致 */
const makeTornClip = (seed: number) => {
  let x = seed;
  const rnd = () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
  const pts: string[] = [];
  const steps = 14;
  for (let i = 0; i <= steps; i++) pts.push(`${(i / steps) * 100}% ${rnd() * 2.2}%`);
  for (let i = 1; i <= steps; i++) pts.push(`${100 - rnd() * 1.6}% ${(i / steps) * 100}%`);
  for (let i = steps - 1; i >= 0; i--) pts.push(`${(i / steps) * 100}% ${100 - rnd() * 2.2}%`);
  for (let i = steps - 1; i >= 1; i--) pts.push(`${rnd() * 1.6}% ${(i / steps) * 100}%`);
  return `polygon(${pts.join(',')})`;
};
const TORN_CLIP_A = makeTornClip(7);
const TORN_CLIP_B = makeTornClip(23);

/** 毛边便签纸 + 胶带 */
const NotePaper: React.FC<{ tone: 'pink' | 'cream'; tape: 'pink' | 'blue'; tilt?: number; children: React.ReactNode }> = ({ tone, tape, tilt = 0, children }) => (
  <div className="relative mt-5 drop-shadow-[0_4px_8px_rgba(160,100,110,.12)]" style={{ transform: `rotate(${tilt}deg)` }}>
    <div
      className={`min-h-[104px] p-3.5 pt-4 ${tone === 'pink' ? 'bg-[#fdebef]' : 'bg-[#fff6e6]'}`}
      style={{ clipPath: tone === 'pink' ? TORN_CLIP_A : TORN_CLIP_B }}
    >
      {children}
    </div>
    <span className={`absolute -top-2.5 left-3 w-12 h-5 rotate-[-14deg] rounded-[3px] opacity-90 shadow-sm ${tape === 'pink' ? 'bg-[#f7b8c6]' : 'bg-[#b9d3f2]'}`} />
  </div>
);

/** 还没选 emoji / TA 还没生成时的虚线圆圈 */
const DashedCircle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="w-[74px] h-[74px] rounded-full border-2 border-dashed border-rose-300/80 bg-white/40 flex items-center justify-center text-rose-300">
    {children}
  </span>
);


/** 流水里那一行的来源标签。 */
const GAME_LABELS: Record<string, string> = {
  turtle_soup: '海龟汤',
  monopoly: '大富翁',
  witch_poison: '女巫的毒药',
  tarot: '塔罗',
  other: '其他',
};

/**
 * 苹果币钱包页。
 *
 * 两个钱包**并排**是这一屏的重点：你一眼看到"我 128、它 64"，才会去想
 * "它攒的钱会拿来干嘛"。分开放两处就没有这个效果了。
 *
 * 🍏 绿苹果是你，🍎 红苹果是 TA。商店还没上架，先把钱和流水摆出来。
 */
const YuZhouWalletPage: React.FC<{ wallet: Wallet; taName: string; onBack: () => void }> = ({ wallet, taName, onBack }) => (
  <div className="absolute inset-0 z-[65] bg-[#fff7f5] text-slate-800">
    <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_15%_10%,rgba(255,190,205,.42),transparent_28%),radial-gradient(circle_at_90%_25%,rgba(255,220,224,.5),transparent_30%),linear-gradient(180deg,#fffafa_0%,#fff4f1_100%)]" />
    <div className="relative h-full overflow-y-auto overscroll-none" style={{ paddingTop: 'var(--safe-top)' }}>
      <header className="h-14 px-4 flex items-center justify-between">
        <button onClick={onBack} className="w-9 h-9 rounded-full bg-white/80 shadow-sm text-rose-400 text-xl active:scale-90 transition-transform">‹</button>
        <div className="text-center">
          <div className="font-black tracking-[.18em] text-rose-500 text-base">兑换商店</div>
          <div className="text-[8px] tracking-[.22em] text-rose-300 mt-0.5">APPLE COINS</div>
        </div>
        <div className="w-9 h-9" />
      </header>

      <main className="px-5 pb-10">
        {/* 两个钱包并排 */}
        <div className="grid grid-cols-2 gap-3 max-w-md mx-auto mt-2">
          {([['🍏', '我', wallet.user], ['🍎', taName, wallet.ta]] as const).map(([icon, who, amount]) => (
            <div key={who} className="rounded-[22px] bg-white/85 border border-white shadow-[0_8px_24px_rgba(172,88,108,.10)] px-4 py-5 text-center">
              <div className="text-[34px] leading-none">{icon}</div>
              <div className="text-[28px] font-black text-slate-700 mt-2 leading-none">{amount}</div>
              <div className="text-[11px] text-rose-300 mt-1.5 font-bold truncate">{who}</div>
            </div>
          ))}
        </div>

        <div className="max-w-md mx-auto mt-6 rounded-[22px] bg-white/70 border border-white px-4 py-5 text-center">
          <div className="text-[13px] font-bold text-slate-600">商店还没上架</div>
          <div className="text-[11px] text-rose-300 mt-1.5 leading-relaxed">
            先把币攒起来。家务券、点歌券、惊喜礼物这些等清单定好就能兑。
          </div>
        </div>

        {/* 流水：让你看得见钱是怎么来的 */}
        <div className="max-w-md mx-auto mt-6">
          <div className="text-[12px] font-bold text-rose-400 mb-2 px-1">最近的收支</div>
          {wallet.ledger.length === 0 ? (
            <div className="text-[11px] text-rose-300 px-1 py-4 text-center">还没有任何收支。去玩一局吧。</div>
          ) : (
            <div className="space-y-1.5">
              {[...wallet.ledger].reverse().slice(0, 30).map((e: WalletEntry) => (
                <div key={e.id} className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/75 border border-white">
                  <span className="text-[14px] shrink-0">{e.side === 'user' ? '🍏' : '🍎'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-slate-700 truncate">{e.reason}</div>
                    <div className="text-[10px] text-rose-300">
                      {GAME_LABELS[e.game] || e.game} · {new Date(e.at).toLocaleDateString()}
                    </div>
                  </div>
                  <span className="text-[13px] font-black shrink-0"
                        style={{ color: e.amount >= 0 ? '#e0767e' : '#94a3b8' }}>
                    {e.amount >= 0 ? '+' : ''}{e.amount}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  </div>
);


/**
 * 兑换商店。
 *
 * 券做成票的样子——两侧一对半圆缺口 + 中间一道虚线撕口。这是整个商店唯一值得
 * 花视觉的地方：商品本身就是内容，做得像票才有"拿到一张"的感觉。
 *
 * 买不起 / 到上限的直接变灰并在按钮上写明原因，不做弹窗报错——
 * 一眼看出能不能买，比点了才告诉你好。
 *
 * 兑换没有二次确认：券不贵，买错了也一直躺在券夹里，多一步很烦。
 * 流水里记一笔负数，反悔了看得见。
 *
 * 这一版**只有你能买**。TA 自己花钱那条（它判断时机、调 API、有自己的券夹）
 * 是另一摊，先让它的余额涨着——你会看着那个数字，等它哪天出手。
 */
const YuZhouStorePage: React.FC<{
  charId: string;
  wallet: Wallet;
  coupons: CouponWallet;
  onBought: (w: Wallet, c: CouponWallet) => void;
  onToast: (text: string) => void;
  onBack: () => void;
}> = ({ charId, wallet, coupons, onBought, onToast, onBack }) => {
  const [tab, setTab] = useState<CouponCategory | 'all'>('all');
  const list = COUPONS.filter(c => tab === 'all' || c.category === tab);

  const buy = (defId: string) => {
    const def = COUPONS.find(c => c.id === defId)!;
    const r = addCoupon(charId, 'user', defId);
    if (!r.ok) {
      onToast(r.reason === 'max_reached' ? `「${def.name}」已经到上限了` : '兑换失败');
      return;
    }
    // 扣钱走 award 记负数，这样商店消费和游戏收入在同一条流水里看得到
    const w = award(charId, [{
      side: 'user', amount: -def.price, game: 'other', reason: `兑换「${def.name}」`,
    }]);
    onBought(w, r.wallet!);
    onToast(`换到一张「${def.name}」`);
  };

  return (
    <div className="absolute inset-0 z-[66] bg-[#fff7f5] text-slate-800">
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_15%_10%,rgba(255,190,205,.42),transparent_28%),radial-gradient(circle_at_90%_25%,rgba(255,220,224,.5),transparent_30%),linear-gradient(180deg,#fffafa_0%,#fff4f1_100%)]" />
      <div className="relative h-full overflow-y-auto overscroll-none" style={{ paddingTop: 'var(--safe-top)' }}>
        <header className="h-14 px-4 flex items-center justify-between">
          <button onClick={onBack} className="w-9 h-9 rounded-full bg-white/80 shadow-sm text-rose-400 text-xl active:scale-90 transition-transform">‹</button>
          <div className="text-center">
            <div className="font-black tracking-[.18em] text-rose-500 text-base">兑换商店</div>
            <div className="text-[8px] tracking-[.22em] text-rose-300 mt-0.5">COUPON SHOP</div>
          </div>
          <div className="h-9 px-2.5 rounded-full bg-white/80 shadow-sm flex items-center gap-1">
            <span className="text-[13px] leading-none">🍏</span>
            <span className="text-[12px] font-black text-slate-600 leading-none">{wallet.user}</span>
          </div>
        </header>

        <main className="px-4 pb-10 max-w-md mx-auto">
          <div className="flex gap-1.5 mb-4">
            {([['all', '全部'], ...COUPON_CATEGORIES.map(c => [c.id, c.label] as const)] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id as CouponCategory | 'all')}
                className="text-[12px] px-3 py-1.5 rounded-full font-bold transition"
                style={tab === id
                  ? { background: '#e0767e', color: '#fff' }
                  : { background: 'rgba(255,255,255,.75)', color: '#c4788a' }}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="space-y-3">
            {list.map(def => {
              const meta = categoryOf(def.category);
              const held = heldCount(coupons, 'user', def.id);
              const full = held >= def.max;
              const poor = wallet.user < def.price;
              const disabled = full || poor;
              return (
                <div key={def.id} className="yz-ticket" style={{ borderColor: `${meta.accent}33` }}>
                  {/* 两侧缺口：用背景色的小圆盖在边上，做出票被撕开的豁口 */}
                  <span className="yz-notch left" />
                  <span className="yz-notch right" />
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-[14px] font-black" style={{ color: meta.accent }}>{def.name}</div>
                      <div className="text-[11px] text-slate-500 mt-1 leading-relaxed">{def.desc}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[17px] font-black text-slate-700 leading-none">{def.price}</div>
                      <div className="text-[9px] text-rose-300 mt-0.5">🍏</div>
                    </div>
                  </div>
                  <div className="yz-tear" style={{ borderColor: `${meta.accent}33` }} />
                  <div className="flex items-center">
                    <span className="text-[10px] text-slate-400">持有 {held}/{def.max}</span>
                    <button
                      onClick={() => buy(def.id)}
                      disabled={disabled}
                      className="ml-auto text-[12px] font-bold px-4 py-1.5 rounded-full transition active:scale-95 disabled:active:scale-100"
                      style={disabled
                        ? { background: 'rgba(0,0,0,.05)', color: '#b6b0ae' }
                        : { background: meta.soft, color: meta.accent }}
                    >
                      {full ? '已达上限' : poor ? `还差 ${def.price - wallet.user}` : '兑换'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="text-[11px] text-rose-300 leading-relaxed mt-6 px-1">
            券换来的是一份<b>权利</b>，不是礼物——礼物是亲手做了送对方的，券是你拿着用的。
            <br />用券的地方在「礼物」里的券夹，那边还没做好，先攒着。
          </div>
        </main>
      </div>
    </div>
  );
};

const YuZhouGamePage: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const { activeCharacterId, characters } = useOS();
  const charId = activeCharacterId || '';
  const taName = characters.find(c => c.id === charId)?.name || 'TA';

  const [openId, setOpenId] = useState<string | null>(null);
  const [showWallet, setShowWallet] = useState(false);
  const [showStore, setShowStore] = useState(false);
  const [coupons, setCoupons] = useState<CouponWallet>(() => loadCoupons(charId));
  const [toast, setToast] = useState('');
  const [wallet, setWallet] = useState<Wallet>(() => loadWallet(charId));
  const opened = GAMES.find(game => game.id === openId);
  const OpenedGame = opened?.component;

  // 从某个游戏退回大厅时重读钱包：那一局刚发的币要立刻反映在顶上那个横条里。
  // 游戏是各自往 localStorage 写的，没有事件通知，所以靠"回到大厅"这个时机重读。
  useEffect(() => {
    if (openId === null) { setWallet(loadWallet(charId)); setCoupons(loadCoupons(charId)); }
  }, [openId, charId, showWallet, showStore]);

  // toast 自己消失，不用点
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(''), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

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
          {/* 两个钱包并排放在这里，点进去是兑换商店。
              并排是关键：一眼看到"我多少、它多少"，才会去想它攒的钱要拿来干嘛。 */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setShowWallet(true)}
              className="h-9 px-2.5 rounded-full bg-white/80 shadow-sm flex items-center gap-1.5 active:scale-95 transition-transform"
            >
              <span className="text-[13px] leading-none">🍏</span>
              <span className="text-[12px] font-black text-slate-600 leading-none">{wallet.user}</span>
              <span className="text-rose-200 text-[10px] leading-none">·</span>
              <span className="text-[13px] leading-none">🍎</span>
              <span className="text-[12px] font-black text-slate-600 leading-none">{wallet.ta}</span>
            </button>
            {/* 商店单独一个入口 [用户确认]：钱包横条只是"看有多少钱"，
                进商店是另一件事，混在一个按钮里两个目的都不清楚。 */}
            <button
              onClick={() => setShowStore(true)}
              className="w-9 h-9 rounded-full bg-white/80 shadow-sm flex items-center justify-center text-[15px] active:scale-90 transition-transform"
              aria-label="兑换商店"
            >
              🏪
            </button>
          </div>
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

      {showWallet && (
        <YuZhouWalletPage wallet={wallet} taName={taName} onBack={() => setShowWallet(false)} />
      )}

      {showStore && (
        <YuZhouStorePage
          charId={charId}
          wallet={wallet}
          coupons={coupons}
          onBought={(w, c) => { setWallet(w); setCoupons(c); }}
          onToast={setToast}
          onBack={() => setShowStore(false)}
        />
      )}

      {toast && (
        <div className="absolute left-1/2 -translate-x-1/2 z-[80] px-4 py-2 rounded-full text-[12px] font-bold
                        bg-slate-800/85 text-white shadow-lg pointer-events-none"
             style={{ bottom: 'calc(var(--safe-bottom, 0px) + 28px)' }}>
          {toast}
        </div>
      )}

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
                      {m?.user && <span title="我">{m.user.emoji || '✏️'}</span>}
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
  const [showNotes, setShowNotes] = useState(false);
  const [taMood, setTaMood] = useState<MoodSide | null>(null);
  const [generatingTa, setGeneratingTa] = useState(false);
  const [pokeCount, setPokeCount] = useState(0);
  const genAbortRef = useRef<AbortController | null>(null);
  const [homeBg, setHomeBg] = useState<string | null>(null);
  const bgInputRef = useRef<HTMLInputElement>(null);
  const homeBgId = `yuzhou-home-bg-${moodCharId}`;

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

  // 中间卡片背景：点一下上传，存 IndexedDB（和头像同一套）
  useEffect(() => {
    let cancelled = false;
    DB.getAsset(homeBgId).then(v => { if (!cancelled) setHomeBg(v || null); }).catch(() => {});
    return () => { cancelled = true; };
  }, [homeBgId]);

  const handleBgFile = async (file?: File) => {
    if (!file) return;
    try {
      const dataUrl = await processImage(file, { maxWidth: 1200, quality: 0.85 });
      await DB.saveAsset(homeBgId, dataUrl);
      setHomeBg(dataUrl);
      addToast?.('背景已更换', 'success');
    } catch {
      addToast?.('背景保存失败，可能是存储空间不足', 'error');
    }
  };

  const resetBg = async () => {
    try { await DB.saveAsset(homeBgId, ''); } catch { /* ignore */ }
    setHomeBg(null);
  };

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


  const NAV_ITEMS = [
    { key: 'note', label: '便签', Icon: NotePencil, circle: 'bg-[#fde2e8]', icon: 'text-[#ef7f9c]' },
    { key: 'game', label: '游戏', Icon: GameController, circle: 'bg-[#ece3fb]', icon: 'text-[#9b7fe0]' },
    { key: 'home', label: '与昼', Icon: null, circle: '', icon: '' },
    { key: 'money', label: '金钱', Icon: Coins, circle: 'bg-[#fdf0d3]', icon: 'text-[#e3a53c]' },
    { key: 'gift', label: '礼物', Icon: Gift, circle: 'bg-[#dff3e6]', icon: 'text-[#5fb887]' },
  ] as const;

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#fdf3f2] text-slate-700">
      <style>{POKE_CSS + TICKET_CSS}</style>
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_12%_8%,rgba(255,214,224,.55),transparent_30%),radial-gradient(circle_at_88%_20%,rgba(255,228,232,.6),transparent_32%),radial-gradient(circle_at_50%_100%,rgba(250,225,230,.7),transparent_45%),linear-gradient(180deg,#fff9f8_0%,#fdf1f0_100%)]" />
      <div className="relative h-full overflow-y-auto overscroll-none pb-[124px]" style={{ paddingTop: 'var(--safe-top)' }}>

        {/* 顶栏：返回 / 纪念日 / 生成TA心情 */}
        <header className="h-14 px-3 flex items-center justify-between">
          <button onClick={closeApp} aria-label="返回" className="w-9 h-9 rounded-full bg-white/60 text-rose-400 text-xl active:scale-90 transition-transform">‹</button>
          <div className="flex items-center gap-2 text-rose-400">
            <SparkLines className="w-4 h-4" />
            <span className="text-[24px] font-black tracking-[.3em] pl-[.3em] text-[#e2577f]">纪念日</span>
            <SparkLines flip className="w-4 h-4" />
          </div>
          <div className="flex items-center">
            <SparkLines className="w-3.5 h-3.5 text-rose-300 -mr-0.5" />
            <button
              onClick={handleGenerateTa}
              disabled={generatingTa}
              aria-label="生成TA的今日心情"
              title="生成TA的今日心情（调用一次 API）"
              className="w-10 h-10 rounded-full bg-gradient-to-br from-[#fb9fb6] to-[#f37c9c] text-white shadow-[0_6px_14px_rgba(240,110,145,.35)] flex items-center justify-center active:scale-90 transition-transform disabled:opacity-80"
            >
              <ArrowClockwise size={20} weight="bold" className={generatingTa ? 'animate-spin' : ''} />
            </button>
          </div>
        </header>

        {/* 头像 + 爱心 */}
        <section className="px-4">
          <div className="flex items-center justify-between">
            <AvatarPicker label="我" image={userAvatar} fallback={fallbackUser} onChange={v => saveAvatar('user', v)} />
            <AnniversaryHeart day={day} onClick={() => { setDayDraft(day); setEditingDay(true); }} />
            <AvatarPicker label={char?.name || 'TA'} image={charAvatar} fallback={fallbackChar} onChange={v => saveAvatar('char', v)} />
          </div>
          <div className="mt-1 flex items-center justify-center gap-3 text-[#e2577f]">
            <HeartBadge className="w-4 h-4 -rotate-12" />
            <span className="text-[14px] font-bold tracking-[.3em] pl-[.3em]">一起走过的每一天</span>
            <HeartBadge className="w-4 h-4 rotate-12" />
          </div>
        </section>

        {/* 中间：两个人的小世界（点一下换背景） */}
        <section className="mx-4 mt-4">
          <div
            role="button"
            tabIndex={0}
            onClick={() => bgInputRef.current?.click()}
            className="relative h-[200px] sm:h-[230px] rounded-[26px] overflow-hidden border-2 border-white shadow-[0_10px_30px_rgba(160,130,190,.18)] active:scale-[.99] transition-transform"
          >
            {homeBg ? (
              <img src={homeBg} alt="背景" className="absolute inset-0 w-full h-full object-cover" />
            ) : (
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_15%_35%,rgba(255,255,255,.75),transparent_28%),radial-gradient(ellipse_at_85%_45%,rgba(255,236,244,.9),transparent_30%),radial-gradient(ellipse_at_50%_105%,rgba(214,200,240,.9),transparent_45%),linear-gradient(180deg,#d9d6f5_0%,#ecd9f0_45%,#fbe2ea_100%)]" />
            )}
            <div className="absolute inset-0 flex items-center justify-center p-6">
              <div className="px-8 py-5 rounded-[22px] border-2 border-dashed border-white/80 bg-white/15 text-center text-[#8e7aa8] backdrop-blur-[1px]">
                <div className="text-[15px] font-bold tracking-[.3em] pl-[.3em]">两个人的小世界</div>
                <div className="mt-2 text-[12px] tracking-[.22em]">· 待加入像素家园 ·</div>
              </div>
            </div>
            <div className="absolute right-2.5 bottom-2.5 flex gap-1.5">
              {homeBg && (
                <button
                  onClick={e => { e.stopPropagation(); void resetBg(); }}
                  className="h-7 px-2.5 rounded-full bg-white/75 text-[10px] font-bold text-slate-500 shadow-sm active:scale-95"
                >恢复默认</button>
              )}
              <span className="h-7 px-2.5 rounded-full bg-white/75 text-[10px] font-bold text-rose-400 shadow-sm flex items-center gap-1">
                <Camera size={12} weight="bold" />{homeBg ? '换背景' : '点击上传背景'}
              </span>
            </div>
            <input ref={bgInputRef} type="file" accept="image/*" className="hidden"
              onClick={e => e.stopPropagation()}
              onChange={e => { void handleBgFile(e.target.files?.[0]); e.target.value = ''; }} />
          </div>
        </section>

        {/* 今日心情 */}
        <section className="mx-4 mt-4 rounded-[28px] bg-white/65 border-2 border-white shadow-[0_10px_30px_rgba(172,88,108,.08)]">
          <div className="pt-4 text-center">
            <div className="flex items-center justify-center gap-3 text-[#e2577f]">
              <HeartBadge className="w-4 h-4 -rotate-12" />
              <span className="text-[24px] font-black tracking-[.2em] pl-[.2em]">今日心情</span>
              <HeartBadge className="w-4 h-4 rotate-12" />
            </div>
            <button
              onClick={() => { flushUserSave(); setShowCalendar(true); }}
              className="mt-1.5 inline-flex items-center gap-1 px-3 py-1 rounded-full bg-[#fdebef] text-[10px] font-bold text-rose-400 active:scale-95 transition-transform"
            >
              <CalendarBlank size={12} weight="bold" />本月
            </button>
          </div>

          <div className="relative flex px-3 pt-3 pb-5">
            {/* 虚线分隔 */}
            <div className="absolute left-1/2 top-5 bottom-7 border-l-2 border-dashed border-rose-200/80" />

            {/* 左：我 */}
            <div className="flex-1 min-w-0 pr-3 flex flex-col">
              <div className="h-[92px] flex items-center justify-center">
                <button onClick={() => setShowEmojiPicker(v => !v)} aria-label="选择我的心情" className="active:scale-90 transition-transform">
                  {userEmoji ? (
                    <span className="flex items-center gap-1">
                      <SparkLines className="w-4 h-4 text-rose-300" />
                      <span className="text-[62px] leading-none">{userEmoji}</span>
                      <SparkLines flip className="w-4 h-4 text-rose-300" />
                    </span>
                  ) : (
                    <DashedCircle><Plus size={30} weight="bold" /></DashedCircle>
                  )}
                </button>
              </div>
              <NotePaper tone="pink" tape="pink" tilt={-1}>
                <textarea value={userMood} maxLength={50} onChange={e => handleUserText(e.target.value)} onBlur={flushUserSave} placeholder="写下你的今日心情吧…"
                  className="w-full h-[64px] resize-none outline-none bg-transparent text-[13px] leading-5 text-slate-600 placeholder:text-slate-400/80" />
                <div className="text-[10px] text-right text-slate-400">{userMood.length}/50</div>
              </NotePaper>
            </div>

            {/* 右：TA */}
            <div className="flex-1 min-w-0 pl-3 flex flex-col">
              <div className="h-[92px] flex items-center justify-center">
                <button onClick={pokeTa} aria-label="戳一下TA" className="relative">
                  {taMood || generatingTa ? (
                    <span className="flex items-center gap-1">
                      <SparkLines className="w-4 h-4 text-rose-300" />
                      <span key={pokeCount} className={`text-[62px] leading-none ${pokeCount > 0 ? 'yz-poke' : 'inline-block'}`}>
                        {generatingTa ? '💭' : taMood?.emoji}
                      </span>
                      <SparkLines flip className="w-4 h-4 text-rose-300" />
                    </span>
                  ) : (
                    <span key={pokeCount} className={pokeCount > 0 ? 'yz-poke' : 'inline-block'}>
                      <DashedCircle><span className="text-[30px] font-black">?</span></DashedCircle>
                    </span>
                  )}
                  {pokeCount > 0 && <span key={`h${pokeCount}`} className="yz-heart absolute left-1/2 -top-1 text-[16px] pointer-events-none">💗</span>}
                </button>
              </div>
              <NotePaper tone="cream" tape="blue" tilt={1}>
                <div className="min-h-[80px] flex items-center justify-center text-center text-[13px] leading-5 text-slate-600 break-words">
                  {generatingTa
                    ? <span className="text-rose-300">{char?.name || 'TA'}正在想今天的心情…</span>
                    : taMood?.text || <span className="text-slate-400">{char?.name || 'TA'}的心情是什么？<br />点右上角 ↻ 问问吧。</span>}
                </div>
              </NotePaper>
            </div>
          </div>

          {showEmojiPicker && <div className="border-t border-rose-100 bg-[#fffaf8] rounded-b-[26px] p-3 grid grid-cols-6 gap-2">{EMOJIS.map(e => <button key={e} onClick={() => handleUserEmoji(e)} className="text-2xl h-10 rounded-xl hover:bg-white active:scale-90">{e}</button>)}</div>}
        </section>
        <div className="h-4" />
      </div>

      {/* 底部导航 */}
      <nav className="absolute bottom-0 inset-x-0 z-50 px-2" style={{ paddingBottom: 'max(8px, var(--safe-bottom))' }}>
        <div className="max-w-md mx-auto rounded-[34px] bg-white/85 backdrop-blur-xl border-2 border-white shadow-[0_-4px_24px_rgba(172,88,108,.10)] px-2 pt-2.5 pb-2 flex items-end justify-between">
          {NAV_ITEMS.map(({ key, label, Icon, circle, icon }) => {
            const isHome = key === 'home';
            const onClick = () => {
              if (key === 'game') setShowGamePage(true);
              else if (key === 'note') setShowNotes(true);
              else if (!isHome) addToast?.(`${label}入口已预留，之后继续做`, 'info');
            };
            return (
              <button key={key} onClick={onClick} className="w-[19%] flex flex-col items-center gap-1 active:scale-90 transition-transform">
                {isHome ? (
                  <span className="-mt-7 w-[70px] h-[70px] rounded-full bg-gradient-to-br from-[#fde4ea] to-[#fbd0dc] ring-4 ring-white shadow-[0_6px_16px_rgba(240,110,145,.22)] flex items-center justify-center">
                    <RingIcon className="w-11 h-11" />
                  </span>
                ) : (
                  <span className={`w-[50px] h-[50px] rounded-full ${circle} flex items-center justify-center`}>
                    {Icon && <Icon size={27} weight="duotone" className={icon} />}
                  </span>
                )}
                <span className={`text-[11px] font-bold ${isHome ? 'text-[#e2577f]' : 'text-slate-500'}`}>{label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {showGamePage && <YuZhouGamePage onBack={() => setShowGamePage(false)} />}
      {showNotes && <YuZhouNoteBoard todayKey={todayKey} onBack={() => setShowNotes(false)} />}
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
