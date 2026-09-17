/**
 * 牌组工坊的数据：有哪些牌组、桌上用哪套、上传的牌面、塔罗牌意改写。
 *
 * 存储方式和壁纸一样：
 * · 整份数据是一条记录，存在「系统资源」表（assets，id = WORKSHOP_ASSET_ID），会进备份包；
 * · 牌面 / 牌背图片存进 blob_assets，记录里只放 `blobref:` 令牌。
 *   assets 表在 utils/blobGc.ts 的引用面清单里，所以「优化资源存储」不会误删这些图。
 *
 * 换图、删牌组时不主动删旧图（和项目其他地方一致），残留的旧图由清理功能回收。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { DB } from '../../../utils/db';
import { putImageBlob } from '../../../utils/blobRef';
import { processImageToBlob } from '../../../utils/file';
import type { CardMeaning } from './meanings';
import type { LenormandMeaning } from './lenormand';
import { renderPdfPages, isPdf } from './pdfCards';
import { TAROT_DECK } from './cards';
import { LENORMAND_DECK } from './lenormand';

export type DeckKind = 'lenormand' | 'tarot' | 'oracle';

/** 分类顺序与显示名（工坊顶部的切换栏） */
export const DECK_KINDS: { kind: DeckKind; label: string }[] = [
  { kind: 'lenormand', label: 'Lenormand' },
  { kind: 'tarot', label: 'Tarot' },
  { kind: 'oracle', label: 'Oracle' },
];

/** 牌的高宽比，按实体牌尺寸：塔罗 12×7，雷诺曼 8.8×6.3，神谕 10.5×7.5 */
export const CARD_RATIOS: Record<DeckKind, number> = {
  tarot: 12 / 7,
  lenormand: 8.8 / 6.3,
  oracle: 10.5 / 7.5,
};

/** 固定张数的牌组：塔罗 id 0~77，雷诺曼 id 1~36。神谕不限张数。 */
export const DECK_RANGE: Record<'tarot' | 'lenormand', { first: number; count: number }> = {
  tarot: { first: 0, count: 78 },
  lenormand: { first: 1, count: 36 },
};

export interface OracleCard {
  id: string;
  name: string;
  /** blobref 令牌 */
  image?: string;
  meaning: string;
}

export interface UserDeck {
  id: string;
  kind: DeckKind;
  name: string;
  createdAt: number;
  /** 牌背，blobref 令牌 */
  back?: string;
  /** 塔罗 / 雷诺曼：牌 id → 牌面令牌。没有的那张用默认牌面 */
  faces: Record<number, string>;
  /** 神谕：按顺序的牌 */
  oracle: OracleCard[];
}

export interface WorkshopData {
  version: 1;
  decks: UserDeck[];
  /** 每个分类桌上正在用哪一套（牌组 id，或基础牌组 id） */
  active: Partial<Record<DeckKind, string>>;
  /** 塔罗牌意改写，所有塔罗牌组共用 */
  meaningOverrides: Record<number, CardMeaning>;
  /** 雷诺曼牌意改写，所有雷诺曼牌组共用 */
  lenormandOverrides: Record<number, LenormandMeaning>;
}

/** 基础牌组（代码画的，不能改不能删）。神谕没有基础牌组，全靠自己上传 */
export const BUILTIN_DECK_ID: Partial<Record<DeckKind, string>> = {
  tarot: 'builtin-tarot',
  lenormand: 'builtin-lenormand',
};

export const WORKSHOP_ASSET_ID = 'tarot_workshop_v1';
/** 上一版存在 localStorage 的牌意改写，首次加载时搬进来 */
const LEGACY_MEANING_KEY = 'sullyos.tarot.meaningOverrides.v1';

function emptyData(): WorkshopData {
  return { version: 1, decks: [], active: {}, meaningOverrides: {}, lenormandOverrides: {} };
}

function normalize(raw: unknown): WorkshopData {
  const base = emptyData();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<WorkshopData>;
  return {
    version: 1,
    decks: Array.isArray(r.decks)
      ? r.decks.map((d) => ({ ...d, faces: d.faces || {}, oracle: Array.isArray(d.oracle) ? d.oracle : [] }))
      : [],
    active: r.active && typeof r.active === 'object' ? r.active : {},
    meaningOverrides: r.meaningOverrides && typeof r.meaningOverrides === 'object' ? r.meaningOverrides : {},
    lenormandOverrides: r.lenormandOverrides && typeof r.lenormandOverrides === 'object' ? r.lenormandOverrides : {},
  };
}

export function newId(prefix = 'd'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 某分类桌上正在用的牌组（null = 用基础牌组或还没有牌组） */
export function getActiveDeck(data: WorkshopData, kind: DeckKind): UserDeck | null {
  const id = data.active[kind];
  if (!id) return null;
  return data.decks.find((d) => d.id === id && d.kind === kind) ?? null;
}

/** 某分类当前「使用中」的 id，没设过就是基础牌组 */
export function activeIdOf(data: WorkshopData, kind: DeckKind): string | undefined {
  const id = data.active[kind];
  if (id && (id === BUILTIN_DECK_ID[kind] || data.decks.some((d) => d.id === id))) return id;
  return BUILTIN_DECK_ID[kind];
}

/** 基础牌组的显示名 */
export const BUILTIN_NAME: Partial<Record<DeckKind, string>> = { tarot: '基础塔罗', lenormand: '基础雷诺曼' };

export const DECK_LABEL: Record<DeckKind, string> = { tarot: '塔罗', lenormand: '雷诺曼', oracle: '神谕' };

/** 牌组 id（含基础牌组）→ 名字；找不到时返回 null */
export function deckNameOf(data: WorkshopData, kind: DeckKind, deckId: string): string | null {
  if (deckId === BUILTIN_DECK_ID[kind]) return BUILTIN_NAME[kind] ?? null;
  return data.decks.find((d) => d.id === deckId && d.kind === kind)?.name ?? null;
}

/** 抽牌池里的一张牌，三副牌统一成这个样子 */
export interface PoolCard {
  /** 在这副牌里唯一：塔罗 t0~t77，雷诺曼 l1~l36，神谕用牌自己的 id */
  key: string;
  name: string;
  /** 上传的牌面（blobref 令牌），没有就画默认牌面 */
  image?: string;
  tarotId?: number;
  lenormandId?: number;
  oracle?: OracleCard;
}

/** 某一套牌（可以是基础牌组）的全部牌 */
export function buildDeckPool(data: WorkshopData, kind: DeckKind, deckId: string | undefined): PoolCard[] {
  const deck = deckId ? data.decks.find((d) => d.id === deckId && d.kind === kind) ?? null : null;
  if (kind === 'tarot') {
    return TAROT_DECK.map((c) => ({ key: `t${c.id}`, name: c.name, tarotId: c.id, image: deck?.faces[c.id] }));
  }
  if (kind === 'lenormand') {
    return LENORMAND_DECK.map((c) => ({ key: `l${c.id}`, name: c.name, lenormandId: c.id, image: deck?.faces[c.id] }));
  }
  return (deck?.oracle ?? []).map((c) => ({ key: c.id, name: c.name, oracle: c, image: c.image }));
}

/** 已上传的张数 / 总张数 */
export function deckProgress(deck: UserDeck): { have: number; total: number | null } {
  if (deck.kind === 'oracle') return { have: deck.oracle.length, total: null };
  const range = DECK_RANGE[deck.kind];
  return { have: Object.keys(deck.faces).length, total: range.count };
}

// ─── 读写 ─────────────────────────────────────────────

export function useWorkshop() {
  const [data, setData] = useState<WorkshopData>(emptyData);
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<WorkshopData>(data);
  const saving = useRef<Promise<void>>(Promise.resolve());
  /** 库里的数据确实读出来了才允许写，免得读失败时拿空数据把库覆盖掉 */
  const readOk = useRef(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      let next = emptyData();
      let needSave = false;
      let ok = false;
      try {
        const raw = await DB.getAssetRaw(WORKSHOP_ASSET_ID);
        if (raw) next = normalize(raw);
        else needSave = true;
        ok = true;
      } catch {
        // 读失败时先用空数据显示，但不允许写，不覆盖库里的东西
      }
      // 搬家：上一版的牌意改写
      try {
        const legacy = window.localStorage.getItem(LEGACY_MEANING_KEY);
        if (legacy) {
          const parsed = JSON.parse(legacy) as Record<number, CardMeaning>;
          next = { ...next, meaningOverrides: { ...parsed, ...next.meaningOverrides } };
          needSave = true;
        }
      } catch {
        // 旧数据坏了就算了
      }
      if (!alive) return;
      readOk.current = ok;
      ref.current = next;
      setData(next);
      setLoaded(true);
      if (ok && needSave) {
        try {
          await DB.saveAssetRaw(WORKSHOP_ASSET_ID, next);
          window.localStorage.removeItem(LEGACY_MEANING_KEY);
        } catch {
          // 存不进去时保留 localStorage 里的旧数据，下次再搬
        }
      }
    })();
    return () => { alive = false; };
  }, []);

  /** 改数据并落盘。返回的 Promise 在写入失败时 reject */
  const update = useCallback((fn: (prev: WorkshopData) => WorkshopData): Promise<void> => {
    if (!readOk.current) return Promise.reject(new Error('牌组数据还没读出来，稍等再试'));
    const next = fn(ref.current);
    ref.current = next;
    setData(next);
    const job = saving.current.catch(() => undefined).then(() => DB.saveAssetRaw(WORKSHOP_ASSET_ID, next));
    saving.current = job;
    return job;
  }, []);

  return { data, loaded, update };
}

/** 只改一套牌组 */
export function patchDeck(data: WorkshopData, deckId: string, fn: (d: UserDeck) => UserDeck): WorkshopData {
  return { ...data, decks: data.decks.map((d) => (d.id === deckId ? fn(d) : d)) };
}

// ─── 上传 ─────────────────────────────────────────────

export interface ImportProgress {
  done: number;
  total: number;
  label: string;
}

export interface ImportResult {
  faces: Record<number, string>;
  oracle: OracleCard[];
  back?: string;
  /** 没对上号的文件名 */
  skipped: string[];
}

const IMAGE_OPTIONS = { maxWidth: 1000, quality: 0.86, forceJpeg: true };

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '').trim();
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

const BACK_NAME = /^(back|cardback|牌背|背面)$/i;

/** 单张图片压缩后存进 blob_assets，返回令牌 */
export async function storeCardImage(file: File | Blob): Promise<string> {
  const blob = file instanceof File ? await processImageToBlob(file, IMAGE_OPTIONS) : file;
  return putImageBlob(blob);
}

/**
 * 把一批图片或一个 PDF 导入成牌。
 * · 塔罗：文件名里的数字就是编号（00~77）；都没有数字时按文件名顺序从 0 排
 * · 雷诺曼：编号 01~36；都没有数字时按顺序从 1 排
 * · 神谕：文件名当牌名，按文件名顺序
 * · 文件名叫 back / 牌背 的那张当牌背
 * · PDF：一页一张牌，第 1 页对应第一张
 */
export async function importCards(
  kind: DeckKind,
  files: File[],
  onProgress: (p: ImportProgress) => void,
): Promise<ImportResult> {
  const result: ImportResult = { faces: {}, oracle: [], skipped: [] };
  const pdf = files.find(isPdf);

  if (pdf) {
    const maxPages = kind === 'oracle' ? 150 : DECK_RANGE[kind].count;
    const pages = await renderPdfPages(pdf, maxPages, (done, total) =>
      onProgress({ done, total: total * 2, label: `读取 PDF 第 ${done} / ${total} 页` }),
    );
    for (let i = 0; i < pages.length; i++) {
      const token = await storeCardImage(pages[i]);
      if (kind === 'oracle') {
        result.oracle.push({ id: newId('o'), name: `第 ${i + 1} 张`, image: token, meaning: '' });
      } else {
        result.faces[DECK_RANGE[kind].first + i] = token;
      }
      onProgress({ done: pages.length + i + 1, total: pages.length * 2, label: `保存第 ${i + 1} / ${pages.length} 张` });
    }
    return result;
  }

  const images = files.filter((f) => f.type.startsWith('image/')).sort((a, b) => naturalCompare(a.name, b.name));
  files.filter((f) => !f.type.startsWith('image/')).forEach((f) => result.skipped.push(f.name));

  const backFile = images.find((f) => BACK_NAME.test(baseName(f.name)));
  const cards = images.filter((f) => f !== backFile);
  const total = images.length;
  let done = 0;
  const tick = (label: string) => onProgress({ done: ++done, total, label });

  if (backFile) {
    result.back = await storeCardImage(backFile);
    tick('保存牌背');
  }

  if (kind === 'oracle') {
    for (const f of cards) {
      const token = await storeCardImage(f);
      result.oracle.push({ id: newId('o'), name: baseName(f.name), image: token, meaning: '' });
      tick(`保存 ${baseName(f.name)}`);
    }
    return result;
  }

  const range = DECK_RANGE[kind];
  const numbers = cards.map((f) => {
    const m = baseName(f.name).match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  });
  const anyNumbered = numbers.some((n) => n !== null);

  for (let i = 0; i < cards.length; i++) {
    const f = cards[i];
    const id = anyNumbered ? numbers[i] : range.first + i;
    if (id === null || id < range.first || id >= range.first + range.count) {
      result.skipped.push(f.name);
      tick(`跳过 ${f.name}`);
      continue;
    }
    result.faces[id] = await storeCardImage(f);
    tick(`保存第 ${i + 1} / ${cards.length} 张`);
  }
  return result;
}
