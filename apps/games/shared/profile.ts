// ═══════════════════════════════════════════════════════════════════════════
// 🧩 小游戏共用 · 从 App 的用户 / 角色资料里读名字、性别、人设
//   ⚠️ 这个文件是小游戏的工具函数，不是论坛的个人主页。
//      论坛个人主页在 apps/forum/ForumProfile.tsx，不要把它的内容贴到这里。
//   字段名不一样的话，加进下面两个表。
// ═══════════════════════════════════════════════════════════════════════════

export type ProfileSex = '男' | '女';

/** 直接写性别的字段（SullyOS 目前没有，留着兼容以后加） */
const SEX_FIELDS = ['gender', 'sex', '性别'];

/** 会去里面找性别 / 拼人设的文字字段，右边是设置页上显示的「读自 XX」 */
const TEXT_FIELDS: Array<[field: string, label: string]> = [
  ['description', '人设'],
  ['systemPrompt', '系统提示词'],
  ['worldview', '世界观'],
  ['writerPersona', '写作人设'],
  ['bio', '简介'],
  ['persona', '人设'],
  ['intro', '简介'],
  ['profile', '资料'],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function normSex(v: unknown): ProfileSex | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (['男', '男性', '男生', 'male', 'm', 'man', 'boy'].includes(s)) return '男';
  if (['女', '女性', '女生', 'female', 'f', 'woman', 'girl'].includes(s)) return '女';
  return null;
}

/** 从一段文字里找性别。找不到返回 null，宁可不认也不乱认。 */
function sexFromText(text: string, selfName?: string, otherName?: string): ProfileSex | null {
  // 1) 明写：「性别：男」「性别 女」「Gender: female」
  const labeled = /性别\s*[:：=]?\s*[「"'（(]?\s*(男|女)/.exec(text);
  if (labeled) return labeled[1] as ProfileSex;
  const labeledEn = /\b(?:gender|sex)\s*[:：=]\s*(male|female|man|woman|m|f)\b/i.exec(text);
  if (labeledEn) return normSex(labeledEn[1]);

  // 2) 名字后面紧跟性别：「林夏（女，24岁）」「林夏，男，」「林夏是个女孩」
  const self = selfName?.replace(/\(我\)$/, '').trim();
  if (self) {
    const m = new RegExp(`${escapeRe(self)}\\s*[（(，,、:：\\s]?\\s*(?:是个?|是一[个名位])?\\s*(男|女)`).exec(text);
    if (m) return m[1] as ProfileSex;
  }

  // 3) 关键词：先去掉提到对方名字的句子，免得把对方的性别算到自己头上
  const other = otherName?.replace(/\(我\)$/, '').trim();
  const sentences = text.split(/[。！？!?\n；;]/).filter(s => !(other && s.includes(other)));
  const rest = sentences.join('。');
  const count = (re: RegExp) => (rest.match(re) || []).length;
  const male = count(/男性|男生|男孩|男人|少年|男子|\bmale\b|\bman\b/gi);
  const female = count(/女性|女生|女孩|女人|少女|女子|\bfemale\b|\bwoman\b/gi);
  if (male && !female) return '男';
  if (female && !male) return '女';

  // 4) 代词：只有一边明显占多数时才算
  const he = count(/他/g);
  const she = count(/她/g);
  if (he >= 3 && he >= she * 3) return '男';
  if (she >= 3 && she >= he * 3) return '女';
  return null;
}

/** 读性别，并告诉设置页是从哪读到的（显示成「性别：男（读自人设）」） */
export function detectSex(
  profile: unknown,
  opts: { selfName?: string; otherName?: string } = {},
): { sex: ProfileSex | null; from: string } {
  if (!profile || typeof profile !== 'object') return { sex: null, from: '' };
  const p = profile as Record<string, unknown>;
  for (const f of SEX_FIELDS) {
    const r = normSex(p[f]);
    if (r) return { sex: r, from: '性别字段' };
  }
  for (const [f, label] of TEXT_FIELDS) {
    const t = p[f];
    if (typeof t !== 'string' || !t.trim()) continue;
    const r = sexFromText(t, opts.selfName, opts.otherName);
    if (r) return { sex: r, from: label };
  }
  return { sex: null, from: '' };
}

/** 旧写法，保留兼容 */
export function readSex(profile: unknown): ProfileSex | null {
  return detectSex(profile).sex;
}

/** 角色人设原文，给 TA 的提示词用 */
export function readPersona(profile: unknown, max = 4000): string {
  if (!profile || typeof profile !== 'object') return '';
  const p = profile as Record<string, unknown>;
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const [f] of TEXT_FIELDS) {
    const v = p[f];
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    parts.push(t);
  }
  return parts.join('\n\n').slice(0, max);
}

/** 名字去空格；和 TA 重名时给自己加个后缀，避免引擎认错人 */
export function readNames(userProfile: unknown, char: unknown): { user: string; ta: string } {
  const clean = (s: unknown, fb: string) => (typeof s === 'string' ? s.replace(/\s+/g, '') : '') || fb;
  const ta = clean((char as { name?: unknown } | null)?.name, 'TA');
  let user = clean((userProfile as { name?: unknown } | null)?.name, '我');
  if (user === ta) user = `${user}(我)`;
  return { user, ta };
}
