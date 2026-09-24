import React, { useEffect, useState, useCallback } from 'react';
import { X } from '@phosphor-icons/react';
import * as db from '../../utils/forumDb';
import { FORUM_DEFAULTS } from '../../utils/forumConstants';
import { ensureSharedAccount } from '../../utils/forumBootstrap';
import { canOpenAlt, ALT_REOPEN_COOLDOWN_MS, type AltOpenability } from '../../utils/forumSuspicion';
import type { CharacterProfile } from '../../types';

interface Props {
  activeAccount: db.ForumAccount;
  characters: CharacterProfile[];
  onSwitch: (accountId: string) => void;
  onClose: () => void;
  /** 每个号没看的私信条数，有的话在那一行标出来，提醒你切过去看。 */
  dmUnreadByAccount?: Map<string, number>;
}

/**
 * [交接5 4.8] "..." 账号切换弹层：主号常驻 + 小号(三态) + 共管账号(存在才显示，
 * 是跳转不是切换) + 注销小号按钮（常驻显示，二次确认，不需要"已被发现"前置条件）。
 */
const ForumIdentitySheet: React.FC<Props> = ({ activeAccount, characters, onSwitch, onClose, dmUnreadByAccount }) => {
  const unreadOf = (id: string) => dmUnreadByAccount?.get(id) || 0;
  const [mainAccount, setMainAccount] = useState<db.ForumAccount | null>(null);
  const [altAccount, setAltAccount] = useState<db.ForumAccount | null>(null);
  /** 注销掉的小号：还能进去看以前的私信/主页/好友，但只能看不能发。 */
  const [burnedAlts, setBurnedAlts] = useState<db.ForumAccount[]>([]);
  const [altBudget, setAltBudget] = useState<db.ForumAltBudget | null>(null);
  const [sharedAccounts, setSharedAccounts] = useState<db.ForumAccount[]>([]);
  const [creatingAlt, setCreatingAlt] = useState(false);
  const [altHandle, setAltHandle] = useState('');
  const [confirmingBurn, setConfirmingBurn] = useState(false);
  /** 共管账号建号：一个角色一个号，多角色时先让用户选给谁建。 */
  const [pickingSharedChar, setPickingSharedChar] = useState(false);
  const [creatingShared, setCreatingShared] = useState(false);
  const [altOpenable, setAltOpenable] = useState<AltOpenability>({ allowed: true });

  const load = useCallback(async () => {
    const userAccounts = await db.getForumAccountsByOwnerType('user');
    setMainAccount(userAccounts.find(a => !a.isAlt) || null);
    setAltAccount(userAccounts.find(a => a.isAlt && a.status === 'active') || null);
    setBurnedAlts(
      userAccounts.filter(a => a.isAlt && a.status === 'deactivated').sort((a, b) => b.updatedAt - a.updatedAt)
    );
    setAltBudget(await db.getAltBudget('user'));
    // 掉马注销之后有冷却期，跟角色那边同一套规则
    setAltOpenable(await canOpenAlt({ type: 'user' }, userAccounts));

    const shared: db.ForumAccount[] = [];
    for (const char of characters) {
      if (!char.id) continue;
      const acc = await db.getForumAccount(`facc_shared_${char.id}`);
      if (acc) shared.push(acc);
    }
    setSharedAccounts(shared);
  }, [characters]);

  useEffect(() => { load(); }, [load]);

  const handleCreateAlt = async () => {
    if (!altHandle.trim()) return;
    const now = Date.now();
    const account: db.ForumAccount = {
      id: db.createForumAccountId(), ownerType: 'user', isAlt: true,
      handle: altHandle.trim(), displayName: altHandle.trim(), status: 'active',
      createdAt: now, updatedAt: now,
    };
    await db.saveForumAccount(account);
    setCreatingAlt(false);
    setAltHandle('');
    await load();
  };

  /** [用户确认] 直接在切换账号这里建，不走"加好友邀请共管"那套流程。 */
  const handleCreateShared = async (char: CharacterProfile) => {
    if (!char.id) return;
    setCreatingShared(true);
    try {
      await ensureSharedAccount(char.id, `${char.name}和我`, char.avatar);
      setPickingSharedChar(false);
      await load();
    } finally {
      setCreatingShared(false);
    }
  };

  const handleBurnAlt = async () => {
    if (!altAccount || !altBudget) return;
    await db.saveForumAccount({ ...altAccount, status: 'deactivated', updatedAt: Date.now() });
    const nextCount = altBudget.burnCount + 1;
    await db.saveAltBudget({ ...altBudget, burnCount: nextCount, locked: nextCount >= FORUM_DEFAULTS.altBurnCap });
    setConfirmingBurn(false);
    // 注销的正是当前在用的号：自动切回主号，不然你还"登录"在一个已注销的号上。
    // （想回看它以前的记录，从下面"已注销的号"里点进去，只读。）
    if (activeAccount.id === altAccount.id && mainAccount) {
      onSwitch(mainAccount.id);
      return;
    }
    await load();
  };

  const sharedCharIds = new Set(sharedAccounts.map(a => a.charId).filter(Boolean));
  const charactersWithoutShared = (characters || []).filter(c => c.id && !sharedCharIds.has(c.id));

  const Row: React.FC<{ label: string; sub?: string; active?: boolean; onClick?: () => void; disabled?: boolean; unread?: number }> = ({ label, sub, active, onClick, disabled, unread }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center justify-between px-4 py-3 rounded-xl text-left disabled:opacity-40"
      style={{ background: active ? 'rgba(59,130,246,0.12)' : 'rgba(127,127,127,0.08)' }}
    >
      <div>
        <div className="font-semibold text-sm">{label}</div>
        {sub && <div className="text-[11px] opacity-50 mt-0.5">{sub}</div>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {!!unread && unread > 0 && (
          <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: '#ef4444', color: '#fff' }}>
            {unread > 99 ? '99+' : unread} 条新私信
          </span>
        )}
        {active && <span className="text-[11px] opacity-60">当前使用中</span>}
      </div>
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      {/* 面板背景原来是 inherit，父级是透明遮罩层，于是整块面板都透着底下的页面。
          改成根节点挂的主题变量，拿到当前深浅色的实色；底部补安全区内边距。 */}
      <div
        className="relative w-full rounded-t-2xl p-4 space-y-3 max-h-[80vh] overflow-y-auto"
        style={{
          background: 'var(--forum-bg, #1A1A1E)',
          color: 'var(--forum-text, inherit)',
          paddingBottom: 'calc(var(--safe-bottom, 0px) + 16px)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="font-bold text-base">身份与账号</div>
          <button onClick={onClose} className="p-1"><X size={20} /></button>
        </div>

        {mainAccount && (
          <Row label={`${mainAccount.displayName}（主号）`} active={activeAccount.id === mainAccount.id} onClick={() => onSwitch(mainAccount.id)} unread={unreadOf(mainAccount.id)} />
        )}

        {altAccount ? (
          <Row label={`${altAccount.displayName}（小号）`} active={activeAccount.id === altAccount.id} onClick={() => onSwitch(altAccount.id)} unread={unreadOf(altAccount.id)} />
        ) : !altOpenable.allowed ? (
          <Row label={altOpenable.reason || '现在不能开新小号'} disabled />
        ) : creatingAlt ? (
          <div className="px-4 py-3 rounded-xl space-y-2" style={{ background: 'rgba(127,127,127,0.08)' }}>
            <input
              value={altHandle}
              onChange={e => setAltHandle(e.target.value)}
              placeholder="给小号起个名字"
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: 'rgba(127,127,127,0.12)' }}
            />
            <div className="flex gap-2">
              <button onClick={handleCreateAlt} className="text-sm px-3 py-1.5 rounded-full" style={{ background: '#3b82f6', color: '#fff' }}>创建</button>
              <button onClick={() => setCreatingAlt(false)} className="text-sm px-3 py-1.5 rounded-full" style={{ background: 'rgba(127,127,127,0.15)' }}>取消</button>
            </div>
          </div>
        ) : (
          <Row label="+ 创建新小号" onClick={() => setCreatingAlt(true)} />
        )}

        {burnedAlts.length > 0 && (
          <div className="space-y-2">
            <div className="text-[12px] opacity-50 px-1 pt-1">已注销的号（进去只能看以前的记录，不能发东西）</div>
            {burnedAlts.map(acc => (
              <Row
                key={acc.id}
                label={`${acc.displayName}（已注销）`}
                sub="只读"
                active={activeAccount.id === acc.id}
                onClick={() => onSwitch(acc.id)}
                unread={unreadOf(acc.id)}
              />
            ))}
          </div>
        )}

        {/* 共管账号现在是可以"登录"的身份，不再只是跳转看主页——切过去之后发的帖
            就以这个号的名义出现在论坛上。底层身份解析本来就允许共管号，这里补上入口。 */}
        {sharedAccounts.map(acc => (
          <Row
            key={acc.id}
            label={`${acc.displayName}（共管账号）`}
            sub="切换后以这个号发帖"
            active={activeAccount.id === acc.id}
            onClick={() => onSwitch(acc.id)}
            unread={unreadOf(acc.id)}
          />
        ))}

        {charactersWithoutShared.length > 0 && (
          pickingSharedChar ? (
            <div className="px-4 py-3 rounded-xl space-y-2" style={{ background: 'rgba(127,127,127,0.08)' }}>
              <div className="text-[12px] opacity-60">给哪个角色建共管账号？</div>
              {charactersWithoutShared.map(char => (
                <button
                  key={char.id}
                  onClick={() => handleCreateShared(char)}
                  disabled={creatingShared}
                  className="w-full text-left px-3 py-2 rounded-lg text-sm disabled:opacity-40"
                  style={{ background: 'rgba(127,127,127,0.12)' }}
                >
                  {char.name}
                </button>
              ))}
              <button onClick={() => setPickingSharedChar(false)} className="text-sm opacity-50">取消</button>
            </div>
          ) : (
            <Row
              label="+ 创建共管账号"
              sub="你和TA共用一个号，双方都能用它发帖"
              onClick={() => {
                // 只有一个角色就别多问一步，直接建
                if (charactersWithoutShared.length === 1) handleCreateShared(charactersWithoutShared[0]);
                else setPickingSharedChar(true);
              }}
            />
          )
        )}

        {altAccount && (
          <div className="pt-2">
            {!confirmingBurn ? (
              <button onClick={() => setConfirmingBurn(true)} className="text-sm px-4 py-2 rounded-full" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>
                注销小号
              </button>
            ) : (
              <div className="text-sm space-y-2">
                <div className="opacity-70">
                  注销后旧帖保留、显示"已注销用户"，以后还能进去看以前的记录（只读）。
                  销号次数将变成 {(altBudget?.burnCount || 0) + 1}/{FORUM_DEFAULTS.altBurnCap}，
                  而且注销后 {Math.round(ALT_REOPEN_COOLDOWN_MS / 86_400_000)} 天内不能开新小号。
                </div>
                <div className="flex gap-2">
                  <button onClick={handleBurnAlt} className="px-4 py-2 rounded-full" style={{ background: '#ef4444', color: '#fff' }}>确定注销</button>
                  <button onClick={() => setConfirmingBurn(false)} className="px-4 py-2 rounded-full" style={{ background: 'rgba(127,127,127,0.15)' }}>取消</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ForumIdentitySheet;
