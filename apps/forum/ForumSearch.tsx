import React, { useState, useCallback } from 'react';
import { MagnifyingGlass } from '@phosphor-icons/react';
import TokenImg from '../../components/os/TokenImg';
import * as db from '../../utils/forumDb';
import * as feed from '../../utils/forumFeed';
import ForumPostCard from './ForumPostCard';
import ForumRelationButton from './ForumRelationButton';

interface Props {
  activeAccount: db.ForumAccount;
  onOpenPost: (postId: string) => void;
  onOpenProfile: (accountId: string) => void;
}

type Tab = 'posts' | 'users';

const MAX_USER_RESULTS = 30;

/** [交接5 4.4] 纯本地搜索，不调用 API。
 *  帖子标签页覆盖所有还没被三天水线清掉的内容；用户标签页搜全部账号——
 *  双方的大号/小号/共管账号和路人号都搜得到，跟真实社交软件一致。
 *  搜得到不等于认得出，这正是小号玩法的前提。 */
const ForumSearch: React.FC<Props> = ({ activeAccount, onOpenPost, onOpenProfile }) => {
  const [tab, setTab] = useState<Tab>('posts');
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<db.ForumPost[]>([]);
  const [users, setUsers] = useState<db.ForumAccount[]>([]);
  const [accountsById, setAccountsById] = useState<Map<string, db.ForumAccount>>(new Map());
  const [commentCounts, setCommentCounts] = useState<Map<string, number>>(new Map());
  const [searched, setSearched] = useState(false);

  const runSearch = useCallback(async (which: Tab = tab) => {
    const kw = keyword.trim();
    if (!kw) return;

    if (which === 'posts') {
      const posts = await feed.searchLocalPosts(kw);
      setResults(posts);
      const accounts = await db.getAllForumAccounts();
      setAccountsById(new Map(accounts.map(a => [a.id, a])));
      // 搜索结果的评论数原来写死是 0。一次事务批量数，跟主页用同一个函数。
      setCommentCounts(await db.getCommentCountsByPosts(posts.map(p => p.id)));
    } else {
      const lower = kw.toLowerCase();
      const accounts = await db.getAllForumAccounts();
      const matched = accounts.filter(a =>
        a.status === 'active' && (
          a.displayName.toLowerCase().includes(lower)
          || a.handle.toLowerCase().includes(lower)
          || (a.bio || '').toLowerCase().includes(lower)
        )
      );
      setUsers(matched.slice(0, MAX_USER_RESULTS));
    }
    setSearched(true);
  }, [keyword, tab]);

  const switchTab = useCallback((next: Tab) => {
    setTab(next);
    setSearched(false);
    if (keyword.trim()) runSearch(next);
  }, [keyword, runSearch]);

  return (
    <div className="pb-8">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b" style={{ borderColor: 'rgba(127,127,127,0.15)' }}>
        <MagnifyingGlass size={16} className="opacity-50 shrink-0" />
        <input
          value={keyword}
          onChange={e => setKeyword(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') runSearch(); }}
          placeholder={tab === 'posts' ? '搜索帖子（标题/正文）' : '搜索账号（昵称/ID/签名）'}
          className="flex-1 min-w-0 bg-transparent outline-none text-sm"
        />
        <button onClick={() => runSearch()} className="text-sm font-bold shrink-0">搜索</button>
      </div>

      <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: 'rgba(127,127,127,0.1)' }}>
        {([['posts', '帖子'], ['users', '用户']] as [Tab, string][]).map(([id, label]) => {
          const active = tab === id;
          return (
            <button
              key={id}
              onClick={() => switchTab(id)}
              className="text-[13px] px-3 py-1.5 rounded-full"
              style={{
                background: active ? 'rgba(59,130,246,0.14)' : 'rgba(127,127,127,0.1)',
                color: active ? '#3b82f6' : undefined,
                fontWeight: active ? 700 : 400,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {tab === 'posts' && <>
        {searched && results.length === 0 && <div className="text-center py-16 text-sm opacity-50">没有找到相关帖子</div>}
        {results.map(p => (
          <ForumPostCard key={p.id} post={p} author={accountsById.get(p.authorAccountId)} commentCount={commentCounts.get(p.id) || 0} onClick={() => onOpenPost(p.id)} />
        ))}
      </>}

      {tab === 'users' && <>
        {searched && users.length === 0 && <div className="text-center py-16 text-sm opacity-50">没有找到这个账号</div>}
        {users.map(a => (
          <div key={a.id} className="flex items-center gap-3 px-3 py-2.5 border-b" style={{ borderColor: 'rgba(127,127,127,0.1)' }}>
            <button onClick={() => onOpenProfile(a.id)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
              {a.avatar
                ? <TokenImg value={a.avatar} className="w-10 h-10 rounded-full object-cover shrink-0" />
                : <div className="w-10 h-10 rounded-full flex items-center justify-center font-bold shrink-0" style={{ background: 'rgba(127,127,127,0.2)' }}>{a.displayName?.[0] || '?'}</div>}
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm truncate">
                  {a.displayName}
                  {a.isVerified && <span className="text-blue-400 ml-1">✔</span>}
                </div>
                <div className="text-[11px] opacity-50 truncate">@{a.handle}{a.bio ? ` · ${a.bio}` : ''}</div>
              </div>
            </button>
            <ForumRelationButton myAccountId={activeAccount.id} targetAccountId={a.id} compact />
          </div>
        ))}
      </>}
    </div>
  );
};

export default ForumSearch;
