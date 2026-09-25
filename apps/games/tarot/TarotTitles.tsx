import React, { useCallback, useEffect, useState } from 'react';
import {
  loadTitles, unlockedTitleIds, titleById, titleCoinToken, hitValueOf,
  PATHS, HIDDEN_TITLES, ULTIMATE_TITLE,
  type PathProgress, type SideProgress, type TitlesSnapshot, type TitleSide,
} from './titles';
import { award, isPaid, markPaid, loadWallet, type Wallet } from '../shared/wallet';

interface Props {
  charId: string;
  taName: string;
  userName: string;
  onClose: () => void;
  onToast: (text: string) => void;
}

const SIDE_ICON: Record<TitleSide, string> = { user: '🍏', ta: '🍎' };

/** 一条路线的进度条 + 四个档位。 */
const PathBlock: React.FC<{ p: PathProgress }> = ({ p }) => {
  const meta = PATHS[p.path];
  const hit = hitValueOf(meta.mode);
  return (
    <div className="tt-path">
      <div className="tt-path-head">
        <span className="tt-path-name">{meta.label}</span>
        <span className="tt-path-mode">{meta.mode === 'basic' ? '基础模式' : '进阶模式'} · 很准 +{hit}</span>
      </div>
      <div className="tt-score">{p.score % 1 === 0 ? p.score : p.score.toFixed(2)}</div>
      <div className="tt-bar"><div className="tt-bar-fill" style={{ width: `${p.ratio * 100}%` }} /></div>
      <div className="tt-tiers">
        {meta.tiers.map(t => {
          const got = p.unlocked.includes(t.id);
          return (
            <div key={t.id} className={`tt-tier${got ? ' got' : ''}`}>
              <span className="tt-tier-name">{got ? t.name : '???'}</span>
              <span className="tt-tier-need">{t.need}</span>
            </div>
          );
        })}
      </div>
      {p.next && (
        <div className="tt-next">
          还差 {(p.next.need - p.score).toFixed(2).replace(/\.00$/, '')} 分到「{p.next.name}」
        </div>
      )}
    </div>
  );
};

/** 一个人的整块。 */
const SideBlock: React.FC<{ p: SideProgress; name: string }> = ({ p, name }) => {
  const crown = p.ultimate
    ? ULTIMATE_TITLE.name
    : (p.scholar.current?.name || p.apprentice.current?.name || '还没有称号');
  return (
    <section className="tt-side">
      <div className="tt-side-head">
        <span className="tt-side-icon">{SIDE_ICON[p.side]}</span>
        <div>
          <div className="tt-side-name">{name}</div>
          <div className={`tt-crown${p.ultimate ? ' ultimate' : ''}`}>{crown}</div>
        </div>
      </div>
      <PathBlock p={p.apprentice} />
      <PathBlock p={p.scholar} />
    </section>
  );
};

/**
 * 称号页（桌上那个铜色浑天仪）。
 *
 * 只读 duoStore 已经在记的分数，不改计分。进来时顺手把"已经达成但还没领币"的称号补发掉——
 * 称号是累计型的，解锁那一刻你多半正在占卜中途，弹个发币提示会打断节奏；
 * 攒到打开这一页再一起给，反而更像"清点战利品"。
 */
const TarotTitles: React.FC<Props> = ({ charId, taName, userName, onClose, onToast }) => {
  const [snap, setSnap] = useState<TitlesSnapshot | null>(null);
  const [wallet, setWallet] = useState<Wallet>(() => loadWallet(charId));

  const refresh = useCallback(async () => {
    const s = await loadTitles(charId);
    setSnap(s);

    // 补发没领过的称号币。同一个称号只发一次，靠 wallet 的 paid 记录挡住。
    const pending: { side: TitleSide; id: string; coins: number; name: string }[] = [];
    for (const side of ['user', 'ta'] as TitleSide[]) {
      for (const id of unlockedTitleIds(s[side])) {
        if (isPaid(charId, titleCoinToken(side, id))) continue;
        const t = titleById(id);
        if (t) pending.push({ side, id, coins: t.coins, name: t.name });
      }
    }
    // 隐藏称号**双方同得**（跟女巫那套 1:1 一个道理）——这四个本来就是
    // "你们俩一起达成的"，只给一边说不过去。两边各自记 paid，互不影响。
    for (const id of s.hidden) {
      const t = titleById(id);
      if (!t) continue;
      for (const side of ['user', 'ta'] as TitleSide[]) {
        if (isPaid(charId, titleCoinToken(side, id))) continue;
        pending.push({ side, id, coins: t.coins, name: t.name });
      }
    }

    if (pending.length > 0) {
      setWallet(award(charId, pending.map(x => ({
        side: x.side, amount: x.coins, game: 'tarot' as const,
        reason: `塔罗称号 · ${x.name}`,
      }))));
      pending.forEach(x => markPaid(charId, titleCoinToken(x.side, x.id)));
      // 隐藏称号一个会产生两笔（你一笔、TA 一笔），所以报数时按称号去重，
      // 不然解锁一个隐藏称号会说成"解锁了 2 个称号"。
      const names = [...new Set(pending.map(x => x.name))];
      const total = pending.reduce((n, x) => n + x.coins, 0);
      onToast(names.length === 1
        ? `解锁「${names[0]}」，+${total} 苹果币`
        : `解锁了 ${names.length} 个称号，+${total} 苹果币`);
    }
  }, [charId, onToast]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="tt-wrap">
      <header className="tt-head">
        <button className="tt-back" onClick={onClose}>‹</button>
        <div className="tt-title">称号</div>
        <div className="tt-coins">🍏{wallet.user} · 🍎{wallet.ta}</div>
      </header>

      {!snap ? (
        <div className="tt-empty">读取中…</div>
      ) : (
        <div className="tt-body">
          <div className="tt-harmony">
            <div className="tt-harmony-num">{snap.harmony % 1 === 0 ? snap.harmony : snap.harmony.toFixed(2)}</div>
            <div className="tt-harmony-label">默契值</div>
            {/* 说清楚它不换币：苹果币只从称号来，默契值是另一条线，
                走到里程碑解锁塔罗专属的新牌背。两条线互不换算。 */}
            <div className="tt-harmony-note">
              你们俩四条路的分数之和，只涨不减。<b>不换苹果币</b>——它用来解锁塔罗专属的新牌背。
              <br />共占卜 {snap.rounds} 局。
            </div>
          </div>

          <SideBlock p={snap.user} name={userName || '我'} />
          <SideBlock p={snap.ta} name={taName} />

          <section className="tt-side">
            <div className="tt-side-head">
              <span className="tt-side-icon">✦</span>
              <div>
                <div className="tt-side-name">隐藏称号</div>
                <div className="tt-crown">{snap.hidden.length} / {HIDDEN_TITLES.length}</div>
              </div>
            </div>
            <div className="tt-hidden">
              {HIDDEN_TITLES.map(h => {
                const got = snap.hidden.includes(h.id);
                return (
                  <div key={h.id} className={`tt-hid${got ? ' got' : ''}`}>
                    <div className="tt-hid-name">{got ? h.name : '???'}</div>
                    <div className="tt-hid-hint">{got ? h.hint : '还没解锁'}</div>
                  </div>
                );
              })}
            </div>
          </section>

          <div className="tt-foot">
            称号只看<b>双人占卜</b>里被判"准"的次数——自己抽自己的不算。
            两条路各走各的：学徒之路数基础模式，学者之路数进阶模式。
            <br />
            苹果币只从<b>称号</b>来，各人算各人的；默契值是另一条线，只解锁牌背。
          </div>
        </div>
      )}
    </div>
  );
};

export const TAROT_TITLES_CSS = `
.tt-wrap{position:absolute;inset:0;z-index:40;display:flex;flex-direction:column;
  background:linear-gradient(180deg,#241a33 0%,#191226 100%);color:#e8dcf2;overflow:hidden}
.tt-head{display:flex;align-items:center;gap:8px;padding:calc(var(--safe-top,0px) + 10px) 14px 10px;
  border-bottom:1px solid rgba(197,164,232,.16);flex-shrink:0}
.tt-back{width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.08);color:#d9c2f5;font-size:18px;line-height:1}
.tt-title{font-weight:800;letter-spacing:.14em;font-size:15px}
.tt-coins{margin-left:auto;font-size:12px;color:rgba(232,220,242,.55)}
.tt-body{flex:1;min-height:0;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:14px}
.tt-empty{flex:1;display:flex;align-items:center;justify-content:center;font-size:13px;color:rgba(232,220,242,.4)}

.tt-harmony{text-align:center;padding:18px 14px;border-radius:20px;
  background:radial-gradient(circle at 50% 0%,rgba(197,164,232,.18),rgba(255,255,255,.04));
  border:1px solid rgba(197,164,232,.2)}
.tt-harmony-num{font-size:36px;font-weight:900;line-height:1;color:#e3c9ff}
.tt-harmony-label{font-size:12px;letter-spacing:.3em;margin-top:6px;color:rgba(232,220,242,.6)}
.tt-harmony-note{font-size:11px;margin-top:8px;color:rgba(232,220,242,.4);line-height:1.6}

.tt-side{border-radius:20px;background:rgba(255,255,255,.04);
  border:1px solid rgba(197,164,232,.14);padding:14px}
.tt-side-head{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.tt-side-icon{font-size:22px}
.tt-side-name{font-size:14px;font-weight:800}
.tt-crown{font-size:12px;color:#c9a6f0;margin-top:2px}
.tt-crown.ultimate{color:#ffd88a;font-weight:800}

.tt-path{margin-top:12px}
.tt-path:first-of-type{margin-top:0}
.tt-path-head{display:flex;align-items:baseline;gap:8px}
.tt-path-name{font-size:12px;font-weight:700;color:#d9c2f5}
.tt-path-mode{font-size:10px;color:rgba(232,220,242,.38);margin-left:auto}
.tt-score{font-size:20px;font-weight:900;line-height:1.2;color:#e8dcf2}
.tt-bar{height:5px;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden;margin:6px 0 8px}
.tt-bar-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,#9b7ad1,#e3c9ff);transition:width .4s}
.tt-tiers{display:grid;grid-template-columns:repeat(4,1fr);gap:5px}
.tt-tier{text-align:center;padding:6px 2px;border-radius:10px;background:rgba(255,255,255,.04)}
.tt-tier.got{background:rgba(197,164,232,.18)}
.tt-tier-name{display:block;font-size:10px;color:rgba(232,220,242,.35);line-height:1.3}
.tt-tier.got .tt-tier-name{color:#e3c9ff;font-weight:700}
.tt-tier-need{display:block;font-size:9px;color:rgba(232,220,242,.3);margin-top:2px}
.tt-next{font-size:10px;color:rgba(232,220,242,.4);margin-top:6px}

.tt-hidden{display:grid;grid-template-columns:1fr 1fr;gap:7px}
.tt-hid{padding:9px;border-radius:12px;background:rgba(255,255,255,.04)}
.tt-hid.got{background:rgba(255,216,138,.12);border:1px solid rgba(255,216,138,.25)}
.tt-hid-name{font-size:12px;font-weight:700;color:rgba(232,220,242,.35)}
.tt-hid.got .tt-hid-name{color:#ffd88a}
.tt-hid-hint{font-size:10px;line-height:1.5;margin-top:3px;color:rgba(232,220,242,.35)}

.tt-foot{font-size:11px;line-height:1.7;color:rgba(232,220,242,.35);padding:0 4px 10px}
`;

export default TarotTitles;
