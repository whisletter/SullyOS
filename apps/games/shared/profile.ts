// ═══════════════════════════════════════════════════════════════════════════
// 🧩 小游戏共用 · 从 App 的用户 / 角色资料里读名字、性别、人设
//   字段名不一样的话，加进下面两个数组。
// ═══════════════════════════════════════════════════════════════════════════

export type ProfileSex = '男' | '女';

const SEX_FIELDS = ['gender', 'sex', '性别'];
const PERSONA_TEXT_FIELDS = ['description', 'persona', 'bio', 'systemPrompt', 'prompt', 'intro', 'profile', 'settings'];

export function readSex(profile: unknown): ProfileSex | null {
  if (!profile || typeof profile !== 'object') return null;
  const p = profile as Record<string, unknown>;
  const norm = (v: unknown): ProfileSex | null => {
    if (typeof v !== 'string') return null;
    const s = v.trim().toLowerCase();
    if (['男', '男性', 'male', 'm', 'man', 'boy'].includes(s)) return '男';
    if (['女', '女性', 'female', 'f', 'woman', 'girl'].includes(s)) return '女';
    return null;
  };
  for (const f of SEX_FIELDS) { const r = norm(p[f]); if (r) return r; }
  for (const f of PERSONA_TEXT_FIELDS) {
    const t = p[f];
    if (typeof t !== 'string') continue;
    const m = /性别\s*[:：]?\s*(男|女)/.exec(t) || /(男|女)性/.exec(t);
    if (m) return m[1] as ProfileSex;
  }
  return null;
}

export function readPersona(profile: unknown, max = 4000): string {
  if (!profile || typeof profile !== 'object') return '';
  const p = profile as Record<string, unknown>;
  return PERSONA_TEXT_FIELDS.map(f => p[f]).filter(v => typeof v === 'string' && (v as string).trim()).join('\n\n').slice(0, max);
}

// 名字去空格；和 TA 重名时给自己加个后缀，避免引擎认错人
export function readNames(userProfile: unknown, char: unknown): { user: string; ta: string } {
  const clean = (s: unknown, fb: string) => (typeof s === 'string' ? s.replace(/\s+/g, '') : '') || fb;
  const ta = clean((char as { name?: unknown } | null)?.name, 'TA');
  let user = clean((userProfile as { name?: unknown } | null)?.name, '我');
  if (user === ta) user = `${user}(我)`;
  return { user, ta };
}
