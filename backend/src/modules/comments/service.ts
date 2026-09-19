import type { CommentStatus } from "@prisma/client";
import {
  AUDIT_ACTIONS,
  COMMENT_EDIT_WINDOW_MS,
  COMMENT_MAX_EDITS,
  ERROR_CODES,
} from "../../config/constants";
import { env } from "../../config/env";
import { prisma } from "../../db/prisma";
import { AppError } from "../../utils/errors";
import { parsePagination, pagedResult } from "../../utils/pagination";
import { checkText } from "../../services/moderation/contentFilter";
import { applyCreditEvent, publishPermissions } from "../../services/moderation/credit";
import { notify } from "../../services/notify";
import { recordAudit } from "../../services/audit";
import { serializeComment } from "../shared/serialize";
import { isModerator } from "../../types/auth";
import type { AuthUser } from "../../types/auth";

const PII_CODE = ERROR_CODES.COMMENT_PII_BLOCKED;

function assertCommentContent(body: string): void {
  const result = checkText(body);
  const blocked = result.flags.filter((flag) => flag.type === "blocked");
  if (blocked.length > 0) {
    throw AppError.badRequest(`评论包含不允许的信息：${blocked.map((flag) => flag.label).join("、")}`);
  }
  const pii = result.flags.filter((flag) => flag.type === "pii");
  if (pii.length > 0) {
    // 这里不是"审核不通过"，而是提醒用户不要把自己的信息暴露在公开页面上
    throw new AppError(
      422,
      PII_CODE,
      `评论疑似包含个人信息（${pii.map((flag) => flag.label).join("、")}），请删除后再发送。这样既保护你自己，也保护他人。`,
      { labels: pii.map((flag) => flag.label) },
    );
  }
}

export async function listComments(
  spotUuid: string,
  query: { page: number; pageSize: number },
  viewer?: AuthUser,
) {
  const spot = await prisma.spot.findUnique({ where: { uuid: spotUuid }, select: { id: true, status: true } });
  if (!spot || spot.status !== "published") throw AppError.notFound("该地点不存在或尚未发布");

  const pagination = parsePagination(query);

  // 先取顶层评论，再一次性把回复取回来，避免 N+1 查询
  const [roots, total] = await Promise.all([
    prisma.comment.findMany({
      where: { spotId: spot.id, parentId: null, status: "visible" },
      orderBy: { createdAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
      include: { user: { select: { uuid: true, nickname: true } } },
    }),
    prisma.comment.count({ where: { spotId: spot.id, parentId: null, status: "visible" } }),
  ]);

  const replies = await prisma.comment.findMany({
    where: { parentId: { in: roots.map((root) => root.id) }, status: "visible" },
    orderBy: { createdAt: "asc" },
    include: { user: { select: { uuid: true, nickname: true } } },
  });

  // 作者与审核员能看到自己/待审评论的状态提示
  const pendingOwn = viewer
    ? await prisma.comment.findMany({
        where: {
          spotId: spot.id,
          userId: viewer.id,
          status: { in: ["pending", "hidden"] },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { user: { select: { uuid: true, nickname: true } } },
      })
    : [];

  const grouped = new Map<string, ReturnType<typeof serializeComment>[]>();
  for (const reply of replies) {
    const key = reply.parentId!.toString();
    grouped.set(key, [...(grouped.get(key) ?? []), serializeComment(reply)]);
  }

  return {
    ...pagedResult(
      roots.map((root) => ({
        ...serializeComment(root),
        replies: grouped.get(root.id.toString()) ?? [],
      })),
      total,
      pagination,
    ),
    ownPending: pendingOwn.map(serializeComment),
  };
}

export async function createComment(
  spotUuid: string,
  user: AuthUser,
  input: { body: string; parentId?: bigint },
) {
  const spot = await prisma.spot.findUnique({
    where: { uuid: spotUuid },
    select: { id: true, uuid: true, status: true, ownerId: true, title: true },
  });
  if (!spot || spot.status !== "published") throw AppError.notFound("该地点不存在或尚未发布");

  assertCommentContent(input.body);

  let parentAuthorId: bigint | null = null;
  if (input.parentId !== undefined) {
    const parent = await prisma.comment.findUnique({
      where: { id: input.parentId },
      select: { id: true, spotId: true, parentId: true, userId: true, status: true },
    });
    if (!parent || parent.status !== "visible") throw AppError.badRequest("要回复的评论不存在");
    if (parent.spotId !== spot.id) throw AppError.badRequest("回复的评论不属于该地点");
    // 只支持两级：对回复再回复时自动挂到顶层评论下
    if (parent.parentId !== null) {
      const root = await prisma.comment.findUnique({
        where: { id: parent.parentId },
        select: { id: true, userId: true },
      });
      input.parentId = root?.id ?? parent.id;
      parentAuthorId = root?.userId ?? parent.userId;
    } else {
      parentAuthorId = parent.userId;
    }
  }

  const since = new Date(Date.now() - 86400000);
  const [dailyCount, sameSpotCount, approvedComments] = await Promise.all([
    prisma.comment.count({ where: { userId: user.id, createdAt: { gte: since } } }),
    prisma.comment.count({
      where: { userId: user.id, spotId: spot.id, createdAt: { gte: since }, status: { not: "deleted" } },
    }),
    prisma.comment.count({ where: { userId: user.id, status: "visible" } }),
  ]);

  if (dailyCount >= env.DAILY_COMMENT_LIMIT) {
    throw AppError.conflict(ERROR_CODES.RATE_LIMITED, `每天最多发表 ${env.DAILY_COMMENT_LIMIT} 条评论`);
  }
  if (sameSpotCount >= 3) {
    throw AppError.conflict(ERROR_CODES.RATE_LIMITED, "同一个地点 24 小时内最多评论 3 次");
  }

  // 分级审核：优质用户直接信任，正常用户需积累 3 条过审评论，受限用户一律先审
  const permissions = publishPermissions(user.creditScore, {
    premoderateThreshold: env.PREMODERATE_CREDIT_THRESHOLD,
  });
  const trusted =
    permissions.commentTrust === "full" ||
    (permissions.commentTrust === "conditional" && approvedComments >= 3);
  const status: CommentStatus = trusted ? "visible" : "pending";

  const comment = await prisma.comment.create({
    data: {
      spotId: spot.id,
      userId: user.id,
      parentId: input.parentId ?? null,
      body: input.body,
      status,
    },
    include: { user: { select: { uuid: true, nickname: true } } },
  });

  if (parentAuthorId && parentAuthorId !== user.id) {
    await notify({
      userId: parentAuthorId,
      type: "comment_reply",
      title: "有人回复了你的评论",
      body: `${user.nickname}：${input.body.slice(0, 80)}`,
      payload: { spotUuid: spot.uuid, commentId: comment.id.toString() },
    });
  } else if (spot.ownerId !== user.id) {
    await notify({
      userId: spot.ownerId,
      type: "comment_reply",
      title: "你记录的地点有了新评论",
      body: `${user.nickname}：${input.body.slice(0, 80)}`,
      payload: { spotUuid: spot.uuid, commentId: comment.id.toString() },
    });
  }

  return {
    ...serializeComment(comment),
    pendingModeration: status === "pending",
  };
}

export async function updateComment(commentId: bigint, user: AuthUser, body: string) {
  const comment = await prisma.comment.findUnique({ where: { id: commentId } });
  if (!comment || comment.status === "deleted") throw AppError.notFound("评论不存在");
  if (comment.userId !== user.id) throw AppError.forbidden("只能编辑自己的评论");

  if (Date.now() - comment.createdAt.getTime() > COMMENT_EDIT_WINDOW_MS) {
    throw AppError.unprocessable(ERROR_CODES.SPOT_STATE_INVALID, "评论发布 10 分钟后不能再编辑");
  }
  if (comment.editCount >= COMMENT_MAX_EDITS) {
    throw AppError.unprocessable(ERROR_CODES.SPOT_STATE_INVALID, "评论只能编辑 1 次");
  }

  assertCommentContent(body);

  const [updated] = await prisma.$transaction([
    prisma.comment.update({
      where: { id: commentId },
      data: { body, edited: true, editCount: { increment: 1 } },
      include: { user: { select: { uuid: true, nickname: true } } },
    }),
    prisma.commentRevision.create({ data: { commentId, body: comment.body } }),
  ]);

  return serializeComment(updated);
}

export async function deleteComment(commentId: bigint, user: AuthUser) {
  const comment = await prisma.comment.findUnique({ where: { id: commentId } });
  if (!comment || comment.status === "deleted") throw AppError.notFound("评论不存在");
  if (comment.userId !== user.id && !isModerator(user)) {
    throw AppError.forbidden("只能删除自己的评论");
  }

  await prisma.comment.update({
    where: { id: commentId },
    data: { status: "deleted", hiddenReason: comment.userId === user.id ? "作者删除" : "管理员删除" },
  });

  return { id: commentId, status: "deleted" as const };
}

// ------------------------------------------------------------------ 评论审核

export async function listPendingComments(query: { page: number; pageSize: number }) {
  const pagination = parsePagination(query);

  const [items, total] = await Promise.all([
    prisma.comment.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
      skip: pagination.skip,
      take: pagination.take,
      include: {
        user: { select: { uuid: true, nickname: true, creditScore: true, approvedCount: true } },
        spot: { select: { uuid: true, title: true } },
      },
    }),
    prisma.comment.count({ where: { status: "pending" } }),
  ]);

  return pagedResult(
    items.map((item) => ({
      ...serializeComment(item),
      authorStats: item.user
        ? { creditScore: item.user.creditScore, approvedCount: item.user.approvedCount }
        : null,
      spot: item.spot,
    })),
    total,
    pagination,
  );
}

export async function approveComment(commentId: bigint, moderator: AuthUser) {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { id: true, status: true, userId: true },
  });
  if (!comment) throw AppError.notFound("评论不存在");
  if (comment.status !== "pending") {
    throw AppError.unprocessable(ERROR_CODES.SPOT_STATE_INVALID, `该评论当前状态为 ${comment.status}，无需审核`);
  }

  await prisma.comment.update({ where: { id: commentId }, data: { status: "visible" } });

  // 先审后发的评论通过审核，给信用分一个小幅回升——
  // 这是低信用用户重建信任的主要通道
  await applyCreditEvent(comment.userId, "comment_approved", {
    targetType: "comment",
    targetId: commentId,
  });

  await recordAudit({
    actorId: moderator.id,
    action: AUDIT_ACTIONS.REVIEW_APPROVE,
    targetType: "comment",
    targetId: commentId,
    after: { status: "visible" },
  });

  return { id: commentId, status: "visible" as const };
}

export async function hideComment(commentId: bigint, moderator: AuthUser, reason: string) {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    include: { spot: { select: { uuid: true } } },
  });
  if (!comment) throw AppError.notFound("评论不存在");

  await prisma.comment.update({
    where: { id: commentId },
    data: { status: "hidden", hiddenReason: reason },
  });

  await applyCreditEvent(comment.userId, "comment_hidden", {
    targetType: "comment",
    targetId: commentId,
  });

  await recordAudit({
    actorId: moderator.id,
    action: AUDIT_ACTIONS.REVIEW_REJECT,
    targetType: "comment",
    targetId: commentId,
    reason,
    after: { status: "hidden" },
  });

  await notify({
    userId: comment.userId,
    type: "comment_hidden",
    title: "你的评论已被隐藏",
    body: `${reason}\n如果你认为处理有误，可以在评论记录中提出申诉。`,
    payload: { spotUuid: comment.spot.uuid, commentId: commentId.toString() },
  });

  return { id: commentId, status: "hidden" as const };
}
