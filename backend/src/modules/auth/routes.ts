import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler";
import { validate } from "../../middleware/validate";
import { requireAuth } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rateLimit";
import { ok } from "../../utils/serialize";
import { prisma } from "../../db/prisma";
import { createCaptcha } from "../../services/captcha";
import { AppError } from "../../utils/errors";
import { changePasswordSchema, loginSchema, registerSchema } from "./schemas";
import {
  captchaRequired,
  changePassword,
  loginUser,
  logoutUser,
  refreshSession,
  registerUser,
} from "./service";

export const authRouter = Router();

const loginLimiter = rateLimit({ scope: "login", limit: 20, windowSeconds: 60 });
const registerLimiter = rateLimit({ scope: "register", limit: 10, windowSeconds: 600 });

authRouter.post(
  "/register",
  registerLimiter,
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const user = await registerUser(req.body);
    res.status(201).json(ok(req, { user }));
  }),
);

authRouter.post(
  "/login",
  loginLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const result = await loginUser(req.body, req, res);
    res.json(ok(req, result));
  }),
);

authRouter.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const result = await refreshSession(req, res);
    res.json(ok(req, result));
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    await logoutUser(req, res);
    res.json(ok(req, { loggedOut: true }));
  }),
);

/**
 * 图形验证码。
 * Redis 不可用时返回 required=false，前端据此跳过验证码步骤。
 */
authRouter.get(
  "/captcha",
  rateLimit({ scope: "captcha", limit: 60, windowSeconds: 60 }),
  asyncHandler(async (req, res) => {
    const challenge = await createCaptcha();
    res.json(
      ok(req, {
        required: Boolean(challenge),
        captchaId: challenge?.captchaId ?? null,
        svg: challenge?.svg ?? null,
      }),
    );
  }),
);

/** 登录页在提交前先问一次，用于决定是否展示验证码输入框 */
authRouter.get(
  "/captcha-required",
  asyncHandler(async (req, res) => {
    const account = typeof req.query.account === "string" ? req.query.account : "";
    if (!account) throw AppError.badRequest("请提供账号");
    res.json(ok(req, { required: await captchaRequired(account) }));
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        uuid: true,
        nickname: true,
        role: true,
        status: true,
        creditScore: true,
        creditTier: true,
        approvedCount: true,
        email: true,
        phone: true,
        createdAt: true,
        settings: {
          select: { defaultFuzzRadius: true, notifyEmail: true, notifyInapp: true, locale: true },
        },
      },
    });
    if (!user) throw AppError.notFound("用户不存在");

    const unreadCount = await prisma.notification.count({
      where: { userId: req.user!.id, readAt: null },
    });

    res.json(
      ok(req, {
        user: {
          uuid: user.uuid,
          nickname: user.nickname,
          role: user.role,
          status: user.status,
          creditScore: user.creditScore,
          creditTier: user.creditTier,
          approvedCount: user.approvedCount,
          email: user.email,
          phone: user.phone,
          createdAt: user.createdAt,
          settings: user.settings ?? {
            defaultFuzzRadius: 50,
            notifyEmail: true,
            notifyInapp: true,
            locale: "zh-CN",
          },
        },
        unreadNotifications: unreadCount,
      }),
    );
  }),
);

authRouter.patch(
  "/password",
  requireAuth,
  validate({ body: changePasswordSchema }),
  asyncHandler(async (req, res) => {
    await changePassword(req.user!.id, req.body, req, res);
    res.json(ok(req, { changed: true }));
  }),
);
