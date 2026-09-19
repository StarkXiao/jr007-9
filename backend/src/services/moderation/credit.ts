import { Prisma, type CreditEventType, type CreditTier } from "@prisma/client";
import { prisma, toJsonValue } from "../../db/prisma";
import {
  APPEAL_COMPENSATION,
  CREDIT_HALF_LIFE_DAYS,
  TIER_POLICY,
  clampCredit,
  computeCredit,
  effectiveAmount,
  nextTierGoal,
  rateScore,
  tierForScore,
  violationAmount,
  type TierPolicy,
} from "./creditPolicy";
import { notify } from "../notify";
import { logger } from "../../utils/logger";

export {
  clampCredit,
  computeCredit,
  rateScore,
  tierForScore,
  effectiveAmount,
  violationAmount,
  severityForReason,
  APPEAL_COMPENSATION,
  CREDIT_HALF_LIFE_DAYS,
  VIOLATION_BASE,
  MERIT_BASE,
  REASON_SEVERITY,
  TIER_POLICY,
  TIER_RESTRICTED_SCORE,
  TIER_FROZEN_SCORE,
  TIER_TRUSTED_SCORE,
  TRUSTED_MIN_APPROVED,
  effectiveDailySpotLimit,
  nextTierGoal,
} from "./creditPolicy";

/** 旧调用方仍引用的名义分值（实际扣分由策略层按严重度计算） */
export const CREDIT_DELTAS = {
  SPOT_APPROVED: 2,
  SPOT_REJECTED: -8,
  SPOT_AUTO_REJECTED_OVERRIDE: -5,
  COMMENT_HIDDEN: -10,
  REPORT_CONFIRMED_ON_USER: -15,
  APPEAL_UPHELD: 6,
} as const;

// ------------------------------------------------------------------ 类型

export interface RecordEventInput {
  userId: bigint;
  type: CreditEventType;
  reasonCode?: string | null;
  reason?: string | null;
  targetType?: string | null;
  targetId?: bigint | null;
  actorId?: bigint | null;
  meta?: Record<string, unknown> | null;
  /** 不传时按类型基准 + 原因码严重度自动算分 */
  amount?: number;
  occurredAt?: Date;
}

export interface UserDecisionStats {
  approved: number;
  rejected: number;
}

export interface CreditRecomputeResult {
  score: number;
  tier: CreditTier;
  previousTier: CreditTier | null;
  violationScore: number;
  meritScore: number;
  adjustmentScore: number;
  rateScore: number;
}

// ------------------------------------------------------------------ 历史通过率

const FINAL_APPROVED = ["approved", "appeal_approved"] as const;
const FINAL_REJECTED = ["rejected", "appeal_rejected"] as const;

/**
 * 统计用户的终审结论：
 * - 只统计审核员/管理员真正做过结论的任务；
 * - 「要求修改」不算驳回（用户本来就还能改），也不算通过；
 * - 同一条目按最近一次终态去重，避免「驳回 → 修改后再提 → 通过」各算一次。
 */
export async function getUserDecisionStats(userId: bigint): Promise<UserDecisionStats> {
  const tasks = await prisma.reviewTask.findMany({
    where: {
      decidedBy: { not: null },
      OR: [{ status: { in: [...FINAL_APPROVED] } }, { status: { in: [...FINAL_REJECTED] } }],
      spot: { ownerId: userId },
    },
    select: { spotId: true, status: true, decidedAt: true },
    orderBy: { decidedAt: "desc" },
  });

  const latestBySpot = new Map<bigint, string>();
  for (const task of tasks) {
    if (!latestBySpot.has(task.spotId)) latestBySpot.set(task.spotId, task.status);
  }

  let approved = 0;
  let rejected = 0;
  for (const status of latestBySpot.values()) {
    if ((FINAL_APPROVED as readonly string[]).includes(status)) approved += 1;
    else rejected += 1;
  }
  return { approved, rejected };
}

// ------------------------------------------------------------------ 记账

function nominalAmount(type: CreditEventType, reasonCode?: string | null): number {
  switch (type) {
    case "spot_rejected":
    case "auto_rejected_override":
    case "comment_hidden":
    case "report_confirmed":
      return violationAmount(type, reasonCode);
    case "spot_approved":
      return 2;
    case "appeal_compensation":
      return APPEAL_COMPENSATION;
    case "appeal_restored":
    case "appeal_upheld":
    case "admin_adjust":
      return 0;
  }
}

const DECAYING_TYPES: ReadonlySet<CreditEventType> = new Set([
  "spot_rejected",
  "auto_rejected_override",
  "comment_hidden",
  "report_confirmed",
  "spot_approved",
]);

/**
 * 记一条信用流水并立即重算信用分。
 * 信用分的唯一写入入口：所有违规、奖励、申诉改判、人工调整都必须走这里，
 * 这样任意时刻都能用流水把分数重放出来，不存在"不知道为什么被扣了分"。
 */
export async function recordCreditEvent(input: RecordEventInput): Promise<CreditRecomputeResult> {
  const amount = input.amount ?? nominalAmount(input.type, input.reasonCode);
  const decayDays = DECAYING_TYPES.has(input.type) ? CREDIT_HALF_LIFE_DAYS : null;

  await prisma.creditEvent.create({
    data: {
      userId: input.userId,
      type: input.type,
      amount,
      decayDays,
      reasonCode: input.reasonCode ?? null,
      reason: input.reason ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      actorId: input.actorId ?? null,
      meta: input.meta ? toJsonValue(input.meta) : Prisma.JsonNull,
      occurredAt: input.occurredAt ?? new Date(),
    },
  });

  return recomputeCredit(input.userId, { notifyOnTierChange: true });
}

// ------------------------------------------------------------------ 申诉改判

export interface AppealOverturnInput {
  userId: bigint;
  /** 原审核任务 id，用于找到对应的违规流水 */
  originalTaskId: bigint;
  /** 改判通过同时记一次贡献奖励（条目确实发布了） */
  grantApprovedMerit: boolean;
  reason?: string | null;
  actorId?: bigint | null;
}

/**
 * 申诉改判成立的信用结算：
 * 1. 找到原驳回产生的违规流水，记一条等额永久返还（appeal_restored）并反向指向它，
 *    原流水从此不再计入分数；
 * 2. 追加错判补偿（appeal_compensation，永久 +6）；
 * 3. 条目实际发布，按正常通过记贡献奖励。
 */
export async function settleAppealOverturn(input: AppealOverturnInput): Promise<CreditRecomputeResult> {
  const originalViolation = await prisma.creditEvent.findFirst({
    where: {
      userId: input.userId,
      targetType: "review_task",
      targetId: input.originalTaskId,
      type: "spot_rejected",
      reversed: { none: {} },
    },
    orderBy: { id: "desc" },
  });

  const data: Prisma.CreditEventCreateManyInput[] = [
    {
      userId: input.userId,
      type: "appeal_compensation",
      amount: APPEAL_COMPENSATION,
      decayDays: null,
      reason: input.reason ?? "申诉成立，错判补偿",
      targetType: "review_task",
      targetId: input.originalTaskId,
      actorId: input.actorId ?? null,
    },
  ];

  if (originalViolation) {
    data.unshift({
      userId: input.userId,
      type: "appeal_restored",
      amount: Math.abs(originalViolation.amount),
      decayDays: null,
      reason: input.reason ?? "申诉改判，返还原扣分",
      targetType: "review_task",
      targetId: input.originalTaskId,
      reversesId: originalViolation.id,
      actorId: input.actorId ?? null,
    });
  }

  if (input.grantApprovedMerit) {
    data.push({
      userId: input.userId,
      type: "spot_approved",
      amount: nominalAmount("spot_approved"),
      decayDays: CREDIT_HALF_LIFE_DAYS,
      reason: "申诉改判通过，条目发布",
      targetType: "review_task",
      targetId: input.originalTaskId,
      actorId: input.actorId ?? null,
    });
  }

  await prisma.creditEvent.createMany({ data });

  return recomputeCredit(input.userId, { notifyOnTierChange: true });
}

/** 申诉被终审驳回（维持原判）：记零分流水，便于追踪申诉行为 */
export async function settleAppealUpheld(input: {
  userId: bigint;
  originalTaskId: bigint;
  reason?: string | null;
  actorId?: bigint | null;
}): Promise<void> {
  await prisma.creditEvent.create({
    data: {
      userId: input.userId,
      type: "appeal_upheld",
      amount: 0,
      decayDays: null,
      reason: input.reason ?? "申诉经终审维持原结论",
      targetType: "review_task",
      targetId: input.originalTaskId,
      actorId: input.actorId ?? null,
    },
  });
}

// ------------------------------------------------------------------ 重算

const eventListSelect = {
  id: true,
  type: true,
  amount: true,
  decayDays: true,
  occurredAt: true,
  reasonCode: true,
  reason: true,
  targetType: true,
  targetId: true,
  reversesId: true,
  reversed: { select: { id: true } },
} as const;

async function loadCreditInputs(userId: bigint, now = new Date()) {
  const [events, decisionStats] = await Promise.all([
    prisma.creditEvent.findMany({ where: { userId }, select: eventListSelect, orderBy: { id: "asc" } }),
    getUserDecisionStats(userId),
  ]);

  // 被 appeal_restored 流水指向的原始违规，其分值从评分中剔除
  const reversedIds = new Set<bigint>();
  for (const event of events) {
    if (event.reversesId !== null) reversedIds.add(event.reversesId);
  }

  const breakdown = computeCredit({
    events: events.map((event) => ({
      id: event.id,
      type: event.type,
      amount: event.amount,
      decayDays: event.decayDays,
      occurredAt: event.occurredAt,
    })),
    reversedEventIds: reversedIds,
    decisionStats,
    now,
  });

  return { events, decisionStats, breakdown, reversedIds };
}

/**
 * 从流水 + 终审统计重算用户信用分与权限层，并落库快照。
 * 三个维度的分项一起存下，前端展示不需要再实时聚合。
 */
export async function recomputeCredit(
  userId: bigint,
  options: { notifyOnTierChange?: boolean; now?: Date } = {},
): Promise<CreditRecomputeResult> {
  const now = options.now ?? new Date();
  const { breakdown, decisionStats } = await loadCreditInputs(userId, now);
  const tier = tierForScore(breakdown.score, decisionStats);

  const current = await prisma.user.findUnique({
    where: { id: userId },
    select: { creditTier: true },
  });

  await prisma.user.update({
    where: { id: userId },
    data: {
      creditScore: breakdown.score,
      creditTier: tier,
      creditViolationScore: breakdown.violationScore,
      creditAppealScore: breakdown.adjustmentScore,
      creditRateScore: breakdown.rateScore,
      creditComputedAt: now,
    },
  });

  const previousTier = current?.creditTier ?? null;
  if (options.notifyOnTierChange && previousTier !== null && previousTier !== tier) {
    void notifyTierChange(userId, previousTier, tier, breakdown.score).catch((error) => {
      logger.warn({ err: (error as Error).message, userId: userId.toString() }, "信用分层变更通知失败");
    });
  }

  return {
    score: breakdown.score,
    tier,
    previousTier,
    violationScore: breakdown.violationScore,
    meritScore: breakdown.meritScore,
    adjustmentScore: breakdown.adjustmentScore,
    rateScore: breakdown.rateScore,
  };
}

const TIER_LABEL: Record<CreditTier, string> = {
  new: "新用户",
  standard: "正常",
  trusted: "可信贡献者",
  restricted: "受限",
  frozen: "冻结",
};

const TIER_RANK: Record<CreditTier, number> = {
  trusted: 4,
  standard: 3,
  new: 2,
  restricted: 1,
  frozen: 0,
};

async function notifyTierChange(userId: bigint, previous: CreditTier, next: CreditTier, score: number): Promise<void> {
  const downgrade = TIER_RANK[next] < TIER_RANK[previous];
  await notify({
    userId,
    type: "credit_tier_changed",
    title: downgrade ? `你的发布权限已调整为「${TIER_LABEL[next]}」` : `你的信用等级已提升为「${TIER_LABEL[next]}」`,
    body: downgrade
      ? `当前信用分 ${score}。近期违规或通过率偏低，提交名额与配图数量已被收紧；保持稳定贡献、申诉成功后会自动恢复。`
      : `当前信用分 ${score}，感谢高质量贡献，你已获得更多发布权限。`,
    payload: { previousTier: previous, tier: next, score },
  });
}

// ------------------------------------------------------------------ 读取

export interface CreditProfile {
  score: number;
  tier: CreditTier;
  policy: TierPolicy;
  breakdown: { violation: number; merit: number; adjustment: number; rate: number };
  decisionStats: UserDecisionStats;
  nextGoal: { tier: CreditTier; scoreGap: number; approvedGap: number } | null;
  events: Array<{
    id: string;
    type: CreditEventType;
    amount: number;
    effective: number;
    decayDays: number | null;
    reasonCode: string | null;
    reason: string | null;
    targetType: string | null;
    targetId: string | null;
    reversed: boolean;
    occurredAt: Date;
  }>;
}

export async function getCreditProfile(userId: bigint): Promise<CreditProfile> {
  const now = new Date();
  const { events, decisionStats, breakdown, reversedIds } = await loadCreditInputs(userId, now);
  const tier = tierForScore(breakdown.score, decisionStats);

  return {
    score: breakdown.score,
    tier,
    policy: TIER_POLICY[tier],
    breakdown: {
      violation: breakdown.violationScore,
      merit: breakdown.meritScore,
      adjustment: breakdown.adjustmentScore,
      rate: breakdown.rateScore,
    },
    decisionStats,
    nextGoal: nextTierGoal(breakdown.score, decisionStats),
    events: [...events]
      .reverse()
      .slice(0, 100)
      .map((event) => ({
        id: event.id.toString(),
        type: event.type,
        amount: event.amount,
        effective: Math.round(effectiveAmount(event, now)),
        decayDays: event.decayDays,
        reasonCode: event.reasonCode,
        reason: event.reason,
        targetType: event.targetType,
        targetId: event.targetId?.toString() ?? null,
        reversed: reversedIds.has(event.id),
        occurredAt: event.occurredAt,
      })),
  };
}

/**
 * 全量重算巡检：每天一次。
 * 违规按半衰期自然衰减，所以即使没有新事件，用户分数也应随时间回升；
 * 只处理「有流水或有过通过记录」的用户，纯新用户不动。
 * 分批游标遍历，避免用户量大时单次任务超时或漏人。
 */
export async function creditSweep(batchSize = 500): Promise<{ recomputed: number; tierChanged: number }> {
  let recomputed = 0;
  let tierChanged = 0;
  let cursor: bigint | undefined;

  for (;;) {
    const users = await prisma.user.findMany({
      where: {
        status: { in: ["active", "muted"] },
        OR: [{ creditEvents: { some: {} } }, { approvedCount: { gt: 0 } }],
      },
      select: { id: true },
      take: batchSize,
      ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: "asc" },
    });
    if (users.length === 0) break;

    for (const user of users) {
      const result = await recomputeCredit(user.id, { notifyOnTierChange: true });
      if (result.previousTier !== null && result.previousTier !== result.tier) tierChanged += 1;
    }

    recomputed += users.length;
    cursor = users[users.length - 1].id;
    if (users.length < batchSize) break;
  }

  return { recomputed, tierChanged };
}

// ------------------------------------------------------------------ 兼容旧调用

export async function incrementApprovedCount(userId: bigint): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { approvedCount: { increment: 1 } },
  });
}

/**
 * 条目新鲜度分数：基础分 50 + 确认数×10 − 天数衰减 − 过期上报×15。
 * 注意：这是「条目」的新鲜度，与用户信用分是两套指标。
 * 与文档第 9.4 节保持一致。
 */
export function computeFreshness(params: {
  confirmCount: number;
  staleReportCount: number;
  lastConfirmedAt: Date | null;
  publishedAt: Date | null;
  now?: Date;
}): number {
  const now = params.now ?? new Date();
  const reference = params.lastConfirmedAt ?? params.publishedAt;
  const days = reference ? Math.floor((now.getTime() - reference.getTime()) / 86400000) : 365;
  const decay = Math.max(0, Math.floor(days / 30)) * 10;

  const raw = 50 + params.confirmCount * 10 - decay - params.staleReportCount * 15;
  return clampCredit(raw);
}

/**
 * @deprecated 请改用 recordCreditEvent。裸分值调整记为永久 admin_adjust 流水，
 * 保证任何分值变动都在流水里可追溯。
 */
export async function adjustCredit(userId: bigint, delta: number, reason = "legacy_adjust"): Promise<number> {
  if (delta === 0) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { creditScore: true } });
    return user?.creditScore ?? 0;
  }
  const result = await recordCreditEvent({ userId, type: "admin_adjust", amount: delta, reason });
  return result.score;
}
