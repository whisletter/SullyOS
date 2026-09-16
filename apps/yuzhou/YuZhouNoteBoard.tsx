/**
 * 与昼 · 便利贴木板
 *
 * 手势：点一下 = 提到最上层；双击 = 出现垃圾桶；长按 = 拖动（拖到底部垃圾桶也能删）；⭐ = 收藏
 * 木板最多 20 张，超出撕掉最旧的。收藏过的便利贴离开木板时存进记忆宫殿，没收藏的直接销毁。
 * 右上角 🔄：TA 每天贴一张。用户在那之前贴过，TA 就回应最新那张。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowClockwise, Trash } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import { DB } from '../../utils/db';
import { processImage } from '../../utils/file';
import { ingestYuZhouNoteToPalace } from '../../utils/memoryPalace/pipeline';
import { toDateKey } from '../../utils/yuzhouMood';
import {
  BOARD_MAX_NOTES, BOARD_RATIO, NOTE_SIZE_RATIO, boardPhotoAssetId, generateTaNote, loadBoard, newId,
  pendingUserNote, randomPlacement, saveBoard, trimBoard,
  type BoardStyle, type NoteBoardState, type YuZhouNote,
} from '../../utils/yuzhouNotes';
import YuZhouNoteCard, { NOTE_CARD_CSS } from './YuZhouNoteCard';
import YuZhouNoteEditor, { type NoteDraft } from './YuZhouNoteEditor';

const PAGE_BG = 'bg-[radial-gradient(circle_at_15%_10%,rgba(255,190,205,.42),transparent_28%),radial-gradient(circle_at_90%_25%,rgba(255,220,224,.5),transparent_30%),linear-gradient(180deg,#fffafa_0%,#fff4f1_100%)]';

// ==================== 三种木板 ====================

const BOARD_SURFACE: Record<BoardStyle, { frame: React.CSSProperties; surface: React.CSSProperties; stitch?: boolean }> = {
  cork: {
    frame: { background: '#fbeee6', boxShadow: '0 14px 36px -12px rgba(150,95,70,.35), inset 0 0 0 1px rgba(255,255,255,.8)' },
    surface: {
      backgroundColor: '#ebd2bb',
      backgroundImage: 'radial-gradient(rgba(150,100,62,.22) .8px, transparent 1.2px), radial-gradient(rgba(130,85,50,.14) 1.3px, transparent 1.8px), radial-gradient(rgba(255,255,255,.4) .9px, transparent 1.3px), radial-gradient(circle at 30% 12%, rgba(255,240,228,.6), transparent 45%)',
      backgroundSize: '7px 11px, 23px 17px, 13px 9px, 100% 100%',
      backgroundPosition: '0 0, 9px 4px, 4px 6px, 0 0',
      boxShadow: 'inset 0 2px 10px rgba(120,80,50,.22)',
    },
  },
  plaid: {
    frame: { background: '#fde2e8', boxShadow: '0 14px 36px -12px rgba(200,100,130,.30), inset 0 0 0 1px rgba(255,255,255,.8)' },
    surface: {
      backgroundColor: '#fff6f8',
      backgroundImage: 'linear-gradient(rgba(240,143,168,.15) 50%, transparent 50%), linear-gradient(90deg, rgba(240,143,168,.15) 50%, transparent 50%)',
      backgroundSize: '34px 34px',
      boxShadow: 'inset 0 2px 10px rgba(200,110,140,.14)',
    },
    stitch: true,
  },
  photo: {
    frame: { background: 'rgba(255,255,255,.35)', boxShadow: '0 14px 36px -12px rgba(120,80,90,.25), inset 0 0 0 1.5px rgba(255,255,255,.85)' },
    surface: { background: 'transparent' },
  },
};

/** 三个样式按钮的小图标 */
const StyleIcon: React.FC<{ kind: BoardStyle }> = ({ kind }) => {
  if (kind === 'cork') return (
    <svg viewBox="0 0 28 28" className="w-6 h-6" aria-hidden="true">
      <rect x="3" y="4" width="22" height="20" rx="5" fill="#ebd2bb" stroke="#d6b193" strokeWidth="1.4" />
      <circle cx="9" cy="11" r="1" fill="#b98e6c" /><circle cx="17" cy="9" r="1" fill="#b98e6c" /><circle cx="13" cy="17" r="1" fill="#b98e6c" /><circle cx="20" cy="18" r="1" fill="#b98e6c" />
      <rect x="11" y="9.5" width="9" height="9" rx="1.2" fill="#fff8f0" transform="rotate(-8 15.5 14)" />
      <circle cx="15.3" cy="9.6" r="1.8" fill="#f3a2b8" />
    </svg>
  );
  if (kind === 'plaid') return (
    <svg viewBox="0 0 28 28" className="w-6 h-6" aria-hidden="true">
      <defs><clipPath id="yz-plaid-clip"><rect x="3" y="4" width="22" height="20" rx="5" /></clipPath></defs>
      <rect x="3" y="4" width="22" height="20" rx="5" fill="#fff6f8" />
      <g clipPath="url(#yz-plaid-clip)" fill="#f7b8c6" opacity=".7">
        <rect x="7" y="4" width="4" height="20" /><rect x="17" y="4" width="4" height="20" />
        <rect x="3" y="8" width="22" height="4" /><rect x="3" y="17" width="22" height="4" />
      </g>
      <rect x="3" y="4" width="22" height="20" rx="5" fill="none" stroke="#f08fa8" strokeWidth="1.4" />
    </svg>
  );
  return (
    <svg viewBox="0 0 28 28" className="w-6 h-6" aria-hidden="true">
      <rect x="3" y="4" width="22" height="20" rx="5" fill="#f3eefb" stroke="#b9a6e3" strokeWidth="1.4" />
      <circle cx="19" cy="10" r="2.2" fill="#fbc9a8" />
      <path d="M4.5 21 L11 13.5 L15 18 L18 15 L23.5 21 Z" fill="#c7b5ec" />
      <path d="M4.5 21 L11 13.5 L14 17 L9.5 21 Z" fill="#f3a2b8" />
    </svg>
  );
};

// ==================== 一张在木板上的便利贴（手势） ====================

interface NoteGestureHandlers {
  onTap: (id: string) => void;
  onDragStart: (id: string, clientX: number, clientY: number) => void;
  onDragMove: (id: string, clientX: number, clientY: number) => void;
  onDragEnd: (id: string, clientX: number, clientY: number) => void;
}

const BoardNote: React.FC<{
  note: YuZhouNote;
  size: number;
  dragging: boolean;
  showTrash: boolean;
  pending: boolean;
  charName: string;
  handlers: NoteGestureHandlers;
  onToggleStar: (id: string) => void;
  onDelete: (id: string) => void;
}> = ({ note, size, dragging, showTrash, pending, charName, handlers, onToggleStar, onDelete }) => {
  const ref = useRef<HTMLDivElement>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const id = note.id;
    let active = false;
    let isDragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let startAt = 0;
    let timer: number | undefined;

    const begin = (x: number, y: number, target: EventTarget | null) => {
      if ((target as HTMLElement | null)?.closest?.('[data-no-drag]')) return false;
      active = true; isDragging = false; moved = false;
      startX = x; startY = y; startAt = Date.now();
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!active || moved) return;
        isDragging = true;
        try { navigator.vibrate?.(12); } catch { /* ignore */ }
        handlersRef.current.onDragStart(id, startX, startY);
      }, 420);
      return true;
    };
    const move = (x: number, y: number, isMouse: boolean): boolean => {
      if (!active) return false;
      if (!isDragging) {
        const dist = Math.hypot(x - startX, y - startY);
        if (isMouse && dist > 5) {
          // 电脑上按住直接拖
          window.clearTimeout(timer);
          isDragging = true;
          handlersRef.current.onDragStart(id, startX, startY);
        } else if (dist > 8) {
          moved = true;
          window.clearTimeout(timer);
          return false;
        } else return false;
      }
      handlersRef.current.onDragMove(id, x, y);
      return true;
    };
    const end = (x: number, y: number) => {
      if (!active) return;
      window.clearTimeout(timer);
      if (isDragging) handlersRef.current.onDragEnd(id, x, y);
      else if (!moved && Date.now() - startAt < 400) handlersRef.current.onTap(id);
      active = false; isDragging = false;
    };

    let lastTouch = { x: 0, y: 0 };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) { active = false; window.clearTimeout(timer); return; }
      const t = e.touches[0];
      lastTouch = { x: t.clientX, y: t.clientY };
      begin(t.clientX, t.clientY, e.target);
    };
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      lastTouch = { x: t.clientX, y: t.clientY };
      // 拖动中阻止页面滚动；没进入拖动就让木板正常滑
      if (move(t.clientX, t.clientY, false) && e.cancelable) e.preventDefault();
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (isDragging && e.cancelable) e.preventDefault(); // 拖完不要再触发 click
      end(lastTouch.x, lastTouch.y);
    };
    const onContextMenu = (e: Event) => e.preventDefault();

    const onMouseMove = (e: MouseEvent) => { move(e.clientX, e.clientY, true); };
    const onMouseUp = (e: MouseEvent) => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      end(e.clientX, e.clientY);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || !begin(e.clientX, e.clientY, e.target)) return;
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: false });
    el.addEventListener('touchcancel', onTouchEnd, { passive: false });
    el.addEventListener('contextmenu', onContextMenu);
    el.addEventListener('mousedown', onMouseDown);
    return () => {
      window.clearTimeout(timer);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      el.removeEventListener('contextmenu', onContextMenu);
      el.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [note.id]);

  return (
    <div
      ref={ref}
      className="absolute"
      style={{
        left: `${note.x}%`,
        top: `${note.y}%`,
        zIndex: dragging ? 9999 : note.z,
        transform: `rotate(${dragging ? note.rotation * 0.4 : note.rotation}deg) scale(${dragging ? 1.07 : 1})`,
        transition: dragging ? 'transform .15s ease-out' : 'transform .2s ease-out',
        filter: dragging ? 'drop-shadow(0 16px 18px rgba(110,60,50,.28))' : undefined,
        WebkitTouchCallout: 'none',
        WebkitUserSelect: 'none',
      }}
    >
      <YuZhouNoteCard
        className="yz-note-in"
        size={size}
        author={note.author}
        text={note.text}
        paperId={note.paperId}
        stickers={note.stickers}
        createdAt={note.createdAt}
        starred={note.starred}
        pending={pending}
        charName={charName}
        onToggleStar={() => onToggleStar(note.id)}
      />
      {showTrash && !dragging && (
        <button
          data-no-drag
          onClick={e => { e.stopPropagation(); onDelete(note.id); }}
          aria-label="删除这张便利贴"
          className="absolute -top-3 -left-3 z-[10] w-9 h-9 rounded-full bg-white text-rose-500 shadow-[0_4px_12px_rgba(200,80,110,.3)] ring-2 ring-rose-100 flex items-center justify-center active:scale-90 transition-transform"
        >
          <Trash size={18} weight="bold" />
        </button>
      )}
    </div>
  );
};

// ==================== 木板页 ====================

interface Props {
  todayKey?: string;
  onBack: () => void;
}

const YuZhouNoteBoard: React.FC<Props> = ({ todayKey, onBack }) => {
  const { activeCharacterId, characters, userProfile, apiConfig, addToast, memoryPalaceConfig } = useOS();
  const charId = activeCharacterId || 'default';
  const char = characters.find(c => c.id === activeCharacterId) ?? null;
  const charName = char?.name || 'TA';
  const today = todayKey || toDateKey();

  const [board, setBoard] = useState<NoteBoardState | null>(null);
  const boardStateRef = useRef<NoteBoardState | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [boardWidth, setBoardWidth] = useState(0);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [trashFor, setTrashFor] = useState<string | null>(null);
  const [overTrash, setOverTrash] = useState(false);
  const [editing, setEditing] = useState(false);
  const [generating, setGenerating] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const trashRef = useRef<HTMLDivElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ id: string; offX: number; offY: number; x: number; y: number } | null>(null);
  const lastTapRef = useRef<{ id: string; at: number } | null>(null);
  const genAbortRef = useRef<AbortController | null>(null);

  // ---------- 读库 ----------
  useEffect(() => {
    let cancelled = false;
    setBoard(null);
    boardStateRef.current = null;
    Promise.all([loadBoard(charId), DB.getAsset(boardPhotoAssetId(charId)).catch(() => null)]).then(([b, p]) => {
      if (cancelled) return;
      boardStateRef.current = b;
      setBoard(b);
      setPhoto(p || null);
    });
    return () => { cancelled = true; genAbortRef.current?.abort(); };
  }, [charId]);

  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const fit = () => setBoardWidth(el.clientWidth);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [board !== null]);

  // ---------- 记忆宫殿 ----------
  const archive = useCallback(async (notes: YuZhouNote[], ownerCharId: string) => {
    const owner = characters.find(c => c.id === ownerCharId);
    for (const n of notes.filter(v => v.starred)) {
      if (!owner) { addToast?.('找不到这个角色，收藏的便利贴没能存进记忆宫殿', 'error'); continue; }
      try {
        const r = await ingestYuZhouNoteToPalace(
          owner as any,
          { noteId: n.id, authorIsUser: n.author === 'user', text: n.text, createdAt: n.createdAt, replyToText: n.replyToText },
          (memoryPalaceConfig as any)?.lightLLM,
          userProfile?.name || '用户',
        );
        if (r.status === 'done' || r.status === 'extracted_none') addToast?.('收藏的便利贴已存进记忆宫殿', 'success');
        else if (r.status === 'palace_disabled') addToast?.(`${owner.name}没开记忆宫殿，这张收藏没能保存`, 'info');
        else if (r.status === 'lightllm_missing' || r.status === 'embedding_missing') addToast?.('记忆宫殿的副 API 或向量模型没配置，这张收藏没能保存', 'info');
      } catch (e: any) {
        console.error('[YuZhou] note ingest failed', e);
        addToast?.(`存进记忆宫殿失败：${e?.message?.slice(0, 40) || '未知错误'}`, 'error');
      }
    }
  }, [characters, memoryPalaceConfig, userProfile, addToast]);

  /** 改木板：更新界面 + 存库 + 超过 20 张时撕掉最旧的 */
  const commit = useCallback((update: (s: NoteBoardState) => NoteBoardState) => {
    const cur = boardStateRef.current;
    if (!cur) return;
    const next = update(cur);
    const { kept, removed } = trimBoard(next.notes);
    const final = { ...next, notes: kept };
    boardStateRef.current = final;
    setBoard(final);
    saveBoard(charId, final).catch(() => addToast?.('便利贴保存失败，可能是存储空间不足', 'error'));
    if (removed.length) void archive(removed, charId);
  }, [charId, archive, addToast]);

  const topZ = () => Math.max(0, ...(boardStateRef.current?.notes.map(n => n.z) || [0])) + 1;

  const bringToFront = (id: string) => {
    const note = boardStateRef.current?.notes.find(n => n.id === id);
    if (!note || note.z === topZ() - 1) return;
    const z = topZ();
    commit(s => ({ ...s, notes: s.notes.map(n => (n.id === id ? { ...n, z } : n)) }));
  };

  const deleteNote = (id: string) => {
    const note = boardStateRef.current?.notes.find(n => n.id === id);
    if (!note) return;
    setTrashFor(null);
    commit(s => ({ ...s, notes: s.notes.filter(n => n.id !== id) }));
    if (note.starred) void archive([note], charId);
  };

  const toggleStar = (id: string) => {
    commit(s => ({ ...s, notes: s.notes.map(n => (n.id === id ? { ...n, starred: !n.starred } : n)) }));
  };

  // ---------- 手势 ----------
  const noteHeightPct = (NOTE_SIZE_RATIO / BOARD_RATIO) * 100;

  const handlers: NoteGestureHandlers = {
    onTap: id => {
      const last = lastTapRef.current;
      const now = Date.now();
      if (last && last.id === id && now - last.at < 320) {
        setTrashFor(id);
        lastTapRef.current = null;
      } else {
        lastTapRef.current = { id, at: now };
        if (trashFor && trashFor !== id) setTrashFor(null);
      }
      bringToFront(id);
    },
    onDragStart: (id, cx, cy) => {
      const note = boardStateRef.current?.notes.find(n => n.id === id);
      const rect = surfaceRef.current?.getBoundingClientRect();
      if (!note || !rect) return;
      const left = (note.x / 100) * rect.width + rect.left;
      const top = (note.y / 100) * rect.height + rect.top;
      dragRef.current = { id, offX: cx - left, offY: cy - top, x: note.x, y: note.y };
      setTrashFor(null);
      setDraggingId(id);
      bringToFront(id);
    },
    onDragMove: (id, cx, cy) => {
      const d = dragRef.current;
      const rect = surfaceRef.current?.getBoundingClientRect();
      const scroller = scrollRef.current;
      if (!d || d.id !== id || !rect || !scroller) return;
      const x = Math.min(100 - NOTE_SIZE_RATIO * 100 + 4, Math.max(-4, ((cx - rect.left - d.offX) / rect.width) * 100));
      const y = Math.min(100 - noteHeightPct, Math.max(0, ((cy - rect.top - d.offY) / rect.height) * 100));
      d.x = x; d.y = y;
      setBoard(s => (s ? { ...s, notes: s.notes.map(n => (n.id === id ? { ...n, x, y } : n)) } : s));
      // 手指靠近上下边缘时，木板跟着滚
      const sr = scroller.getBoundingClientRect();
      if (cy < sr.top + 70) scroller.scrollTop -= 12;
      else if (cy > sr.bottom - 90) scroller.scrollTop += 12;
      const tr = trashRef.current?.getBoundingClientRect();
      setOverTrash(!!tr && cx >= tr.left - 16 && cx <= tr.right + 16 && cy >= tr.top - 16 && cy <= tr.bottom + 16);
    },
    onDragEnd: (id, cx, cy) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDraggingId(null);
      const tr = trashRef.current?.getBoundingClientRect();
      const inTrash = !!tr && cx >= tr.left - 16 && cx <= tr.right + 16 && cy >= tr.top - 16 && cy <= tr.bottom + 16;
      setOverTrash(false);
      if (inTrash) { deleteNote(id); return; }
      if (d) commit(s => ({ ...s, notes: s.notes.map(n => (n.id === id ? { ...n, x: d.x, y: d.y } : n)) }));
    },
  };

  /** 当前这一屏在木板上的范围（%），新便利贴贴在这里面 */
  const visibleRange = () => {
    const scroller = scrollRef.current;
    const surface = surfaceRef.current;
    if (!scroller || !surface) return { top: 0, bottom: 40 };
    const sr = scroller.getBoundingClientRect();
    const br = surface.getBoundingClientRect();
    const toPct = (clientY: number) => ((clientY - br.top) / br.height) * 100;
    return { top: Math.max(0, toPct(sr.top + 10)), bottom: Math.min(100, toPct(sr.bottom - 100)) };
  };

  // ---------- 贴上用户的便签 ----------
  const handlePaste = (draft: NoteDraft) => {
    setEditing(false);
    const range = visibleRange();
    const place = randomPlacement(range.top, range.bottom);
    const note: YuZhouNote = {
      id: newId('note'),
      author: 'user',
      text: draft.text,
      paperId: draft.paperId,
      stickers: draft.stickers,
      ...place,
      z: topZ(),
      starred: false,
      createdAt: Date.now(),
    };
    commit(s => ({ ...s, notes: [...s.notes, note] }));
  };

  // ---------- TA 贴一张（一天一次） ----------
  const usedToday = board?.taLastDate === today;

  const handleGenerate = async () => {
    if (generating) return;
    if (usedToday) { addToast?.(`${charName}今天已经贴过啦，明天再来`, 'info'); return; }
    if (!char) { addToast?.('请先选择一个角色', 'info'); return; }
    if (!apiConfig?.apiKey || !apiConfig?.baseUrl) { addToast?.('请先配置 API', 'info'); return; }
    const cur = boardStateRef.current;
    if (!cur) return;

    genAbortRef.current?.abort();
    const ac = new AbortController();
    genAbortRef.current = ac;
    const replyTo = pendingUserNote(cur);
    setGenerating(true);
    try {
      const result = await generateTaNote({ char, userProfile, apiConfig, replyTo, signal: ac.signal });
      if (ac.signal.aborted) return;
      const range = visibleRange();
      const place = randomPlacement(range.top, range.bottom);
      const now = Date.now();
      const note: YuZhouNote = {
        id: newId('note'),
        author: 'ta',
        text: result.text,
        paperId: result.paperId,
        stickers: result.stickers.map((url, i) => ({
          id: newId('st'),
          url,
          x: i === 0 ? 78 + Math.random() * 8 : 18 + Math.random() * 8,
          y: 74 + Math.random() * 10,
          rotation: Math.round(Math.random() * 36 - 18),
          scale: 0.9 + Math.random() * 0.25,
        })),
        ...place,
        z: topZ(),
        starred: false,
        createdAt: now,
        ...(replyTo ? { replyToId: replyTo.id, replyToText: replyTo.text } : {}),
      };
      commit(s => ({
        ...s,
        taLastDate: toDateKey(),
        taLastAt: now,
        notes: [...s.notes.map(n => (replyTo && n.id === replyTo.id ? { ...n, replied: true } : n)), note],
      }));
      addToast?.(replyTo ? `${charName}回了你一张便利贴` : `${charName}贴了一张便利贴`, 'success');
    } catch (e: any) {
      if (ac.signal.aborted) return;
      console.error('[YuZhou] generate TA note failed', e);
      addToast?.(`生成失败：${e?.message?.slice(0, 60) || '未知错误'}`, 'error');
    } finally {
      if (!ac.signal.aborted) setGenerating(false);
    }
  };

  // ---------- 木板样式 / 照片 ----------
  const setStyle = (style: BoardStyle) => commit(s => ({ ...s, style }));

  const onStyleButton = (style: BoardStyle) => {
    if (style !== 'photo') { setStyle(style); return; }
    if (board?.style === 'photo' || !photo) photoInputRef.current?.click();
    else setStyle('photo');
  };

  const handlePhotoFile = async (file?: File) => {
    if (!file) return;
    try {
      const dataUrl = await processImage(file, { maxWidth: 1200, quality: 0.85 });
      await DB.saveAsset(boardPhotoAssetId(charId), dataUrl);
      setPhoto(dataUrl);
      setStyle('photo');
    } catch {
      addToast?.('照片保存失败，可能是存储空间不足', 'error');
    }
  };

  const style: BoardStyle = board?.style === 'photo' && !photo ? 'cork' : (board?.style || 'cork');
  const surfaceCfg = BOARD_SURFACE[style];
  const pending = board ? pendingUserNote(board) : undefined;
  const noteSize = boardWidth * NOTE_SIZE_RATIO;

  return (
    <div className="absolute inset-0 z-[60] bg-[#fff7f5] text-slate-800 flex flex-col overflow-hidden">
      <style>{NOTE_CARD_CSS}</style>
      <div className={`absolute inset-0 pointer-events-none ${PAGE_BG}`} />
      {style === 'photo' && photo && (
        <>
          <img src={photo} alt="" className="absolute inset-0 w-full h-full object-cover pointer-events-none" />
          <div className="absolute inset-0 bg-white/25 pointer-events-none" />
        </>
      )}

      {/* 顶部 */}
      <header className="relative h-14 px-4 flex items-center justify-between shrink-0" style={{ marginTop: 'var(--safe-top)' }}>
        <button onClick={onBack} aria-label="返回与昼" className="w-9 h-9 rounded-full bg-white/80 shadow-sm text-rose-400 text-xl active:scale-90 transition-transform">‹</button>
        <div className="font-black tracking-[.3em] text-rose-500 text-base pl-[.3em]">便签</div>
        <button
          onClick={handleGenerate}
          aria-label={usedToday ? `${charName}今天已经贴过了` : `让${charName}贴一张便利贴`}
          className={`w-10 h-10 rounded-full flex items-center justify-center active:scale-90 transition-all ${usedToday
            ? 'bg-white/80 text-rose-200 shadow-sm'
            : 'bg-gradient-to-br from-[#fb9fb6] to-[#f37c9c] text-white shadow-[0_6px_14px_rgba(240,110,145,.35)]'}`}
        >
          <ArrowClockwise size={20} weight="bold" className={generating ? 'animate-spin' : ''} />
        </button>
      </header>

      {/* 样式切换 + 数量 */}
      <div className="relative shrink-0 px-5 pb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 rounded-full bg-white/70 border border-white p-1 shadow-sm">
          {(['cork', 'plaid', 'photo'] as const).map(k => (
            <button
              key={k}
              onClick={() => onStyleButton(k)}
              aria-label={k === 'cork' ? '奶油软木' : k === 'plaid' ? '粉格布艺' : style === 'photo' ? '换一张照片' : '我的照片'}
              className={`w-9 h-9 rounded-full flex items-center justify-center transition-all active:scale-90 ${style === k ? 'bg-white shadow-[0_3px_10px_rgba(200,110,140,.22)] ring-1 ring-rose-200' : 'opacity-70'}`}
            >
              <StyleIcon kind={k} />
            </button>
          ))}
        </div>
        <span className="text-[11px] font-bold text-rose-300 bg-white/60 rounded-full px-2.5 py-1">{board?.notes.length ?? 0}/{BOARD_MAX_NOTES}</span>
        <input ref={photoInputRef} type="file" accept="image/*" className="hidden" onChange={e => { void handlePhotoFile(e.target.files?.[0]); e.target.value = ''; }} />
      </div>

      {/* 木板 */}
      <div ref={scrollRef} className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain" style={{ touchAction: draggingId ? 'none' : 'pan-y' }}>
        <div className="px-3 pt-3" style={{ paddingBottom: 'calc(96px + var(--safe-bottom, 0px))' }}>
          <div className="relative max-w-md mx-auto rounded-[28px] p-2.5" style={surfaceCfg.frame}>
            <div
              ref={surfaceRef}
              className="relative w-full rounded-[20px]"
              style={{ ...surfaceCfg.surface, aspectRatio: `1 / ${BOARD_RATIO}` }}
              onClick={e => { if (e.target === e.currentTarget) setTrashFor(null); }}
            >
              {surfaceCfg.stitch && <div className="absolute inset-[7px] rounded-[15px] border-[1.5px] border-dashed border-[#f08fa8]/50 pointer-events-none" />}
              {board === null && <div className="absolute inset-x-0 top-24 text-center text-[12px] text-rose-300">加载中…</div>}
              {board && board.notes.length === 0 && (
                <div className="absolute inset-x-8 top-28 text-center pointer-events-none">
                  <div className={`text-[13px] font-bold ${style === 'cork' ? 'text-[#9c7258]' : 'text-rose-400'}`}>木板还空着</div>
                  <div className={`mt-1 text-[12px] ${style === 'cork' ? 'text-[#9c7258]/80' : 'text-rose-300'}`}>点右下角写一张，或者点 ↻ 让{charName}先贴</div>
                </div>
              )}
              {board && noteSize > 0 && board.notes.map(n => (
                <BoardNote
                  key={n.id}
                  note={n}
                  size={noteSize}
                  dragging={draggingId === n.id}
                  showTrash={trashFor === n.id}
                  pending={!!pending && pending.id === n.id}
                  charName={charName}
                  handlers={handlers}
                  onToggleStar={toggleStar}
                  onDelete={deleteNote}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 写便签 */}
      {!draggingId && (
        <button
          onClick={() => { setTrashFor(null); setEditing(true); }}
          className="absolute right-5 z-[20] h-11 pl-3.5 pr-4 rounded-full bg-white/90 backdrop-blur border-2 border-white text-rose-500 text-[13px] font-bold shadow-[0_8px_20px_rgba(200,100,130,.25)] flex items-center gap-1.5 active:scale-95 transition-transform"
          style={{ bottom: 'calc(22px + var(--safe-bottom, 0px))' }}
        >
          <span className="text-base leading-none">📋</span>写便签
        </button>
      )}

      {/* 拖动时出现的垃圾桶 */}
      {draggingId && (
        <div
          ref={trashRef}
          className={`absolute left-1/2 z-[20] -translate-x-1/2 w-16 h-16 rounded-full flex items-center justify-center transition-all ${overTrash ? 'bg-rose-400 text-white scale-110 shadow-[0_8px_22px_rgba(240,110,145,.45)]' : 'bg-white/90 text-rose-400 shadow-[0_6px_18px_rgba(200,100,130,.25)]'}`}
          style={{ bottom: 'calc(20px + var(--safe-bottom, 0px))' }}
        >
          <Trash size={28} weight={overTrash ? 'fill' : 'bold'} />
        </div>
      )}

      {editing && <YuZhouNoteEditor onBack={() => setEditing(false)} onPaste={handlePaste} />}
    </div>
  );
};

export default YuZhouNoteBoard;
