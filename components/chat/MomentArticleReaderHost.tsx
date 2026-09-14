/**
 * 聊天框里点开「朋友圈转发卡片」的文章后，挂载的全屏详情页宿主。
 *
 * 为什么单独一个文件、而不是直接在 MessageItem 里 useOS()：
 * MessageItem 是纯 props 组件（整个文件没有任何 context 订阅），聊天列表里
 * 几百条消息同时在场，给它加一个 useOS() 等于让每条消息都订阅全局状态，
 * OS 任何一处变动都会重刷整条列表。这里把 context 订阅关在「详情页打开时
 * 才挂载」的子组件里，同一时间最多只有一个实例在订阅，列表本身不受影响。
 *
 * 职责：只做两件 ArticleReader 不该知道的事 ——
 *   1. 从 OSContext 取 char / userProfile / apiConfig / addToast
 *   2. 把生成好的 fakeComments 写回这条消息的 content
 *
 * 存储形态注意：moment_card 这类消息的数据不在 metadata 里，而是整个
 * momentData 被 JSON.stringify 塞进了 content（见 MomentsApp 的转发逻辑）。
 * 所以这里不能用 DB.updateMessageMetadata，要用 DB.updateMessageContent
 * 读旧 JSON → 改 article → 整体 stringify 存回去。
 */

import React, { useCallback } from 'react';
import { useOS } from '../../context/OSContext';
import { DB } from '../../utils/db';
import ArticleReader from '../moments/ArticleReader';
import type { MomentArticleCard } from '../../utils/momentsDb';

interface MomentArticleReaderHostProps {
  /** 这条 moment_card 消息的 id。缺失时详情页仍可看，只是评论区生成结果不落库。 */
  messageId?: number;
  /** 转发时打包进 content 的 momentData，用来定位是哪个角色的朋友圈。 */
  momentData: any;
  /** 当前正在读的文章（含可能已生成的 fakeComments）。 */
  article: MomentArticleCard;
  onClose: () => void;
  /** 生成完评论后把新 article 回灌给卡片，让详情页当场刷新、不用等重新拉库。 */
  onArticleUpdated: (updated: MomentArticleCard) => void;
}

const MomentArticleReaderHost: React.FC<MomentArticleReaderHostProps> = ({
  messageId,
  momentData,
  article,
  onClose,
  onArticleUpdated,
}) => {
  const { characters, activeCharacterId, userProfile, apiConfig, addToast } = useOS();

  // 转发卡片自带 charId（这条动态属于哪个角色的朋友圈）；旧数据没有就退回当前聊天对象。
  const char =
    characters.find(c => c.id === (momentData?.charId || activeCharacterId)) || null;

  const handleCommentsGenerated = useCallback(
    async (updated: MomentArticleCard) => {
      onArticleUpdated(updated);
      if (typeof messageId !== 'number') return;
      try {
        await DB.updateMessageContent(messageId, (prev: string) => {
          let data: any = {};
          try { data = JSON.parse(prev || '{}'); } catch { data = {}; }
          return JSON.stringify({ ...data, article: updated });
        });
      } catch {
        // 落库失败不拦 UI：评论区这次仍然看得到，只是下次打开要重新生成。
        addToast('评论已生成，但没能保存', 'info');
      }
    },
    [messageId, onArticleUpdated, addToast],
  );

  return (
    <ArticleReader
      article={article}
      onClose={onClose}
      onCommentsGenerated={handleCommentsGenerated}
      char={char}
      userProfile={userProfile}
      apiConfig={apiConfig}
      onToast={addToast}
      zIndex={140}
    />
  );
};

export default MomentArticleReaderHost;
