import type { ReportStatus } from "@prisma/client";
import { env } from "../../config/env";
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PRIVACY_SENSITIVE_REASONS,
  REPORT_MERGE_WINDOW_MS,
  REPORT_REASONS,
  REPORT_TARGET_TYPES,
  type ReportReason,
  type ReportTargetType,
} from "../../config/constants";
import { prisma } from "../../db/prisma";
import { AppError } from "../../utils/errors";
import { parsePagination, pagedResult } from "../../utils/pagination";
import { notify } from "../../services/notify";
import { recordAudit } from "../../services/audit";
import { applyCreditEvent } from "../../services/moderation/credit";
import { revokePublicVariants } from "../media/service";
import { isAdmin } from "../../types/auth";
import type { AuthUser } from "../../types/auth";
import { logger } from "../../utils/logger";

function assertReason(reason: string): asserts reason is ReportReason {
  if (!(reason in REPORT_REASONS)) {
    throw AppError.badRequest(`举报类型不合法：${reason}`);
  }
}

function assertTargetType(type: string): asserts type is ReportTargetType {
  if (!(REPORT_TARGET_TYPES as readonly string[]).includes(type)) {
    throw AppError.badRequest(`举报对象类型不合法：${type}`);
  }
}

function slaHoursFor(reason: ReportReason): number {
  return PRIVACY_SENSITIVE_REASONS.includes(reason) ? env.PRIVACY_REPORT_SLA_HOURS : env.REPORT_SLA_HOURS;
}

// 校验举报对象确实存在，避免出现指向空气的工单
async function assertTargetExists(type: ReportTargetType, targetId: bigint): Promise<{ ownerId?: bigint }> {
  switch (type) {
    case "spot": {
      const spot = await prisma.spot.findUnique({
        where: { id: targetId },
        select: { ownerId: true, deletedAt: true },
      });
      if (!spot || spot.deletedAt) throw AppError.notFound("举报的地点不存在");
      return { ownerId: spot.ownerId };
    }
    case "comment": {
      const comment = await prisma.comment.findUnique({
        where: { id: targetId },
        select: { userId: true, status: true },
      });
      if (!comment || comment.status === "deleted") throw AppError.notFound("举报的评论不存在");
      return { ownerId: comment.userId };
    }
    case "media": {
      const asset = await prisma.mediaAsset.findUnique({
        where: { id: targetId },
        select: { ownerId: true },
      });
      if (!asset) throw AppError.notFound("举报的图片不存在");
      return { ownerId: asset.ownerId };
    }
    case "user": {
      const user = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
      if (!user) throw AppError.notFound("举报的用户不存在");
      return { ownerId: user.id };
    }
    default:
      throw AppError.badRequest("不支持的举报对象类型");
  }
}

export interface CreateReportInput {
  targetType: string;
  targetId: bigint;
  reason: string;
  detail?: string;
}

export async function createReport(reporter: AuthUser, input: CreateReportInput) {
  assertReason(input.reason);
  assertTargetType(input.targetType);

  const target = await assertTargetExists(input.targetType, input.targetId);
  if (target.ownerId === reporter.id) {
    throw AppError.badRequest("不能举报自己发布的内容");
  }

  const existing = await prisma.report.findUnique({
    where: {
      reporterId_targetType_targetId: {
        reporterId: reporter.id,
        targetType: input.targetType,
        targetId: input.targetId,
      },
    },
  });
  if (existing) {
    throw AppError.conflict(ERROR_CODES.DUPLICATE_REPORT, "你已经举报过这条内容，我们会在处理完成后通知你");
  }

  // 同对象 24 小时内的多个举报合并到同一个工单，避免审核员重复劳动
  const mergeTarget = await prisma.report.findFirst({
    where: {
      targetType: input.targetType,
      targetId: input.targetId,
      status: { in: ["open", "in_review"] },
      mergedInto: null,
      createdAt: { gte: new Date(Date.now() - REPORT_MERGE_WINDOW_MS) },
    },
    orderBy: { createdAt: "asc" },
  });

  const slaDueAt = new Date(Date.now() + slaHoursFor(input.reason) * 3600000);

  const report = await prisma.report.create({
    data: {
      reporterId: reporter.id,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      detail: input.detail ?? null,
      slaDueAt,
      mergedInto: mergeTarget?.id ?? null,
      // 隐私类举报优先级更高，直接插到队列前面
      status: "open",
    },
    select: { id: true, reason: true, targetType: true, targetId: true, slaDueAt: true },
  });

  // 只统计"被合并进来"的其他举报，不含这条记录自己
  const mergedCount = mergeTarget
    ? await prisma.report.count({ where: { mergedInto: mergeTarget.id } })
    : 0;

  return {
    ...report,
    mergedInto: mergeTarget?.id ?? null,
    relatedCount: mergedCount,
    slaHours: slaHoursFor(input.reason),
    privacySensitive: PRIVACY_SENSITIVE_REASONS.includes(input.reason),
  };
}

const TARGET_LABEL: Record<ReportTargetType, string> = {
  spot: "地点条目",
  comment: "评论",
  media: "图片",
  user: "用户",
};

export async function listReports(query: {
  status?: ReportStatus;
  targetType?: string;
  overdueOnly?: boolean;
  page: number;
  pageSize: number;
}) {
  const pagination = parsePagination(query);

  const where = {
    mergedInto: null,
    ...(query.status ? { status: query.status } : { status: { in: ["open", "in_review"] as ReportStatus[] } }),
    ...(query.targetType ? { targetType: query.targetType } : {}),
    ...(query.overdueOnly ? { slaDueAt: { lt: new Date() } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.report.findMany({
      where,
      orderBy: [{ slaDueAt: "asc" }, { createdAt: "asc" }],
      skip: pagination.skip,
      take: pagination.take,
      include: {
        reporter: { select: { uuid: true, nickname: true } },
        handler: { select: { nickname: true } },
      },
    }),
    prisma.report.count({ where }),
  ]);

  const relatedCounts = await prisma.report.groupBy({
    by: ["mergedInto"],
    where: { mergedInto: { in: items.map((item) => item.id) } },
    _count: { _all: true },
  });
  const relatedByRoot = new Map(relatedCounts.map((row) => [row.mergedInto!.toString(), row._count._all]));

  const now = Date.now();

  return pagedResult(
    items.map((item) => ({
      id: item.id,
      targetType: item.targetType,
      targetId: item.targetId,
      targetLabel: TARGET_LABEL[item.targetType as ReportTargetType] ?? item.targetType,
      reason: item.reason,
      reasonLabel: REPORT_REASONS[item.reason as ReportReason] ?? item.reason,
      detail: item.detail,
      status: item.status,
      createdAt: item.createdAt,
      slaDueAt: item.slaDueAt,
      overdue: item.slaDueAt.getTime() < now && item.status === "open",
      privacySensitive: PRIVACY_SENSITIVE_REASONS.includes(item.reason as ReportReason),
      reporter: item.reporter,
      handler: item.handler?.nickname ?? null,
      relatedCount: relatedByRoot.get(item.id.toString()) ?? 0,
    })),
    total,
    pagination,
  );
}

// 举报详情里带上被举报对象的当前快照，审核员不必再去别处翻
async function loadTargetSnapshot(type: ReportTargetType, targetId: bigint) {
  switch (type) {
    case "spot": {
      const spot = await prisma.spot.findUnique({
        where: { id: targetId },
        select: {
          uuid: true,
          title: true,
          description: true,
          status: true,
          createdAt: true,
          publishedAt: true,
          category: { select: { name: true, code: true } },
          owner: { select: { uuid: true, nickname: true, creditScore: true } },
          media: {
            select: { uuid: true, privacyStatus: true, variantVersion: true },
            orderBy: { id: "asc" },
          },
        },
      });
      return spot;
    }
    case "comment": {
      return prisma.comment.findUnique({
        where: { id: targetId },
        select: {
          id: true,
          body: true,
          status: true,
          createdAt: true,
          hiddenReason: true,
          user: { select: { uuid: true, nickname: true, creditScore: true } },
          spot: { select: { uuid: true, title: true } },
        },
      });
    }
    case "media": {
      return prisma.mediaAsset.findUnique({
        where: { id: targetId },
        select: {
          uuid: true,
          privacyStatus: true,
          variantVersion: true,
          createdAt: true,
          originalPath: true,
          owner: { select: { uuid: true, nickname: true } },
          spot: { select: { uuid: true, title: true } },
        },
      });
    }
    default: {
      return prisma.user.findUnique({
        where: { id: targetId },
        select: { uuid: true, nickname: true, status: true, creditScore: true, createdAt: true },
      });
    }
  }
}

export async function getReportDetail(reportId: bigint) {
  const report = await prisma.report.findUnique({
    where: { id: reportId },
    include: {
      reporter: { select: { uuid: true, nickname: true, creditScore: true } },
      handler: { select: { nickname: true } },
      merged: { select: { id: true, reason: true, detail: true, createdAt: true } },
    },
  });
  if (!report) throw AppError.notFound("举报工单不存在");

  const snapshot = await loadTargetSnapshot(
    report.targetType as ReportTargetType,
    report.targetId,
  );

  const reporterHistory = await prisma.report.count({
    where: { reporterId: report.reporterId, status: "resolved" },
  });

  return {
    id: report.id,
    targetType: report.targetType,
    targetId: report.targetId,
    targetLabel: TARGET_LABEL[report.targetType as ReportTargetType] ?? report.targetType,
    reason: report.reason,
    reasonLabel: REPORT_REASONS[report.reason as ReportReason] ?? report.reason,
    detail: report.detail,
    status: report.status,
    createdAt: report.createdAt,
    slaDueAt: report.slaDueAt,
    privacySensitive: PRIVACY_SENSITIVE_REASONS.includes(report.reason as ReportReason),
    reporter: { ...report.reporter, resolvedReports: reporterHistory },
    handler: report.handler?.nickname ?? null,
    handleResult: report.handleResult,
    handledAt: report.handledAt,
    mergedReports: report.merged,
    targetSnapshot: snapshot,
  };
}

async function performResolveAction(
  type: ReportTargetType,
  targetId: bigint,
  reason: ReportReason,
): Promise<{ action: string; affectedOwnerId?: bigint; needsPrivacyRecheck?: boolean }> {
  switch (type) {
    case "spot": {
      const spot = await prisma.spot.findUnique({
        where: { id: targetId },
        select: { id: true, ownerId: true, uuid: true, status: true },
      });
      if (!spot) throw AppError.notFound("被举报的地点不存在");

      await prisma.spot.update({
        where: { id: spot.id },
        data: { status: "hidden", publicLat: null, publicLng: null },
      });
      await applyCreditEvent(spot.ownerId, "report_confirmed", {
        targetType: "spot",
        targetId: spot.id,
      });
      return { action: "spot_hidden", affectedOwnerId: spot.ownerId };
    }
    case "comment": {
      const comment = await prisma.comment.findUnique({
        where: { id: targetId },
        select: { id: true, userId: true, spot: { select: { uuid: true } } },
      });
      if (!comment) throw AppError.notFound("被举报的评论不存在");

      await prisma.comment.update({
        where: { id: comment.id },
        data: { status: "hidden", hiddenReason: `举报成立：${REPORT_REASONS[reason]}` },
      });
      await applyCreditEvent(comment.userId, "report_confirmed", {
        targetType: "comment",
        targetId: comment.id,
      });
      return { action: "comment_hidden", affectedOwnerId: comment.userId };
    }
    case "media": {
      const asset = await prisma.mediaAsset.findUnique({
        where: { id: targetId },
        select: { uuid: true, ownerId: true },
      });
      if (!asset) throw AppError.notFound("被举报的图片不存在");

      // 隐私类举报成立时必须让公开版本立即失效，不能等下一次渲染
      await revokePublicVariants(asset.uuid);
      await applyCreditEvent(asset.ownerId, "report_confirmed", {
        targetType: "media",
        targetId,
      });
      return { action: "media_variants_revoked", affectedOwnerId: asset.ownerId, needsPrivacyRecheck: true };
    }
    default: {
      const user = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
      if (!user) throw AppError.notFound("被举报的用户不存在");
      await applyCreditEvent(user.id, "report_confirmed", {
        targetType: "user",
        targetId,
      });
      return { action: "credit_penalty", affectedOwnerId: user.id };
    }
  }
}

export async function resolveReport(reportId: bigint, moderator: AuthUser, note: string) {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) throw AppError.notFound("举报工单不存在");
  if (report.status === "resolved" || report.status === "dismissed") {
    throw AppError.unprocessable(ERROR_CODES.SPOT_STATE_INVALID, "该工单已经处理过了");
  }

  const type = report.targetType as ReportTargetType;
  const reason = report.reason as ReportReason;
  const outcome = await performResolveAction(type, report.targetId, reason);

  await prisma.$transaction([
    prisma.report.update({
      where: { id: reportId },
      data: {
        status: "resolved",
        handledBy: moderator.id,
        handledAt: new Date(),
        handleResult: `${note}（执行动作：${outcome.action}）`,
      },
    }),
    prisma.report.updateMany({
      where: { mergedInto: reportId, status: { in: ["open", "in_review"] } },
      data: {
        status: "resolved",
        handledBy: moderator.id,
        handledAt: new Date(),
        handleResult: `随主工单 #${reportId.toString()} 一并处理`,
      },
    }),
  ]);

  await recordAudit({
    actorId: moderator.id,
    action: AUDIT_ACTIONS.REPORT_RESOLVE,
    targetType: report.targetType,
    targetId: report.targetId,
    reason: note,
    after: { reportId: reportId.toString(), action: outcome.action },
  });

  if (outcome.affectedOwnerId) {
    await notify({
      userId: outcome.affectedOwnerId,
      type: "report_result",
      title: "你发布的内容被下架",
      body: `${note}\n如认为处理有误，可在 7 天内提出申诉。`,
      payload: { reportId: reportId.toString(), targetType: type, targetId: report.targetId.toString() },
    });
  }

  await notify({
    userId: report.reporterId,
    type: "report_result",
    title: "你的举报已处理",
    body: `我们已核实并处理了这条${TARGET_LABEL[type]}。感谢你帮助维护地图质量。`,
    payload: { reportId: reportId.toString() },
  });

  logger.info({ reportId: reportId.toString(), action: outcome.action }, "举报成立并已处置");

  return {
    status: "resolved" as const,
    action: outcome.action,
    needsPrivacyRecheck: outcome.needsPrivacyRecheck ?? false,
  };
}

export async function dismissReport(reportId: bigint, moderator: AuthUser, note: string) {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) throw AppError.notFound("举报工单不存在");
  if (report.status === "resolved" || report.status === "dismissed") {
    throw AppError.unprocessable(ERROR_CODES.SPOT_STATE_INVALID, "该工单已经处理过了");
  }

  // 用户举报若被驳回，只能由管理员复核；避免审核员用驳回掩盖问题
  if (report.targetType === "user" && !isAdmin(moderator)) {
    throw AppError.forbidden("针对用户的举报只能由管理员处理");
  }

  await prisma.report.update({
    where: { id: reportId },
    data: {
      status: "dismissed",
      handledBy: moderator.id,
      handledAt: new Date(),
      handleResult: note,
    },
  });

  await recordAudit({
    actorId: moderator.id,
    action: AUDIT_ACTIONS.REPORT_DISMISS,
    targetType: report.targetType,
    targetId: report.targetId,
    reason: note,
  });

  await notify({
    userId: report.reporterId,
    type: "report_result",
    title: "你的举报未通过核实",
    body: `${note}\n被举报的内容会继续保留。如果你有更多信息，欢迎补充后再反馈。`,
    payload: { reportId: reportId.toString() },
  });

  return { status: "dismissed" as const };
}
