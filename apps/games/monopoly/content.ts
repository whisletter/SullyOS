// ═══════════════════════════════════════════════════════════════════════════
// ✏️✏️✏️  大富翁 · 内容填写区（整个文件都是你可以改的内容）  ✏️✏️✏️
// ═══════════════════════════════════════════════════════════════════════════
//
// 【这个文件管什么】
//   · 设置页上的文字（强度说明、1-6 尺、红线、小字提示…）
//   · 棋盘布局、金币数值、功能卡、未知格、淫纹部位
//   · 三份卡库 JSON 的位置
//   · 荷官 / TA 用哪个模型、要不要写进聊天记录
//   提示词在同目录的 prompts.ts；机制在 engine.ts，不用改。
//   读性别、调 AI、写聊天记录是所有小游戏共用的，在 ../shared/ 里。
//
// 【数值来源】除非注明，数值都和原版 monopoly_play.py 一致。
//
// 【通用注意】
//   · 文字里要用英文单引号 ' 时写成 \'，或者直接用中文引号「」“”。
//   · 固定数量的数组（6 项 / 13 项 / 20 项）不要增删项。
//   · 调换了红线顺序、或想让所有人已保存的设置和对局作废 → 把 CONTENT_VERSION 加 1。
// ═══════════════════════════════════════════════════════════════════════════

import type { CellKind, FunctionCardDef, IdentityCard, Intensity, LibTask, LibTruth, MysteryEventDef } from './types';

import libraryJson from './data/monopoly-library_v2.json';
import truthsJson from './data/monopoly-truths.json';
import identitiesJson from './data/monopoly-identities.json';

// 📝 CONTENT_VERSION：内容版本号。v3 = 按原版引擎重新移植，旧存档不兼容。
export const CONTENT_VERSION = 3;

// ─── ⓪ 卡库 ───────────────────────────────────────────────────────────────

// 📝 三份卡库 JSON 放在 data/，直接覆盖同名文件即可换库，字段结构不要变。
export const LIBRARY: LibTask[] = ((libraryJson as unknown as { tasks: LibTask[] }).tasks) || [];
export const TRUTHS: LibTruth[] = (truthsJson as unknown as LibTruth[]) || [];
export const IDENTITY_CARDS: IdentityCard[] = (identitiesJson as unknown as IdentityCard[]) || [];

// ─── ① 强度 ────────────────────────────────────────────────────────────────

// 📝 INTENSITY_RANGES：每一档在 1-6 尺上的区间（原版 CURVES）。格式 '起-止'。
export const INTENSITY_RANGES: Record<Intensity, string> = {
  light: '1-3',
  medium: '2-5',
  heavy: '3-6',
};

// 📝 INTENSITY_NOTES：每一档一句话，开局念给人类（原版 _FLAVOR_TAIL）
export const INTENSITY_NOTES: Record<Intensity, string> = {
  light: '最重到「碰性器外部」，不含口交、不含插入（调情/爱抚级）。',
  medium: '含口手服务到插入，插入是下半场才开、结尾附近最烈。',
  heavy: '每道都在高段、没有轻任务，会玩到失控层（强制/连续高潮）。',
};

// ─── ② 1-6 尺分级 ─────────────────────────────────────────────────────────

// 📝 LEVEL_STEPS：①~⑥ 每一级碰到哪一步（原版 INTENSITY_SCALE）
export const LEVEL_STEPS: [string, string, string, string, string, string] = [
  '只挑逗、不碰身体（骚话/展示/对视/隔空撩）',
  '碰身体但不碰性器（亲摸咬舔脖子/腰/腿/臀·隔衣蹭）',
  '碰性器外部、不进入（揉摸乳头·隔内裤碰·点到即止轻舔）',
  '口手成套服务或进入准备（口交/手活/乳交/扩张润滑/抵着入口磨）',
  '插入（手指/玩具/性器进入·骑乘/抽插）',
  '失控层（强制/连续高潮·边缘到极限·多点同时）',
];

export const LEVELS_FOOTER = '🌡️ 前 2 回合热身、从低段起步逐步升温；前半场不开这档的顶，最后 1/4 锁在最高档。';
export const LEVEL_NAMES = ['触电', '撩', '碰', '口手', '做', '失控'];

// ─── ③ 开局提醒 ───────────────────────────────────────────────────────────

export const OPENING_REMINDER = '★ 开局荷官会把这档念给你、说清大概玩到哪一步，再问接受还是换档——知情再开。';

// ─── ④ 红线 ───────────────────────────────────────────────────────────────

// 📝 RED_LINE_LABELS：13 类红线（原版 REDLINE_SWITCHES 去掉后庭），必须和任务库 kink 写法一致
export const RED_LINE_LABELS: string[] = [
  '打', '绑', '玩具', '暴露',
  '羞辱', '失禁', '足', '口水',
  '产乳', '电', '双龙', '催眠',
  '蜡',
];

export const RED_LINE_DEFAULT_ON: boolean[] = [
  false, false, false, false,
  false, false, false, false,
  false, false, false, false,
  false,
];

// 📝 REDLINE_CONTENT：内容兜底（原版 _RL_CONTENT）。卡片漏标 kink 时，正文命中这些词也挡掉。
//   · 键 = 红线名；值 = 正则。没有键的红线只看 kink 标签。
export const REDLINE_CONTENT: Record<string, RegExp> = {
  玩具: /跳蛋|震动棒|振动棒|按摩棒|电动棒|拉珠|肛塞|尾巴塞|延时环|锁精环|假鸡巴|假阳具|穿戴式|遥控.{0,3}蛋|情趣玩具/,
  失禁: /失禁|憋尿|漏尿|尿出|尿液|撒尿|尿在|尿了|喷尿|尿意|尿裤/,
  打: /掌掴|鞭打|巴掌|打屁股|打红|拍臀|扇.{0,3}屁股|扇.{0,2}巴掌|掴|抽.{0,4}(屁股|臀|背)/,
  绑: /绑|捆|反缚|反绑|手铐|束缚|拘束|镣铐|皮带缚|丝带.{0,3}缚/,
  口水: /口水|唾液|吐口水|唾沫|口涎/,
  产乳: /产乳|挤奶|乳汁|奶水|母乳|喷奶|催乳|泌乳/,
  电: /电击|电流|通电|电棒|电击棒|电击贴片|电击跳蛋|电击乳夹/,
  双龙: /双头龙|双插|双龙/,
  催眠: /催眠|触发词/,
  足: /足交|脚交|用脚|脚底|脚趾|脚背|脚心|踩着|穿.{0,4}高跟|丝袜.{0,4}脚/,
  暴露: /当众|公共场|走光|露天|阳台|窗边|户外/,
  蜡: /蜡/,
};

// 📝 BACKDOOR_KINK：任务库里代表后庭的 kink 名
export const BACKDOOR_KINK = '后庭';

// ─── ⑤ 设置页小字 ─────────────────────────────────────────────────────────

export const SETTING_HINTS = {
  roles: '性别读自人设资料；攻受每局自己选。纯top=任何孔都不被插。',
  levels: '每一级对应一句内容；上面选中的强度会高亮它覆盖的级别。',
  backdoor: '默认两人都关，不会抽到后庭任务。开门=愿意被做；禁门=只给不收（和关一样不会被做）。',
  redLines: '共 13 类；选中的引擎全程避开，漏标的卡还会按正文再拦一次。',
  reversal: '0=严守攻受 · 0.3=偶尔反转（默认）· 0.5=混乱 · 1=全程反着来',
  rounds: '两人合计掷几次：速玩12（~20分钟，任务格更多）/ 正常18 / 超长24（默认）',
  identity: 'off=不发身份卡 · mixed=35 张全池（默认）· nsfw_only=只发 NSFW 20 张',
  firstMove: '默认=我先手，之后轮流',
};

// ─── ⑥ 棋盘 ───────────────────────────────────────────────────────────────

// 📝 两套 20 格棋盘（原版 SPECIAL / SPECIAL_DENSE）。局长 ≤12 用密任务盘。
//   · 'start' 起点 · 'task' 任务 · 'truth' 真心话 · 'chance' 抽卡(+换身份) · 'mystery' 未知格 · 'jail' 监狱 · 'shop' 商店
const layout = (special: Record<number, CellKind>): CellKind[] =>
  Array.from({ length: 20 }, (_, i) => (i === 0 ? 'start' : special[i] ?? 'task'));
export const BOARD_NORMAL: CellKind[] = layout({ 4: 'truth', 5: 'chance', 8: 'mystery', 10: 'jail', 12: 'shop', 14: 'truth', 15: 'chance', 17: 'mystery', 19: 'shop' });
export const BOARD_DENSE: CellKind[] = layout({ 5: 'chance', 8: 'mystery', 11: 'jail', 14: 'truth', 17: 'shop' });
export const DENSE_BOARD_MAX_ROUNDS = 12;

// ─── ⑦ 数值 ───────────────────────────────────────────────────────────────

export const GAME_NUMBERS = {
  startCoins: 5,        // 开局每人
  coinLight: 1,         // 强度 1-2
  coinMedium: 2,        // 强度 3-4
  coinHeavy: 3,         // 强度 5-6
  coinSuper: 5,         // 超级任务
  buyoutCost: 8,        // 超级任务买断
  lapBonus: 2,          // 路过/踩中起点
  cardCost: 3,          // 商店摸卡
  handLimit: 3,         // 手牌上限（暂存位同样 3）
  toll: 3,              // 过路费（暴君 +1）
  jailTurns: 1,         // 监狱关几轮
  swapCap: 3,           // 每人每局换题次数
  swapCost: 1,          // 换题赔对方
  markFoundReward: 3,   // 淫纹被猜中，猜的人 +3
  markHiddenReward: 5,  // 淫纹整局没被找到，持有者 +5
  sleepWakeBonus: 1,    // 睡美人醒来 +1
  gambleGuess: 1,       // 赌徒押大小 ±1
  tiebreakRounds: 2,    // 平局加掷：再加几回合
  identityTenure: 3,    // 身份任期保护：抽卡格满几回合才换
  mysteryGoodChance: 0.4,
};

// 📝 SUPER_CAN_EXCEED_RANGE：🔥超级任务能不能超过本局强度区间
//   · true = 原版：比当前窗口再高 1-2 级，封顶 6（medium 局也可能抽到 6）。
//   · false = 封顶在本局区间的最高档。
export const SUPER_CAN_EXCEED_RANGE = true;

// ─── ⑧ 功能卡 ─────────────────────────────────────────────────────────────

// 📝 FUNCTION_CARDS：🎴 抽卡格 / 🛒 商店 / 未知格「摸卡」随机发（原版 CARD_POOL）
//   · effect 是引擎执行的效果，不要改；name / value / description 可以改。
export const FUNCTION_CARDS: FunctionCardDef[] = [
  { name: '🔙 回退', effect: 'push_back', value: 3, description: '对手后退3格' },
  { name: '🔒 入狱', effect: 'send_jail', value: 0, description: '送对手进监狱' },
  { name: '🔓 出狱', effect: 'jail_free', value: 0, description: '正被关着→当场出狱；没被关→攒着免疫下次进监狱' },
  { name: '⏩ 加速', effect: 'double_roll', value: 0, description: '下一轮再掷一次（连走两回合）' },
  { name: '💰 抢劫', effect: 'steal_coins', value: 3, description: '偷对手3币' },
  { name: '🎰 赌一把', effect: 'gamble', value: 3, description: '掷硬币：赢→对手给你3币，输→你给对手3币' },
  { name: '💰 收租', effect: 'collect_rent', value: 1, description: '对手按你的地盘数交租（每块地1币）' },
  { name: '💸 敲诈', effect: 'extort', value: 2, description: '逼对手交2币（没钱用身体抵）' },
];

// ─── ⑨ 未知格 ─────────────────────────────────────────────────────────────

// 📝 MYSTERY：好运 40%（幸运儿 75%）/ 坏运 60%，各自等概率抽一条。effect 不要改。
export const MYSTERY_GOOD: MysteryEventDef[] = [
  { name: '⬅️ 推人', effect: 'push_opponent', desc: '对手后退3格' },
  { name: '💰 发财', effect: 'bonus_coins', desc: '获得3币' },
  { name: '🍀 捡钱', effect: 'found_coins', desc: '路上捡到2币' },
  { name: '🎴 摸卡', effect: 'free_card', desc: '免费摸一张功能卡' },
];
export const MYSTERY_BAD: MysteryEventDef[] = [
  { name: '🔥 超级任务', effect: 'super_task', desc: '比当前强度档再高1-2级（封顶6），不做交8币' },
  { name: '💸 罚款', effect: 'fine', desc: '交3币给对手' },
  { name: '🔒 入狱', effect: 'go_jail', desc: '直接进监狱' },
  { name: '🎭 暴露', effect: 'expose', desc: '抽一道真心话，你必须答（不给币）' },
  { name: '⏪ 倒退', effect: 'go_back', desc: '后退5格' },
  { name: '🫣 羞耻', effect: 'shame_task', desc: '做一个羞耻展示任务，不能买断' },
];

// ─── ⑩ 淫纹 ───────────────────────────────────────────────────────────────

// 📝 MARK_PARTS：淫纹可能藏的部位（原版 MARK_SPOTS）。候选给双方看，藏在哪只有引擎知道。
export const MARK_PARTS = ['耳垂', '后颈', '锁骨', '乳头', '腰侧', '肚脐', '大腿内侧', '膝窝', '脚踝', '手腕', '背脊', '臀'];

// ─── ⑪ 对决 / 终局 / 飞鸟 ─────────────────────────────────────────────────

export const DUEL_HINT = '两人一起做这道，谁先破功（先出声/求饶/高潮/受不了）谁输，输的任赢家处置一道（不赌币）。';
export const FINAL_ORDER_HINT = '终极指令同样不能越过红线；飞鸟依然随时有效。';
export const TIE_HINT = '平局两条路：① 平手言和，各砸对方一道终极指令；② 加掷决胜，两人各再掷一轮，还平就再加。';
export const BIRD_TEXT = '游戏立刻停，不追问理由。想继续再点「继续这局」，想结束就结束。';
export const BIRD_WORDS = ['飞鸟', '404'];

// ─── ⑫ AI 线路 ────────────────────────────────────────────────────────────

// 📝 DEALER_NAME：荷官的称呼，不要和 TA 同名
export const DEALER_NAME = '荷官';

// 📝 两条线路用的模型（留空 = 用 App 设置里的主 API 和模型）
//   · DEALER：荷官建议用稳定、听话、便宜的模型；可以连接口一起换。
//   · TA_MODEL：留空 = 角色平时聊天用的那个模型。
export const DEALER_API = { baseUrl: '', apiKey: '', model: '' };
export const TA_MODEL = '';
export const AI_TEMPERATURE = { dealer: 0.3, ta: 0.9 };

// 📝 CHAT_MIRROR：游戏里的对话伪装成普通聊天消息写进这个角色的聊天记录，记忆宫殿会自动整理
//   · dialogue：你对 TA 说的话 + TA 的回复 · tasks：每道新题记一条系统消息
//   · milestones：开局 / 飞鸟 / 结束 · dealer：荷官播报（默认关）
export const CHAT_MIRROR = {
  enabled: true,
  dialogue: true,
  tasks: true,
  milestones: true,
  dealer: false,
  tag: '〔大富翁〕',
};
