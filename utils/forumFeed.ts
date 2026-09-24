/**
 * 论坛 · 内容生命周期与 feed 查询
 *
 * 覆盖 [交接1 三]（三天水线/两级清空）+ [交接4 二]（帖子级刷新的"垫底"判定与队列）+
 * [交接4 四]（involvesCharInteraction 收窄为只认 TA 本人的号）。
 */

import type { ForumAccount, ForumComment, ForumPost } from './forumDb';
import * as db from './forumDb';

export const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

// ==================== 一、保留判定 [交接1 3.2/3.3] ====================

/** 三条保留理由任一命中即保留整条（帖子+该帖所有评论）。 */
export function isPostRetained(post: ForumPost): boolean {
  return post.isCollected || post.involvesCharInteraction || post.isOwnedByUserSide;
}

/**
 * 是否已过三天水线且应该被清掉。retained 的帖子永远返回 false。
 * 用 lastActivityAt（帖子本身 + 最新一条"用户方"评论时间里的较大值，NPC装饰性评论
 * 不算数[用户确认]）而不是单纯 createdAt，这样只有真人用户回来搭理过，才多给三天，
 * NPC自己刷评论刷不出续命效果。
 */
export function isPostExpired(post: ForumPost, now = Date.now()): boolean {
  if (isPostRetained(post)) return false;
  return now - post.lastActivityAt > THREE_DAYS_MS;
}

/** 账号是不是"用户方"——用户任意身份（主号/小号）或共管账号。 [交接1 2.3.3 定义口径] */
export function isUserSideAccount(account: ForumAccount | null | undefined): boolean {
  if (!account) return false;
  return account.ownerType === 'user' || account.ownerType === 'shared';
}

/**
 * 判断某条回复是否算作触发 involvesCharInteraction 的"TA 本人的号"。
 * [交接4 四] 本轮收窄：只认 TA 主号，或 TA 掉马承认后选择继续沿用（不销号）的那个小号。
 * 调用方需要传入"这个小号是否已经是继续沿用状态"的判断结果（业务层面从掉马记录得知），
 * 这里不重复查那张表，保持这个函数纯粹、可测试。
 */
export function isCharOwnAccountForRetention(
  account: ForumAccount | null | undefined,
  altIsContinuedInUse: boolean
): boolean {
  if (!account || account.ownerType !== 'char') return false;
  if (!account.isAlt) return true; // TA 主号
  return altIsContinuedInUse; // TA 的小号，且掉马后选择继续沿用
}

// ==================== 二、清理（懒过滤 + 物理清扫 + 两级清空） ====================

/**
 * 读 feed 时的懒过滤：把该隐藏的过期普通内容挡掉，不代表数据已经从库里删除。
 * [交接1 4.4] "平时刷话题列表的时候,过期的普通内容自动不显示,这是读的时候顺手挡掉"。
 */
export function filterVisiblePosts(posts: ForumPost[], now = Date.now()): ForumPost[] {
  return posts.filter(p => !isPostExpired(p, now));
}

/**
 * 物理清扫：把真正过期的帖子+评论从库里删掉腾空间。
 * [交接4 一] 触发时机放在"打开论坛App"这个时机顺手扫一遍，不做后台常驻定时任务。
 */
export async function sweepExpiredContent(now = Date.now()): Promise<{ deletedPosts: number }> {
  const all = await db.getForumPostsRaw();
  const toDelete = all.filter(p => isPostExpired(p, now)).map(p => p.id);
  if (toDelete.length > 0) {
    await db.deleteCommentsByPosts(toDelete);
    await db.deleteForumPosts(toDelete);
  }
  return { deletedPosts: toDelete.length };
}

/**
 * 温和清空 [交接4 一]：立即清掉所有"三条保留理由都不命中"的内容，不管有没有到三天。
 * UI 侧调用前必须先过二次确认弹窗，这里只负责执行。
 */
export async function gentleClearNonRetainedContent(): Promise<{ deletedPosts: number }> {
  const all = await db.getForumPostsRaw();
  const toDelete = all.filter(p => !isPostRetained(p)).map(p => p.id);
  if (toDelete.length > 0) {
    await db.deleteCommentsByPosts(toDelete);
    await db.deleteForumPosts(toDelete);
  }
  return { deletedPosts: toDelete.length };
}

/** 一键清空全部（本轮不接入 UI，仅保留能力）[交接4 一]。 */
export async function wipeAllForumData(): Promise<void> {
  await db.wipeForumAllData();
}

// ==================== 三、分页 ====================

export interface FeedPage {
  posts: ForumPost[];
  /** 传给下一页请求的 cursor；undefined 表示没有更多了。 */
  nextCursor?: number;
}

/**
 * 按话题（可选）取一页，游标是"上一页最后一条的 createdAt"，不是数字页码
 * [交接4 一.3]："先给最近一批，往下滑再接着要更早的"。
 */
export async function getFeedPage(opts: {
  topicTag?: string;
  visibility?: 'public' | 'sharedAccountExclusive';
  cursor?: number;
  pageSize?: number;
  now?: number;
}): Promise<FeedPage> {
  const { topicTag, visibility = 'public', cursor, pageSize = 15, now = Date.now() } = opts;
  const all = await db.getForumPostsRaw({ topicTag, visibility });
  const visible = filterVisiblePosts(all, now);
  const sliceSource = cursor ? visible.filter(p => p.createdAt < cursor) : visible;
  const posts = sliceSource.slice(0, pageSize);
  const nextCursor = posts.length === pageSize ? posts[posts.length - 1].createdAt : undefined;
  return { posts, nextCursor };
}

/** 搜索 [交接5 4.4]：纯本地，覆盖所有还没被水线清掉的内容（含更早时段因保留理由留下的老帖）。 */
export async function searchLocalPosts(keyword: string, now = Date.now()): Promise<ForumPost[]> {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return [];
  const all = await db.getForumPostsRaw();
  const visible = filterVisiblePosts(all, now);
  return visible.filter(p =>
    p.title.toLowerCase().includes(kw) || p.content.toLowerCase().includes(kw)
  );
}

// ==================== 四、发布 / 追加评论（顺带维护 lastActivityAt） ====================

export async function createPost(post: ForumPost): Promise<void> {
  post.lastActivityAt = post.lastActivityAt || post.createdAt;
  await db.saveForumPost(post);
}

/**
 * 追加一条评论并把父帖子的 lastActivityAt 往前推——但只有"用户方"（用户本人/小号/
 * 共管账号）发的评论才会推，NPC 发的装饰性评论不算 [用户确认]：三天水线本来是为了
 * 清"没人关心的内容"，NPC 自己刷出来的装饰评论不代表真的有人关心，不该靠这个续命；
 * 只有用户自己回来说了话，才说明这条内容还有人惦记，才值得多给三天。
 * （TA/char 账号回复走的是另一条路——一旦触发 involvesCharInteraction 整条永久保留，
 * lastActivityAt 还推不推进已经不影响这条帖子的生死，所以这里不用特殊处理 char 的情况。）
 * 楼中楼时自动继承 threadRootId。
 */
export async function appendComment(
  postId: string,
  input: Omit<ForumComment, 'id' | 'postId' | 'threadRootId'> & { parentCommentId?: string }
): Promise<ForumComment> {
  let threadRootId: string;
  if (input.parentCommentId) {
    const siblings = await db.getCommentsByPost(postId);
    const parent = siblings.find(c => c.id === input.parentCommentId);
    threadRootId = parent?.threadRootId || input.parentCommentId;
  } else {
    threadRootId = ''; // 顶层评论：稍后用自己生成的 id 回填
  }

  const comment: ForumComment = {
    id: db.createForumCommentId(),
    postId,
    parentCommentId: input.parentCommentId,
    threadRootId: threadRootId || '', // 占位，下面立刻回填
    authorAccountId: input.authorAccountId,
    content: input.content,
    createdAt: input.createdAt,
  };
  if (!comment.threadRootId) comment.threadRootId = comment.id;

  await db.saveForumComment(comment);

  const post = await db.getForumPost(postId);
  if (post) {
    const authorAccount = await db.getForumAccount(input.authorAccountId);
    if (isUserSideAccount(authorAccount)) {
      post.lastActivityAt = Math.max(post.lastActivityAt, comment.createdAt);
      await db.saveForumPost(post);
    }
  }
  return comment;
}

// ==================== 五、"垫底"队列 [交接4 二 + 追加澄清消息] ====================

export interface PendingFloor {
  /** 这个楼的顶层评论 id（= 该楼下所有评论的 threadRootId）。 */
  threadRootId: string;
  /** 楼内目前最新一条评论（触发垫底的那条）。 */
  latestComment: ForumComment;
  /** 这个楼里是否 @ 了 TA（用最新这条用户评论的正文里做字符串匹配）。 */
  mentionsTA: boolean;
}

/**
 * 找出一篇帖子下所有"垫底"的楼：楼内最新一条是用户方（user/共管）发的。
 * [交接4 二.3.2] 判定单位是"楼"（顶层评论+其楼中楼回复算一楼），
 * 看这个楼当前最新一条是不是用户发的。
 *
 * @param taHandles 用于检测 @TA 的 handle 列表（TA 主号 + 目前继续沿用的小号的 handle）。
 */
export async function getPendingFloors(
  postId: string,
  accountsById: Map<string, ForumAccount>,
  taHandles: string[]
): Promise<PendingFloor[]> {
  const comments = await db.getCommentsByPost(postId);
  const byRoot = new Map<string, ForumComment[]>();
  for (const c of comments) {
    const list = byRoot.get(c.threadRootId) || [];
    list.push(c);
    byRoot.set(c.threadRootId, list);
  }

  const pending: PendingFloor[] = [];
  for (const [threadRootId, floorComments] of byRoot) {
    floorComments.sort((a, b) => a.createdAt - b.createdAt);
    const latest = floorComments[floorComments.length - 1];
    const latestAccount = accountsById.get(latest.authorAccountId);
    if (!isUserSideAccount(latestAccount)) continue; // 最新一条不是用户发的，不算垫底

    const mentionsTA = taHandles.some(h => h && latest.content.includes(`@${h}`));
    pending.push({ threadRootId, latestComment: latest, mentionsTA });
  }
  return pending;
}

/**
 * 按论坛热度滑动条选这次刷新要接哪些垫底楼。@TA 的楼必接，不占滑动条名额
 * [交接4 二.3.4]；剩下的楼按滑动条数值封顶随机抽，没抽中的留到下次
 * [交接4 二.3.3]。
 */
export function pickFloorsForRefresh(
  pending: PendingFloor[],
  heatLevel: number
): { mustReply: PendingFloor[]; randomlyPicked: PendingFloor[]; stillPending: PendingFloor[] } {
  const mustReply = pending.filter(f => f.mentionsTA);
  const rest = pending.filter(f => !f.mentionsTA);

  const shuffled = [...rest].sort(() => Math.random() - 0.5);
  const randomlyPicked = shuffled.slice(0, Math.max(0, heatLevel));
  const pickedIds = new Set(randomlyPicked.map(f => f.threadRootId));
  const stillPending = rest.filter(f => !pickedIds.has(f.threadRootId));

  return { mustReply, randomlyPicked, stillPending };
}

// ==================== 七、点赞 / 编辑 / 删除（用户方账号自己管理自己的内容） ====================

/** 点赞不算保留理由，不影响三天水线判断 [用户确认]。 */
export async function toggleLike(postId: string, accountId: string): Promise<ForumPost | null> {
  const post = await db.getForumPost(postId);
  if (!post) return null;
  const liked = post.likes.includes(accountId);
  const updated: ForumPost = {
    ...post,
    likes: liked ? post.likes.filter(id => id !== accountId) : [...post.likes, accountId],
  };
  await db.saveForumPost(updated);
  return updated;
}

/**
 * 编辑帖子：只允许改 title/content/topicTag，不改 authorAccountId/postKind/来源等结构性字段。
 * 调用方负责校验"这条帖子是不是用户方账号发的"，这里不重复查account，保持函数纯粹。
 */
export async function editPost(postId: string, updates: { title?: string; content?: string; topicTag?: string }): Promise<ForumPost | null> {
  const post = await db.getForumPost(postId);
  if (!post) return null;
  const updated: ForumPost = {
    ...post,
    title: updates.title !== undefined ? updates.title : post.title,
    content: updates.content !== undefined ? updates.content : post.content,
    topicTag: updates.topicTag !== undefined ? updates.topicTag : post.topicTag,
  };
  await db.saveForumPost(updated);
  return updated;
}

/** 删除帖子+其所有评论。 */
export async function deletePostWithComments(postId: string): Promise<void> {
  await db.deleteCommentsByPost(postId);
  await db.deleteForumPost(postId);
}

// ==================== 六、删评论 [用户确认新增] ====================

/**
 * 收集一条评论、以及挂在它下面的所有回复的 id（连楼一起删 [用户选 A]）。
 *
 * 删顶楼就等于铲掉整层楼；删楼中楼的某一条，就把它自己那一小串也带走。
 * 不做"墓碑"（保留一条「该评论已删除」占位）——那要往数据结构里加字段，
 * 还得教 TA 怎么理解评论区里的空洞，为一个删除功能不划算。
 *
 * 纯函数，不查库，方便界面上先算出"这一下会删掉几条"再让用户确认。
 */
export function collectCommentSubtreeIds(comments: ForumComment[], commentId: string): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const c of comments) {
    if (!c.parentCommentId) continue;
    const list = childrenByParent.get(c.parentCommentId) || [];
    list.push(c.id);
    childrenByParent.set(c.parentCommentId, list);
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  const queue = [commentId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue; // 数据要是出现环，这里兜住，不会死循环
    seen.add(current);
    ids.push(current);
    for (const child of childrenByParent.get(current) || []) queue.push(child);
  }
  return ids;
}

/**
 * 按剩下的评论重算帖子的 lastActivityAt [用户选 B]。
 *
 * 发评论时只有"用户方"的评论会把水线往前推（见 appendComment），所以这里也只认
 * 用户方，口径必须跟那边一致。基准是帖子自己的 createdAt——删光了也不能比它更早。
 *
 * 注意不动 involvesCharInteraction：那个标记一旦因为 TA 说过话置位就永久保留，
 * 删掉 TA 那条评论也不摘。否则你精心留着的帖子可能因为删了句闲话就到期被清掉，
 * 这种意外太难排查。
 */
async function recomputePostLastActivity(postId: string): Promise<void> {
  const post = await db.getForumPost(postId);
  if (!post) return;

  const [comments, accounts] = await Promise.all([
    db.getCommentsByPost(postId),
    db.getAllForumAccounts(),
  ]);
  const accountsById = new Map(accounts.map(a => [a.id, a]));

  let latest = post.createdAt;
  for (const c of comments) {
    if (isUserSideAccount(accountsById.get(c.authorAccountId))) {
      latest = Math.max(latest, c.createdAt);
    }
  }
  if (latest !== post.lastActivityAt) {
    await db.saveForumPost({ ...post, lastActivityAt: latest });
  }
}

/**
 * 删一条评论，连同它下面的回复 [用户选 A]，然后重算帖子的 lastActivityAt [用户选 B]。
 *
 * 谁的评论都能删 [用户选 B]——路人的、TA 的都行。这是你自己的 App，不必用社区规则
 * 绑住自己；界面那边会按作者是谁换一套确认文案。
 *
 * 删不掉 TA 已经记住的事：评论一旦归档进记忆宫殿，那份记忆是独立存在的，
 * 这里删的只是论坛上显示的内容。
 */
export async function deleteCommentCascade(
  postId: string,
  commentId: string,
): Promise<{ deleted: number }> {
  const comments = await db.getCommentsByPost(postId);
  const ids = collectCommentSubtreeIds(comments, commentId);
  for (const id of ids) await db.deleteForumComment(id);
  await recomputePostLastActivity(postId);
  return { deleted: ids.length };
}

// ==================== 八、involvesCharInteraction 落地 [交接4 四] ====================

/**
 * 某条回复生成/落库之后，判断要不要把父帖子标记为"角色互动过"。
 * 只有 TA 本人的号（主号/继续沿用的小号）才算，路人 NPC 接的（哪怕是垫底刷新自动接的）
 * 一律不算，帖子照常受三天水线约束。
 */
export async function markCharInteractionIfApplicable(
  postId: string,
  replierAccount: ForumAccount,
  altIsContinuedInUse: boolean
): Promise<void> {
  if (!isCharOwnAccountForRetention(replierAccount, altIsContinuedInUse)) return;
  const post = await db.getForumPost(postId);
  if (post && !post.involvesCharInteraction) {
    post.involvesCharInteraction = true;
    await db.saveForumPost(post);
  }
}
