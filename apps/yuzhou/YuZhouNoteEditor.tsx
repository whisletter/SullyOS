/**
 * 与昼 · 写便签页
 * 上面是便签纸（点击书写，最多 60 字，可以贴贴纸），下面是「纸张 / 贴纸」两栏。
 * 点纸右下角「去黏贴」把便签交回木板页。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, Plus, Sticker as StickerIcon, Trash, X } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import { DB } from '../../utils/db';
import { processImage } from '../../utils/file';
import {
  DEFAULT_NOTE_STICKERS, NOTE_MAX_CHARS, NOTE_MAX_STICKERS, NOTE_PAPERS, newId, paperOf, type NoteSticker,
} from '../../utils/yuzhouNotes';
import YuZhouNoteCard, { NOTE_CARD_CSS } from './YuZhouNoteCard';

export interface NoteDraft {
  text: string;
  paperId: string;
  stickers: NoteSticker[];
}

interface Props {
  onBack: () => void;
  onPaste: (draft: NoteDraft) => void;
}

type Tab = 'paper' | 'sticker';

const PAGE_BG = 'bg-[radial-gradient(circle_at_15%_10%,rgba(255,190,205,.42),transparent_28%),radial-gradient(circle_at_90%_25%,rgba(255,220,224,.5),transparent_30%),linear-gradient(180deg,#fffafa_0%,#fff4f1_100%)]';

const YuZhouNoteEditor: React.FC<Props> = ({ onBack, onPaste }) => {
  const { addToast } = useOS();
  const [text, setText] = useState('');
  const [paperId, setPaperId] = useState(NOTE_PAPERS[0].id);
  const [stickers, setStickers] = useState<NoteSticker[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('paper');
  const [customStickers, setCustomStickers] = useState<{ name: string; url: string }[]>([]);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [deleting, setDeleting] = useState<{ name: string; url: string } | null>(null);
  const [size, setSize] = useState(280);

  const stageRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const gesture = useRef<{ id: string; mode: 'move' | 'resize'; cx: number; cy: number; dist: number; scale: number } | null>(null);
  const longPress = useRef<number | undefined>(undefined);

  useEffect(() => { DB.getJournalStickers().then(setCustomStickers).catch(() => {}); }, []);

  // 便签纸尽量大，但不超过可用区域
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const fit = () => setSize(Math.max(180, Math.min(el.clientWidth - 56, el.clientHeight - 56, 330)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const paper = paperOf(paperId);

  // ---------- 贴纸 ----------
  const addSticker = (url: string) => {
    if (stickers.length >= NOTE_MAX_STICKERS) { addToast?.(`一张便签最多贴 ${NOTE_MAX_STICKERS} 个贴纸`, 'info'); return; }
    const s: NoteSticker = {
      id: newId('st'),
      url,
      x: 25 + Math.random() * 50,
      y: 30 + Math.random() * 45,
      rotation: Math.round(Math.random() * 40 - 20),
      scale: 1,
    };
    setStickers(prev => [...prev, s]);
    setSelected(s.id);
  };

  const onStickerDown = (e: React.PointerEvent, id: string, mode: 'move' | 'resize') => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setSelected(id);
    const s = stickers.find(v => v.id === id);
    const rect = paperRef.current?.getBoundingClientRect();
    if (!s || !rect) return;
    const centerX = rect.left + (s.x / 100) * rect.width;
    const centerY = rect.top + (s.y / 100) * rect.height;
    gesture.current = { id, mode, cx: e.clientX, cy: e.clientY, dist: Math.max(12, Math.hypot(e.clientX - centerX, e.clientY - centerY)), scale: s.scale };
  };

  const onStickerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    const rect = paperRef.current?.getBoundingClientRect();
    if (!g || !rect) return;
    setStickers(prev => prev.map(s => {
      if (s.id !== g.id) return s;
      if (g.mode === 'move') {
        return {
          ...s,
          x: Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100)),
          y: Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100)),
        };
      }
      const cx = rect.left + (s.x / 100) * rect.width;
      const cy = rect.top + (s.y / 100) * rect.height;
      const d = Math.hypot(e.clientX - cx, e.clientY - cy);
      return { ...s, scale: Math.min(2.4, Math.max(0.5, g.scale * (d / g.dist))) };
    }));
  };

  const onStickerUp = () => { gesture.current = null; };

  // ---------- 导入贴纸（和交换日记同一个贴纸库） ----------
  const reloadCustom = async () => setCustomStickers(await DB.getJournalStickers());

  const handleImportText = async () => {
    let count = 0;
    for (const line of importText.split('\n')) {
      const parts = line.split('--');
      if (parts.length < 2) continue;
      const name = parts[0].trim();
      const url = parts.slice(1).join('--').trim();
      if (name && url) { await DB.saveJournalSticker(name, url); count++; }
    }
    if (!count) { addToast?.('格式是「名称--图片网址」，每行一个', 'info'); return; }
    await reloadCustom();
    setImportText('');
    setShowImport(false);
    addToast?.(`添加了 ${count} 个贴纸`, 'success');
  };

  const handleImportFile = async (file?: File) => {
    if (!file) return;
    try {
      const url = await processImage(file, { maxWidth: 300, quality: 0.9 });
      await DB.saveJournalSticker(`与昼贴纸-${Date.now()}`, url);
      await reloadCustom();
      setShowImport(false);
      addToast?.('贴纸已添加', 'success');
    } catch {
      addToast?.('贴纸保存失败，可能是存储空间不足', 'error');
    }
  };

  const confirmDeleteCustom = async () => {
    if (!deleting) return;
    await DB.deleteJournalSticker(deleting.name);
    setCustomStickers(prev => prev.filter(s => s.name !== deleting.name));
    setDeleting(null);
  };

  const handlePaste = () => {
    if (!text.trim()) { addToast?.('先写点什么吧', 'info'); textRef.current?.focus(); return; }
    onPaste({ text: text.trim().slice(0, NOTE_MAX_CHARS), paperId, stickers });
  };

  return (
    <div className="absolute inset-0 z-[70] bg-[#fff7f5] text-slate-800 flex flex-col">
      <style>{NOTE_CARD_CSS}</style>
      <div className={`absolute inset-0 pointer-events-none ${PAGE_BG}`} />

      <header className="relative h-14 px-4 flex items-center justify-between shrink-0" style={{ marginTop: 'var(--safe-top)' }}>
        <button onClick={onBack} aria-label="返回木板" className="w-9 h-9 rounded-full bg-white/80 shadow-sm text-rose-400 text-xl active:scale-90 transition-transform">‹</button>
        <div className="font-black tracking-[.2em] text-rose-500 text-base">写便签</div>
        <div className="w-9 h-9" />
      </header>

      {/* 便签纸 */}
      <div ref={stageRef} className="relative flex-1 min-h-0 flex items-center justify-center" onPointerDown={() => setSelected(null)}>
        <div className="relative" style={{ width: size, height: size }}>
          <div ref={paperRef} className="absolute inset-0">
            <YuZhouNoteCard
              size={size}
              author="user"
              text={text}
              paperId={paperId}
              bare
              hideStickers
              body={
                <textarea
                  ref={textRef}
                  value={text}
                  maxLength={NOTE_MAX_CHARS}
                  onChange={e => setText(e.target.value.slice(0, NOTE_MAX_CHARS))}
                  onPointerDown={e => { e.stopPropagation(); setSelected(null); }}
                  placeholder="点这里写便签…"
                  className="w-full h-full resize-none bg-transparent outline-none placeholder:opacity-40"
                  style={{ color: paper.ink, lineHeight: 1.55, fontSize: '.95em' }}
                />
              }
            />
            {/* 贴纸层 */}
            <div className="absolute inset-0 z-[5] pointer-events-none" style={{ fontSize: size / 12 }}>
              {stickers.map(s => {
                const isSel = selected === s.id;
                return (
                  <div
                    key={s.id}
                    className="absolute pointer-events-auto"
                    style={{ left: `${s.x}%`, top: `${s.y}%`, width: `${22 * s.scale}%`, transform: `translate(-50%, -50%) rotate(${s.rotation}deg)`, touchAction: 'none' }}
                    onPointerDown={e => onStickerDown(e, s.id, 'move')}
                    onPointerMove={onStickerMove}
                    onPointerUp={onStickerUp}
                    onPointerCancel={onStickerUp}
                  >
                    <img src={s.url} alt="" draggable={false} className={`w-full object-contain select-none ${isSel ? 'outline-dashed outline-2 outline-rose-300 outline-offset-2 rounded' : ''}`} />
                    {isSel && (
                      <>
                        <button
                          aria-label="删除贴纸"
                          onPointerDown={e => { e.stopPropagation(); setStickers(prev => prev.filter(v => v.id !== s.id)); setSelected(null); }}
                          className="absolute -top-3 -left-3 w-6 h-6 rounded-full bg-white text-rose-400 shadow flex items-center justify-center"
                        ><X size={12} weight="bold" /></button>
                        <span
                          aria-label="缩放贴纸"
                          onPointerDown={e => onStickerDown(e, s.id, 'resize')}
                          onPointerMove={onStickerMove}
                          onPointerUp={onStickerUp}
                          className="absolute -bottom-3 -right-3 w-6 h-6 rounded-full bg-rose-400 border-2 border-white shadow"
                          style={{ touchAction: 'none' }}
                        />
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <span className="absolute left-3 bottom-2 z-[6] text-[11px] pointer-events-none" style={{ color: paper.ink, opacity: .45 }}>{text.length}/{NOTE_MAX_CHARS}</span>

          <button
            onClick={handlePaste}
            className="absolute z-[6] -right-3 -bottom-4 h-10 px-4 rounded-full bg-gradient-to-br from-[#fb9fb6] to-[#f37c9c] text-white text-[13px] font-bold shadow-[0_6px_14px_rgba(240,110,145,.35)] active:scale-95 transition-transform"
          >去黏贴</button>
        </div>
      </div>

      {/* 纸张 / 贴纸 */}
      <div className="relative shrink-0 rounded-t-[28px] bg-white/85 backdrop-blur-xl border-t-2 border-white shadow-[0_-6px_24px_rgba(172,88,108,.10)]" style={{ paddingBottom: 'max(10px, var(--safe-bottom))' }}>
        <div className="flex gap-2 px-4 pt-3">
          {([['paper', '纸张', ImageIcon], ['sticker', '贴纸', StickerIcon]] as const).map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`h-8 px-3.5 rounded-full text-[12px] font-bold flex items-center gap-1.5 transition-colors ${tab === key ? 'bg-rose-400 text-white' : 'bg-rose-50 text-rose-400'}`}
            ><Icon size={14} weight="bold" />{label}</button>
          ))}
          {tab === 'sticker' && <span className="ml-auto self-center text-[11px] text-rose-300">{stickers.length}/{NOTE_MAX_STICKERS}</span>}
        </div>

        <div className="h-[136px] overflow-y-auto overscroll-contain px-4 pt-3 pb-2">
          {tab === 'paper' ? (
            <div className="flex gap-3 overflow-x-auto no-scrollbar -mx-4 px-4 pb-1">
              {NOTE_PAPERS.map(p => (
                <button key={p.id} onClick={() => setPaperId(p.id)} className="shrink-0 w-[72px] flex flex-col items-center gap-1.5 active:scale-95 transition-transform">
                  <span
                    className={`w-[72px] h-[72px] rounded-[10px] shadow-sm ${paperId === p.id ? 'ring-2 ring-rose-400 ring-offset-2' : 'ring-1 ring-rose-100'}`}
                    style={{ ...p.style, fontSize: 6 }}
                  />
                  <span className={`text-[11px] ${paperId === p.id ? 'text-rose-500 font-bold' : 'text-slate-400'}`}>{p.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-6 gap-2">
              <button onClick={() => setShowImport(true)} aria-label="导入贴纸" className="aspect-square rounded-xl border-2 border-dashed border-rose-200 text-rose-300 flex items-center justify-center active:scale-95">
                <Plus size={18} weight="bold" />
              </button>
              {DEFAULT_NOTE_STICKERS.map(s => (
                <button key={s.url} onClick={() => addSticker(s.url)} className="aspect-square rounded-xl bg-rose-50/60 flex items-center justify-center active:scale-90 transition-transform">
                  <img src={s.url} alt="" className="w-7 h-7 object-contain pointer-events-none" />
                </button>
              ))}
              {customStickers.map(s => (
                <button
                  key={s.name}
                  onClick={() => addSticker(s.url)}
                  onTouchStart={() => { longPress.current = window.setTimeout(() => setDeleting(s), 550); }}
                  onTouchEnd={() => window.clearTimeout(longPress.current)}
                  onTouchMove={() => window.clearTimeout(longPress.current)}
                  onContextMenu={e => { e.preventDefault(); setDeleting(s); }}
                  className="aspect-square rounded-xl bg-rose-50/60 flex items-center justify-center active:scale-90 transition-transform"
                >
                  <img src={s.url} alt="" className="w-7 h-7 object-contain pointer-events-none" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 导入贴纸 */}
      {showImport && (
        <div className="absolute inset-0 z-[80] bg-black/30 flex items-center justify-center px-7" onClick={() => setShowImport(false)}>
          <div className="w-full max-w-xs rounded-[28px] bg-white p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="font-bold text-slate-800">导入贴纸</div>
            <div className="text-xs text-slate-400 mt-1">和交换日记共用，这里加的那边也能用。</div>
            <button onClick={() => fileRef.current?.click()} className="mt-4 w-full h-11 rounded-2xl bg-rose-50 text-rose-500 font-bold flex items-center justify-center gap-2 active:scale-[.98]">
              <ImageIcon size={18} weight="bold" />从相册选图片
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={e => { void handleImportFile(e.target.files?.[0]); e.target.value = ''; }} />
            <div className="text-[11px] text-slate-400 mt-4 mb-1.5">或者粘贴网址：每行一个「名称--图片网址」</div>
            <textarea
              value={importText}
              onChange={e => setImportText(e.target.value)}
              placeholder={'小猫--https://...\n爱心--https://...'}
              className="w-full h-24 rounded-2xl bg-slate-50 p-3 text-[13px] resize-none outline-none text-slate-700"
            />
            <div className="mt-3 flex gap-2">
              <button onClick={() => setShowImport(false)} className="flex-1 h-11 rounded-2xl bg-slate-100 text-slate-500 font-bold">取消</button>
              <button onClick={handleImportText} className="flex-1 h-11 rounded-2xl bg-rose-400 text-white font-bold">添加</button>
            </div>
          </div>
        </div>
      )}

      {deleting && (
        <div className="absolute inset-0 z-[80] bg-black/30 flex items-center justify-center px-8" onClick={() => setDeleting(null)}>
          <div className="w-full max-w-xs rounded-[28px] bg-white p-5 shadow-2xl text-center" onClick={e => e.stopPropagation()}>
            <img src={deleting.url} alt="" className="w-14 h-14 object-contain mx-auto" />
            <div className="mt-3 font-bold text-slate-800">删除这个贴纸？</div>
            <div className="text-xs text-slate-400 mt-1">交换日记里也会一起删掉。</div>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setDeleting(null)} className="flex-1 h-11 rounded-2xl bg-slate-100 text-slate-500 font-bold">取消</button>
              <button onClick={confirmDeleteCustom} className="flex-1 h-11 rounded-2xl bg-rose-400 text-white font-bold flex items-center justify-center gap-1.5"><Trash size={16} weight="bold" />删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default YuZhouNoteEditor;
