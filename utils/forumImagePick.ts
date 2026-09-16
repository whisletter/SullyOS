import { processImage } from './file';
import { migrateDataUrlToRef } from './blobRef';

/**
 * 论坛「从相册选图」的统一入口，口径跟朋友圈一致：
 * 先 processImage 压一道（避免整张原图进库），再 migrateDataUrlToRef 存成 blobref 令牌。
 *
 * 存令牌而不是 data: 长串，是为了跟全局图片存储对齐——同一张图多处引用只占一份，
 * 备份/存储占用面板也能统计到。令牌落在论坛自己的库里，GC 与去重的引用面已在
 * utils/blobGc.ts、utils/blobDedupe.ts 接好（见 forumDb 的 FORUM_BLOB_REF_STORES）。
 */

/** 单帖配图上限，与朋友圈同规格 [交接5 4.2]。 */
export const FORUM_MAX_POST_IMAGES = 9;

/**
 * 把用户选中的文件批量转成令牌。limit 是「还能再放几张」，超出的直接丢掉不报错，
 * 由调用方负责提示；单张失败会上抛，调用方 catch 后 toast。
 */
export async function filesToForumImageTokens(files: File[], limit: number): Promise<string[]> {
  const room = Math.max(0, limit);
  const tokens: string[] = [];
  for (const file of files.slice(0, room)) {
    const base64 = await processImage(file);
    tokens.push(await migrateDataUrlToRef(base64));
  }
  return tokens;
}
