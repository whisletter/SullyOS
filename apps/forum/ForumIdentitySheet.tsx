import React, { useEffect, useState, useCallback } from 'react';
import { X } from '@phosphor-icons/react';
import * as db from '../../utils/forumDb';
import { FORUM_DEFAULTS } from '../../utils/forumConstants';
import { ensureSharedAccount } from '../../utils/forumBootstrap';
import type { CharacterProfile } from '../../types';

interface Props {
  activeAccount: db.ForumAccount;
  characters: CharacterProfile[];
  onSwitch: (accountId: string) => void;
  onClose: () => void;
}

/**
 * [交接5 4.8] "..." 账号切换弹层：主号常驻 + 小号(三态) + 共管账号(存在才显示，
 * 是跳转不是切换) + 注销小号按钮（常驻显示，二次确认，不需要"已被发现"前置条件）。
 */
const ForumIdentitySheet: React.FC<Props> = ({ activeAccount, characters, onSwitch, onClose }) => {
  const [mainAccount, setMainAccount] = useState<db.ForumAccount | null>(null);
  const [altAccount, setAltAccount] = useState<db.ForumAccount | null>(null);
  const [altBudget, setAltBudget] = useState<db.ForumAltBudget | null>(null);
  const [sharedAccounts, setSharedAccounts] = useState<db.ForumAccount[]>([]);
  const [creatingAlt, setCreatingAlt] = useState(false);
  const [altHandle, setAltHandle] = useState('');
  const [confirmingBurn, setConfirmingBurn] = useState(false);
  /** 共管账号建号：一个角色一个号，多角色时先让用户选给谁建。 */
  const [pickingSharedChar, setPickingSharedChar] = useState(false);
  const [creatingShared, setCreatingShared] = useState(false);

  const load = useCallback(async () => {
    const userAccounts = await db.getForumAccountsByOwnerType('user');
    setMainAccount(userAccounts.find(a => !a.isAlt) || null);
    setAltAccount(userAccounts.find(a => a.isAlt && a.status === 'active') || null);
    setAltBudget(await db.getAltBudget('user'));

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
    await load();
  };

  const sharedCharIds = new Set(sharedAccounts.map(a => a.charId).filter(Boolean));
  const charactersWithoutShared = (characters || []).filter(c => c.id && !sharedCharIds.has(c.id));

  const Row: React.FC<{ label: string; sub?: string; active?: boolean; onClick?: () => void; disabled?: boolean }> = ({ label, sub, active, onClick, disabled }) => (
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
      {active && <span className="text-[11px] opacity-60">当前使用中</span>}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative w-full rounded-t-2xl p-4 space-y-3 max-h-[80vh] overflow-y-auto"
        style={{ background: 'inherit' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="font-bold text-base">身份与账号</div>
          <button onClick={onClose} className="p-1"><X size={20} /></button>
        </div>

        {mainAccount && (
          <Row label={`${mainAccount.displayName}（主号）`} active={activeAccount.id === mainAccount.id} onClick={() => onSwitch(mainAccount.id)} />
        )}

        {altAccount ? (
          <Row label={`${altAccount.displayName}（小号）`} active={activeAccount.id === altAccount.id} onClick={() => onSwitch(altAccount.id)} />
        ) : altBudget?.locked ? (
          <Row label="小号已用尽 5 次机会，不可再开" disabled />
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

        {/* 共管账号现在是可以"登录"的身份，不再只是跳转看主页——切过去之后发的帖
            就以这个号的名义出现在论坛上。底层身份解析本来就允许共管号，这里补上入口。 */}
        {sharedAccounts.map(acc => (
          <Row
            key={acc.id}
            label={`${acc.displayName}（共管账号）`}
            sub="切换后以这个号发帖"
            active={activeAccount.id === acc.id}
            onClick={() => onSwitch(acc.id)}
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
                  注销后旧帖保留、显示"已注销用户"，销号次数将变成 {(altBudget?.burnCount || 0) + 1}/{FORUM_DEFAULTS.altBurnCap}。
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
