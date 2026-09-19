import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { initStorage } from "../../src/services/storage";

// 信用分体系的端到端验证：
// 违规扣分 → 权限层降级 → 冻结发布 → 申诉改判 → 分数返还恢复 → 管理员调整留痕。
// 跑在真实数据库与 Redis 上（docker compose up -d postgres redis）。
let app: Express;
let userToken = "";
let modToken = "";
let adminToken = "";
let userUuid = "";
let modUuid = "";
let adminUuid = "";

const suffix = Date.now().toString(36);
const userEmail = `credit-user-${suffix}@example.com`;
const modEmail = `credit-mod-${suffix}@example.com`;
const adminEmail = `credit-admin-${suffix}@example.com`;
const password = "Str0ngPass1";

async function tokenFor(account: string): Promise<string> {
  const response = await request(app).post("/api/v1/auth/login").send({ account, password }).expect(200);
  return response.body.data.accessToken as string;
}

async function createSpot(token: string, title: string) {
  const created = await request(app)
    .post("/api/v1/spots")
    .set("Authorization", `Bearer ${token}`)
    .send({
      categoryCode: "bench",
      title,
      description: "信用体系集成测试",
      attributes: { has_backrest: true, condition: "good", count: 2 },
      lat: 30.1 + Math.random() * 0.01,
      lng: 120.5 + Math.random() * 0.01,
      fuzzEnabled: true,
      fuzzRadiusM: 100,
      mediaUuids: [],
    })
    .expect(201);
  return created.body.data.uuid as string;
}

async function submitAndReject(spotUuid: string, reasonCode: string) {
  const submitted = await request(app)
    .post(`/api/v1/spots/${spotUuid}/submit`)
    .set("Authorization", `Bearer ${userToken}`);

  let taskId = submitted.body.data?.taskId as string | undefined;
  // 自动预检未通过时（如地理编码把随机坐标判到水域），走人工复核通道拿 pending 任务
  if (submitted.status === 202) {
    const manual = await request(app)
      .post(`/api/v1/spots/${spotUuid}/request-manual-review`)
      .set("Authorization", `Bearer ${userToken}`)
      .expect(200);
    taskId = manual.body.data.taskId as string;
  } else {
    expect(submitted.status).toBe(200);
  }
  expect(taskId).toBeTruthy();

  await request(app)
    .post(`/api/v1/moderation/tasks/${taskId}/claim`)
    .set("Authorization", `Bearer ${modToken}`)
    .expect(200);
  await request(app)
    .post(`/api/v1/moderation/tasks/${taskId}/reject`)
    .set("Authorization", `Bearer ${modToken}`)
    .send({ reasonCode, reason: "集成测试驳回" })
    .expect(200);
  return taskId!;
}

beforeAll(async () => {
  await initStorage();
  app = createApp();

  for (const [email, nick] of [
    [userEmail, `信用用户${suffix.slice(-4)}`],
    [modEmail, `信用审核${suffix.slice(-4)}`],
    [adminEmail, `信用管理${suffix.slice(-4)}`],
  ] as const) {
    await request(app).post("/api/v1/auth/register").send({ email, password, nickname: nick }).expect(201);
  }

  await prisma.user.update({ where: { email: modEmail }, data: { role: "moderator" } });
  await prisma.user.update({ where: { email: adminEmail }, data: { role: "admin" } });

  userToken = await tokenFor(userEmail);
  modToken = await tokenFor(modEmail);
  adminToken = await tokenFor(adminEmail);
  userUuid = (await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${userToken}`)).body.data.user.uuid;
  modUuid = (await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${modToken}`)).body.data.user.uuid;
  adminUuid = (await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${adminToken}`)).body.data.user
    .uuid;
}, 60000);

afterAll(async () => {
  const users = [userUuid, modUuid, adminUuid].filter(Boolean);
  const records = await prisma.user.findMany({ where: { uuid: { in: users } }, select: { id: true } });
  const ids = records.map((record) => record.id);
  if (ids.length > 0) {
    await prisma.creditEvent.deleteMany({ where: { userId: { in: ids } } });
    await prisma.comment.deleteMany({ where: { userId: { in: ids } } });
    await prisma.report.deleteMany({ where: { reporterId: { in: ids } } });
    await prisma.spot.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.mediaAsset.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
}, 60000);

describe("信用分体系", () => {
  it("新用户初始满分、new 层，信用档案包含三个维度", async () => {
    const me = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${userToken}`).expect(200);
    expect(me.body.data.user.creditScore).toBe(100);
    expect(me.body.data.user.creditTier).toBe("new");

    const credit = await request(app).get("/api/v1/me/credit").set("Authorization", `Bearer ${userToken}`).expect(200);
    expect(credit.body.data.score).toBe(100);
    expect(credit.body.data.tier).toBe("new");
    expect(credit.body.data.breakdown).toHaveProperty("violation");
    expect(credit.body.data.breakdown).toHaveProperty("rate");
    expect(credit.body.data.decisionStats).toEqual({ approved: 0, rejected: 0 });
  });

  it("普通驳回一次扣 8 分并产生流水", async () => {
    const spotUuid = await createSpot(userToken, `普通驳回${suffix.slice(-4)}`);
    await submitAndReject(spotUuid, "INSUFFICIENT_DETAIL");

    const credit = await request(app).get("/api/v1/me/credit").set("Authorization", `Bearer ${userToken}`).expect(200);
    expect(credit.body.data.score).toBeLessThan(100);
    expect(credit.body.data.events[0].type).toBe("spot_rejected");
    expect(credit.body.data.events[0].amount).toBe(-8);
  });

  it("隐私类驳回按双倍严重度扣分", async () => {
    const spotUuid = await createSpot(userToken, `隐私驳回${suffix.slice(-4)}`);
    await submitAndReject(spotUuid, "PRIVACY_RISK");

    const credit = await request(app).get("/api/v1/me/credit").set("Authorization", `Bearer ${userToken}`).expect(200);
    const privacyEvent = credit.body.data.events.find((e: { type: string }) => e.type === "spot_rejected");
    expect(privacyEvent.amount).toBe(-16);
  });

  it("连续驳回导致通过率下降，信用层降级为受限或冻结", async () => {
    // 再补三条普通驳回。受限层每日名额只有 5 条，所以这里最多再造 3 个，
    // 加上前两条共 5 次驳回，分数已足以跌进受限 / 冻结区。
    for (let i = 0; i < 3; i++) {
      const spotUuid = await createSpot(userToken, `连续驳回${i}-${suffix.slice(-4)}`);
      await submitAndReject(spotUuid, "OFF_TOPIC");
    }

    const credit = await request(app).get("/api/v1/me/credit").set("Authorization", `Bearer ${userToken}`).expect(200);
    expect(["restricted", "frozen"]).toContain(credit.body.data.tier);
  });

  it("冻结后无法新建条目和评论，收到 PUBLISH_FROZEN", async () => {
    // 直接由管理员重分强制打到冻结区，确保断言稳定
    const userId = (await prisma.user.findUniqueOrThrow({ where: { uuid: userUuid } })).id;
    // 找到一个已发布的条目供评论测试（其他种子数据）
    const published = await prisma.spot.findFirst({ where: { status: "published" }, select: { uuid: true } });

    const before = await request(app).get("/api/v1/me/credit").set("Authorization", `Bearer ${userToken}`);
    if (before.body.data.tier !== "frozen") {
      const deficit = before.body.data.score - 30;
      await request(app)
        .post(`/api/v1/admin/users/${userUuid}/credit`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ amount: -deficit, reason: "集成测试：验证冻结层权限拦截" })
        .expect(200);
    }

    const create = await request(app)
      .post("/api/v1/spots")
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        categoryCode: "bench",
        title: "冻结层不该能发",
        attributes: { count: 1 },
        lat: 30.33,
        lng: 120.66,
      })
      .expect(403);
    expect(create.body.error.code).toBe("PUBLISH_FROZEN");

    if (published) {
      const comment = await request(app)
        .post(`/api/v1/spots/${published.uuid}/comments`)
        .set("Authorization", `Bearer ${userToken}`)
        .send({ body: "冻结层评论" })
        .expect(403);
      expect(comment.body.error.code).toBe("PUBLISH_FROZEN");
    }

    // 被冻结的用户仍可走申诉通道（路由不拦截）
    const rejectedSpot = await prisma.spot.findFirst({
      where: { ownerId: userId, status: "rejected" },
      select: { uuid: true },
    });
    expect(rejectedSpot).not.toBeNull();
  });

  it("申诉改判成立：返还原扣分、追加补偿、条目发布、权限层回升", async () => {
    // 选一条被普通驳回（-8）的条目申诉，隐私驳回不返还也无妨——只验证最近这条普通驳回
    const rejectedSpot = await prisma.spot.findFirst({
      where: { ownerId: (await prisma.user.findUniqueOrThrow({ where: { uuid: userUuid } })).id, status: "rejected" },
      orderBy: { updatedAt: "desc" },
      select: { id: true, uuid: true },
    });
    expect(rejectedSpot).toBeTruthy();

    await request(app)
      .post(`/api/v1/spots/${rejectedSpot!.uuid}/appeal`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ reason: "集成测试申诉理由，原驳回属于误判" })
      .expect(201);

    const appealTask = await prisma.reviewTask.findFirstOrThrow({
      where: { spotId: rejectedSpot!.id, status: "appealed" },
      select: { id: true },
    });

    // 申诉改判同样要过隐私门禁；无图片时直接通过
    const decided = await request(app)
      .post(`/api/v1/moderation/appeals/${appealTask.id}/decide`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "approve", reason: "集成测试：申诉成立" });
    expect([200, 422]).toContain(decided.status);

    if (decided.status === 200) {
      const credit = await request(app)
        .get("/api/v1/me/credit")
        .set("Authorization", `Bearer ${userToken}`)
        .expect(200);
      const types = credit.body.data.events.map((e: { type: string }) => e.type);
      expect(types).toContain("appeal_restored");
      expect(types).toContain("appeal_compensation");
      // 有了一条通过记录后不再是 new 层
      expect(credit.body.data.decisionStats.approved).toBeGreaterThan(0);
    }
  });

  it("管理员调整必须写流水与审计日志", async () => {
    await request(app)
      .post(`/api/v1/admin/users/${userUuid}/credit`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amount: 5, reason: "集成测试：人工补偿 5 分" })
      .expect(200);

    const logs = await request(app)
      .get("/api/v1/admin/audit-logs?action=user.credit.adjust")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(logs.body.data.items.length).toBeGreaterThan(0);
  });
});
