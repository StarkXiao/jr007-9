import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { ERROR_CODES } from "../config/constants";
import { prisma } from "../db/prisma";
import { AppError } from "../utils/errors";
import type { AuthUser } from "../types/auth";

export interface AccessTokenPayload {
  sub: string;
  role: string;
  type: "access";
}

export function signAccessToken(user: { uuid: string; role: string }): string {
  return jwt.sign({ sub: user.uuid, role: user.role, type: "access" }, env.JWT_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload;
  if (payload.type !== "access") {
    throw AppError.unauthorized("令牌类型不正确");
  }
  return payload;
}

async function loadUser(uuid: string): Promise<AuthUser | undefined> {
  const user = await prisma.user.findUnique({
    where: { uuid },
    select: {
      id: true,
      uuid: true,
      role: true,
      status: true,
      nickname: true,
      creditScore: true,
      creditTier: true,
      mutedUntil: true,
    },
  });
  if (!user) return undefined;

  // 禁言到期自动解除。
  // 这里做而不是只靠定时任务，是为了即使 worker 没在跑，
  // 被禁言的用户也不会变成永久禁言——那是不可接受的用户可见故障。
  if (user.status === "muted" && user.mutedUntil && user.mutedUntil.getTime() <= Date.now()) {
    await prisma.user
      .update({ where: { id: user.id }, data: { status: "active", mutedUntil: null } })
      .catch(() => undefined);
    return {
      id: user.id,
      uuid: user.uuid,
      role: user.role,
      status: "active" as const,
      nickname: user.nickname,
      creditScore: user.creditScore,
      creditTier: user.creditTier,
    };
  }

  return {
    id: user.id,
    uuid: user.uuid,
    role: user.role,
    status: user.status,
    nickname: user.nickname,
    creditScore: user.creditScore,
    creditTier: user.creditTier,
  };
}

function extractToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim() || undefined;
}

/**
 * 解析令牌但不强制登录。
 * 关键点：每次都回库取用户，保证封禁 / 改角色能立即生效，
 * 而不是等到 access token 过期才生效。
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);
  if (!token) return next();

  try {
    const payload = verifyAccessToken(token);
    const user = await loadUser(payload.sub);
    if (user && user.status !== "deleted") {
      req.user = user;
    }
  } catch {
    // 令牌无效时按游客处理，由 requireAuth 决定是否拒绝
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    return next(AppError.unauthorized("请先登录"));
  }
  if (req.user.status === "banned") {
    return next(new AppError(403, ERROR_CODES.ACCOUNT_BANNED, "账号已被封禁，无法执行该操作"));
  }
  next();
}

/** 写操作额外校验：被禁言用户不能发内容 */
export function requireActiveWriter(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(AppError.unauthorized("请先登录"));
  if (req.user.status === "banned") {
    return next(new AppError(403, ERROR_CODES.ACCOUNT_BANNED, "账号已被封禁，无法发布内容"));
  }
  if (req.user.status === "muted") {
    return next(new AppError(403, ERROR_CODES.ACCOUNT_MUTED, "账号处于禁言期，暂时无法发布内容"));
  }
  next();
}

export { loadUser };
