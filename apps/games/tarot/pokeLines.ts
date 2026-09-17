// ═══════════════════════════════════════════════════════════════════════════
// ✏️✏️✏️  塔罗 · 戳一戳 TA 的台词  ✏️✏️✏️
// ═══════════════════════════════════════════════════════════════════════════
//
// TA 坐在对面、没在抽牌的时候，戳他会弹出一句气泡。这里的话不调用 API，也不写进记忆。
//
// 分档：连着戳越多下，用越后面的一档。停下超过 POKE_RESET_MS 毫秒没戳，就从第一档重新算。
//   · from：从连戳第几下开始用这一档（第一档必须是 1）
//   · lines：这一档的台词，随机抽一句，不会连着两次出同一句
//   · 台词里写 {我}，会自动换成你的名字
//
// ⚠️ 下面是占位台词，请换成符合 TA 人设的话。
// ═══════════════════════════════════════════════════════════════════════════

export const POKE_TIERS: Array<{ from: number; lines: string[] }> = [
  {
    from: 1,
    lines: [
      '嗯？',
      '（看你）',
      '……怎么了。',
    ],
  },
  {
    from: 4,
    lines: [
      '{我}。',
      '（抓住你的手指）',
      '……还戳？',
    ],
  },
  {
    from: 7,
    lines: [
      '（叹气）',
      '好了好了。',
      '……',
    ],
  },
];

/** 停下多久没戳，就重新从第一档算（毫秒） */
export const POKE_RESET_MS = 5000;
/** 气泡显示多久（毫秒） */
export const POKE_BUBBLE_MS = 2600;

// ⛔ 以下是机制代码，不需要改

/** 按连戳次数挑一句，避开上一句 */
export function pickPokeLine(count: number, lastLine: string, userName: string): string {
  const tiers = POKE_TIERS.filter((t) => t.lines.length > 0).sort((a, b) => a.from - b.from);
  if (!tiers.length) return '……';
  let tier = tiers[0];
  for (const t of tiers) if (count >= t.from) tier = t;
  const pool = tier.lines.map((l) => l.split('{我}').join(userName));
  const choices = pool.length > 1 ? pool.filter((l) => l !== lastLine) : pool;
  return choices[Math.floor(Math.random() * choices.length)] ?? '……';
}
