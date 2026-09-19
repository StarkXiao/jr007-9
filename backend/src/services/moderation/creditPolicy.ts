import type { CreditEventType, CreditTier } from "@prisma/client";

/**
 * 信用分策略层：全部是纯函数，不碰数据库，方便单测。
 *
 * 信用分 = 100
 *   + 违规记录分（按半衰期 180 天衰减，被申诉改判撤销的不计）
 *   + 贡献奖励分（通过审核，同样衰减）
 *   + 申诉/人工调整分（申诉改判返还、错判补偿、管理员调整，永久有效）
 *   + 历史通过率分（Beta 平滑后的通过率，±30）
 *
 * 设计理由见 README「信用体系」一节：任何一个维度都不能把用户一棍打死，
 * 违规会随时间被原谅，误判有返还通道，但长期记录差的人发布范围会被持续收窄。
 */

export const MIN_CREDIT = 0;
export const MAX_CREDIT = 100;

/** 违规与奖励流水的半衰期：180 天后影响减半，一年后约剩 1/4 */
export const CREDIT_HALF_LIFE_DAYS = 180;

/** 申诉改判成立时，除返还原扣分外的错判补偿（永久有效） */
export const APPEAL_COMPENSATION = 6;

/** 各违规类型的基准扣分量（未乘严重度权重前） */
export const VIOLATION_BASE: Record<string, number> = {
  spot_rejected: 8,
  auto_rejected_override: 5,
  comment_hidden: 10,
  report_confirmed: 15,
};

/** 单次贡献奖励 */
export const MERIT_BASE: Record<string, number> = {
  spot_approved: 2,
};

/**
 * 违规严重度权重，按审核原因码 / 举报原因码取值。
 * 隐私、广告、不当内容是平台红线，权重加倍；重复、侵权 1.5 倍。
 */
export const REASON_SEVERITY: Record<string, number> = {
  PRIVACY_RISK: 2,
  PRIVACY_LEAK: 2,
  ADVERTISING: 2,
  INAPPROPRIATE: 2,
  INFRINGEMENT: 1.5,
  DUPLICATE: 1.5,
};

export const VIOLATION_TYPES: ReadonlySet<CreditEventType> = new Set([
  "spot_rejected",
  "auto_rejected_override",
  "comment_hidden",
  "report_confirmed",
]);

export const MERIT_TYPES: ReadonlySet<CreditEventType> = new Set(["spot_approved"]);

export const PERMANENT_TYPES: ReadonlySet<CreditEventType> = new Set([
  "appeal_restored",
  "appeal_compensation",
  "appeal_upheld",
  "admin_adjust",
]);

export function clampCredit(value: number): number {
  return Math.max(MIN_CREDIT, Math.min(MAX_CREDIT, Math.round(value)));
}

export function severityForReason(reasonCode: string | null | undefined): number {
  if (!reasonCode) return 1;
  return REASON_SEVERITY[reasonCode] ?? 1;
}

/** 违规实际扣分 = 基准 × 严重度，钳制在 100 以内 */
export function violationAmount(type: CreditEventType, reasonCode?: string | null): number {
  const base = VIOLATION_BASE[type] ?? 0;
  return -Math.min(MAX_CREDIT, Math.round(base * severityForReason(reasonCode)));
}

// ------------------------------------------------------------------ 时间衰减

export interface DecayingEvent {
  /** 流水主键；被申诉撤销时按它排除 */
  id?: bigint | number;
  type: CreditEventType;
  amount: number;
  decayDays: number | null;
  occurredAt: Date;
}

/**
 * 流水在指定时刻的生效分值。
 * decayDays 即半衰期：空表示永久有效（申诉返还、管理员调整）。
 */
export function effectiveAmount(event: DecayingEvent, now: Date): number {
  if (event.decayDays === null || event.decayDays === undefined) return event.amount;
  const ageDays = (now.getTime() - event.occurredAt.getTime()) / 86400000;
  if (ageDays <= 0) return event.amount;
  return event.amount * Math.pow(0.5, ageDays / event.decayDays);
}

// ------------------------------------------------------------------ 历史通过率

export interface DecisionStats {
  approved: number;
  rejected: number;
}

/**
 * 把通过率映射到 ±30 分。
 *
 * 用 (approved + 1.2) / (total + 2) 做 Beta 平滑：没有记录时恰好在中性基线
 * 0.6（对应产品指标「一次通过率 ≥ 70%」的保守版本），得 0 分；
 * 样本很少时单次驳回不会直接把人打进受限层。
 */
export function rateScore(stats: DecisionStats): number {
  const total = stats.approved + stats.rejected;
  const smoothed = (stats.approved + 1.2) / (total + 2);
  const raw = (smoothed - 0.6) * 75;
  return Math.max(-30, Math.min(30, Math.round(raw)));
}

// ------------------------------------------------------------------ 汇总评分

export interface CreditScoreInput {
  events: DecayingEvent[];
  /** 已被申诉改判撤销的流水 id（其分值不再计入） */
  reversedEventIds?: ReadonlySet<bigint | number>;
  decisionStats: DecisionStats;
  now?: Date;
}

export interface CreditBreakdown {
  score: number;
  /** 违规记录分（负值或 0） */
  violationScore: number;
  /** 贡献奖励分（≥0） */
  meritScore: number;
  /** 申诉改判 + 人工调整分（永久有效，可正可负） */
  adjustmentScore: number;
  /** 历史通过率分（-30..30） */
  rateScore: number;
}

export function computeCredit(input: CreditScoreInput): CreditBreakdown {
  const now = input.now ?? new Date();
  const reversed = input.reversedEventIds ?? new Set<bigint | number>();

  let violation = 0;
  let merit = 0;
  let adjustment = 0;

  input.events.forEach((event) => {
    if (event.id !== undefined && reversed.has(event.id)) return;
    const value = effectiveAmount(event, now);
    if (VIOLATION_TYPES.has(event.type)) violation += value;
    else if (MERIT_TYPES.has(event.type)) merit += value;
    else if (PERMANENT_TYPES.has(event.type)) adjustment += value;
  });

  const violationScore = Math.round(violation);
  const meritScore = Math.round(merit);
  const adjustmentScore = Math.round(adjustment);
  const rate = rateScore(input.decisionStats);

  const score = clampCredit(100 + violationScore + meritScore + adjustmentScore + rate);

  return { score, violationScore, meritScore, adjustmentScore, rateScore: rate };
}

// ------------------------------------------------------------------ 权限分层

export const TIER_RESTRICTED_SCORE = 60;
export const TIER_FROZEN_SCORE = 40;
export const TIER_TRUSTED_SCORE = 85;
export const TRUSTED_MIN_APPROVED = 5;

export function tierForScore(score: number, decisionStats: DecisionStats): CreditTier {
  const decisions = decisionStats.approved + decisionStats.rejected;
  // 受限 / 冻结优先于「新用户」：没有审核结论不代表可以带着违规记录享受默认权限。
  // 典型场景：新用户的评论被举报成立，或坚持把预检未通过的内容转人工。
  if (score < TIER_FROZEN_SCORE) return "frozen";
  if (score < TIER_RESTRICTED_SCORE) return "restricted";
  // 没有任何终审结论且分数正常的账号按新用户预审
  if (decisions === 0) return "new";
  if (score >= TIER_TRUSTED_SCORE && decisionStats.approved >= TRUSTED_MIN_APPROVED) return "trusted";
  return "standard";
}

export interface TierPolicy {
  tier: CreditTier;
  label: string;
  /** 能否提交新条目（被冻结用户只能申诉、不能再发） */
  canSubmitSpots: boolean;
  /** 能否发表评论 */
  canComment: boolean;
  /** 每日提交名额相对系统基准值的倍数（受限层收紧，可信层放宽） */
  dailySpotMultiplier: number;
  /** 单条目最多附带图片数 */
  maxSpotMedia: number;
  /** 审核队列优先级加成（可信用户快速通道） */
  priorityBoost: number;
  /** 评论是否强制先审后发 */
  commentRequiresPremoderation: boolean;
  description: string;
}

export const TIER_POLICY: Record<CreditTier, TierPolicy> = {
  new: {
    tier: "new",
    label: "新用户",
    canSubmitSpots: true,
    canComment: true,
    dailySpotMultiplier: 1,
    maxSpotMedia: 6,
    priorityBoost: 0,
    commentRequiresPremoderation: true,
    description: "还没有通过审核的记录，发布内容会先进入人工审核。",
  },
  standard: {
    tier: "standard",
    label: "正常",
    canSubmitSpots: true,
    canComment: true,
    dailySpotMultiplier: 1,
    maxSpotMedia: 6,
    priorityBoost: 0,
    commentRequiresPremoderation: false,
    description: "发布权限正常，保持稳定贡献可以获得快速通道。",
  },
  trusted: {
    tier: "trusted",
    label: "可信贡献者",
    canSubmitSpots: true,
    canComment: true,
    dailySpotMultiplier: 2,
    maxSpotMedia: 6,
    priorityBoost: 2,
    commentRequiresPremoderation: false,
    description: "历史记录良好，提交名额更多，审核排队更靠前。",
  },
  restricted: {
    tier: "restricted",
    label: "受限",
    canSubmitSpots: true,
    canComment: true,
    dailySpotMultiplier: 0.25,
    maxSpotMedia: 3,
    priorityBoost: 0,
    commentRequiresPremoderation: true,
    description: "近期违规或通过率偏低，每日提交名额与配图数量已被收紧，所有内容先审后发。",
  },
  frozen: {
    tier: "frozen",
    label: "冻结",
    canSubmitSpots: false,
    canComment: false,
    dailySpotMultiplier: 0,
    maxSpotMedia: 0,
    priorityBoost: 0,
    commentRequiresPremoderation: true,
    description: "信用分过低，已暂停发布与评论权限；你仍可修改被驳回的内容并通过申诉恢复。",
  },
};

/** 生效的每日条目提交名额，至少保留 1 个名额给受限层（冻结层为 0） */
export function effectiveDailySpotLimit(baseLimit: number, tier: CreditTier): number {
  const policy = TIER_POLICY[tier];
  if (!policy.canSubmitSpots) return 0;
  return Math.max(1, Math.round(baseLimit * policy.dailySpotMultiplier));
}

/**
 * 距离下一权限层还差多少，供个人页给出可执行的提升建议。
 * 返回 null 表示已到顶或处于冻结（冻结层没有「只差几分」的承诺）。
 */
export function nextTierGoal(
  score: number,
  decisionStats: DecisionStats,
): { tier: CreditTier; scoreGap: number; approvedGap: number } | null {
  const tier = tierForScore(score, decisionStats);
  if (tier === "frozen") return null;
  if (tier === "trusted") return null;

  if (tier === "new" || tier === "restricted" || tier === "standard") {
    const scoreGap = Math.max(0, TIER_TRUSTED_SCORE - score);
    const approvedGap = Math.max(0, TRUSTED_MIN_APPROVED - decisionStats.approved);
    return { tier: "trusted", scoreGap, approvedGap };
  }
  return null;
}
