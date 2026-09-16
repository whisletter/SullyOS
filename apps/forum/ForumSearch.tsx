import React, { useState, useCallback } from 'react';
import { MagnifyingGlass } from '@phosphor-icons/react';
import * as db from '../../utils/forumDb';
import * as feed from '../../utils/forumFeed';
import ForumPostCard from './ForumPostCard';

interface Props {
  onOpenPost: (postId: string) => void;
}

/** [交接5 4.4] 纯本地搜索，不调用 API，覆盖所有还没被三天水线清掉的内容。 */
const ForumSearch: React.FC<Props> = ({ onOpenPost }) => {
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<db.ForumPost[]>([]);
  const [accountsById, setAccountsById] = useState<Map<string, db.ForumAccount>>(new Map());
  const [searched, setSearched] = useState(false);

  const runSearch = useCallback(async () => {
    if (!keyword.trim()) return;
    const posts = await feed.searchLocalPosts(keyword);
    setResults(posts);
    setSearched(true);
    const accounts = await db.getAllForumAccounts();
    setAccountsById(new Map(accounts.map(a => [a.id, a])));
  }, [keyword]);

  return (
    <div className="pb-8">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b" style={{ borderColor: 'rgba(127,127,127,0.15)' }}>
        <MagnifyingGlass size={16} className="opacity-50 shrink-0" />
        <input
          value={keyword}
          onChange={e => setKeyword(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') runSearch(); }}
          placeholder="搜索本地帖子（标题/正文）"
          className="flex-1 min-w-0 bg-transparent outline-none text-sm"
        />
        <button onClick={runSearch} className="text-sm font-bold shrink-0">搜索</button>
      </div>
      {searched && results.length === 0 && <div className="text-center py-16 text-sm opacity-50">没有找到相关内容</div>}
      {results.map(p => (
        <ForumPostCard key={p.id} post={p} author={accountsById.get(p.authorAccountId)} commentCount={0} onClick={() => onOpenPost(p.id)} />
      ))}
    </div>
  );
};

export default ForumSearch;
