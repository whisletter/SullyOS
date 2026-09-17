/**
 * 戳一戳台词。
 *
 * 按连续戳的次数分三档：隔了 POKE_RESET_MS 没戳，就重新从第一档算。
 * 台词里的 {角色名} 显示时换成当前角色的名字，{用户名} 换成当前用户的名字。
 * 同一档里不会连着两次说同一句。
 */

/** 隔这么久没戳，次数清零 */
export const POKE_RESET_MS = 5000;
/** 气泡停留多久 */
export const POKE_BUBBLE_MS = 3200;

/** 第一档：偶尔戳一下 */
const TIER_1 = [
  '你准确无误地找到了我最不痒的地方',
  '又是新型突击训练？',
  '看我干什么？看牌^^',
  '让我猜猜...你今天就没想抽牌对不对？',
  '今天想我问什么？',
  '在犹豫什么？',
  '嗯，你的{角色名}在呢',
  '有什么想告诉我？',
  '昨晚几点睡的？戳我也躲不过这个问题',
  '牌还没洗好，别急着拆我',
  '戳一下，是想换你来抽？',
  '嗯，收到。下一张牌我替你挑个好的',
];

/** 第二档：连着戳 */
const TIER_2 = [
  '就这么喜欢戳我？',
  '还戳？',
  '嗯？就知道你会这样...',
  '一两次是不小心，三四次就是故意了--',
  '今天能猜中几个？要不要我放水？',
  '这是撒娇，还是宣战？',
  '...你戳几下，我就还几下',
  '再戳，这局我可就不让你了~',
  '心情不好就直说，戳我也行，别憋着',
];

/** 第三档：戳个不停 */
const TIER_3 = [
  '胡闹份额要用完了...',
  '好啦好啦，再戳下去，就要变成扁扁的{角色名}了',
  '账记满了，这局输的人要答应对方一件事',
  '占卜暂停，开始讨债',
  '再这样，我可要抓住你的手了-',
  '戳够了就去喝口水，喝完回来让你接着戳',
  '这么着急，是想问我什么？',
  '再戳下去，我们就去玩大富翁吧？',
];

/** 连续戳到第几下进下一档 */
const TIER_2_FROM = 3;
const TIER_3_FROM = 6;

function fill(line: string, names: { ta: string; user: string }): string {
  return line
    .replace(/\{角色名\}/g, names.ta.trim() || 'TA')
    .replace(/\{用户名\}/g, names.user.trim() || '你');
}

/**
 * 挑一句。count 是连续戳的次数，prev 是上一句（已经换过名字的），
 * names 是当前角色和当前用户的名字（现查的，不存）。
 */
export function pickPokeLine(count: number, prev: string, names: { ta: string; user: string }): string {
  const pool = count >= TIER_3_FROM ? TIER_3 : count >= TIER_2_FROM ? TIER_2 : TIER_1;
  const lines = pool.map((l) => fill(l, names));
  const choices = lines.length > 1 ? lines.filter((l) => l !== prev) : lines;
  return choices[Math.floor(Math.random() * choices.length)] ?? lines[0];
}
