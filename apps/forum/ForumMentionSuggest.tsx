import React, { useEffect, useMemo, useState } from 'react';
import * as db from '../../utils/forumDb';

/**
 * 输入框里的 @ 补全。
 *
 * 为什么需要它：@ 的判定原来只认 handle（`moss_club` 这种英文串），而界面上
 * 没有任何地方告诉你某个人的 handle 是什么——所以大家打的一直是 `@昵称`，
 * 一次都没匹配上，看起来就像"@ 功能坏了"。判定那边现在昵称也认了，
 * 但真正解决问题的是这个：让你根本不用去记 handle。
 *
 * 用法：受控输入框的 value/onChange 照旧，把 value 和 onChange 也传给这个组件，
 * 它自己判断要不要浮出来。检测的是**光标前最后一个 @ 到现在**这一段，
 * 所以只有你正在打 @ 的时候才出现，打完别的字就自动收起。
 */
interface Props {
  value: string;
  onChange: (next: string) => void;
  /** 排在最前面的账号（TA 的号、这条帖子里出现过的人）。其余的从全部账号里补。 */
  priorityAccountIds?: string[];
  /** 不出现在候选里的账号（通常是你当前用的那个号，@ 自己没意义）。 */
  excludeAccountIds?: string[];
}

/** 取出光标前正在输入的那个 @片段。没有就返回 null。 */
function activeMentionQuery(text: string): { start: number; query: string } | null {
  const at = text.lastIndexOf('@');
  if (at < 0) return null;
  const after = text.slice(at + 1);
  // @ 后面已经出现空白或换行 = 这个 @ 打完了，不再补全
  if (/[\s\n]/.test(after)) return null;
  // 太长了多半不是在选人，是在打别的
  if (after.length > 20) return null;
  return { start: at, query: after };
}

const ForumMentionSuggest: React.FC<Props> = ({ value, onChange, priorityAccountIds, excludeAccountIds }) => {
  const [accounts, setAccounts] = useState<db.ForumAccount[]>([]);

  useEffect(() => {
    let cancelled = false;
    db.getAllForumAccounts()
      .then(list => { if (!cancelled) setAccounts(list.filter(a => a.status === 'active')); })
      .catch(() => { /* 取不到就不补全，不影响打字 */ });
    return () => { cancelled = true; };
  }, []);

  const active = activeMentionQuery(value);

  const candidates = useMemo(() => {
    if (!active) return [];
    const exclude = new Set(excludeAccountIds || []);
    const priority = priorityAccountIds || [];
    const rank = (a: db.ForumAccount) => {
      const i = priority.indexOf(a.id);
      return i < 0 ? priority.length : i;
    };
    const q = active.query.toLowerCase();
    return accounts
      .filter(a => !exclude.has(a.id))
      .filter(a => !q
        || a.handle.toLowerCase().includes(q)
        || a.displayName.toLowerCase().includes(q))
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, 6);
  }, [accounts, active, priorityAccountIds, excludeAccountIds]);

  if (!active || candidates.length === 0) return null;

  /** 选中一个：把 @片段 换成 @handle，后面补个空格，方便接着打字。 */
  const pick = (account: db.ForumAccount) => {
    onChange(`${value.slice(0, active.start)}@${account.handle} `);
  };

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-1 rounded-xl overflow-hidden shadow-lg z-20"
      style={{ background: 'var(--forum-bg, #1A1A1E)', border: '1px solid rgba(127,127,127,0.25)' }}
    >
      {candidates.map(a => (
        <button
          key={a.id}
          onClick={() => pick(a)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left active:opacity-70"
          style={{ borderBottom: '1px solid rgba(127,127,127,0.08)' }}
        >
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold truncate">
              {a.displayName}
              {a.isVerified && <span className="text-blue-400 ml-1">✔</span>}
            </div>
            <div className="text-[11px] opacity-40 truncate">@{a.handle}</div>
          </div>
        </button>
      ))}
      <div className="px-3 py-1.5 text-[10px] opacity-35">点一下插入，@ 的人会在刷新时被叫到</div>
    </div>
  );
};

export default ForumMentionSuggest;
