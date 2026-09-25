import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkle, Image as ImageIcon, X, Trash, ArrowClockwise, Ticket, PaperPlaneTilt } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import TokenImg from '../../components/os/TokenImg';
import { processImage } from '../../utils/file';
import { migrateDataUrlToRef } from '../../utils/blobRef';
import { isImageGenApiReady, generateImage } from '../../utils/imageGenApi';
import GiftPackage from './GiftPackage';
import {
  WRAPS, addGift, loadGifts, openGift, deleteGift, giftsFrom, buildGiftImagePrompt,
  type Gift, type GiftWrap,
} from './gifts';
import { checkGiftGate, runTaGift } from './giftAi';
import {
  loadCoupons, useCoupon, couponById, categoryOf,
  type CouponItem, type CouponWallet,
} from '../games/shared/coupons';
import { DB } from '../../utils/db';

interface Props {
  charId: string;
  taName: string;
  onBack: () => void;
}

type Tab = 'make' | 'shelf' | 'coupon';

/**
 * 礼物。两栏：制作台 / 藏柜。
 *
 * 这一版**只有你能送**——TA 那半（它自己挑时机、礼物界面的 🔄）和券夹是第二步。
 *
 * 藏柜里是"对方给我的心意"，永久、没有状态；券是"自己花钱买的权利"，有未用/已用。
 * 所以券不混进藏柜，以后单独第三栏。
 */
/**
 * 藏柜里的一列。
 *
 * ⚠️ 必须定义在组件外面。定义在里面的话每次 render 都是新的组件类型，React 会把
 * 整列卸载重建——拆开动画播到一半就会被打断重来，而那正是这个功能最该做对的一下。
 */
const GiftColumn: React.FC<{
  title: string;
  list: Gift[];
  empty: string;
  openingId: string | null;
  onOpen: (g: Gift) => void;
}> = ({ title, list, empty, openingId, onOpen }) => (
  <div className="flex-1 min-w-0">
    <div className="text-[11px] font-black text-rose-400 text-center mb-2 tracking-[.1em]">{title}</div>
    {list.length === 0 ? (
      <div className="text-[10px] text-rose-300 text-center py-8 leading-relaxed px-2">{empty}</div>
    ) : (
      <div className="space-y-4">
        {list.map(g => (
          <button key={g.id} onClick={() => onOpen(g)} className="w-full flex flex-col items-center active:scale-95 transition-transform">
            <div className="relative">
              <GiftPackage
                wrap={g.wrap}
                size={76}
                opening={openingId === g.id}
                opened={!!g.openedAt && openingId !== g.id}
                className={!g.openedAt && openingId !== g.id ? 'yg-idle' : ''}
              />
              {!g.openedAt && (
                <span className="absolute top-0 right-0 w-2.5 h-2.5 rounded-full bg-rose-400 ring-2 ring-white" />
              )}
            </div>
            {/* 日期铭牌 */}
            <div className="mt-1 px-2 py-0.5 rounded-full bg-white/80 text-[9px] text-slate-500 shadow-sm">
              {new Date(g.createdAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
            </div>
          </button>
        ))}
      </div>
    )}
  </div>
);

const YuZhouGiftPage: React.FC<Props> = ({ charId, taName, onBack }) => {
  const { apiConfig, addToast, characters, userProfile } = useOS();
  const char = characters.find(c => c.id === charId) || null;
  const [tab, setTab] = useState<Tab>('make');
  const [gifts, setGifts] = useState<Gift[]>([]);

  // 制作台
  const [wrap, setWrap] = useState<GiftWrap>('ribbon');
  const [note, setNote] = useState('');
  const [image, setImage] = useState('');
  const [imagePrompt, setImagePrompt] = useState('');
  const [genWhat, setGenWhat] = useState('');
  const [genOpen, setGenOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [sealing, setSealing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 藏柜
  const [viewing, setViewing] = useState<Gift | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  /** 它没送东西时说的那句话。显示一会儿就淡掉。 */
  const [taLine, setTaLine] = useState('');

  // 券夹
  const [coupons, setCoupons] = useState<CouponWallet>({ items: [] });

  const canGen = isImageGenApiReady(apiConfig?.imageGenApi);

  const refresh = useCallback(async () => setGifts(await loadGifts(charId)), [charId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { setCoupons(loadCoupons(charId)); }, [charId, tab]);

  // ── 制作 ──

  const pickFromAlbum = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const base64 = await processImage(file);
      setImage(await migrateDataUrlToRef(base64));
      setImagePrompt('');
    } catch (err: any) {
      addToast(err?.message || '图片处理失败', 'error');
    }
  };

  /**
   * 让 AI 做一件。单独一个通道 [用户确认]：平时只写一句话就能送，
   * 不点这个按钮**一点生图额度都不花**。
   */
  const generate = async () => {
    const what = genWhat.trim();
    if (!what || !canGen || generating) return;
    setGenerating(true);
    try {
      const prompt = buildGiftImagePrompt(what);
      const results = await generateImage(apiConfig!.imageGenApi!, prompt, {
        n: 1,
        meta: { appName: '与昼', charId: charId || undefined, purpose: '礼物 · 做一件' } as any,
      });
      const src = results[0]?.src;
      if (!src) { addToast('没做出来，再试一次', 'error'); return; }
      setImage(src.startsWith('data:') ? await migrateDataUrlToRef(src) : src);
      setImagePrompt(what);
      setGenOpen(false);
    } catch (e: any) {
      addToast(`做失败了：${e?.message?.slice(0, 50) || '未知错误'}`, 'error');
    } finally {
      setGenerating(false);
    }
  };

  const seal = async () => {
    if (!note.trim() && !image) { addToast('至少写一句话，或者放一张图', 'info'); return; }
    setSealing(true);
    try {
      await addGift(charId, { from: 'user', wrap, note: note.trim(), image: image || undefined, imagePrompt: imagePrompt || undefined });
      setNote(''); setImage(''); setImagePrompt(''); setGenWhat('');
      await refresh();
      setTab('shelf');
      addToast(`封好了，放进${taName}的柜子里`, 'success');
    } finally { setSealing(false); }
  };

  // ── 拆开 ──

  const handleOpen = async (g: Gift) => {
    if (g.openedAt) { setViewing(g); return; }
    setOpeningId(g.id);
    // 等动画播完再落库并展示内容——先跳内容的话，拆的那一下就白做了
    window.setTimeout(async () => {
      await openGift(charId, g.id);
      const list = await loadGifts(charId);
      setGifts(list);
      setViewing(list.find(x => x.id === g.id) || null);
      setOpeningId(null);
    }, 780);
  };

  /**
   * 去看看它有没有留下什么。
   *
   * 不是"送我一个"——它自己判断此刻想不想送，可能有也可能没有。
   * 冷却 12 小时，超过 7 天没送过会保底必给，纪念日整百天也必给。
   */
  const checkTaGift = async () => {
    if (checking) return;
    const gate = checkGiftGate(charId);
    if (!gate.can) {
      const t = new Date(gate.nextAt);
      addToast(`下次可以去看看：${t.getMonth() + 1}月${t.getDate()}日 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`, 'info');
      return;
    }
    if (!apiConfig?.baseUrl || !apiConfig?.apiKey) { addToast('请先配置 API', 'info'); return; }

    setChecking(true);
    setTaLine('');
    try {
      const r = await runTaGift({ charId, char: char || null, apiConfig, userName: userProfile?.name || '我', gate });
      setGifts(r.gifts);
      if (r.gift) { setTab('shelf'); addToast(`${taName}留了个东西给你`, 'success'); }
      else setTaLine(r.line || '');
    } catch (e: any) {
      addToast(`没看成：${e?.message?.slice(0, 40) || '未知错误'}`, 'error');
    } finally { setChecking(false); }
  };

  /**
   * 把券发进聊天框 = 用掉 [用户确认]。
   *
   * 以你的身份发一条普通文字消息，不打 source 标记——这条**要**出现在聊天气泡流里，
   * TA 读到之后自然会接。发出去就作废，不能反悔。
   */
  const playCoupon = async (item: CouponItem) => {
    const def = couponById(item.defId);
    if (!def) return;
    try {
      await DB.saveMessage({
        charId, role: 'user', type: 'text',
        content: `【${def.name}】${def.desc}`,
      } as any);
      setCoupons(useCoupon(charId, item.id));
      addToast(`「${def.name}」已经发给${taName}了`, 'success');
    } catch (e: any) {
      addToast(`发失败：${e?.message?.slice(0, 40) || '未知错误'}`, 'error');
    }
  };

  const remove = async (g: Gift) => {
    await deleteGift(charId, g.id);
    setViewing(null);
    await refresh();
  };

  const mine = giftsFrom(gifts, 'user');
  const theirs = giftsFrom(gifts, 'ta');

  return (
    <div className="absolute inset-0 z-[62] bg-[#fdf3f2] text-slate-700">
      {/* 券的票形。礼物页是独立覆盖层，YuZhouApp 挂的那份样式在它的子树里，
          这里自带一份，免得券夹里的票缺了缺口和撕线。 */}
      <style>{`
        .yz-ticket{position:relative;background:rgba(255,255,255,.88);border:1px solid;
          border-radius:16px;padding:13px 15px;box-shadow:0 6px 18px rgba(172,88,108,.08)}
        .yz-notch{position:absolute;width:14px;height:14px;border-radius:50%;
          background:#fdf3f2;top:50%;transform:translateY(-50%)}
        .yz-notch.left{left:-8px}
        .yz-notch.right{right:-8px}
        .yz-tear{border-top:1px dashed;margin:11px -15px 9px;padding:0}
      `}</style>
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_12%_8%,rgba(255,214,224,.55),transparent_30%),radial-gradient(circle_at_88%_20%,rgba(255,228,232,.6),transparent_32%),linear-gradient(180deg,#fff9f8_0%,#fdf1f0_100%)]" />
      <div className="relative h-full overflow-y-auto overscroll-none" style={{ paddingTop: 'var(--safe-top)' }}>
        <header className="h-14 px-4 flex items-center justify-between">
          <button onClick={onBack} className="w-9 h-9 rounded-full bg-white/80 shadow-sm text-rose-400 text-xl active:scale-90 transition-transform">‹</button>
          <div className="text-center">
            <div className="font-black tracking-[.18em] text-rose-500 text-base">礼物</div>
            <div className="text-[8px] tracking-[.22em] text-rose-300 mt-0.5">FOR YOU</div>
          </div>
          <div className="w-9 h-9" />
        </header>

        <div className="px-5 max-w-md mx-auto">
          <div className="flex gap-2 mb-5">
            {([['make', '制作台'], ['shelf', '藏柜'], ['coupon', '券夹']] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className="flex-1 py-2 rounded-2xl text-[13px] font-black transition"
                style={tab === id
                  ? { background: '#fff', color: '#e0767e', boxShadow: '0 4px 14px rgba(172,88,108,.10)' }
                  : { background: 'rgba(255,255,255,.5)', color: '#d4a0a8' }}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'make' ? (
            <div className="space-y-5 pb-10">
              <div>
                <div className="text-[11px] font-bold text-rose-400 mb-2">选个包装</div>
                <div className="flex gap-2">
                  {WRAPS.map(w => (
                    <button
                      key={w.id}
                      onClick={() => setWrap(w.id)}
                      className="flex-1 rounded-2xl py-3 flex flex-col items-center transition"
                      style={wrap === w.id
                        ? { background: '#fff', boxShadow: '0 4px 14px rgba(172,88,108,.12)', outline: '2px solid #f7c6cd' }
                        : { background: 'rgba(255,255,255,.55)' }}
                    >
                      <GiftPackage wrap={w.id} size={54} />
                      <div className="text-[10px] font-bold mt-1" style={{ color: wrap === w.id ? '#e0767e' : '#c4a5a8' }}>{w.label}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-[11px] font-bold text-rose-400 mb-2">写点什么</div>
                <textarea
                  value={note}
                  onChange={e => setNote(e.target.value.slice(0, 500))}
                  rows={4}
                  placeholder={`想对${taName}说的话…只写这一段也能送`}
                  className="w-full px-3 py-2.5 rounded-2xl text-[13px] leading-relaxed outline-none resize-none bg-white/80 border border-white placeholder:text-rose-200"
                />
              </div>

              {image ? (
                <div className="relative rounded-2xl overflow-hidden bg-white/80 border border-white">
                  <TokenImg value={image} className="w-full h-auto object-contain max-h-60" />
                  <button
                    onClick={() => { setImage(''); setImagePrompt(''); }}
                    className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/45 text-white flex items-center justify-center"
                  >
                    <X size={13} weight="bold" />
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="flex-1 py-2.5 rounded-2xl bg-white/80 border border-white text-[12px] font-bold text-slate-500 flex items-center justify-center gap-1.5 active:scale-95 transition"
                  >
                    <ImageIcon size={15} /> 从相册选
                  </button>
                  <button
                    onClick={() => canGen && setGenOpen(v => !v)}
                    disabled={!canGen}
                    className="flex-1 py-2.5 rounded-2xl text-[12px] font-bold flex items-center justify-center gap-1.5 active:scale-95 transition disabled:active:scale-100"
                    style={canGen
                      ? { background: '#fdeef0', color: '#e0767e', border: '1px solid #fadfe3' }
                      : { background: 'rgba(0,0,0,.04)', color: '#bdb5b3', border: '1px solid transparent' }}
                  >
                    <Sparkle size={15} weight="fill" /> {canGen ? '让 AI 做一件' : '没配生图 API'}
                  </button>
                </div>
              )}
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pickFromAlbum} />

              {genOpen && !image && (
                <div className="rounded-2xl bg-white/85 border border-white p-3 space-y-2">
                  <div className="text-[11px] text-rose-400 font-bold">想送什么？</div>
                  <input
                    value={genWhat}
                    onChange={e => setGenWhat(e.target.value.slice(0, 60))}
                    placeholder="一盏照亮书桌的小灯"
                    className="w-full px-3 py-2 rounded-xl text-[13px] outline-none bg-[#fdf3f2] placeholder:text-rose-200"
                  />
                  <div className="text-[10px] text-rose-300 leading-relaxed">
                    只写送什么就行，画风这边统一——柜子里的礼物才像一套。
                  </div>
                  <button
                    onClick={generate}
                    disabled={!genWhat.trim() || generating}
                    className="w-full py-2 rounded-full text-[12px] font-black disabled:opacity-40"
                    style={{ background: '#e0767e', color: '#fff' }}
                  >
                    {generating ? '做着呢…' : '做出来'}
                  </button>
                </div>
              )}

              <button
                onClick={seal}
                disabled={sealing || (!note.trim() && !image)}
                className="w-full py-3 rounded-full text-[14px] font-black disabled:opacity-40 active:scale-95 transition"
                style={{ background: '#e0767e', color: '#fff' }}
              >
                {sealing ? '封装中…' : '封装'}
              </button>
            </div>
          ) : tab === 'shelf' ? (
            <div className="pb-10">
              {/* 不是"送我一个"，是"去看看它有没有留下什么"——可能有，也可能没有 */}
              <button
                onClick={checkTaGift}
                disabled={checking}
                className="w-full mb-4 py-2.5 rounded-2xl text-[12px] font-bold flex items-center justify-center gap-1.5 active:scale-95 transition disabled:opacity-50"
                style={{ background: '#fff', color: '#e0767e', boxShadow: '0 4px 14px rgba(172,88,108,.10)' }}
              >
                <ArrowClockwise size={14} className={checking ? 'animate-spin' : ''} />
                {checking ? `${taName}那边看看…` : `去看看${taName}有没有留下什么`}
              </button>

              {taLine && (
                <div className="mb-4 px-4 py-3 rounded-2xl bg-white/70 text-[12.5px] leading-relaxed text-slate-600">
                  <span className="text-rose-400 font-bold">{taName}：</span>{taLine}
                </div>
              )}

              <div className="flex gap-3">
                <GiftColumn title="我送的" list={mine} empty={`还没送过${taName}东西`} openingId={openingId} onOpen={handleOpen} />
                <div className="w-px bg-rose-200/50" />
                <GiftColumn title={`${taName}送的`} list={theirs} empty="它还没送过你东西" openingId={openingId} onOpen={handleOpen} />
              </div>
              <div className="text-[10px] text-rose-300 leading-relaxed mt-8 px-1 text-center">
                点一下盒子拆开。拆开只有一次，之后随时能重看里面。
              </div>
            </div>
          ) : (
            <div className="pb-10">
              {(() => {
                const unused = coupons.items.filter(i => i.owner === 'user' && !i.usedAt);
                const used = coupons.items.filter(i => i.owner === 'user' && i.usedAt)
                  .sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0));
                return (
                  <>
                    {unused.length === 0 ? (
                      <div className="text-center py-10">
                        <Ticket size={34} className="mx-auto text-rose-200" />
                        <div className="text-[12px] text-rose-300 mt-3 leading-relaxed">
                          还没有券。<br />去「游戏 → 🏪」用苹果币换。
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {unused.map(item => {
                          const def = couponById(item.defId);
                          if (!def) return null;
                          const meta = categoryOf(def.category);
                          return (
                            <div key={item.id} className="yz-ticket" style={{ borderColor: `${meta.accent}33` }}>
                              <span className="yz-notch left" />
                              <span className="yz-notch right" />
                              <div className="text-[14px] font-black" style={{ color: meta.accent }}>{def.name}</div>
                              <div className="text-[11px] text-slate-500 mt-1 leading-relaxed">{def.desc}</div>
                              <div className="yz-tear" style={{ borderColor: `${meta.accent}33` }} />
                              <div className="flex items-center">
                                <span className="text-[10px] text-slate-400">
                                  {new Date(item.boughtAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} 换的
                                </span>
                                <button
                                  onClick={() => playCoupon(item)}
                                  className="ml-auto text-[12px] font-bold px-3.5 py-1.5 rounded-full flex items-center gap-1 active:scale-95 transition"
                                  style={{ background: meta.soft, color: meta.accent }}
                                >
                                  <PaperPlaneTilt size={12} weight="fill" /> 发给{taName}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {used.length > 0 && (
                      <div className="mt-8">
                        <div className="text-[11px] font-bold text-rose-300 mb-2 px-1">用过的</div>
                        <div className="space-y-1.5">
                          {used.map(item => {
                            const def = couponById(item.defId);
                            if (!def) return null;
                            return (
                              <div key={item.id} className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/50">
                                <span className="text-[12px] text-slate-400 line-through">{def.name}</span>
                                <span className="ml-auto text-[10px] text-rose-200">
                                  {new Date(item.usedAt!).toLocaleDateString()}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <div className="text-[10px] text-rose-300 leading-relaxed mt-8 px-1 text-center">
                      发进聊天框就算用掉了，不能反悔。<br />
                      券是你拿着用的权利，跟藏柜里那些"对方给的东西"是两回事。
                    </div>
                  </>
                );
              })()}
            </div>
          )}
        </div>
      </div>

      {/* 拆开后 / 重看 */}
      {viewing && (
        <div className="absolute inset-0 z-[10] flex items-center justify-center p-6" style={{ background: 'rgba(60,40,45,.45)' }} onClick={() => setViewing(null)}>
          <div className="w-full max-w-sm rounded-3xl bg-[#fffaf9] p-5 shadow-2xl max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <GiftPackage wrap={viewing.wrap} size={36} opened />
              <div className="text-[11px] text-rose-400 font-bold">
                {viewing.from === 'user' ? '我送的' : `${taName}送的`}
              </div>
              <div className="ml-auto text-[10px] text-rose-300">
                {new Date(viewing.createdAt).toLocaleDateString()}
              </div>
            </div>
            {viewing.image && (
              <TokenImg value={viewing.image} className="w-full h-auto rounded-2xl mb-3 object-contain max-h-72" />
            )}
            {viewing.note && (
              <div className="text-[13.5px] leading-[1.9] text-slate-600 whitespace-pre-wrap">{viewing.note}</div>
            )}
            <div className="flex items-center gap-2 mt-5">
              <button onClick={() => setViewing(null)} className="flex-1 py-2 rounded-full text-[12px] font-bold bg-[#fdeef0] text-[#e0767e]">
                收好
              </button>
              <button onClick={() => remove(viewing)} className="w-9 h-9 rounded-full bg-black/5 text-slate-400 flex items-center justify-center">
                <Trash size={14} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default YuZhouGiftPage;
