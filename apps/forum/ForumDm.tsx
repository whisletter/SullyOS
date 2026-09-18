import React, { useEffect, useState, useCallback } from 'react';
import { Lightning, MagnifyingGlass, ArrowLeft } from '@phosphor-icons/react';
import TokenImg from '../../components/os/TokenImg';
import * as db from '../../utils/forumDb';
import * as ai from '../../utils/forumAi';
import * as social from '../../utils/forumSocial';
import { useOS } from '../../context/OSContext';

interface Props {
  activeAccount: db.ForumAccount;
  apiConfig: { baseUrl: string; apiKey: string; model: string };
}

/**
 * [交接2 一 + 交接5 4.6] 论坛内部私信，跟主线1v1聊天物理隔离。
 * 触发方式跟主聊天窗口一样：手动点⚡才会真的调一次模型生成回复，发送消息本身
 * 不自动触发（对应 InstantPushConfig.autoTriggerOnSend 关闭时的手动⚡体验）。
 */
const ForumDm: React.FC<Props> = ({ activeAccount, apiConfig }) => {
  const { addToast } = useOS();
  const [threads, setThreads] = useState<{ counterpartAccountId: string; lastMessage: db.ForumDmMessage }[]>([]);
  const [accountsById, setAccountsById] = useState<Map<string, db.ForumAccount>>(new Map());
  const [openCounterpartId, setOpenCounterpartId] = useState<string | null>(null);
  const [messages, setMessages] = useState<db.ForumDmMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [triggering, setTriggering] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pickKeyword, setPickKeyword] = useState('');
  /** 跟我有拉黑关系的账号（任一方向）。拉黑双向断，被拉黑的人也发不过来。 */
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());

  const loadThreads = useCallback(async () => {
    const [list, accounts, blocked] = await Promise.all([
      db.getDmThreadsForIdentity(activeAccount.id),
      db.getAllForumAccounts(),
      social.getBlockedCounterparts(activeAccount.id),
    ]);
    setThreads(list);
    setAccountsById(new Map(accounts.map(a => [a.id, a])));
    setBlockedIds(blocked);
  }, [activeAccount.id]);

  useEffect(() => { loadThreads(); }, [loadThreads]);

  const openThread = useCallback(async (counterpartId: string) => {
    setOpenCounterpartId(counterpartId);
    const msgs = await db.getDmThreadMessages(activeAccount.id, counterpartId);
    setMessages(msgs);
  }, [activeAccount.id]);

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
      await ai.runDmReply({ apiConfig, viewerIdentityAccountId: activeAccount.id, counterpartAccountId: openCounterpartId });
      const msgs = await db.getDmThreadMessages(activeAccount.id, openCounterpartId);
      setMessages(msgs);
      await loadThreads();
    } catch (e: any) {
      addToast(`触发失败: ${e?.message?.slice(0, 60) || '未知错误'}`, 'error');
    } finally {
      setTriggering(false);
    }
  }, [openCounterpartId, apiConfig, activeAccount.id, addToast, loadThreads]);

  // ── 聊天窗口 ──
  if (openCounterpartId) {
    const counterpart = accountsById.get(openCounterpartId);
    return (
      <div className="pb-20 flex flex-col h-full">
        <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: 'rgba(127,127,127,0.15)' }}>
          <button onClick={() => setOpenCounterpartId(null)} className="p-1"><ArrowLeft size={18} /></button>
          <span className="font-semibold text-sm">{counterpart?.displayName || '未知账号'}</span>
        </div>
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
        {blockedIds.has(openCounterpartId) ? (
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
        <button onClick={() => setPicking(true)} className="text-sm px-3 py-1 rounded-full" style={{ background: 'rgba(127,127,127,0.12)' }}>+ 新对话</button>
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
        return (
          <button key={t.counterpartAccountId} onClick={() => openThread(t.counterpartAccountId)} className="w-full flex items-center gap-3 px-3 py-3 border-b text-left" style={{ borderColor: 'rgba(127,127,127,0.1)' }}>
            {counterpart?.avatar
              ? <TokenImg value={counterpart.avatar} className="w-11 h-11 rounded-full object-cover" />
              : <div className="w-11 h-11 rounded-full flex items-center justify-center font-bold" style={{ background: 'rgba(127,127,127,0.2)' }}>{counterpart?.displayName?.[0]}</div>}
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm">{counterpart?.displayName || '未知账号'}</div>
              <div className="text-[12px] opacity-60 truncate">{t.lastMessage.content}</div>
            </div>
            <div className="text-[11px] opacity-40 shrink-0">{new Date(t.lastMessage.createdAt).toLocaleDateString()}</div>
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
