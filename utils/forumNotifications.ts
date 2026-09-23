/**
 * 论坛 · 通知的派生与已读状态
 *
 * 没有专门的通知表，通知是从"评论"现算出来的派生视图 [交接5 4.5]：别人（路人 NPC
 * 或 TA）回复了你方账号的帖子或评论，就算一条通知。这里把这套推导从页面组件里抽出来，
 * 因为 App 外壳也要用它算未读角标，两边必须是同一套口径，不然角标和列表会对不上。
 *
 * 性能上跟原来的差别：原来是把库里所有帖子拉出来、逐条 getCommentsByPost 数过去，
 * 帖子多了就是几百次串行查询；现在只沿 createdAt 索引往回走固定条数，再批量补齐
 * 帖子和父评论，总共三次查询，跟库里有多少帖子无关。
 *
 * 已读只给你自己看（红点），TA 那边完全不知道你读没读——跟私信未读同一个口径。
 */

import * as db from './forumDb';
import { isUserSideAccount } from './forumFeed';

/** 一次往回扫多少条评论。够撑满通知列表就行，不用扫全库。 */
const SCAN_COMMENT_LIMIT = 400;
/** 通知列表最多显示多少条。 */
export const FORUM_NOTIFICATION_LIMIT = 50;

export interface ForumNotificationItem {
  /** 就是那条评论的 id，拿来当 React key，比数组下标稳。 */
  id: string;
  postId: string;
  postTitle: string;
  fromAccount?: db.ForumAccount;
  content: string;
  createdAt: number;
  /** true=回复你的某条评论，false=直接评论了你的帖子。 */
  isReplyToComment: boolean;
}

/**
 * 算出当前的通知列表（最新在前）。
 *
 * 判定沿用原来的口径，一个字没改：回复的人不是你方账号，且被回复的对象是你方账号。
 * 你方 = 主号 / 小号 / 共管账号（isUserSideAccount）。
 */
export async function loadForumNotifications(
  limit = FORUM_NOTIFICATION_LIMIT,
): Promise<ForumNotificationItem[]> {
  const [comments, accounts] = await Promise.all([
    db.getRecentForumComments(SCAN_COMMENT_LIMIT),
    db.getAllForumAccounts(),
  ]);
  if (comments.length === 0) return [];

  const accountsById = new Map(accounts.map(a => [a.id, a]));

  // 先把"回复者是你自己"的滤掉，剩下的才需要去查父帖子/父评论，能少查不少
  const candidates = comments.filter(c => !isUserSideAccount(accountsById.get(c.authorAccountId)));
  if (candidates.length === 0) return [];

  const [postsById, parentsById] = await Promise.all([
    db.getForumPostsByIds(candidates.map(c => c.postId)),
    db.getForumCommentsByIds(candidates.map(c => c.parentCommentId).filter((x): x is string => !!x)),
  ]);

  const items: ForumNotificationItem[] = [];
  for (const c of candidates) {
    const post = postsById.get(c.postId);
    if (!post) continue; // 原帖已被三天水线清掉，这条通知也没有落脚点了

    const parentAuthorId = c.parentCommentId
      ? parentsById.get(c.parentCommentId)?.authorAccountId
      : post.authorAccountId;
    if (!parentAuthorId) continue;
    if (!isUserSideAccount(accountsById.get(parentAuthorId))) continue;

    items.push({
      id: c.id,
      postId: post.id,
      postTitle: post.title || post.content.slice(0, 20),
      fromAccount: accountsById.get(c.authorAccountId),
      content: c.content,
      createdAt: c.createdAt,
      isReplyToComment: !!c.parentCommentId,
    });
    if (items.length >= limit) break; // 游标本来就是从新到旧，够数了就不用再往下走
  }
  return items;
}

/** 当前的已读水位。没有记录过就退回全局起始点，免得更新后第一次打开满屏红点。 */
export async function getForumNotificationReadAt(): Promise<number> {
  const mark = await db.getReadMark(db.notificationReadKey());
  if (mark !== undefined) return mark;
  return db.getUnreadTrackingEpoch();
}

/** 有几条通知是你还没看过的。App 外壳的角标用它。 */
export async function getForumNotificationUnreadCount(): Promise<number> {
  try {
    const [items, readAt] = await Promise.all([
      loadForumNotifications(FORUM_NOTIFICATION_LIMIT),
      getForumNotificationReadAt(),
    ]);
    return items.filter(it => it.createdAt > readAt).length;
  } catch {
    return 0; // 角标算不出来不该影响别的东西
  }
}

/**
 * 把通知标成已读。水位推到"这一批里最新那条"，而不是 Date.now()——
 * 用 now 的话，正好卡在读取和写入之间进来的新通知会被无声吃掉。
 */
export async function markForumNotificationsRead(items: ForumNotificationItem[]): Promise<void> {
  const newest = items.reduce((max, it) => Math.max(max, it.createdAt), 0);
  if (newest <= 0) return;
  const current = await getForumNotificationReadAt();
  if (newest <= current) return;
  await db.setReadMark(db.notificationReadKey(), newest);
}
