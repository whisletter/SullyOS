import React, { useCallback, useEffect, useState } from 'react';
import TokenImg from '../../components/os/TokenImg';
import * as db from '../../utils/forumDb';
import * as social from '../../utils/forumSocial';

interface Props {
  activeAccount: db.ForumAccount;
  onOpenProfile: (accountId: string) => void;
}

type Tab = 'friends' | 'requests' | 'blocked';

const TABS: { id: Tab; label: string }[] = [
  { id: 'friends', label: '好友' },
  { id: 'requests', label: '申请' },
  { id: 'blocked', label: '黑名单' },
];

/**
 * 好友页。关系是挂在"当前使用中的身份"上的——主号和小号各有各的好友列表，
 * 切身份就换一套人际关系，这是小号玩法成立的前提（用小号加的人，主号那边看不到）。
 */
const ForumFriends: React.FC<Props> = ({ activeAccount, onOpenProfile }) => {
  const [tab, setTab] = useState<Tab>('friends');
  const [friends, setFriends] = useState<db.ForumAccount[]>([]);
  const [requests, setRequests] = useState<db.ForumAccount[]>([]);
  const [blocked, setBlocked] = useState<db.ForumAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [f, r, b] = await Promise.all([
        social.getFriendAccounts(activeAccount.id),
        social.getIncomingRequests(activeAccount.id),
        social.getBlockedAccounts(activeAccount.id),
      ]);
      setFriends(f);
      setRequests(r);
      setBlocked(b);
    } finally {
      setLoading(false);
    }
  }, [activeAccount.id]);

  useEffect(() => { load(); }, [load]);

  const act = useCallback(async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id);
    try { await fn(); await load(); } finally { setBusyId(null); }
  }, [load]);

  const Row: React.FC<{ account: db.ForumAccount; actions: React.ReactNode }> = ({ account, actions }) => (
    <div className="flex items-center gap-3 px-3 py-2.5 border-b" style={{ borderColor: 'rgba(127,127,127,0.1)' }}>
      <button onClick={() => onOpenProfile(account.id)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
        {account.avatar
          ? <TokenImg value={account.avatar} className="w-10 h-10 rounded-full object-cover shrink-0" />
          : <div className="w-10 h-10 rounded-full flex items-center justify-center font-bold shrink-0" style={{ background: 'rgba(127,127,127,0.2)' }}>{account.displayName?.[0] || '?'}</div>}
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm truncate">
            {account.displayName}
            {account.isVerified && <span className="text-blue-400 ml-1">✔</span>}
          </div>
          <div className="text-[11px] opacity-50 truncate">@{account.handle}</div>
        </div>
      </button>
      <div className="shrink-0 flex items-center gap-1.5">{actions}</div>
    </div>
  );

  const SmallBtn: React.FC<{ label: string; onClick: () => void; danger?: boolean; primary?: boolean; disabled?: boolean }> =
    ({ label, onClick, danger, primary, disabled }) => (
      <button
        onClick={onClick}
        disabled={disabled}
        className="text-[12px] px-3 py-1.5 rounded-full whitespace-nowrap disabled:opacity-40"
        style={{
          background: primary ? '#3b82f6' : danger ? 'rgba(239,68,68,0.12)' : 'rgba(127,127,127,0.15)',
          color: primary ? '#fff' : danger ? '#ef4444' : undefined,
        }}
      >
        {label}
      </button>
    );

  const current = tab === 'friends' ? friends : tab === 'requests' ? requests : blocked;
  const emptyText = tab === 'friends' ? '还没有好友，去搜索里找人加'
    : tab === 'requests' ? '没有待处理的申请'
    : '黑名单是空的';

  return (
    <div className="pb-8">
      <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: 'rgba(127,127,127,0.15)' }}>
        {TABS.map(t => {
          const active = tab === t.id;
          const badge = t.id === 'requests' && requests.length > 0 ? ` ${requests.length}` : '';
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="text-[13px] px-3 py-1.5 rounded-full"
              style={{
                background: active ? 'rgba(59,130,246,0.14)' : 'rgba(127,127,127,0.1)',
                color: active ? '#3b82f6' : undefined,
                fontWeight: active ? 700 : 400,
              }}
            >
              {t.label}{badge}
            </button>
          );
        })}
        <span className="ml-auto text-[11px] opacity-40 truncate">当前身份 @{activeAccount.handle}</span>
      </div>

      {loading && <div className="text-center py-16 text-sm opacity-50">加载中…</div>}
      {!loading && current.length === 0 && <div className="text-center py-16 text-sm opacity-50">{emptyText}</div>}

      {!loading && tab === 'friends' && friends.map(a => (
        <Row key={a.id} account={a} actions={
          <SmallBtn label="删除" danger disabled={busyId === a.id}
                    onClick={() => act(a.id, () => social.removeFriend(activeAccount.id, a.id))} />
        } />
      ))}

      {!loading && tab === 'requests' && requests.map(a => (
        <Row key={a.id} account={a} actions={<>
          <SmallBtn label="通过" primary disabled={busyId === a.id}
                    onClick={() => act(a.id, () => social.acceptFriendRequest(a.id, activeAccount.id))} />
          <SmallBtn label="拒绝" disabled={busyId === a.id}
                    onClick={() => act(a.id, () => social.declineFriendRequest(a.id, activeAccount.id))} />
        </>} />
      ))}

      {!loading && tab === 'blocked' && blocked.map(a => (
        <Row key={a.id} account={a} actions={
          <SmallBtn label="解除拉黑" disabled={busyId === a.id}
                    onClick={() => act(a.id, () => social.unblockAccount(activeAccount.id, a.id))} />
        } />
      ))}
    </div>
  );
};

export default ForumFriends;
