import { prisma } from "../../db/prisma";

const MIN_CREDIT = 0;
const MAX_CREDIT = 100;

/**
 * 信用事件类型与分值。
 * 信用分的每一次变动都对应这里的一种事件，并落一条 credit_events 记录——
 * 分数必须可解释，用户才认账。
 */
export const CREDIT_DELTAS = {
  /** 条目通过审核 */
  spot_approved: 2,
  /** 条目被驳回（违规记录） */
  spot_rejected: -8,
  /** 自动预检未通过仍坚持转人工复核 */
  spot_auto_rejected_override: -5,
  /** 先审后发的评论通过审核（低分用户的回升通道） */
  comment_approved: 1,
  /** 评论被隐藏（违规记录） */
  comment_hidden: -10,
  /** 举报成立（违规记录） */
  report_confirmed: -15,
  /** 申诉改判通过：全额回抵原驳回的 -8，改判意味着原判有误 */
  appeal_approved: 8,
  /** 申诉维持原判 */
  appeal_rejected: -2,
  /** 历史通过率修正（每日巡检，差值动态计算） */
  pass_rate_adjustment: 0,
} as const;

export type CreditEventKind = keyof typeof CREDIT_DELTAS;

/** 事件类型的中文说明，用于 /me/credit 与管理后台展示 */
export const CREDIT_EVENT_LABELS: Record<CreditEventKind, string> = {
  spot_approved: "条目通过审核",
  spot_rejected: "条目被驳回",
  spot_auto_rejected_override: "预检未通过后坚持转人工",
  comment_approved: "评论通过审核",
  comment_hidden: "评论被隐藏",
  report_confirmed: "举报成立",
  appeal_approved: "申诉改判通过",
  appeal_rejected: "申诉维持原判",
  pass_rate_adjustment: "历史通过率修正",
};

export function clampCredit(value: number): number {
  return Math.max(MIN_CREDIT, Math.min(MAX_CREDIT, Math.round(value)));
}

/**
 * 记录一次信用事件并更新分数。
 * 加分与写流水在同一个事务里完成，且分数更新用一条带钳制的 UPDATE
 * （而不是"先查再改"），并发扣分不会互相覆盖。
 */
export async function applyCreditEvent(
  userId: bigint,
  kind: CreditEventKind,
  options: { targetType?: string; targetId?: bigint; note?: string; delta?: number } = {},
): Promise<number | null> {
  const delta = options.delta ?? CREDIT_DELTAS[kind];

  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ credit_score: number }>>`
      UPDATE "users"
      SET "credit_score" = GREATEST(${MIN_CREDIT}, LEAST(${MAX_CREDIT}, "credit_score" + ${delta})),
          "updated_at" = now()
      WHERE "id" = ${userId}
      RETURNING "credit_score"
    `;
    const scoreAfter = rows[0]?.credit_score;
    if (scoreAfter === undefined) return null;

    await tx.creditEvent.create({
      data: {
        userId,
        kind,
        delta,
        scoreAfter,
        targetType: options.targetType ?? null,
        targetId: options.targetId ?? null,
        note: options.note ?? null,
      },
    });

    return scoreAfter;
  });
}

export async function incrementApprovedCount(userId: bigint): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { approvedCount: { increment: 1 } },
  });
}

// ------------------------------------------------------------------ 信用等级与发布权限

export type CreditTier = "trusted" | "standard" | "limited" | "restricted";

export const CREDIT_TIER_LABELS: Record<CreditTier, string> = {
  trusted: "优质贡献者",
  standard: "正常",
  limited: "受限",
  restricted: "限制发布",
};

/** 优质档分数线；评论免预审线由 env.PREMODERATE_CREDIT_THRESHOLD 配置 */
export const TRUSTED_CREDIT_THRESHOLD = 80;
/** 低于该分数进入限制档：暂停新发布，只保留修改与评论（先审）的回升通道 */
export const RESTRICTED_CREDIT_THRESHOLD = 40;

export function creditTier(score: number, premoderateThreshold = 60): CreditTier {
  if (score >= TRUSTED_CREDIT_THRESHOLD) return "trusted";
  if (score >= premoderateThreshold) return "standard";
  if (score >= RESTRICTED_CREDIT_THRESHOLD) return "limited";
  return "restricted";
}

export interface PublishPermissions {
  tier: CreditTier;
  tierLabel: string;
  /** 每日可提交条目数，0 表示暂停新发布 */
  dailySpotLimit: number;
  /** 每条目最多图片数，0 表示不能带图 */
  maxPhotosPerSpot: number;
  /** 是否允许上传图片 */
  canUploadImages: boolean;
  /** 评论信任级别：直接发布 / 积累 3 条过审后直接发布 / 一律先审 */
  commentTrust: "full" | "conditional" | "premoderated";
  /** 自动预检未通过后能否坚持转人工复核 */
  canOverrideAutoReject: boolean;
}

export interface PublishPermissionOptions {
  /** 评论免预审分数线，默认 60（对应 env.PREMODERATE_CREDIT_THRESHOLD） */
  premoderateThreshold?: number;
  /** 满额每日提交上限，默认 20（对应 env.DAILY_SPOT_LIMIT） */
  dailySpotLimit?: number;
  /** 满额每条目图片数，默认 6 */
  maxPhotosPerSpot?: number;
}

/**
 * 由信用分推导发布权限范围——这是信用分唯一的落地方式：
 * 分数不直接惩罚人，而是收窄或放宽"能发什么、发多少"。
 */
export function publishPermissions(
  score: number,
  options: PublishPermissionOptions = {},
): PublishPermissions {
  const premoderateThreshold = options.premoderateThreshold ?? 60;
  const dailySpotLimit = options.dailySpotLimit ?? 20;
  const maxPhotosPerSpot = options.maxPhotosPerSpot ?? 6;

  const tier = creditTier(score, premoderateThreshold);

  switch (tier) {
    case "trusted":
      return {
        tier,
        tierLabel: CREDIT_TIER_LABELS[tier],
        dailySpotLimit,
        maxPhotosPerSpot,
        canUploadImages: true,
        commentTrust: "full",
        canOverrideAutoReject: true,
      };
    case "standard":
      return {
        tier,
        tierLabel: CREDIT_TIER_LABELS[tier],
        dailySpotLimit,
        maxPhotosPerSpot,
        canUploadImages: true,
        commentTrust: "conditional",
        canOverrideAutoReject: true,
      };
    case "limited":
      return {
        tier,
        tierLabel: CREDIT_TIER_LABELS[tier],
        dailySpotLimit: Math.max(1, Math.floor(dailySpotLimit / 4)),
        maxPhotosPerSpot: Math.max(1, Math.floor(maxPhotosPerSpot / 2)),
        canUploadImages: true,
        commentTrust: "premoderated",
        canOverrideAutoReject: true,
      };
    case "restricted":
      return {
        tier,
        tierLabel: CREDIT_TIER_LABELS[tier],
        dailySpotLimit: 0,
        maxPhotosPerSpot: 0,
        canUploadImages: false,
        commentTrust: "premoderated",
        canOverrideAutoReject: false,
      };
  }
}

// ------------------------------------------------------------------ 历史通过率

/** 通过率修正启用的最小已决提交数：样本太少时不做评价 */
export const PASS_RATE_MIN_DECIDED = 5;
export const PASS_RATE_BONUS_THRESHOLD = 0.85;
export const PASS_RATE_PENALTY_THRESHOLD = 0.4;
export const PASS_RATE_BONUS = 2;
export const PASS_RATE_PENALTY = -2;

export interface PassRateStats {
  approved: number;
  rejected: number;
  decided: number;
  /** decided 为 0 时为 null */
  rate: number | null;
}

/**
 * 统计历史通过率。
 * 被申诉推翻的驳回不算作"拒"：原驳回任务会被一条 appeal_approved 任务改判，
 * 因此驳回侧只统计"维持原判"与"未申诉的驳回"。
 */
export async function computePassRate(userId: bigint): Promise<PassRateStats> {
  const [approved, rejected] = await Promise.all([
    prisma.reviewTask.count({
      where: { spot: { ownerId: userId }, status: { in: ["approved", "appeal_approved"] } },
    }),
    prisma.reviewTask.count({
      where: {
        spot: { ownerId: userId },
        OR: [{ status: "appeal_rejected" }, { status: "rejected", appealedBy: { none: {} } }],
      },
    }),
  ]);

  const decided = approved + rejected;
  return {
    approved,
    rejected,
    decided,
    rate: decided > 0 ? approved / decided : null,
  };
}

/** 通过率对应的目标修正分（纯函数，便于测试） */
export function desiredPassRateAdjustment(stats: { decided: number; rate: number | null }): number {
  if (stats.rate === null || stats.decided < PASS_RATE_MIN_DECIDED) return 0;
  if (stats.rate >= PASS_RATE_BONUS_THRESHOLD) return PASS_RATE_BONUS;
  if (stats.rate <= PASS_RATE_PENALTY_THRESHOLD) return PASS_RATE_PENALTY;
  return 0;
}

/**
 * 把"目标修正分"与"已应用的修正分"对齐，差值作为一条新事件落库。
 * 幂等：通过率回升后之前扣的分会自动退回，反之亦然。
 */
export async function reconcilePassRateAdjustment(userId: bigint): Promise<{
  adjusted: boolean;
  desired: number;
  applied: number;
  stats: PassRateStats;
}> {
  const stats = await computePassRate(userId);
  const desired = desiredPassRateAdjustment(stats);

  const aggregate = await prisma.creditEvent.aggregate({
    _sum: { delta: true },
    where: { userId, kind: "pass_rate_adjustment" },
  });
  const applied = aggregate._sum.delta ?? 0;

  const diff = desired - applied;
  if (diff !== 0) {
    await applyCreditEvent(userId, "pass_rate_adjustment", {
      delta: diff,
      note: `历史通过率 ${Math.round((stats.rate ?? 0) * 100)}%（${stats.approved}/${stats.decided}）`,
    });
  }

  return { adjusted: diff !== 0, desired, applied, stats };
}

// ------------------------------------------------------------------ 新鲜度

/**
 * 计算新鲜度分数：基础分 50 + 确认数×10 − 天数衰减 − 过期上报×15。
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
