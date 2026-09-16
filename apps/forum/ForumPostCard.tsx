import React from 'react';
import { Newspaper, Heart } from '@phosphor-icons/react';
import type { ForumAccount, ForumPost } from '../../utils/forumDb';
import { getTopicLabel, type ForumTopicTag } from '../../utils/forumConstants';

interface Props {
  post: ForumPost;
  author?: ForumAccount;
  commentCount: number;
  onClick: () => void;
}

/** 头像兜底：没有 avatar 就用昵称首字，跟项目里其它 App 的图片裂图兜底思路一致
 *  [交接5 4.11]，不引入额外图片资源。 */
const AvatarFallback: React.FC<{ name: string }> = ({ name }) => (
  <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
       style={{ background: 'rgba(127,127,127,0.2)' }}>
    {name?.[0] || '?'}
  </div>
);

const ForumPostCard: React.FC<Props> = ({ post, author, commentCount, onClick }) => {
  return (
    <button onClick={onClick} className="w-full text-left px-3 py-3 border-b active:opacity-70 transition-opacity"
            style={{ borderColor: 'rgba(127,127,127,0.15)' }}>
      <div className="flex gap-2.5">
        {author?.avatar
          ? <img src={author.avatar} className="w-9 h-9 rounded-full object-cover shrink-0" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          : <AvatarFallback name={author?.displayName || '?'} />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-[13px] opacity-70">
            <span className="font-semibold opacity-100">{author?.displayName || '未知账号'}</span>
            {author?.isVerified && <span className="text-blue-400">✔</span>}
            <span>· {getTopicLabel(post.topicTag as ForumTopicTag)}</span>
            {post.postKind === 'news' && (
              <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full"
                    style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>
                <Newspaper size={10} weight="fill" /> News
              </span>
            )}
          </div>
          {post.title && <div className="font-bold text-[15px] mt-0.5 truncate">{post.title}</div>}
          <div className="text-[13px] opacity-80 mt-0.5 line-clamp-2">{post.content}</div>
          <div className="text-[11px] opacity-50 mt-1 flex items-center gap-3">
            <span>{commentCount} 条评论</span>
            {post.likes.length > 0 && (
              <span className="flex items-center gap-0.5"><Heart size={11} weight="fill" />{post.likes.length}</span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
};

export default ForumPostCard;
