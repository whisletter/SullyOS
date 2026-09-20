import React, { useEffect, useState, useCallback } from 'react';
import { Lightning, MagnifyingGlass, ArrowLeft, Eye } from '@phosphor-icons/react';
import TokenImg from '../../components/os/TokenImg';
import * as db from '../../utils/forumDb';
import * as ai from '../../utils/forumAi';
import * as social from '../../utils/forumSocial';
import * as suspicion from '../../utils/forumSuspicion';
import { useOS } from '../../context/OSContext';

interface Props {
  activeAccount: db.ForumAccount;
  apiConfig: { baseUrl: string; apiKey: string; model: string };
  /** 当前身份是已注销的号：能翻以前的私信，但不能发、不能触发回复、不能对质。 */
  readOnly?: boolean;
  /** 当前身份被注销了（比如被 TA 质问后选了"承认 + 注销"），让外层切回主号。 */
  onActiveAccountDeactivated?: () => void;
  /** 已读状态变了（点开了某个会话），让外层刷新左侧私信图标和切换面板上的红点。 */
  onUnreadChanged?: () => void;
}

/**
 * [交接2 一 + 交接5 4.6] 论坛内部私信，跟主线1v1聊天物理隔离。
 * 触发方式跟主聊天窗口一样：手动点⚡才会真的调一次模型生成回复，发送消息本身
 * 不自动触发（对应 InstantPushConfig.autoTriggerOnSend 关闭时的手动⚡体验）。
 */
const ForumDm: React.FC<Props> = ({ activeAccount, apiConfig, readOnly, onActiveAccountDeactivated, onUnreadChanged }) => {
  const { addToast, userProfile } = useOS();
  const [threads, setThreads] = useState<{ counterpartAccountId: string; lastMessage: db.ForumDmMessage }[]>([]);
  const [accountsById, setAccountsById] = useState<Map<string, db.ForumAccount>>(new Map());
  const [openCounterpartId, setOpenCounterpartId] = useState<string | null>(null);
  const [messages, setMessages] = useState<db.ForumDmMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [triggering, setTriggering] = useState(false);
  const [confirmingConfront, setConfirmingConfront] = useState(false);
  const [confronting, setConfronting] = useState(false);
  /** TA 已经当面质问过我这个号、我还没表态的那条记录。 */
  const [pendingAccusation, setPendingAccusation] = useState<{ observerKey: string } | null>(null);
  const [admitting, setAdmitting] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pickKeyword, setPickKeyword] = useState('');
  /** 跟我有拉黑关系的账号（任一方向）。拉黑双向断，被拉黑的人也发不过来。 */
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());
  /** 每个会话里对方发来、你还没看的条数。只给你自己看，TA 不知道你读没读。 */
  const [unreadByCounterpart, setUnreadByCounterpart] = useState<Map<string, number>>(new Map());

  const loadThreads = useCallback(async () => {
    const [list, accounts, blocked, unread] = await Promise.all([
      db.getDmThreadsForIdentity(activeAccount.id),
      db.getAllForumAccounts(),
      social.getBlockedCounterparts(activeAccount.id),
      db.getDmUnreadByCounterpart(activeAccount.id),
    ]);
    setThreads(list);
    setUnreadByCounterpart(unread);
    setAccountsById(new Map(accounts.map(a => [a.id, a])));
    setBlockedIds(blocked);

    const accusation = await suspicion.getPendingConfrontationFor(activeAccount.id);
    setPendingAccusation(accusation ? { observerKey: accusation.observerKey } : null);
    setAdmitting(false);
  }, [activeAccount.id]);

  useEffect(() => { loadThreads(); }, [loadThreads]);

  /** 把一个会话标成已读：读到"现在"为止。 */
  const markThreadRead = useCallback(async (counterpartId: string) => {
    await db.setReadMark(db.dmReadKey(activeAccount.id, counterpartId));
    setUnreadByCounterpart(prev => {
      if (!prev.has(counterpartId)) return prev;
      const next = new Map(prev);
      next.delete(counterpartId);
      return next;
    });
    onUnreadChanged?.();
  }, [activeAccount.id, onUnreadChanged]);

  const openThread = useCallback(async (counterpartId: string) => {
    setOpenCounterpartId(counterpartId);
    const msgs = await db.getDmThreadMessages(activeAccount.id, counterpartId);
    setMessages(msgs);
    await markThreadRead(counterpartId);
  }, [activeAccount.id, markThreadRead]);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !openCounterpartId) return;
    // 拉黑后不能再发。这里每次发送都重新查一次而不是只信列表加载时的快照——
    // 用户可能在另一个页面刚拉黑完就回来发消息。
    if (await social.isDmBlocked(activeAccount.id, openCounterpartId)) {
      addToast('你们之间已拉黑，发不出去', 'info');
      return;
    }
    await db.saveForumDmMessage({
      id: db.createForumDmMessageId(), viewerIdentityAccountId: activeAccount.id,
      counterpartAccountId: openCounterpartId, fromAccountId: activeAccount.id,
      content: text, createdAt: Date.now(),
    });
    setInputText('');
    const msgs = await db.getDmThreadMessages(activeAccount.id, openCounterpartId);
    setMessages(msgs);
  }, [inputText, openCounterpartId, activeAccount.id, addToast]);

  const handleTrigger = useCallback(async () => {
    if (!openCounterpartId) return;
    if (!apiConfig?.baseUrl || !apiConfig?.apiKey || !apiConfig?.model) {
      addToast('请先配置 API', 'info');
      return;
    }
    if (await social.isDmBlocked(activeAccount.id, openCounterpartId)) {
      addToast('你们之间已拉黑，对方不会回复', 'info');
      return;
    }
    setTriggering(true);
    try {
      await ai.runDmReply({
        apiConfig,
        viewerIdentityAccountId: activeAccount.id,
        counterpartAccountId: openCounterpartId,
        // 名字只有在 TA 已经认出"这个号就是本人"时才会被用上，遮罩层里判断
        userDisplayName: userProfile?.name,
      });
      const msgs = await db.getDmThreadMessages(activeAccount.id, openCounterpartId);
      setMessages(msgs);
      // 回复是在你开着这个会话的时候到的，当场就算看过了
      await markThreadRead(openCounterpartId);
      await loadThreads();
    } catch (e: any) {
      addToast(`触发失败: ${e?.message?.slice(0, 60) || '未知错误'}`, 'error');
    } finally {
      setTriggering(false);
    }
  }, [openCounterpartId, apiConfig, activeAccount.id, addToast, loadThreads, userProfile, markThreadRead]);

  /**
   * 当面对质："我觉得这个号是你的小号"。
   *
   * 认不认由对方自己决定，路人号在生成层就被锁死不可能认领。所以挨个指认所有账号
   * 是无效策略——否认从外面看长得都一样，只有承认才是信号。
   */
  const handleConfront = useCallback(async () => {
    if (!openCounterpartId) return;
    if (!apiConfig?.baseUrl || !apiConfig?.apiKey || !apiConfig?.model) {
      addToast('请先配置 API', 'info');
      return;
    }
    setConfirmingConfront(false);
    setConfronting(true);
    try {
      const result = await ai.runAltConfrontation({
        apiConfig,
        accuserAccountId: activeAccount.id,
        targetAccountId: openCounterpartId,
        userDisplayName: userProfile?.name,
      });
      const msgs = await db.getDmThreadMessages(activeAccount.id, openCounterpartId);
      setMessages(msgs);
      await loadThreads();

      if (result.admitted) {
        addToast(result.keptAccount ? '对方承认了，并且打算继续用这个号' : '对方承认了，并注销了这个号', 'success');
      } else {
        addToast('对方没认', 'info');
      }
    } catch (e: any) {
      addToast(`对质失败: ${e?.message?.slice(0, 60) || '未知错误'}`, 'error');
    } finally {
      setConfronting(false);
    }
  }, [openCounterpartId, apiConfig, activeAccount.id, userProfile, addToast, loadThreads]);

  /**
   * 回应 TA 的质问。承认与否、承认之后留不留这个号，都由用户自己点——
   * 跟"你指认 TA"那边由 TA 自己决定是对称的。
   */
  const handleAnswerAccusation = useCallback(async (admit: boolean, keep?: boolean) => {
    if (!pendingAccusation) return;
    setAnswering(true);
    try {
      if (!admit) {
        await suspicion.markDenied(pendingAccusation.observerKey, activeAccount.id);
        addToast('你否认了', 'info');
      } else {
        await suspicion.markAdmitted(
          pendingAccusation.observerKey, activeAccount, keep ? 'kept' : 'burned',
        );
        addToast(keep ? '你承认了，这个号继续用' : '你承认了，并注销了这个号', 'success');
        if (!keep) {
          // 注销的正是当前在用的号：切回主号。想回看记录，从切换面板"已注销的号"进去。
          setPendingAccusation(null);
          setAdmitting(false);
          onActiveAccountDeactivated?.();
          return;
        }
      }
      setPendingAccusation(null);
      setAdmitting(false);
      await loadThreads();
    } finally {
      setAnswering(false);
    }
  }, [pendingAccusation, activeAccount, addToast, loadThreads, onActiveAccountDeactivated]);

  // ── 聊天窗口 ──
  if (openCounterpartId) {
    const counterpart = accountsById.get(openCounterpartId);
    return (
      <div className="pb-20 flex flex-col h-full">
        <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: 'rgba(127,127,127,0.15)' }}>
          <button onClick={() => setOpenCounterpartId(null)} className="p-1"><ArrowLeft size={18} /></button>
          <span className="font-semibold text-sm">{counterpart?.displayName || '未知账号'}</span>
          {!readOnly && <button
            onClick={() => setConfirmingConfront(true)}
            disabled={confronting}
            className="ml-auto flex items-center gap-1 text-[12px] px-2.5 py-1 rounded-full disabled:opacity-40"
            style={{ background: 'rgba(127,127,127,0.12)' }}
            title="指认这个号是小号"
          >
            <Eye size={13} />
            {confronting ? '等回话…' : '当面对质'}
          </button>}
        </div>

        {/* TA 已经把话挑明了，等你表态。只在质问你的那个角色的会话里显示。 */}
        {!readOnly && pendingAccusation && counterpart?.charId === pendingAccusation.observerKey && (
          <div className="px-3 py-2.5 text-sm space-y-2 border-b" style={{ background: 'rgba(250,204,21,0.12)', borderColor: 'rgba(127,127,127,0.15)' }}>
            {!admitting ? (
              <>
                <div>对方在质问这个号是不是你的小号。</div>
                <div className="flex gap-2">
                  <button onClick={() => setAdmitting(true)} disabled={answering} className="px-3 py-1.5 rounded-full text-xs font-bold" style={{ background: '#3b82f6', color: '#fff' }}>承认</button>
                  <button onClick={() => handleAnswerAccusation(false)} disabled={answering} className="px-3 py-1.5 rounded-full text-xs" style={{ background: 'rgba(127,127,127,0.15)' }}>否认</button>
                </div>
              </>
            ) : (
              <>
                <div>承认了。这个号还要吗？</div>
                <div className="flex gap-2">
                  <button onClick={() => handleAnswerAccusation(true, true)} disabled={answering} className="px-3 py-1.5 rounded-full text-xs font-bold" style={{ background: '#3b82f6', color: '#fff' }}>继续用</button>
                  <button onClick={() => handleAnswerAccusation(true, false)} disabled={answering} className="px-3 py-1.5 rounded-full text-xs" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>注销这个号</button>
                  <button onClick={() => setAdmitting(false)} disabled={answering} className="px-3 py-1.5 rounded-full text-xs" style={{ background: 'rgba(127,127,127,0.15)' }}>返回</button>
                </div>
              </>
            )}
          </div>
        )}

        {confirmingConfront && (
          <div className="px-3 py-2.5 text-sm space-y-2 border-b" style={{ background: 'rgba(59,130,246,0.08)', borderColor: 'rgba(127,127,127,0.15)' }}>
            <div>要当面指认「{counterpart?.displayName}」是小号吗？对方认不认由他自己决定。</div>
            <div className="flex gap-2">
              <button onClick={handleConfront} className="px-3 py-1.5 rounded-full text-xs font-bold" style={{ background: '#3b82f6', color: '#fff' }}>指认</button>
              <button onClick={() => setConfirmingConfront(false)} className="px-3 py-1.5 rounded-full text-xs" style={{ background: 'rgba(127,127,127,0.15)' }}>算了</button>
            </div>
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
          {messages.map(m => {
            const mine = m.fromAccountId === activeAccount.id;
            return (
              <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div className="max-w-[75%] px-3 py-2 rounded-2xl text-sm" style={{ background: mine ? '#3b82f6' : 'rgba(127,127,127,0.15)', color: mine ? '#fff' : 'inherit' }}>
                  {m.content}
                </div>
              </div>
            );
          })}
        </div>
        {readOnly ? (
          <div className="px-3 py-3 text-center text-[12px] opacity-50 border-t" style={{ borderColor: 'rgba(127,127,127,0.15)' }}>
            这个号已注销，只能查看以前的记录
          </div>
        ) : blockedIds.has(openCounterpartId) ? (
          <div className="px-3 py-3 text-center text-[12px] opacity-50 border-t" style={{ borderColor: 'rgba(127,127,127,0.15)' }}>
            你们之间已拉黑，无法继续私信
          </div>
        ) : (
        <div className="flex items-center gap-2 px-3 py-2 border-t" style={{ borderColor: 'rgba(127,127,127,0.15)' }}>
          <input
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSend(); }}
            placeholder="发消息…（发了也不会自动回复，点⚡才触发）"
            className="flex-1 min-w-0 px-3 py-2 rounded-full text-sm outline-none"
            style={{ background: 'rgba(127,127,127,0.12)' }}
          />
          <button onClick={handleSend} className="text-sm font-bold px-2 shrink-0">发送</button>
          <button
            onClick={handleTrigger}
            disabled={triggering}
            className="p-2 rounded-full shrink-0 disabled:opacity-40"
            style={{ background: 'rgba(250,204,21,0.2)' }}
            title="触发对方回复"
          >
            <Lightning size={18} weight="fill" className={triggering ? 'animate-pulse' : ''} />
          </button>
        </div>
        )}
      </div>
    );
  }

  // ── 会话列表（[交接5 4.6] 参考 Launcher 角色列表：头像+最后一条消息预览+时间戳）──
  return (
    <div className="pb-8">
      <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: 'rgba(127,127,127,0.15)' }}>
        <span className="font-bold text-sm">私信</span>
        {!readOnly && <button onClick={() => setPicking(true)} className="text-sm px-3 py-1 rounded-full" style={{ background: 'rgba(127,127,127,0.12)' }}>+ 新对话</button>}
      </div>

      {picking && (
        <NewDmPicker
          currentAccounts={accountsById}
          selfAccountId={activeAccount.id}
          blockedIds={blockedIds}
          keyword={pickKeyword}
          onKeywordChange={setPickKeyword}
          onPick={async id => { setPicking(false); setPickKeyword(''); await openThread(id); }}
          onClose={() => setPicking(false)}
        />
      )}

      {threads.length === 0 && <div className="text-center py-16 text-sm opacity-50">还没有私信</div>}
      {threads.map(t => {
        const counterpart = accountsById.get(t.counterpartAccountId);
        const unread = unreadByCounterpart.get(t.counterpartAccountId) || 0;
        return (
          <button key={t.counterpartAccountId} onClick={() => openThread(t.counterpartAccountId)} className="w-full flex items-center gap-3 px-3 py-3 border-b text-left" style={{ borderColor: 'rgba(127,127,127,0.1)' }}>
            {counterpart?.avatar
              ? <TokenImg value={counterpart.avatar} className="w-11 h-11 rounded-full object-cover" />
              : <div className="w-11 h-11 rounded-full flex items-center justify-center font-bold" style={{ background: 'rgba(127,127,127,0.2)' }}>{counterpart?.displayName?.[0]}</div>}
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm">{counterpart?.displayName || '未知账号'}</div>
              <div className={`text-[12px] truncate ${unread > 0 ? 'opacity-90 font-medium' : 'opacity-60'}`}>{t.lastMessage.content}</div>
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              <div className="text-[11px] opacity-40">{new Date(t.lastMessage.createdAt).toLocaleDateString()}</div>
              {unread > 0 && (
                <span className="min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center"
                      style={{ background: '#ef4444', color: '#fff' }}>
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
};

const NewDmPicker: React.FC<{
  currentAccounts: Map<string, db.ForumAccount>;
  selfAccountId: string;
  blockedIds: Set<string>;
  keyword: string;
  onKeywordChange: (v: string) => void;
  onPick: (accountId: string) => void;
  onClose: () => void;
}> = ({ currentAccounts, selfAccountId, blockedIds, keyword, onKeywordChange, onPick, onClose }) => {
  // 只排除"当前这个身份自己"和拉黑对象。用户的其它号（主号↔小号）照常可以互发，
  // 跟真实社交软件一致 [用户确认]。
  const list = Array.from(currentAccounts.values()).filter(a =>
    a.id !== selfAccountId && a.status === 'active' && !blockedIds.has(a.id)
    && (!keyword.trim() || a.displayName.includes(keyword) || a.handle.includes(keyword))
  );
  return (
    <div className="px-3 py-2 border-b" style={{ borderColor: 'rgba(127,127,127,0.15)' }}>
      <div className="flex items-center gap-2 mb-2">
        <MagnifyingGlass size={14} className="opacity-50" />
        <input value={keyword} onChange={e => onKeywordChange(e.target.value)} placeholder="搜索账号" className="flex-1 bg-transparent outline-none text-sm" />
        <button onClick={onClose} className="text-sm opacity-50">取消</button>
      </div>
      <div className="max-h-48 overflow-y-auto space-y-1">
        {list.slice(0, 30).map(a => (
          <button key={a.id} onClick={() => onPick(a.id)} className="w-full text-left px-2 py-1.5 rounded-lg text-sm" style={{ background: 'rgba(127,127,127,0.08)' }}>
            {a.displayName} <span className="opacity-40">@{a.handle}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default ForumDm;
