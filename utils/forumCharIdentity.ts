/**
 * 论坛 · 角色小号建号
 *
 * TA 的小号跟用户小号是对称的玩法：论坛上没人知道那是它，用户只能从言行里猜。
 *
 * 名字和说话风格由 TA 自己定（调一次模型），不是我在代码里给它安排的：
 *   - 我随机拼的名字没有性格，一个毒舌角色叫"温柔小天使"就很出戏；
 *   - 用户明确说了**不强制伪装人设**，只给 TA"你可以选择怎么装"这个选项，
 *     装不装、装成什么样是它自己的判断。所以提示词里只描述可能性，不下指令。
 *
 * 只在第一次建号时调一次模型，之后永久固定。模型调用失败就返回 null、不建号，
 * 下次进 App 再试——不拿一个随机兜底名字把这个号定死。
 */

import { safeFetchJson, extractJson } from './safeApi';
import * as db from './forumDb';
import type { ForumAccount } from './forumDb';
import type { ForumApiConfig } from './forumAi';

export interface CharAltSeedInput {
  id: string;
  name: string;
  systemPrompt?: string;
  worldview?: string;
}

/** handle 只保留 ASCII 可见字符，并保证全库唯一——@提及靠字符串匹配，撞车会认错人。 */
async function sanitizeUniqueHandle(raw: string, fallbackSeed: string): Promise<string> {
  const accounts = await db.getAllForumAccounts();
  const taken = new Set(accounts.map(a => a.handle));

  let base = String(raw || '').trim().replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20).toLowerCase();
  if (base.length < 3) base = `u${fallbackSeed.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6) || 'anon'}`;

  if (!taken.has(base)) return base;
  for (let i = 2; i < 60; i++) {
    const candidate = `${base}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}${Date.now().toString(36).slice(-4)}`;
}

export async function getCharAltAccount(charId: string): Promise<ForumAccount | null> {
  const accounts = await db.getForumAccountsByOwnerType('char');
  return accounts.find(a => a.charId === charId && a.isAlt && a.status === 'active') || null;
}

/**
 * 确保这个角色有一个小号。已有就直接返回，没有就调一次模型让 TA 自己起名定风格。
 *
 * @returns 小号账号；模型没配好或调用失败时返回 null（不建号，下次再试）
 */
export async function ensureCharAltAccount(
  apiConfig: ForumApiConfig,
  char: CharAltSeedInput,
): Promise<ForumAccount | null> {
  const existing = await getCharAltAccount(char.id);
  if (existing) return existing;
  if (!apiConfig?.baseUrl || !apiConfig?.apiKey || !apiConfig?.model) return null;

  const personaBrief = [char.systemPrompt, char.worldview]
    .filter(Boolean).join('\n').slice(0, 1200);

  const prompt = `
你是"${char.name}"。下面是你的人设：
${personaBrief || '（没有额外人设说明，按这个名字给人的感觉自己把握）'}

你要在一个论坛上开一个小号。这个号跟你的主号没有任何公开关联，论坛上没人知道它是你。

怎么用这个小号完全由你决定：你可以拿它当纯粹的树洞、随便发点主号不方便说的话；
也可以刻意装成另一种人——语气、关注的话题、说话习惯都跟主号不一样；
也可以基本还是你自己，只是换了个名字。没有标准答案，按你的性格来。

请给这个小号定下来：
- displayName：昵称，像真人随手取的网名，不要出现你的本名或明显联想
- handle：论坛 ID，3-20 个字符，只能用小写英文字母、数字和下划线
- bio：个性签名，可以留空字符串
- personaNote：一句话写给你自己看的备忘——这个号你打算怎么用、说话上有什么倾向。
  这条只有你自己看得见，不会显示在论坛上。

请只返回 JSON：
{ "displayName": "", "handle": "", "bio": "", "personaNote": "" }
`.trim();

  let parsed: any = null;
  try {
    const data = await safeFetchJson(
      `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
        body: JSON.stringify({
          model: apiConfig.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 1.0,
          max_tokens: 600,
          stream: false,
          response_format: { type: 'json_object' },
        }),
      },
      2, 0, { appName: '杂波频段', purpose: '角色小号建号' },
    );
    parsed = extractJson<any>(data?.choices?.[0]?.message?.content?.trim() || '');
  } catch (e: any) {
    console.warn('[ForumCharAlt] 建号调用失败:', e?.message || String(e));
    return null;
  }

  const displayName = String(parsed?.displayName || '').trim().slice(0, 30);
  if (!displayName) return null;

  const handle = await sanitizeUniqueHandle(parsed?.handle, displayName);
  const now = Date.now();
  const account: ForumAccount = {
    id: db.createForumAccountId(),
    ownerType: 'char',
    charId: char.id,
    isAlt: true,
    handle,
    displayName,
    bio: String(parsed?.bio || '').trim().slice(0, 100) || undefined,
    altPersonaNote: String(parsed?.personaNote || '').trim().slice(0, 300) || undefined,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  await db.saveForumAccount(account);
  return account;
}
