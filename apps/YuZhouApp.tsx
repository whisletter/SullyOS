
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowClockwise, Camera, Check, X } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';

const ANNIVERSARY_KEY = 'yuzhou_anniversary_day';
const USER_MOOD_KEY = 'yuzhou_user_mood';
const USER_EMOJI_KEY = 'yuzhou_user_emoji';

const EMOJIS = ['😊', '🥰', '😸', '😠', '😢', '😣', '😾', '😎', '😳', '🤧', '😈', '😼'];
const TA_EMOJIS = ['😊', '🥰', '😸', '😠', '😢', '😣', '😾', '😎', '😳', '🤧', '😈', '😼'];

const storageGet = (key: string, fallback = '') => {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
};
const storageSet = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
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

const YuZhouApp: React.FC = () => {
  const { activeCharacterId, characters, userProfile, closeApp, addToast } = useOS();
  const char = characters.find(c => c.id === activeCharacterId) ?? null;
  const [day, setDay] = useState(() => storageGet(ANNIVERSARY_KEY, '520'));
  const [editingDay, setEditingDay] = useState(false);
  const [dayDraft, setDayDraft] = useState(day);
  const [userAvatar, setUserAvatar] = useState<string | null>(null);
  const [charAvatar, setCharAvatar] = useState<string | null>(null);
  const [userMood, setUserMood] = useState(() => storageGet(USER_MOOD_KEY));
  const [userEmoji, setUserEmoji] = useState(() => storageGet(USER_EMOJI_KEY, '🥰'));
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [taMoodIndex, setTaMoodIndex] = useState(0);
  const [taMoodText, setTaMoodText] = useState('');
  const [refreshingTaMood, setRefreshingTaMood] = useState(false);

  const fallbackUser = userProfile?.perCharAvatars?.[activeCharacterId || ''] || userProfile?.avatar;
  const fallbackChar = char?.avatar;
  const taEmoji = TA_EMOJIS[taMoodIndex % TA_EMOJIS.length];

  const refreshTaMood = useCallback(() => {
    setRefreshingTaMood(true);
    window.setTimeout(() => {
      const nextIndex = Math.floor(Math.random() * TA_EMOJIS.length);
      const name = char?.name || 'TA';
      const texts = [
        `${name}今天看起来心情不错，想和你待在一起。`,
        `${name}今天有一点小情绪，戳一下问问TA吧。`,
        `${name}今天状态轻松，似乎在期待你的消息。`,
        `${name}今天有点累，但还是想和你说说话。`,
        `${name}今天心里藏着一点小开心。`,
      ];
      setTaMoodIndex(nextIndex);
      setTaMoodText(texts[Math.floor(Math.random() * texts.length)]);
      setRefreshingTaMood(false);
    }, 220);
  }, [char?.name]);


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
    setDay(cleaned); storageSet(ANNIVERSARY_KEY, cleaned); setEditingDay(false);
  };

  useEffect(() => { storageSet(USER_MOOD_KEY, userMood); }, [userMood]);
  useEffect(() => { storageSet(USER_EMOJI_KEY, userEmoji); }, [userEmoji]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#fff7f5] text-slate-800">
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_15%_10%,rgba(255,190,205,.42),transparent_28%),radial-gradient(circle_at_90%_25%,rgba(255,220,224,.5),transparent_30%),linear-gradient(180deg,#fffafa_0%,#fff4f1_100%)]" />
      <div className="relative h-full overflow-y-auto overscroll-none pb-[94px]" style={{ paddingTop: 'var(--safe-top)' }}>
        <header className="h-12 px-4 flex items-center justify-between">
          <button onClick={closeApp} className="w-9 h-9 rounded-full bg-white/70 shadow-sm text-rose-400 text-lg">‹</button>
          <div className="font-black tracking-[.22em] text-rose-400 text-sm">与昼</div>
          <button
            onClick={refreshTaMood}
            disabled={refreshingTaMood}
            aria-label="刷新TA的心情"
            title="刷新TA的心情"
            className={`w-9 h-9 rounded-full bg-white/80 border border-rose-100 shadow-sm flex items-center justify-center text-rose-400 active:scale-90 transition-transform ${refreshingTaMood ? 'animate-spin' : ''}`}
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
          </div>

          <div className="flex mt-2 pb-5 px-2 sm:px-3">
            {/* 左：用户 */}
            <div className="flex-1 min-w-0 px-2 sm:px-4 py-2 text-center">
              <div className="text-[12px] font-bold tracking-wide text-rose-500/75">我的心情</div>
              <button onClick={() => setShowEmojiPicker(v => !v)} className="mt-2 text-[58px] leading-none active:scale-90 transition-transform">{userEmoji}</button>
              <div className="relative mt-2 min-h-[86px] rounded-[18px] bg-[#fffaf2] border border-[#f3dfcf] shadow-[0_3px_10px_rgba(120,80,50,.05)] p-3 text-left">
                <span className="absolute -top-2 left-4 w-10 h-4 rounded-sm bg-rose-200/80 rotate-[-8deg] shadow-sm" />
                <textarea value={userMood} maxLength={50} onChange={e => setUserMood(e.target.value)} placeholder="写下你的今日心情吧…"
                  className="w-full h-[58px] resize-none outline-none bg-transparent text-[13px] leading-5 text-slate-700 placeholder:text-slate-300" />
                <div className="text-[9px] text-right text-slate-300 mt-0.5">{userMood.length}/50</div>
              </div>
            </div>

            <div className="w-px bg-rose-100 self-stretch my-3" />

            {/* 右：TA */}
            <div className="flex-1 min-w-0 px-2 sm:px-4 py-2 text-center">
              <div className="text-[12px] font-bold tracking-wide text-rose-500/75">{char?.name || 'TA'}的心情</div>
              <button onClick={refreshTaMood} disabled={refreshingTaMood} className={`mt-2 text-[58px] leading-none active:scale-90 transition-transform ${refreshingTaMood ? 'animate-bounce' : ''}`}>{taEmoji}</button>
              <div className="relative mt-2 min-h-[86px] rounded-[18px] bg-[#fffaf8] border border-[#f4d9e0] shadow-[0_3px_10px_rgba(120,80,50,.05)] p-3 text-left">
                <span className="absolute -top-2 left-4 w-10 h-4 rounded-sm bg-pink-200/80 rotate-[8deg] shadow-sm" />
                <div className="min-h-[58px] flex items-center justify-center text-center text-[13px] leading-5 text-slate-600 break-words">
                  {taMoodText || 'TA的心情是什么？戳一下TA问问吧。'}
                </div>
              </div>
            </div>
          </div>

          {showEmojiPicker && <div className="border-t border-rose-100 bg-[#fffaf8] p-3 grid grid-cols-6 gap-2">{EMOJIS.map(e => <button key={e} onClick={() => { setUserEmoji(e); setShowEmojiPicker(false); }} className="text-2xl h-10 rounded-xl hover:bg-white active:scale-90">{e}</button>)}</div>}
        </section>
        <div className="h-6" />
      </div>

      {/* 五入口导航 */}
      <nav className="absolute bottom-0 inset-x-0 z-50 px-4 pt-2 bg-white/90 backdrop-blur-xl border-t border-rose-100" style={{ paddingBottom: 'max(10px, var(--safe-bottom))' }}>
        <div className="max-w-md mx-auto flex items-end justify-between">
          {[
            ['📝', '便签'], ['🎮', '游戏'], ['💍', '与昼'], ['💰', '金钱'], ['🎁', '礼物']
          ].map(([icon, label], i) => (
            <button key={label} onClick={() => i === 2 ? undefined : addToast?.(`${label}入口已预留，之后继续做`, 'info')} className={`w-[18%] flex flex-col items-center gap-1 py-1 rounded-2xl ${i === 2 ? 'text-rose-500' : 'text-slate-400'} active:scale-90 transition-transform`}>
              <span className={`${i === 2 ? 'text-[29px]' : 'text-[23px]'} leading-none`}>{icon}</span>
              <span className="text-[9px] font-bold">{label}</span>
            </button>
          ))}
        </div>
      </nav>

      {editingDay && <div className="absolute inset-0 z-[70] bg-black/25 flex items-center justify-center px-8">
        <div className="w-full max-w-xs rounded-[28px] bg-white p-5 shadow-2xl">
          <div className="font-bold text-slate-800">修改纪念日天数</div>
          <div className="text-xs text-slate-400 mt-1">这里暂时由你手动填写，不自动计算。</div>
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
