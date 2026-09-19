import type { Prisma, ReviewStatus } from "@prisma/client";
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  REVIEW_LOCK_MS,
  REVIEW_REASON_CODES,
  MAX_PAGE_SIZE,
} from "../../config/constants";
import { prisma } from "../../db/prisma";
import { AppError } from "../../utils/errors";
import { parsePagination, pagedResult } from "../../utils/pagination";
import { serializeMedia } from "../shared/serialize";
import { recordAudit } from "../../services/audit";
import type { AuthUser } from "../../types/auth";

// ------------------------------------------------------------------ 队列

export interface QueueQuery {
  status?: ReviewStatus;
  categoryCode?: string;
  hasMedia?: boolean;
  overdueOnly?: boolean;
  page: number;
  pageSize: number;
}

export async function listQueue(query: QueueQuery) {
  const pagination = parsePagination({
    page: query.page,
    pageSize: Math.min(query.pageSize, MAX_PAGE_SIZE),
  });

  const where: Prisma.ReviewTaskWhereInput = {
    status: query.status ?? { in: ["pending", "in_review"] },
  };

  const spotFilter: Prisma.SpotWhereInput = {};
  if (query.categoryCode) spotFilter.category = { code: query.categoryCode };
  if (query.hasMedia) spotFilter.media = { some: {} };
  if (Object.keys(spotFilter).length > 0) where.spot = spotFilter;
  if (query.overdueOnly) {
    where.decidedAt = null;
    where.slaDueAt = { lt: new Date() };
  }

  const [items, total] = await Promise.all([
    prisma.reviewTask.findMany({
      where,
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      skip: pagination.skip,
      take: pagination.take,
      include: {
        spot: {
          select: {
            uuid: true,
            title: true,
            status: true,
            category: { select: { code: true, name: true, color: true, icon: true } },
            owner: { select: { uuid: true, nickname: true, creditScore: true, creditTier: true, approvedCount: true } },
          },
        },
        assignee: { select: { nickname: true } },
      },
    }),
    prisma.reviewTask.count({ where }),
  ]);

  const mediaCounts = await prisma.mediaAsset.groupBy({
    by: ["spotId"],
    where: { spotId: { in: items.map((item) => item.spotId), not: null } },
    _count: { _all: true },
  });
  const mediaCountBySpot = new Map(
    mediaCounts
      .filter((row) => row.spotId !== null)
      .map((row) => [(row.spotId as bigint).toString(), row._count._all]),
  );

  const now = Date.now();

  return pagedResult(
    items.map((task) => ({
      id: task.id,
      status: task.status,
      priority: task.priority,
      createdAt: task.createdAt,
      slaDueAt: task.slaDueAt,
      overdue: task.decidedAt === null && task.slaDueAt.getTime() < now,
      claimedBy: task.assignee?.nickname ?? null,
      lockActive: task.lockedUntil !== null && task.lockedUntil.getTime() > now,
      lockExpiresAt: task.lockedUntil,
      spot: {
        uuid: task.spot.uuid,
        title: task.spot.title,
        status: task.spot.status,
        category: task.spot.category,
        mediaCount: mediaCountBySpot.get(task.spotId.toString()) ?? 0,
        author: {
          uuid: task.spot.owner.uuid,
          nickname: task.spot.owner.nickname,
          creditScore: task.spot.owner.creditScore,
          creditTier: task.spot.owner.creditTier,
          approvedCount: task.spot.owner.approvedCount,
        },
      },
    })),
    total,
    pagination,
  );
}

// 领取任务用一条带条件的 UPDATE 完成加锁。
// 应用层"先查再改"在并发下必然出现两个人同时拿到同一任务。
export async function claimTask(taskId: bigint, moderator: AuthUser) {
  const now = new Date();
  const updated = await prisma.reviewTask.updateMany({
    where: {
      id: taskId,
      status: { in: ["pending", "in_review", "appealed"] },
      OR: [{ assignedTo: null }, { lockedUntil: { lt: now } }, { assignedTo: moderator.id }],
    },
    data: {
      assignedTo: moderator.id,
      lockedUntil: new Date(now.getTime() + REVIEW_LOCK_MS),
      status: "in_review",
    },
  });

  if (updated.count === 0) {
    const task = await prisma.reviewTask.findUnique({
      where: { id: taskId },
      include: { assignee: { select: { nickname: true } } },
    });
    if (!task) throw AppError.notFound("审核任务不存在");
    throw AppError.conflict(
      ERROR_CODES.REVIEW_ALREADY_CLAIMED,
      `该任务已被 ${task.assignee?.nickname ?? "其他审核员"} 领取，请选择其他任务`,
    );
  }

  await recordAudit({
    actorId: moderator.id,
    action: AUDIT_ACTIONS.REVIEW_CLAIM,
    targetType: "review_task",
    targetId: taskId,
  });

  return { taskId, lockedUntil: new Date(Date.now() + REVIEW_LOCK_MS) };
}

export async function releaseTask(taskId: bigint, moderator: AuthUser) {
  const task = await prisma.reviewTask.findUnique({ where: { id: taskId } });
  if (!task) throw AppError.notFound("审核任务不存在");
  if (task.assignedTo !== moderator.id) throw AppError.forbidden("只能释放自己领取的任务");

  await prisma.reviewTask.update({
    where: { id: taskId },
    data: { assignedTo: null, lockedUntil: null, status: "pending" },
  });

  return { taskId, released: true };
}

// ------------------------------------------------------------------ 详情

export async function getTaskDetail(taskId: bigint, moderator: AuthUser) {
  const task = await prisma.reviewTask.findUnique({
    where: { id: taskId },
    include: {
      spot: {
        include: {
          category: { include: { schemas: { where: { isCurrent: true }, take: 1 } } },
          owner: { select: { uuid: true, nickname: true, creditScore: true, creditTier: true, approvedCount: true } },
          media: {
            orderBy: { id: "asc" },
            include: { blurRegions: { where: { ignored: false }, orderBy: { id: "asc" } } },
          },
          reviewTasks: {
            orderBy: { id: "desc" },
            take: 5,
            select: {
              id: true,
              status: true,
              reasonCode: true,
              decisionReason: true,
              decidedAt: true,
              decider: { select: { nickname: true } },
            },
          },
        },
      },
      revision: true,
      assignee: { select: { nickname: true } },
      appealOf: { include: { decider: { select: { nickname: true } } } },
    },
  });

  if (!task) throw AppError.notFound("审核任务不存在");

  const previous = await prisma.spotRevision.findFirst({
    where: { spotId: task.spotId, revisionNo: { lt: task.revision.revisionNo } },
    orderBy: { revisionNo: "desc" },
    select: { revisionNo: true, snapshot: true, createdAt: true },
  });

  const schema = task.spot.category.schemas[0];
  const now = Date.now();
  const lockActive = task.lockedUntil !== null && task.lockedUntil.getTime() > now;

  return {
    id: task.id,
    status: task.status,
    priority: task.priority,
    autoCheck: task.autoCheck ?? {},
    slaDueAt: task.slaDueAt,
    overdue: task.decidedAt === null && task.slaDueAt.getTime() < now,
    lockActive,
    lockExpiresAt: task.lockedUntil,
    claimedBy: task.assignee?.nickname ?? null,
    claimedByMe: task.assignedTo === moderator.id && lockActive,
    appeal: task.appealOf
      ? {
          originalTaskId: task.appealOf.id,
          text: task.appealText,
          originalReasonCode: task.appealOf.reasonCode,
          originalReason: task.appealOf.decisionReason,
          originalDecisionBy: task.appealOf.decider?.nickname ?? null,
          originalDecidedAt: task.appealOf.decidedAt,
        }
      : null,
    spot: {
      uuid: task.spot.uuid,
      status: task.spot.status,
      title: task.spot.title,
      description: task.spot.description,
      attributes: task.spot.attributes,
      category: {
        code: task.spot.category.code,
        name: task.spot.category.name,
        color: task.spot.category.color,
        icon: task.spot.category.icon,
      },
      schemaVersion: schema?.version ?? 0,
      schema: schema?.schema ?? {},
      exactLocation: { lat: task.spot.exactLat, lng: task.spot.exactLng },
      fuzzEnabled: task.spot.fuzzEnabled,
      fuzzRadiusM: task.spot.fuzzRadiusM,
      addressText: task.spot.addressText,
      createdAt: task.spot.createdAt,
      author: {
        uuid: task.spot.owner.uuid,
        nickname: task.spot.owner.nickname,
        creditScore: task.spot.owner.creditScore,
        creditTier: task.spot.owner.creditTier,
        approvedCount: task.spot.owner.approvedCount,
      },
      history: task.spot.reviewTasks,
    },
    revision: {
      revisionNo: task.revision.revisionNo,
      createdAt: task.revision.createdAt,
      schemaVersion: task.revision.schemaVersion,
      snapshot: task.revision.snapshot,
    },
    previousRevision: previous,
    media: task.spot.media.map((asset) => ({
      ...serializeMedia(asset),
      exifStripped: asset.exifStripped,
      detectionMeta: asset.detectionMeta ?? {},
      originalPurged: asset.originalPath === null,
      regions: asset.blurRegions,
    })),
    reasonCodes: REVIEW_REASON_CODES,
  };
}

export {
  approveTask,
  decideAppeal,
  listAppeals,
  moderationStats,
  rejectTask,
  requestChanges,
} from "./decisions";
