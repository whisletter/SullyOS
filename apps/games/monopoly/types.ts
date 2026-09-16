// ⛔ 大富翁 · 类型（机制代码，不需要改）

export type Who = 'user' | 'ta';
export type Sex = '男' | '女';
export type Role = '攻' | '受';
export type Intensity = 'light' | 'medium' | 'heavy';
export type BackdoorMode = 'off' | 'open' | 'giveOnly';
export type IdentityMode = 'off' | 'mixed' | 'nsfw_only';
export type FirstMove = 'default' | 'user' | 'ta';
export type CellKind = 'start' | 'task' | 'truth' | 'chance' | 'mystery' | 'jail' | 'shop';

export interface MonopolySettings {
  intensity: Intensity;
  roles: Record<Who, Role>;
  pureTop: Record<Who, boolean>;
  backdoor: Record<Who, BackdoorMode>;
  redLineActive: boolean[];
  reversal: number;
  rounds: number;          // 总回合数（两人合计）
  identityMode: IdentityMode;
  firstMove: FirstMove;
}

export interface Profiles {
  names: Record<Who, string>;
  sexes: Record<Who, Sex | null>;
  taPersona: string;
}

// ─── 卡库 JSON 的字段（只描述结构，不关心内容） ───
export interface SkeletonSeg { 施动方?: string; 动作?: string; 用具?: string; 受动方?: string; 受动部位?: string }
export interface LibTask {
  强度: number;
  flavor: string;
  玩法类型: string;
  kink: string[];
  行动方需: string;
  对方需: string;
  target: string;
  内容: string;
  骨架?: SkeletonSeg[];
  穴承受方?: string | null;
  后庭承受方?: string | null;
  resolve?: string;
  内容_输?: string;
  [k: string]: unknown;
}
export interface LibTruth { 强度: number; 内容: string }
export interface IdentityEffect { type: string; value?: number | boolean; [k: string]: unknown }
export interface IdentityCard {
  name: string;
  nsfw?: boolean;
  hint?: string;
  behavior?: string;
  persona?: string[];
  effects: IdentityEffect[];
}

export type FnEffect = 'push_back' | 'send_jail' | 'jail_free' | 'double_roll' | 'steal_coins' | 'gamble' | 'collect_rent' | 'extort';
export interface FunctionCardDef { name: string; effect: FnEffect; value: number; description: string }

export type MysteryEffect = 'push_opponent' | 'bonus_coins' | 'found_coins' | 'free_card'
  | 'super_task' | 'fine' | 'go_jail' | 'expose' | 'go_back' | 'shame_task';
export interface MysteryEventDef { name: string; effect: MysteryEffect; desc: string }
