import React, { useLayoutEffect, useRef, useState } from 'react';
import { TAROT_DECK, SUIT_INFO } from './cards';
import { lenormandName } from './lenormand';
import { GenericCardFace, CardBack } from './CardFace';
import {
  DeckKind, DECK_KINDS, CARD_RATIOS, DECK_RANGE, BUILTIN_DECK_ID, BUILTIN_NAME,
  UserDeck, WorkshopData, OracleCard, ImportProgress,
  activeIdOf, deckProgress, importCards, newId, patchDeck, storeCardImage,
} from './decks';
import { PawButton } from './FreeDraw';

/**
 * 牌组工坊：点墙上的画进来。
 *
 * 书架（分类切换 + 牌组 + 「+」）→ 牌组详情（所有牌 + 操作）→ 单张牌（换图 / 神谕改名改牌意）。
 * 数据和存储都在 decks.ts，这里只管界面。
 */

interface WorkshopProps {
  data: WorkshopData;
  update: (fn: (prev: WorkshopData) => WorkshopData) => Promise<void>;
  onClose: () => void;
  onToast: (text: string) => void;
  /** 进来时先停在哪个分类 */
  initialKind?: DeckKind;
}

type View = { type: 'shelf' } | { type: 'deck'; id: string };

/** 单张牌的统一描述（详情页网格用） */
interface Slot {
  key: string;
  /** 塔罗 / 雷诺曼的牌 id */
  cardId?: number;
  /** 神谕牌 */
  oracle?: OracleCard;
  title: string;
  mark?: string;
  symbol?: string;
  image?: string;
}


const NAMING_HINT: Record<DeckKind, string> = {
  tarot: '图片按文件名编号对号入座：00 愚者 ~ 21 世界，22 ~ 77 小阿卡纳；叫 back 或「牌背」的那张会当牌背。PDF 一页一张，按页码顺序。缺的牌用默认牌面。',
  lenormand: '图片按文件名编号对号入座：01 骑士 ~ 36 十字架；叫 back 或「牌背」的那张会当牌背。PDF 一页一张，按页码顺序。缺的牌用默认牌面。',
  oracle: '张数不限，文件名就是牌名（之后可以改）；叫 back 或「牌背」的那张会当牌背。PDF 一页一张。',
};

function slotsOf(kind: DeckKind, deck: UserDeck | null): Slot[] {
  if (kind === 'oracle') {
    return (deck?.oracle ?? []).map((c) => ({ key: c.id, oracle: c, title: c.name, image: c.image }));
  }
  if (kind === 'tarot') {
    return TAROT_DECK.map((c) => ({
      key: String(c.id),
      cardId: c.id,
      title: c.name,
      mark: c.mark,
      symbol: c.arcana === 'major' ? '✦' : c.suit ? SUIT_INFO[c.suit].symbol : undefined,
      image: deck?.faces[c.id],
    }));
  }
  const { first, count } = DECK_RANGE.lenormand;
  return Array.from({ length: count }, (_, i) => {
    const id = first + i;
    return { key: String(id), cardId: id, title: lenormandName(id), mark: String(id), symbol: '✧', image: deck?.faces[id] };
  });
}

/** 让用户选文件，返回选中的文件（取消时为空） */
function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    input.onchange = () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    };
    document.body.appendChild(input);
    input.click();
  });
}

export function Workshop({ data, update, onClose, onToast, initialKind = 'tarot' }: WorkshopProps) {
  const [kind, setKind] = useState<DeckKind>(initialKind);
  const [view, setView] = useState<View>({ type: 'shelf' });
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [sheet, setSheet] = useState<Slot | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // 量宽度，算每张牌多宽
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyW, setBodyW] = useState(360);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setBodyW(el.clientWidth || 360);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ratio = CARD_RATIOS[kind];
  const busy = progress !== null;

  const decksOfKind = data.decks.filter((d) => d.kind === kind);
  const builtinId = BUILTIN_DECK_ID[kind];
  const activeId = activeIdOf(data, kind);

  const openDeckId = view.type === 'deck' ? view.id : null;
  const openDeck = openDeckId ? data.decks.find((d) => d.id === openDeckId) ?? null : null;
  const openIsBuiltin = !!openDeckId && openDeckId === builtinId;

  // 书架三列，详情四列
  const shelfCardW = Math.floor(Math.min(112, (bodyW - 2 * 18) / 3 - 4));
  const gridCols = bodyW >= 520 ? 6 : 4;
  const gridCardW = Math.floor(Math.min(96, (bodyW - (gridCols - 1) * 10) / gridCols));

  const saveFail = () => onToast('保存失败，可能是存储空间不够了');

  const switchKind = (k: DeckKind) => {
    if (busy) return;
    setKind(k);
    setView({ type: 'shelf' });
    setSheet(null);
    setConfirmDelete(false);
  };

  /** 导入文件并合并进牌组 */
  const runImport = async (deckId: string, deckKind: DeckKind, files: File[]) => {
    if (files.length === 0) return;
    setProgress({ done: 0, total: files.length, label: '准备中' });
    try {
      const res = await importCards(deckKind, files, setProgress);
      await update((prev) =>
        patchDeck(prev, deckId, (d) => ({
          ...d,
          back: res.back ?? d.back,
          faces: { ...d.faces, ...res.faces },
          oracle: [...d.oracle, ...res.oracle],
        })),
      );
      const added = Object.keys(res.faces).length + res.oracle.length;
      let msg = `导入了 ${added} 张${res.back ? '，含牌背' : ''}`;
      if (res.skipped.length) msg += `，${res.skipped.length} 个文件没对上号`;
      onToast(msg);
    } catch (err) {
      onToast(err instanceof Error ? `导入失败：${err.message}` : '导入失败');
    } finally {
      setProgress(null);
    }
  };

  const createDeck = async (mode: 'images' | 'pdf' | 'empty') => {
    const files =
      mode === 'images' ? await pickFiles('image/*', true)
      : mode === 'pdf' ? await pickFiles('application/pdf,.pdf', false)
      : [];
    if (mode !== 'empty' && files.length === 0) return;

    const count = data.decks.filter((d) => d.kind === kind).length + 1;
    const label = DECK_KINDS.find((k) => k.kind === kind)?.label ?? '';
    const deck: UserDeck = {
      id: newId(),
      kind,
      name: newName.trim() || `我的 ${label} ${count}`,
      createdAt: Date.now(),
      faces: {},
      oracle: [],
    };
    try {
      await update((prev) => ({
        ...prev,
        decks: [...prev.decks, deck],
        // 这个分类还没有任何可用牌组时（比如神谕），新建的直接设为使用中
        active: prev.active[kind] || BUILTIN_DECK_ID[kind] ? prev.active : { ...prev.active, [kind]: deck.id },
      }));
    } catch {
      saveFail();
      return;
    }
    setCreating(false);
    setNewName('');
    setView({ type: 'deck', id: deck.id });
    await runImport(deck.id, kind, files);
  };

  const addMore = async (mode: 'images' | 'pdf') => {
    if (!openDeck) return;
    const files = mode === 'images' ? await pickFiles('image/*', true) : await pickFiles('application/pdf,.pdf', false);
    await runImport(openDeck.id, openDeck.kind, files);
  };

  const changeBack = async () => {
    if (!openDeck) return;
    const [file] = await pickFiles('image/*', false);
    if (!file) return;
    setProgress({ done: 0, total: 1, label: '保存牌背' });
    try {
      const token = await storeCardImage(file);
      await update((prev) => patchDeck(prev, openDeck.id, (d) => ({ ...d, back: token })));
      onToast('牌背换好了');
    } catch {
      saveFail();
    } finally {
      setProgress(null);
    }
  };

  const setActive = (id: string) => {
    update((prev) => ({ ...prev, active: { ...prev.active, [kind]: id } }))
      .then(() => onToast('已经放到桌上了'))
      .catch(saveFail);
  };

  const deleteDeck = () => {
    if (!openDeck) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    const id = openDeck.id;
    update((prev) => {
      const active = { ...prev.active };
      if (active[kind] === id) delete active[kind];
      return { ...prev, decks: prev.decks.filter((d) => d.id !== id), active };
    })
      .then(() => onToast('牌组已删除'))
      .catch(saveFail);
    setConfirmDelete(false);
    setView({ type: 'shelf' });
  };

  const renameDeck = (name: string) => {
    if (!openDeck) return;
    const clean = name.trim();
    setRenaming(null);
    if (!clean || clean === openDeck.name) return;
    update((prev) => patchDeck(prev, openDeck.id, (d) => ({ ...d, name: clean }))).catch(saveFail);
  };

  // ── 单张牌 ──
  const replaceSlotImage = async (slot: Slot) => {
    if (!openDeck) return;
    const [file] = await pickFiles('image/*', false);
    if (!file) return;
    setProgress({ done: 0, total: 1, label: '保存牌面' });
    try {
      const token = await storeCardImage(file);
      await update((prev) =>
        patchDeck(prev, openDeck.id, (d) =>
          slot.oracle
            ? { ...d, oracle: d.oracle.map((c) => (c.id === slot.oracle!.id ? { ...c, image: token } : c)) }
            : { ...d, faces: { ...d.faces, [slot.cardId!]: token } },
        ),
      );
      setSheet({ ...slot, image: token, oracle: slot.oracle ? { ...slot.oracle, image: token } : undefined });
    } catch {
      saveFail();
    } finally {
      setProgress(null);
    }
  };

  const clearSlotImage = (slot: Slot) => {
    if (!openDeck || slot.cardId === undefined) return;
    update((prev) =>
      patchDeck(prev, openDeck.id, (d) => {
        const faces = { ...d.faces };
        delete faces[slot.cardId!];
        return { ...d, faces };
      }),
    ).catch(saveFail);
    setSheet({ ...slot, image: undefined });
  };

  const saveOracleCard = (card: OracleCard) => {
    if (!openDeck) return;
    update((prev) =>
      patchDeck(prev, openDeck.id, (d) => ({ ...d, oracle: d.oracle.map((c) => (c.id === card.id ? card : c)) })),
    )
      .then(() => onToast('保存好了'))
      .catch(saveFail);
    setSheet(null);
  };

  const deleteOracleCard = (card: OracleCard) => {
    if (!openDeck) return;
    update((prev) => patchDeck(prev, openDeck.id, (d) => ({ ...d, oracle: d.oracle.filter((c) => c.id !== card.id) })))
      .catch(saveFail);
    setSheet(null);
  };

  const addOracleCard = () => {
    if (!openDeck) return;
    const card: OracleCard = { id: newId('o'), name: `第 ${openDeck.oracle.length + 1} 张`, meaning: '' };
    update((prev) => patchDeck(prev, openDeck.id, (d) => ({ ...d, oracle: [...d.oracle, card] }))).catch(saveFail);
    setSheet({ key: card.id, oracle: card, title: card.name });
  };

  // ── 渲染 ──
  const renderShelf = () => (
    <>
    {kind === 'oracle' && decksOfKind.length === 0 && (
      <p className="ws-hint ws-shelf-tip">神谕卡没有基础牌组，点「+」上传你自己的牌，牌名和牌意都由你来写。</p>
    )}
    <div className="ws-shelf">
      {builtinId && (
        <button className="ws-tile" onClick={() => setView({ type: 'deck', id: builtinId })}>
          <span className={activeId === builtinId ? 'ws-cover ws-cover-on' : 'ws-cover'}>
            <CardBack width={shelfCardW} ratio={ratio} />
          </span>
          <span className="ws-tile-name">{BUILTIN_NAME[kind]}</span>
          <span className="ws-tile-meta">{activeId === builtinId ? '使用中' : '基础牌组'}</span>
        </button>
      )}

      {decksOfKind.map((deck) => {
        const { have, total } = deckProgress(deck);
        const firstImage = deck.kind === 'oracle' ? deck.oracle.find((c) => c.image)?.image : Object.values(deck.faces)[0];
        const on = activeId === deck.id;
        return (
          <button key={deck.id} className="ws-tile" onClick={() => setView({ type: 'deck', id: deck.id })}>
            <span className={on ? 'ws-cover ws-cover-on' : 'ws-cover'}>
              {deck.back || !firstImage ? (
                <CardBack width={shelfCardW} ratio={ratio} image={deck.back} />
              ) : (
                <GenericCardFace width={shelfCardW} ratio={ratio} image={firstImage} />
              )}
            </span>
            <span className="ws-tile-name">{deck.name}</span>
            <span className="ws-tile-meta">
              {on ? '使用中 · ' : ''}
              {total === null ? `${have} 张` : `${have}/${total}`}
            </span>
          </button>
        );
      })}

      <button className="ws-tile" onClick={() => setCreating(true)} disabled={busy}>
        <span className="ws-add" style={{ width: shelfCardW, height: Math.round(shelfCardW * ratio) }}>
          <span className="ws-add-circle">+</span>
        </span>
        <span className="ws-tile-name">新建牌组</span>
        <span className="ws-tile-meta">图片 / PDF</span>
      </button>
    </div>
    </>
  );

  const renderDeck = () => {
    if (!openDeckId) return null;
    if (!openIsBuiltin && !openDeck) {
      return <p className="ws-empty">这套牌找不到了</p>;
    }
    const slots = slotsOf(kind, openIsBuiltin ? null : openDeck);
    const name = openIsBuiltin ? BUILTIN_NAME[kind] : openDeck!.name;
    const isActive = activeId === openDeckId;

    return (
      <div className="ws-deck">
        <div className="ws-deck-head">
          {renaming !== null ? (
            <input
              className="ws-input"
              value={renaming}
              autoFocus
              maxLength={24}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRenaming(e.target.value)}
              onBlur={() => renameDeck(renaming)}
              onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                if (e.key === 'Enter') renameDeck(renaming);
              }}
            />
          ) : (
            <h3 className="ws-deck-name">
              {name}
              {isActive && <span className="ws-badge">使用中</span>}
            </h3>
          )}
          {!openIsBuiltin && openDeck && (
            <span className="ws-deck-count">
              {(() => {
                const { have, total } = deckProgress(openDeck);
                return total === null ? `${have} 张` : `已上传 ${have}/${total}`;
              })()}
            </span>
          )}
        </div>

        <div className="ws-actions">
          {!isActive && (
            <button className="tarot-chip tarot-chip-sm" onClick={() => setActive(openDeckId)} disabled={busy}>
              放到桌上用
            </button>
          )}
          {!openIsBuiltin && openDeck && (
            <>
              <button className="tarot-chip tarot-chip-sm" onClick={() => addMore('images')} disabled={busy}>
                上传图片
              </button>
              <button className="tarot-chip tarot-chip-sm" onClick={() => addMore('pdf')} disabled={busy}>
                上传 PDF
              </button>
              <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={changeBack} disabled={busy}>
                换牌背
              </button>
              <button
                className="tarot-chip tarot-chip-ghost tarot-chip-sm"
                onClick={() => setRenaming(openDeck.name)}
                disabled={busy}
              >
                改名
              </button>
              <button
                className={confirmDelete ? 'tarot-chip tarot-chip-sm ws-danger' : 'tarot-chip tarot-chip-ghost tarot-chip-sm'}
                onClick={deleteDeck}
                disabled={busy}
              >
                {confirmDelete ? '再点一次删除' : '删除'}
              </button>
            </>
          )}
        </div>

        <p className="ws-hint">
          {openIsBuiltin ? '基础牌组由代码绘制，不能修改。想换成自己的牌面，回书架点「+」新建一套。' : NAMING_HINT[kind]}
        </p>

        {!openIsBuiltin && openDeck && (
          <div className="ws-back-row">
            <span>牌背</span>
            <CardBack width={Math.round(gridCardW * 0.6)} ratio={ratio} image={openDeck.back} />
          </div>
        )}

        {slots.length === 0 && kind === 'oracle' && <p className="ws-empty">还没有牌，上传图片、PDF，或者手动加一张</p>}

        <div className="ws-grid" style={{ gridTemplateColumns: `repeat(${gridCols}, ${gridCardW}px)` }}>
          {slots.map((slot) => (
            <button
              key={slot.key}
              className="ws-slot"
              onClick={() => !openIsBuiltin && setSheet(slot)}
              style={{ cursor: openIsBuiltin ? 'default' : 'pointer' }}
            >
              <GenericCardFace
                width={gridCardW}
                ratio={ratio}
                image={slot.image}
                mark={slot.mark}
                symbol={slot.symbol ?? '✧'}
                title={slot.title}
                dim={!openIsBuiltin && !slot.image && kind !== 'oracle'}
              />
              <span className="ws-slot-name">{slot.title}</span>
            </button>
          ))}
          {kind === 'oracle' && openDeck && (
            <button className="ws-slot" onClick={addOracleCard} disabled={busy}>
              <span className="ws-add" style={{ width: gridCardW, height: Math.round(gridCardW * ratio) }}>
                <span className="ws-add-circle ws-add-circle-sm">+</span>
              </span>
              <span className="ws-slot-name">加一张</span>
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="ws-root">
      <div className="ws-top">
        {view.type === 'deck' ? (
          <button
            className="tarot-chip tarot-chip-ghost tarot-chip-sm"
            onClick={() => {
              if (busy) return;
              setView({ type: 'shelf' });
              setConfirmDelete(false);
              setRenaming(null);
            }}
            disabled={busy}
          >
            ‹ 书架
          </button>
        ) : (
          <PawButton onClick={() => { if (!busy) onClose(); }} gradientId="wsPawGold" />
        )}
        <h2 className="ws-title">牌组工坊</h2>
        <span style={{ width: 40 }} />
      </div>

      <div className="ws-tabs">
        {DECK_KINDS.map((k) => (
          <button
            key={k.kind}
            className={kind === k.kind ? 'ws-tab ws-tab-on' : 'ws-tab'}
            onClick={() => switchKind(k.kind)}
          >
            {k.label}
          </button>
        ))}
      </div>

      {progress && (
        <div className="ws-progress">
          <div className="ws-progress-bar">
            <i style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
          </div>
          <span>{progress.label}</span>
        </div>
      )}

      <div className="ws-body" ref={bodyRef}>
        {view.type === 'shelf' ? renderShelf() : renderDeck()}
      </div>

      {/* 新建牌组 */}
      {creating && (
        <div className="ws-mask" onClick={() => setCreating(false)}>
          <div className="ws-sheet" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <h3 className="ws-sheet-title">新建 {DECK_KINDS.find((k) => k.kind === kind)?.label} 牌组</h3>
            <input
              className="ws-input"
              placeholder="牌组名字（可以不填）"
              value={newName}
              maxLength={24}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewName(e.target.value)}
            />
            <p className="ws-hint">{NAMING_HINT[kind]}</p>
            <div className="ws-sheet-actions">
              <button className="tarot-chip" onClick={() => createDeck('images')}>选图片</button>
              <button className="tarot-chip" onClick={() => createDeck('pdf')}>选 PDF</button>
              <button className="tarot-chip tarot-chip-ghost" onClick={() => createDeck('empty')}>先建空的</button>
            </div>
          </div>
        </div>
      )}

      {/* 单张牌 */}
      {sheet && openDeck && (
        <CardSheet
          key={sheet.key}
          slot={sheet}
          ratio={ratio}
          kind={kind}
          busy={busy}
          onClose={() => setSheet(null)}
          onReplace={() => replaceSlotImage(sheet)}
          onClear={() => clearSlotImage(sheet)}
          onSaveOracle={saveOracleCard}
          onDeleteOracle={deleteOracleCard}
        />
      )}
    </div>
  );
}

function CardSheet({
  slot, ratio, kind, busy, onClose, onReplace, onClear, onSaveOracle, onDeleteOracle,
}: {
  slot: Slot;
  ratio: number;
  kind: DeckKind;
  busy: boolean;
  onClose: () => void;
  onReplace: () => void;
  onClear: () => void;
  onSaveOracle: (card: OracleCard) => void;
  onDeleteOracle: (card: OracleCard) => void;
}) {
  const [name, setName] = useState(slot.oracle?.name ?? '');
  const [meaning, setMeaning] = useState(slot.oracle?.meaning ?? '');
  const [confirm, setConfirm] = useState(false);

  return (
    <div className="ws-mask" onClick={onClose}>
      <div className="ws-sheet" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
        <div className="ws-sheet-card">
          <GenericCardFace
            width={120}
            ratio={ratio}
            image={slot.image}
            mark={slot.mark}
            symbol={slot.symbol ?? '✧'}
            title={slot.oracle ? name : slot.title}
          />
        </div>

        {slot.oracle ? (
          <>
            <input
              className="ws-input"
              value={name}
              maxLength={20}
              placeholder="牌名"
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
            />
            <textarea
              className="ws-input ws-textarea"
              value={meaning}
              rows={3}
              placeholder="牌意（抽到这张时显示）"
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setMeaning(e.target.value)}
            />
          </>
        ) : (
          <h3 className="ws-sheet-title">{slot.title}</h3>
        )}

        <div className="ws-sheet-actions">
          <button className="tarot-chip tarot-chip-sm" onClick={onReplace} disabled={busy}>
            {slot.image ? '换一张图' : '上传这张'}
          </button>
          {!slot.oracle && slot.image && kind !== 'oracle' && (
            <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={onClear} disabled={busy}>
              改回默认牌面
            </button>
          )}
          {slot.oracle && (
            <>
              <button
                className="tarot-chip tarot-chip-sm"
                onClick={() => onSaveOracle({ ...slot.oracle!, name: name.trim() || slot.oracle!.name, meaning: meaning.trim() })}
                disabled={busy}
              >
                保存
              </button>
              <button
                className={confirm ? 'tarot-chip tarot-chip-sm ws-danger' : 'tarot-chip tarot-chip-ghost tarot-chip-sm'}
                onClick={() => (confirm ? onDeleteOracle(slot.oracle!) : setConfirm(true))}
                disabled={busy}
              >
                {confirm ? '再点一次删除' : '删掉这张'}
              </button>
            </>
          )}
          <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

/** 工坊的样式，由 TarotApp 的 <style> 一起注入 */
export const WORKSHOP_CSS = `
.ws-root {
  position: absolute; inset: 0; z-index: 35;
  display: flex; flex-direction: column;
  background: linear-gradient(180deg, #1c1030 0%, #150b24 100%);
  color: #efe3c8;
  padding-top: var(--safe-top, 0px);
}
.ws-top {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px 8px;
}
.ws-title { margin: 0; font-size: 17px; font-weight: 500; letter-spacing: 0.14em; color: #efe3c8; }
.ws-tabs {
  display: flex;
  margin: 0 14px;
  border-top: 1px solid rgba(217,185,120,0.45);
  border-bottom: 1px solid rgba(217,185,120,0.45);
}
.ws-tab {
  flex: 1;
  border: none;
  background: transparent;
  color: rgba(239,227,200,0.55);
  font-family: inherit;
  font-size: 14px;
  letter-spacing: 0.06em;
  padding: 10px 0;
  cursor: pointer;
  position: relative;
}
.ws-tab + .ws-tab { border-left: 1px solid rgba(217,185,120,0.3); }
.ws-tab-on { color: #d9b978; background: rgba(217,185,120,0.08); }
.ws-tab-on::after {
  content: ''; position: absolute; left: 30%; right: 30%; bottom: -1px; height: 2px; background: #d9b978;
}
.ws-progress { margin: 10px 14px 0; display: flex; flex-direction: column; gap: 5px; font-size: 11px; color: rgba(239,227,200,0.65); }
.ws-progress-bar { height: 4px; border-radius: 4px; background: rgba(239,227,200,0.12); overflow: hidden; }
.ws-progress-bar i { display: block; height: 100%; background: #d9b978; transition: width 0.2s ease; }
.ws-body { flex: 1; overflow-y: auto; padding: 16px 14px 28px; }

.ws-shelf {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 22px 10px;
  justify-items: center;
}
.ws-tile {
  border: none; background: transparent; padding: 0; cursor: pointer;
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  color: #efe3c8; font-family: inherit; min-width: 0; max-width: 100%;
}
.ws-cover { display: block; line-height: 0; border-radius: 8px; transition: box-shadow 0.2s ease; }
.ws-cover-on { box-shadow: 0 0 0 2px #d9b978, 0 0 16px rgba(217,185,120,0.45); }
.ws-tile-name {
  font-size: 13px; letter-spacing: 0.04em; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ws-tile-meta { font-size: 10px; color: #d9b978; opacity: 0.85; margin-top: -3px; }
.ws-add {
  display: flex; align-items: center; justify-content: center;
  border: 1px dashed rgba(217,185,120,0.6);
  border-radius: 8px;
  background: rgba(217,185,120,0.04);
  box-sizing: border-box;
}
.ws-add-circle {
  width: 44px; height: 44px; border-radius: 50%;
  border: 1px solid #d9b978; color: #d9b978;
  display: flex; align-items: center; justify-content: center;
  font-size: 26px; line-height: 1;
}
.ws-add-circle-sm { width: 30px; height: 30px; font-size: 20px; }

.ws-deck { display: flex; flex-direction: column; gap: 12px; }
.ws-deck-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.ws-deck-name { margin: 0; font-size: 17px; font-weight: 500; letter-spacing: 0.06em; display: flex; align-items: center; gap: 8px; }
.ws-deck-count { font-size: 12px; color: rgba(239,227,200,0.55); white-space: nowrap; }
.ws-badge {
  font-size: 10px; color: #d9b978; border: 1px solid rgba(217,185,120,0.6);
  border-radius: 999px; padding: 1px 8px; letter-spacing: 0.08em;
}
.ws-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.ws-shelf-tip { text-align: center; margin: 0 0 16px !important; }
.ws-hint { margin: 0; font-size: 11px; line-height: 1.7; color: rgba(239,227,200,0.5); }
.ws-empty { margin: 20px 0; text-align: center; font-size: 13px; color: rgba(239,227,200,0.5); }
.ws-back-row { display: flex; align-items: center; gap: 10px; font-size: 12px; color: rgba(239,227,200,0.6); }
.ws-grid { display: grid; gap: 14px 10px; justify-content: center; }
.ws-slot {
  border: none; background: transparent; padding: 0;
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  color: #efe3c8; font-family: inherit; min-width: 0;
}
.ws-slot-name {
  font-size: 10px; color: rgba(239,227,200,0.7); max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ws-danger { border-color: #e08a8a !important; color: #f0a8a8 !important; background: rgba(224,138,138,0.12) !important; }

.ws-mask {
  position: absolute; inset: 0; z-index: 5;
  background: rgba(8,4,16,0.7);
  display: flex; align-items: flex-end; justify-content: center;
}
.ws-sheet {
  width: 100%; max-width: 440px;
  background: #221436;
  border-top: 1px solid rgba(217,185,120,0.5);
  border-radius: 18px 18px 0 0;
  padding: 18px 16px calc(20px + var(--safe-bottom, 0px));
  display: flex; flex-direction: column; gap: 12px;
  box-sizing: border-box;
  animation: wsSheetUp 0.22s ease both;
}
@keyframes wsSheetUp { from { transform: translateY(24px); opacity: 0; } }
.ws-sheet-title { margin: 0; text-align: center; font-size: 15px; font-weight: 500; letter-spacing: 0.08em; }
.ws-sheet-card { display: flex; justify-content: center; }
.ws-sheet-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.ws-input {
  width: 100%; box-sizing: border-box;
  font-family: inherit; font-size: 16px; line-height: 1.5;
  color: #efe3c8; background: rgba(12,6,22,0.6);
  border: 1px solid rgba(217,185,120,0.4); border-radius: 8px;
  padding: 8px 10px;
  user-select: text; -webkit-user-select: text;
}
.ws-input:focus { outline: none; border-color: #d9b978; }
.ws-textarea { resize: vertical; min-height: 72px; }
`;

export default Workshop;
