import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { TAROT_DECK } from './cards';
import type { CardMeaning } from './meanings';
import type { LenormandMeaning } from './lenormand';
import { CardFace, GenericCardFace } from './CardFace';
import { CARD_RATIOS, WorkshopData, PoolCard, buildDeckPool } from './decks';
import { RATING_LABEL } from './prompts';
import {
  DuoSession, DuoRound, DuoCard, DuoLogEntry, PLAY_LABEL, MODE_LABEL,
  loadDuoRecords, loadDuoSession, peekDuoSession, subscribeDuo, deleteDuoRecord,
} from './duoStore';
import { shareOrDownloadFile } from '../../../utils/shareExport';

/**
 * 占卜记录（壁炉边的书架）。
 *
 * 读 duoStore 里的占卜记录，加上还没结束的那一场，照见面记录的样子排：
 *   · 顶部切「按次 / 按日期」，排序「新 → 旧 / 旧 → 新」
 *   · 右上角「导出全部」；每一场「导出本次」，按日期看时是「导出当天」
 *   · 点开一场：每一局的问题、答案、牌面、评分，和这一局里说过的话
 * 只读记录，不碰进行中的桌面。
 */

type View = 'session' | 'day';
type Order = 'newest' | 'oldest';

export interface DuoRecordsProps {
  charId: string;
  /** 当前角色的名字（按角色 ID 现查）。记录按角色 ID 分开存，显示时一律用这个名字 */
  who: string;
  /** 当前用户的名字（现查）。记录里存的旧名字不再用于显示 */
  userName: string;
  workshop: WorkshopData;
  tarotMeaning: (id: number) => CardMeaning;
  lenormandMeaning: (id: number) => LenormandMeaning;
  /** 合上按钮上的字：占卜进行中是「回桌前」 */
  closeLabel: string;
  onClose: () => void;
  onToast: (text: string) => void;
}

/** 显示用：存档里没有名字，打开页面时按当前角色、当前用户补上 */
type Named = DuoSession & { taName: string; userName: string };

interface Entry { s: Named; live: boolean }
interface DayGroup { key: string; entries: Entry[] }

const KIND_CN = { tarot: '塔罗', lenormand: '雷诺曼', oracle: '神谕卡' } as const;
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const hm = (t: number) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fullTime = (t: number) => `${dayKey(t)} ${hm(t)}`;
const scoreText = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

/** 一场结束的时间：结束占卜的时间，没有就用最后一句话或最后一局的时间 */
function lastTimeOf(s: Named): number {
  if (s.endedAt) return s.endedAt;
  let t = s.startedAt;
  for (const e of s.log) t = Math.max(t, e.t);
  for (const r of s.rounds) t = Math.max(t, r.endedAt ?? r.startedAt);
  return t;
}

/** 把这一场的对话按局切开：[开局前, 第 1 局, 第 2 局 …] */
function splitLog(s: Named): DuoLogEntry[][] {
  const parts: DuoLogEntry[][] = [[], ...s.rounds.map(() => [])];
  for (const e of s.log) {
    let idx = 0;
    for (let i = 0; i < s.rounds.length; i++) if (e.t >= s.rounds[i].startedAt) idx = i + 1;
    parts[idx].push(e);
  }
  return parts;
}

/** 这一局的答案有没有揭晓（TA 抽我解时，没对完答案前不显示） */
function revealed(r: DuoRound): boolean {
  return r.stage === 'done' || !!r.rating;
}

function questionLines(r: DuoRound, s: Named): Array<[string, string]> {
  const ta = s.taName;
  const out: Array<[string, string]> = [];
  if (r.play === 'ta_draws') {
    const dir = r.ask.trim() ? r.ask.trim() : r.topic ? `${r.topic}（随机）` : '';
    if (dir) out.push(['方向', dir]);
    const q = r.secret?.question?.trim();
    const open = revealed(r) || r.mode === 'basic';
    if (q || r.stage !== 'deck') out.push([`${ta}的问题`, open ? (q || '（没有记下）') : '还没揭晓']);
    if (q || r.stage !== 'deck') out.push([`${ta}的答案`, revealed(r) ? (r.secret?.answer?.trim() || '（没有记下）') : '还没揭晓']);
  } else {
    out.push([`${s.userName}的问题`, r.ask.trim() || '心里默念，没有说出来']);
  }
  return out;
}

function ratingLine(r: DuoRound, s: Named): string {
  if (!r.rating) return r.stage === 'done' ? '' : '这一局还没玩完';
  const label = RATING_LABEL[r.rating];
  const score = r.score ?? 0;
  const reader = r.play === 'ta_draws' ? s.userName : s.taName;
  const judge = r.play === 'ta_draws' ? s.taName : s.userName;
  // 不准不加分，就不写「+0」
  const gain = score > 0 ? `，${reader} +${scoreText(score)}` : '';
  return `${judge}觉得${reader}解得${label}${gain}`;
}

function cardText(c: DuoCard): string {
  const bits = [c.name || '（没记下牌名）'];
  if (c.kind === 'tarot') bits.push(c.reversed ? '逆位' : '正位');
  const tail = [KIND_CN[c.kind], c.deckName].filter(Boolean).join('·');
  return `${bits.join(' ')}（${tail}${c.extra ? '，补的' : ''}）`;
}

// ─── 导出成文字 ─────────────────────────────────────────────────────────

function sessionToText(e: Entry): string {
  const s = e.s;
  const lines: string[] = [];
  const end = lastTimeOf(s);
  const range = dayKey(end) === dayKey(s.startedAt) ? `${fullTime(s.startedAt)} — ${hm(end)}` : `${fullTime(s.startedAt)} — ${fullTime(end)}`;
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push(`${range}　${s.userName} 和 ${s.taName}　共 ${s.rounds.length} 局${e.live ? '（还在进行中）' : ''}`);
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  const logs = splitLog(s);
  const logLine = (x: DuoLogEntry) => {
    if (x.from === 'event') return `  ${hm(x.t)} 【小屋】${x.text}`;
    return `  ${hm(x.t)} ${x.from === 'ta' ? s.taName : s.userName}：${x.text}`;
  };
  if (logs[0].length) {
    lines.push('', '【开局前】');
    logs[0].forEach((x) => lines.push(logLine(x)));
  }
  s.rounds.forEach((r, i) => {
    const who = r.play === 'ta_draws' ? `${s.taName}抽牌、${s.userName}解` : `${s.userName}抽牌、${s.taName}解`;
    lines.push('', `【第 ${i + 1} 局】${who}，${MODE_LABEL[r.mode]}模式，${r.cards.length} 张牌`);
    questionLines(r, s).forEach(([k, v]) => lines.push(`${k}：${v}`));
    if (r.cards.length) {
      lines.push('牌：');
      const ordered = r.cards.slice().sort((a, b) => Number(a.extra) - Number(b.extra));
      ordered.forEach((c, k) => {
        const shown = c.faceUp || revealed(r) || r.play === 'user_draws';
        lines.push(`  ${k + 1}. ${shown ? cardText(c) : '（还没翻开）'}`);
      });
    }
    const rl = ratingLine(r, s);
    if (rl) lines.push(`结果：${rl}`);
    if (logs[i + 1].length) {
      lines.push('对话：');
      logs[i + 1].forEach((x) => lines.push(logLine(x)));
    }
  });
  return lines.join('\n');
}

function buildExport(title: string, view: View, entries: Entry[]): string {
  const head = [title, `整理方式：${view === 'session' ? '按次' : '按日期'}`, `导出时间：${fullTime(Date.now())}`].join('\n');
  if (view === 'session') return [head, ...entries.map(sessionToText)].join('\n\n\n');
  const days = groupByDay(entries);
  const body = days.map((d) => {
    const rounds = d.entries.reduce((n, e) => n + e.s.rounds.length, 0);
    return [`◆ ${d.key}　${d.entries.length} 场，${rounds} 局`, ...d.entries.map(sessionToText)].join('\n\n');
  });
  return [head, ...body].join('\n\n\n');
}

function groupByDay(entries: Entry[]): DayGroup[] {
  const out: DayGroup[] = [];
  for (const e of entries) {
    const key = dayKey(e.s.startedAt);
    const last = out[out.length - 1];
    if (last && last.key === key) last.entries.push(e);
    else out.push({ key, entries: [e] });
  }
  return out;
}

function fileNameOf(ta: string, scope: string): string {
  const safe = (x: string) => x.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${safe(ta)}_占卜记录_${safe(scope)}_${stamp}.txt`;
}

// ─── 页面 ──────────────────────────────────────────────────────────────

export function DuoRecords({
  charId, who, userName, workshop, tarotMeaning, lenormandMeaning, closeLabel, onClose, onToast,
}: DuoRecordsProps) {
  const taName = who.trim() || 'TA';
  const meName = userName.trim() || '我';
  /** 名字不认存档里的快照，只认 ID：现在是谁，就显示谁 */
  const named = useCallback(
    (x: DuoSession): Named => ({ ...x, taName, userName: meName }),
    [taName, meName],
  );
  const [records, setRecords] = useState<DuoSession[] | null>(null);
  const [live, setLive] = useState<DuoSession | null>(() => peekDuoSession(charId).session);
  const [view, setView] = useState<View>('session');
  const [order, setOrder] = useState<Order>('newest');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [inspect, setInspect] = useState<{ card: DuoCard; hidden: boolean } | null>(null);
  const [confirmDel, setConfirmDel] = useState<Entry | null>(null);

  // 读记录；后台那一局有变化（落了回复、存了记录）时重读
  useEffect(() => {
    let alive = true;
    const reload = () => {
      loadDuoRecords(charId).then((r) => { if (alive) setRecords(r.sessions); });
      setLive(peekDuoSession(charId).session);
    };
    const unsub = subscribeDuo(charId, reload);
    loadDuoSession(charId).then((s) => { if (alive) setLive(s); });
    reload();
    return () => { alive = false; unsub(); };
  }, [charId]);

  /** 记录 + 进行中的那一场（同一场以进行中的为准） */
  const entries = useMemo<Entry[]>(() => {
    const map = new Map<string, Entry>();
    for (const s of records ?? []) map.set(s.id, { s: named(s), live: false });
    if (live && !live.endedAt && (live.rounds.length || live.log.some((e) => e.from !== 'event'))) {
      map.set(live.id, { s: named(live), live: true });
    }
    const list = Array.from(map.values());
    list.sort((a, b) => (order === 'newest' ? b.s.startedAt - a.s.startedAt : a.s.startedAt - b.s.startedAt));
    return list;
  }, [records, live, order, named]);

  const days = useMemo(() => groupByDay(entries), [entries]);

  // 牌面：按牌组找上传的图，牌组删了就画默认牌面
  const pools = useMemo(() => new Map<string, PoolCard[]>(), [workshop]);
  const pcOf = useCallback((c: DuoCard): PoolCard | undefined => {
    const k = `${c.kind}:${c.deckId}`;
    let p = pools.get(k);
    if (!p) {
      try { p = buildDeckPool(workshop, c.kind, c.deckId); } catch { p = []; }
      pools.set(k, p);
    }
    return p.find((x) => x.key === c.cardKey);
  }, [pools, workshop]);

  const renderFace = (c: DuoCard, width: number) => {
    const pc = pcOf(c);
    if (pc?.tarotId !== undefined) return <CardFace card={TAROT_DECK[pc.tarotId]} reversed={c.reversed} width={width} image={pc.image} />;
    if (pc?.lenormandId !== undefined) {
      return <GenericCardFace width={width} ratio={CARD_RATIOS.lenormand} image={pc.image} mark={String(pc.lenormandId)} symbol="✧" title={pc.name} />;
    }
    return (
      <GenericCardFace
        width={width}
        ratio={CARD_RATIOS[c.kind]}
        image={pc?.image}
        symbol="✧"
        title={pc?.name || c.name}
        reversed={c.kind === 'tarot' && c.reversed}
      />
    );
  };

  const meaningOf = (c: DuoCard): string => {
    const pc = pcOf(c);
    if (pc?.tarotId !== undefined) { const m = tarotMeaning(pc.tarotId); return c.reversed ? m.rev : m.up; }
    if (pc?.lenormandId !== undefined) { const m = lenormandMeaning(pc.lenormandId); return `关键词：${m.keywords}\n时间：${m.time}`; }
    if (pc?.oracle?.meaning?.trim()) return pc.oracle.meaning.trim();
    return pc ? '这张没写牌意。' : '这副牌已经不在工坊里了，只留下了牌名。';
  };

  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const doExport = async (list: Entry[], scope: string, title: string) => {
    if (busy || !list.length) return;
    setBusy(true);
    try {
      const result = await shareOrDownloadFile({
        content: buildExport(title, view, list),
        fileName: fileNameOf(taName, scope),
        mimeType: 'text/plain;charset=utf-8',
        shareTitle: title,
      });
      onToast(result === 'shared' ? '已打开分享面板' : '占卜记录已导出');
    } catch {
      onToast('导出失败了，再试一次');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (e: Entry) => {
    setConfirmDel(null);
    try {
      await deleteDuoRecord(charId, e.s.id);
      onToast('这一场记录删掉了');
    } catch {
      onToast('没删掉，再试一次');
    }
  };

  // ── 一局 ──
  const renderRound = (s: Named, r: DuoRound, i: number, talk: DuoLogEntry[]) => {
    const rl = ratingLine(r, s);
    const cards = r.cards.slice().sort((a, b) => Number(a.extra) - Number(b.extra));
    return (
      <section key={r.id} className="dr-round">
        <div className="dr-round-head">
          <span className="dr-round-no">第 {i + 1} 局</span>
          <span className="dr-round-meta">{PLAY_LABEL[r.play]}，{MODE_LABEL[r.mode]}，{r.cards.length} 张</span>
        </div>

        <dl className="dr-qa">
          {questionLines(r, s).map(([k, v]) => (
            <React.Fragment key={k}>
              <dt>{k}</dt>
              <dd className={v === '还没揭晓' ? 'dr-muted' : undefined}>{v}</dd>
            </React.Fragment>
          ))}
        </dl>

        {cards.length > 0 && (
          <div className="dr-cards">
            {cards.map((c) => {
              const hidden = !(c.faceUp || revealed(r) || r.play === 'user_draws');
              return (
                <button key={c.id} className="dr-card" onClick={() => setInspect({ card: c, hidden })}>
                  <span className="dr-card-face">
                    {hidden
                      ? <GenericCardFace width={46} ratio={CARD_RATIOS[c.kind]} symbol="✵" title="" />
                      : renderFace(c, 46)}
                  </span>
                  <span className="dr-card-name">{hidden ? '没翻开' : c.name}</span>
                  <span className="dr-card-sub">
                    {!hidden && c.kind === 'tarot' ? (c.reversed ? '逆位' : '正位') : ''}
                    {c.extra ? `${!hidden && c.kind === 'tarot' ? '，' : ''}${c.by === 'ta' ? s.taName : s.userName}补` : ''}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {rl && <p className={r.rating ? `dr-verdict dr-verdict-${r.rating}` : 'dr-verdict dr-muted'}>{rl}</p>}

        {talk.length > 0 && renderTalk(s, talk)}
      </section>
    );
  };

  const renderTalk = (s: Named, talk: DuoLogEntry[]) => (
    <div className="dr-talk">
      {talk.map((x) => {
        if (x.from === 'event') return <p key={x.id} className="dr-event">{x.text}</p>;
        const mine = x.from === 'user';
        return (
          <div key={x.id} className={mine ? 'dr-line dr-line-me' : 'dr-line'}>
            <span className="dr-line-who">{mine ? s.userName : s.taName}<i>{hm(x.t)}</i></span>
            <span className="dr-line-text">{x.text}</span>
          </div>
        );
      })}
    </div>
  );

  // ── 一场展开后 ──
  const renderSessionBody = (e: Entry) => {
    const s = e.s;
    const logs = splitLog(s);
    return (
      <div className="dr-body">
        {logs[0].length > 0 && (
          <section className="dr-round">
            <div className="dr-round-head"><span className="dr-round-no">开局前</span></div>
            {renderTalk(s, logs[0])}
          </section>
        )}
        {s.rounds.map((r, i) => renderRound(s, r, i, logs[i + 1]))}
        {!e.live && (
          <button className="dr-del" onClick={() => setConfirmDel(e)}>删除这一场记录</button>
        )}
      </div>
    );
  };

  const sessionSummary = (e: Entry) => {
    const s = e.s;
    const end = lastTimeOf(s);
    const sameDay = dayKey(end) === dayKey(s.startedAt);
    const hits = s.rounds.filter((r) => r.rating === 'hit').length;
    const said = s.log.filter((x) => x.from !== 'event').length;
    return {
      time: `${hm(s.startedAt)} — ${sameDay ? hm(end) : fullTime(end)}`,
      sub: [`${s.rounds.length} 局`, hits ? `${hits} 局很准` : '', said ? `${said} 句对话` : ''].filter(Boolean).join('，'),
    };
  };

  const renderDate = (t: number) => {
    const d = new Date(t);
    return (
      <span className="dr-date">
        <b>{d.getDate()}</b>
        <span>{d.getMonth() + 1}月</span>
        <span>周{WEEK[d.getDay()]}</span>
      </span>
    );
  };

  const empty = records !== null && entries.length === 0;

  return (
    <div className="dr-root">
      <header className="dr-head">
        <div className="dr-head-row">
          <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={onClose}>{closeLabel}</button>
          <div className="dr-title">
            <h2>占卜记录</h2>
            <span>和{taName}</span>
          </div>
          <button
            className="tarot-chip tarot-chip-sm"
            disabled={busy || entries.length === 0}
            onClick={() => doExport(entries, `全部_${view === 'session' ? '按次' : '按日期'}`, `${taName}的全部占卜记录`)}
          >
            导出全部
          </button>
        </div>
        <div className="dr-controls">
          <div className="dr-seg">
            <button className={view === 'session' ? 'dr-seg-on' : ''} onClick={() => setView('session')}>按次</button>
            <button className={view === 'day' ? 'dr-seg-on' : ''} onClick={() => setView('day')}>按日期</button>
          </div>
          <button className="dr-order" onClick={() => setOrder((o) => (o === 'newest' ? 'oldest' : 'newest'))}>
            {order === 'newest' ? '新 → 旧' : '旧 → 新'}
          </button>
        </div>
      </header>

      <div className="dr-list">
        {records === null && <p className="dr-empty">翻书中…</p>}
        {empty && (
          <div className="dr-empty">
            <p>书架上还是空的。</p>
            <p className="dr-muted">点电话请{who}坐到对面，一起占卜之后，每一局都会记在这里。</p>
          </div>
        )}

        {view === 'session' && entries.map((e) => {
          const sum = sessionSummary(e);
          const isOpen = open.has(e.s.id);
          return (
            <article key={e.s.id} className={isOpen ? 'dr-entry dr-entry-open' : 'dr-entry'}>
              <div className="dr-entry-head">
                <button className="dr-entry-toggle" onClick={() => toggle(e.s.id)} aria-expanded={isOpen}>
                  {renderDate(e.s.startedAt)}
                  <span className="dr-entry-info">
                    <span className="dr-entry-time">
                      {sum.time}
                      {e.live && <em className="dr-live">进行中</em>}
                    </span>
                    <span className="dr-entry-sub">{sum.sub}</span>
                  </span>
                  <span className="dr-caret" aria-hidden="true">{isOpen ? '收起' : '展开'}</span>
                </button>
                <button
                  className="dr-export"
                  disabled={busy}
                  onClick={() => doExport([e], `本次_${dayKey(e.s.startedAt)}_${hm(e.s.startedAt).replace(':', '')}`, `${taName}的占卜记录`)}
                >
                  导出本次
                </button>
              </div>
              {isOpen && renderSessionBody(e)}
            </article>
          );
        })}

        {view === 'day' && days.map((d) => {
          const isOpen = open.has(`day:${d.key}`);
          const rounds = d.entries.reduce((n, e) => n + e.s.rounds.length, 0);
          return (
            <article key={d.key} className={isOpen ? 'dr-entry dr-entry-open' : 'dr-entry'}>
              <div className="dr-entry-head">
                <button className="dr-entry-toggle" onClick={() => toggle(`day:${d.key}`)} aria-expanded={isOpen}>
                  {renderDate(d.entries[0].s.startedAt)}
                  <span className="dr-entry-info">
                    <span className="dr-entry-time">
                      {d.key}
                      {d.entries.some((e) => e.live) && <em className="dr-live">进行中</em>}
                    </span>
                    <span className="dr-entry-sub">{d.entries.length} 场，{rounds} 局</span>
                  </span>
                  <span className="dr-caret" aria-hidden="true">{isOpen ? '收起' : '展开'}</span>
                </button>
                <button
                  className="dr-export"
                  disabled={busy}
                  onClick={() => doExport(d.entries, `当天_${d.key}`, `${taName}的占卜记录 ${d.key}`)}
                >
                  导出当天
                </button>
              </div>
              {isOpen && d.entries.map((e) => (
                <div key={e.s.id} className="dr-day-session">
                  <p className="dr-day-session-head">
                    {sessionSummary(e).time}
                    {e.live && <em className="dr-live">进行中</em>}
                  </p>
                  {renderSessionBody(e)}
                </div>
              ))}
            </article>
          );
        })}
      </div>

      {/* 点牌：拿近看 */}
      {inspect && (
        <div className="duo-mask dr-mask dr-mask-center" onClick={() => setInspect(null)}>
          <div className="dr-inspect" onClick={(ev: React.MouseEvent) => ev.stopPropagation()}>
            <div className="dr-inspect-face">
              {inspect.hidden
                ? <GenericCardFace width={150} ratio={CARD_RATIOS[inspect.card.kind]} symbol="✵" title="" />
                : renderFace(inspect.card, 150)}
            </div>
            {inspect.hidden ? (
              <p className="dr-muted">这张在那一局里还没翻开。</p>
            ) : (
              <>
                <h3>
                  {inspect.card.name}
                  {inspect.card.kind === 'tarot' && <span>{inspect.card.reversed ? '逆位' : '正位'}</span>}
                </h3>
                <p className="dr-inspect-deck">{KIND_CN[inspect.card.kind]}，{inspect.card.deckName || '未命名牌组'}</p>
                <p className="dr-inspect-meaning">{meaningOf(inspect.card)}</p>
              </>
            )}
            <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={() => setInspect(null)}>放回去</button>
          </div>
        </div>
      )}

      {confirmDel && (
        <div className="duo-mask dr-mask" onClick={() => setConfirmDel(null)}>
          <div className="duo-sheet" onClick={(ev: React.MouseEvent) => ev.stopPropagation()}>
            <h3 className="duo-sheet-title">删除这一场记录？</h3>
            <p className="duo-small">
              {fullTime(confirmDel.s.startedAt)} 的这一场（{confirmDel.s.rounds.length} 局）会从书架上拿掉，删了找不回来。
              已经写进聊天记录、记忆宫殿的内容不受影响，猜中次数也不变。
            </p>
            <div className="duo-panel-actions">
              <div style={{ flex: 1 }} />
              <button className="tarot-chip tarot-chip-ghost tarot-chip-sm" onClick={() => setConfirmDel(null)}>留着</button>
              <button className="tarot-chip tarot-chip-sm dr-danger" onClick={() => doDelete(confirmDel)}>删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const DUO_RECORDS_CSS = `
.dr-root {
  position: absolute; inset: 0; z-index: 30;
  display: flex; flex-direction: column;
  background:
    radial-gradient(ellipse at 50% -10%, rgba(217,185,120,0.10), rgba(217,185,120,0) 55%),
    linear-gradient(180deg, #1c1030 0%, #150b24 100%);
  color: #efe3c8;
  animation: drIn 0.3s ease both;
}
@keyframes drIn { from { opacity: 0; } }
.dr-head {
  flex-shrink: 0;
  padding: 10px 14px 10px;
  padding-top: calc(10px + var(--safe-top, 0px));
  border-bottom: 1px solid rgba(217,185,120,0.22);
}
.dr-head-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dr-head .tarot-chip:disabled { opacity: 0.4; cursor: default; }
.dr-title { text-align: center; min-width: 0; }
.dr-title h2 { margin: 0; font-size: 18px; font-weight: 500; letter-spacing: 0.14em; color: #efe3c8; }
.dr-title span { display: block; margin-top: 2px; font-size: 11px; color: rgba(239,227,200,0.5); letter-spacing: 0.06em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px; }
.dr-controls { display: flex; gap: 8px; margin-top: 10px; }
.dr-seg { flex: 1; display: flex; padding: 3px; border-radius: 10px; background: rgba(239,227,200,0.06); border: 1px solid rgba(239,227,200,0.12); }
.dr-seg button {
  flex: 1; border: none; background: transparent; color: rgba(239,227,200,0.5);
  font: inherit; font-size: 12px; letter-spacing: 0.08em; padding: 6px 0; border-radius: 7px; cursor: pointer;
}
.dr-seg .dr-seg-on { background: rgba(217,185,120,0.16); color: #d9b978; box-shadow: inset 0 0 0 1px rgba(217,185,120,0.45); }
.dr-order {
  flex-shrink: 0; border: 1px solid rgba(239,227,200,0.18); background: transparent; color: rgba(239,227,200,0.7);
  font: inherit; font-size: 11px; padding: 0 12px; border-radius: 10px; cursor: pointer; white-space: nowrap;
}

.dr-list { flex: 1; overflow-y: auto; padding: 4px 14px calc(28px + var(--safe-bottom, 0px)); -webkit-overflow-scrolling: touch; }
.dr-empty { text-align: center; margin-top: 64px; font-size: 14px; line-height: 1.8; color: rgba(239,227,200,0.75); }
.dr-empty p { margin: 0 auto 6px; max-width: 260px; }
.dr-muted { color: rgba(239,227,200,0.42) !important; }

.dr-entry { border-bottom: 1px solid rgba(239,227,200,0.10); }
.dr-entry-head { display: flex; align-items: center; gap: 8px; }
.dr-entry-toggle {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px;
  border: none; background: transparent; color: inherit; font: inherit; text-align: left;
  padding: 14px 0; cursor: pointer; -webkit-tap-highlight-color: transparent;
}
.dr-date {
  flex-shrink: 0; width: 44px; display: flex; flex-direction: column; align-items: center;
  border-right: 1px solid rgba(217,185,120,0.35); padding-right: 10px;
  font-size: 10px; color: rgba(239,227,200,0.5); line-height: 1.35;
}
.dr-date b { font-size: 22px; font-weight: 400; color: #d9b978; line-height: 1.1; }
.dr-entry-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.dr-entry-time { font-size: 14px; letter-spacing: 0.04em; display: flex; align-items: center; gap: 6px; }
.dr-entry-sub { font-size: 11px; color: rgba(239,227,200,0.5); }
.dr-caret { flex-shrink: 0; font-size: 10px; color: rgba(239,227,200,0.35); }
.dr-live {
  font-style: normal; font-size: 10px; color: #1a0f28; background: #d9b978;
  border-radius: 999px; padding: 1px 7px; letter-spacing: 0.06em;
}
.dr-export {
  flex-shrink: 0; border: 1px solid rgba(217,185,120,0.4); background: rgba(217,185,120,0.08);
  color: #d9b978; font: inherit; font-size: 11px; border-radius: 999px; padding: 5px 11px; cursor: pointer;
}
.dr-export:disabled { opacity: 0.4; }

.dr-body { padding: 0 0 14px 22px; margin-left: 21px; border-left: 1px solid rgba(217,185,120,0.25); }
.dr-day-session { margin-bottom: 6px; }
.dr-day-session-head {
  margin: 4px 0 6px; font-size: 12px; color: #d9b978; letter-spacing: 0.06em;
  display: flex; align-items: center; gap: 6px;
}

.dr-round { padding: 10px 0 14px; }
.dr-round + .dr-round { border-top: 1px dashed rgba(239,227,200,0.12); }
.dr-round-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; position: relative; }
.dr-round-head::before {
  content: ''; position: absolute; left: -26.5px; top: 5px; width: 8px; height: 8px; border-radius: 50%;
  background: #1c1030; border: 1px solid #d9b978;
}
.dr-round-no { font-size: 14px; color: #d9b978; letter-spacing: 0.1em; }
.dr-round-meta { font-size: 11px; color: rgba(239,227,200,0.5); }

.dr-qa { display: grid; grid-template-columns: auto 1fr; gap: 5px 10px; margin: 0 0 10px; font-size: 13px; line-height: 1.6; }
.dr-qa dt { color: rgba(239,227,200,0.5); font-size: 12px; white-space: nowrap; }
.dr-qa dd { margin: 0; white-space: pre-wrap; word-break: break-word; }

.dr-cards { display: flex; gap: 10px; overflow-x: auto; padding: 2px 2px 8px; margin-bottom: 4px; }
.dr-card {
  flex-shrink: 0; width: 58px; display: flex; flex-direction: column; align-items: center; gap: 4px;
  border: none; background: transparent; color: inherit; font: inherit; padding: 0; cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.dr-card-face { line-height: 0; }
.dr-card-name { font-size: 10px; text-align: center; line-height: 1.3; max-width: 58px; word-break: break-all; }
.dr-card-sub { font-size: 9px; color: rgba(239,227,200,0.45); min-height: 11px; text-align: center; }

.dr-verdict {
  margin: 4px 0 10px; font-size: 12px; padding: 6px 10px; border-radius: 8px;
  background: rgba(239,227,200,0.05); border-left: 2px solid rgba(239,227,200,0.3);
}
.dr-verdict-hit { border-left-color: #d9b978; color: #f0d9a4; }
.dr-verdict-half { border-left-color: #b79ad6; }
.dr-verdict-miss { border-left-color: rgba(239,227,200,0.3); color: rgba(239,227,200,0.7); }

.dr-talk { display: flex; flex-direction: column; gap: 8px; }
.dr-event { margin: 0; font-size: 11px; color: rgba(239,227,200,0.4); line-height: 1.5; }
.dr-line { display: flex; flex-direction: column; align-items: flex-start; max-width: 92%; }
.dr-line-me { align-self: flex-end; align-items: flex-end; }
.dr-line-who { font-size: 10px; color: #d9b978; margin-bottom: 2px; letter-spacing: 0.06em; }
.dr-line-me .dr-line-who { color: rgba(239,227,200,0.5); }
.dr-line-who i { font-style: normal; color: rgba(239,227,200,0.3); margin-left: 6px; }
.dr-line-text {
  font-size: 13px; line-height: 1.65; white-space: pre-wrap; word-break: break-word;
  padding: 7px 11px; border-radius: 4px 12px 12px 12px;
  background: rgba(52,30,78,0.75); border: 1px solid rgba(217,185,120,0.18);
  user-select: text; -webkit-user-select: text;
}
.dr-line-me .dr-line-text { border-radius: 12px 4px 12px 12px; background: rgba(239,227,200,0.08); border-color: rgba(239,227,200,0.12); }

.dr-del {
  margin-top: 6px; border: none; background: transparent; color: rgba(229,140,140,0.75);
  font: inherit; font-size: 11px; padding: 4px 0; cursor: pointer;
}
.dr-mask { z-index: 46; }
.dr-mask-center { align-items: center; }
.dr-danger { border-color: rgba(229,140,140,0.6) !important; color: #eaa !important; }

.dr-inspect {
  width: min(320px, 86vw); max-height: 86%; overflow-y: auto;
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 20px 18px 16px; border-radius: 16px;
  background: linear-gradient(180deg, #241538, #170d24); border: 1px solid rgba(217,185,120,0.4);
  animation: drPop 0.25s ease both;
}
@keyframes drPop { from { opacity: 0; transform: scale(0.94); } }
.dr-inspect-face { line-height: 0; }
.dr-inspect h3 { margin: 4px 0 0; font-size: 17px; font-weight: 500; letter-spacing: 0.08em; display: flex; align-items: baseline; gap: 8px; }
.dr-inspect h3 span { font-size: 12px; color: #d9b978; }
.dr-inspect-deck { margin: 0; font-size: 11px; color: rgba(239,227,200,0.5); }
.dr-inspect-meaning { margin: 0; font-size: 13px; line-height: 1.7; white-space: pre-wrap; text-align: left; align-self: stretch; }

@media (prefers-reduced-motion: reduce) {
  .dr-root, .dr-inspect { animation: none; }
}
`;
