import React, { useCallback, useEffect, useState } from 'react';
import * as social from '../../utils/forumSocial';
import type { RelationState } from '../../utils/forumSocial';

interface Props {
  myAccountId: string;
  targetAccountId: string;
  /** 紧凑模式：搜索结果那种一行一个的场景，只留主操作，不显示拉黑。 */
  compact?: boolean;
  onChanged?: (state: RelationState) => void;
}

const LABELS: Record<RelationState, string> = {
  self: '这是你',
  none: '加好友',
  outgoing: '已申请',
  incoming: '通过申请',
  friends: '已是好友',
  blocked: '已拉黑',
  blockedBy: '无法添加',
};

/**
 * 关系按钮：加好友 / 已申请 / 通过 / 已是好友 / 拉黑。
 *
 * 好友不影响能不能私信（[用户确认] 跟真实社交软件一样，陌生人也能发），
 * 只有拉黑会断私信。所以这里纯粹是关系管理，不承担权限含义。
 */
const ForumRelationButton: React.FC<Props> = ({ myAccountId, targetAccountId, compact, onChanged }) => {
  const [state, setState] = useState<RelationState | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingBlock, setConfirmingBlock] = useState(false);

  const load = useCallback(async () => {
    setState(await social.getRelationState(myAccountId, targetAccountId));
  }, [myAccountId, targetAccountId]);

  useEffect(() => { load(); }, [load]);

  const apply = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      const next = await social.getRelationState(myAccountId, targetAccountId);
      setState(next);
      onChanged?.(next);
    } finally {
      setBusy(false);
      setConfirmingBlock(false);
    }
  }, [myAccountId, targetAccountId, onChanged]);

  const handleMain = useCallback(() => {
    if (busy || !state) return;
    if (state === 'none') return void apply(() => social.sendFriendRequest(myAccountId, targetAccountId));
    if (state === 'incoming') return void apply(() => social.acceptFriendRequest(targetAccountId, myAccountId));
    if (state === 'friends') return void apply(() => social.removeFriend(myAccountId, targetAccountId));
    if (state === 'blocked') return void apply(() => social.unblockAccount(myAccountId, targetAccountId));
    if (state === 'outgoing') return void apply(() => social.declineFriendRequest(myAccountId, targetAccountId));
  }, [busy, state, apply, myAccountId, targetAccountId]);

  if (!state || state === 'self') return null;

  // 已是好友时主按钮变成"删除好友"，已拉黑时变成"解除拉黑"——按钮文案说明的是
  // 当前状态，点下去的动作写在括号里，不让用户点完才发现干了别的事。
  const mainLabel = busy ? '…'
    : state === 'friends' ? '好友（点击删除）'
    : state === 'blocked' ? '已拉黑（点击解除）'
    : state === 'outgoing' ? '已申请（点击撤回）'
    : LABELS[state];

  const isPrimary = state === 'none' || state === 'incoming';

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <button
        onClick={handleMain}
        disabled={busy || state === 'blockedBy'}
        className="text-[12px] px-3 py-1.5 rounded-full whitespace-nowrap disabled:opacity-40"
        style={{
          background: isPrimary ? '#3b82f6' : 'rgba(127,127,127,0.15)',
          color: isPrimary ? '#fff' : undefined,
        }}
      >
        {mainLabel}
      </button>

      {!compact && state !== 'blocked' && state !== 'blockedBy' && (
        confirmingBlock ? (
          <>
            <button
              onClick={() => apply(() => social.blockAccount(myAccountId, targetAccountId))}
              disabled={busy}
              className="text-[12px] px-3 py-1.5 rounded-full"
              style={{ background: '#ef4444', color: '#fff' }}
            >
              确定拉黑
            </button>
            <button
              onClick={() => setConfirmingBlock(false)}
              className="text-[12px] px-2 py-1.5 rounded-full"
              style={{ background: 'rgba(127,127,127,0.15)' }}
            >
              取消
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirmingBlock(true)}
            className="text-[12px] px-3 py-1.5 rounded-full"
            style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444' }}
          >
            拉黑
          </button>
        )
      )}
    </div>
  );
};

export default ForumRelationButton;
