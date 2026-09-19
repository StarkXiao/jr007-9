import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { initStorage } from "../../src/services/storage";
import { reconcilePassRateAdjustment } from "../../src/services/moderation/credit";

// 信用分体系主链路：违规记录、申诉改判、评论过审进入分数，
// 分数再反过来决定发布权限范围。
// 跑在真实数据库与 Redis 上（docker compose up -d postgres redis）。
let app: Express;
let contributorToken = "";
let moderatorToken = "";
let adminToken = "";
let contributorId = 0n;
let contributorUuid = "";

const suffix = Date.now().toString(36);
const contributorEmail = `credit-user-${suffix}@example.com`;
const moderatorEmail = `credit-mod-${suffix}@example.com`;
const adminEmail = `credit-admin-${suffix}@example.com`;
const password = "Str0ngPass1";

async function login(account: string): Promise<string> {
  const response = await request(app).post("/api/v1/auth/login").send({ account, password }).expect(200);
  return response.body.data.accessToken as string;
}

async function creditOf(userId: bigint): Promise<number> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return user.creditScore;
}

/** 走一遍"提交 → 领取 → 驳回"，返回任务 id */
async function submitAndReject(title: string): Promise<string> {
  const created = await request(app)
    .post("/api/v1/spots")
    .set("Authorization", `Bearer ${contributorToken}`)
    .send({
      categoryCode: "bench",
      title,
      attributes: { has_backrest: true, condition: "good" },
      lat: 31.11,
      lng: 121.11,
    })
    .expect(201);

  const submitted = await request(app)
    .post(`/api/v1/spots/${created.body.data.uuid}/submit`)
    .set("Authorization", `Bearer ${contributorToken}`)
    .expect(200);

  const taskId = submitted.body.data.taskId as string;

  await request(app)
    .post(`/api/v1/moderation/tasks/${taskId}/claim`)
    .set("Authorization", `Bearer ${moderatorToken}`)
    .expect(200);
  await request(app)
    .post(`/api/v1/moderation/tasks/${taskId}/reject`)
    .set("Authorization", `Bearer ${moderatorToken}`)
    .send({ reasonCode: "INSUFFICIENT_DETAIL", reason: "细节不够，测试驳回" })
    .expect(200);

  return created.body.data.uuid as string;
}

beforeAll(async () => {
  await initStorage();
  app = createApp();

  await request(app)
    .post("/api/v1/auth/register")
    .send({ email: contributorEmail, password, nickname: `信用用户${suffix.slice(-4)}` })
    .expect(201);
  await request(app)
    .post("/api/v1/auth/register")
    .send({ email: moderatorEmail, password, nickname: `信用审核${suffix.slice(-4)}` })
    .expect(201);
  await request(app)
    .post("/api/v1/auth/register")
    .send({ email: adminEmail, password, nickname: `信用管理${suffix.slice(-4)}` })
    .expect(201);

  await prisma.user.update({ where: { email: moderatorEmail }, data: { role: "moderator" } });
  await prisma.user.update({ where: { email: adminEmail }, data: { role: "admin" } });

  contributorToken = await login(contributorEmail);
  moderatorToken = await login(moderatorEmail);
  adminToken = await login(adminEmail);

  const record = await prisma.user.findUniqueOrThrow({ where: { email: contributorEmail } });
  contributorId = record.id;
  contributorUuid = record.uuid;
}, 60000);

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { in: [contributorEmail, moderatorEmail, adminEmail] } },
    select: { id: true },
  });
  const ids = users.map((item) => item.id);

  if (ids.length > 0) {
    await prisma.comment.deleteMany({ where: { userId: { in: ids } } });
    await prisma.report.deleteMany({ where: { reporterId: { in: ids } } });
    await prisma.creditEvent.deleteMany({ where: { userId: { in: ids } } });
    await prisma.spot.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.mediaAsset.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
}, 60000);

describe("违规记录与申诉改判进入信用分", () => {
  let rejectedSpotUuid = "";

  it("条目被驳回扣分，且留下信用事件", async () => {
    rejectedSpotUuid = await submitAndReject(`信用驳回测试${suffix.slice(-4)}`);

    expect(await creditOf(contributorId)).toBe(92);

    const events = await prisma.creditEvent.findMany({
      where: { userId: contributorId, kind: "spot_rejected" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].delta).toBe(-8);
    expect(events[0].scoreAfter).toBe(92);
  });

  it("申诉维持原判再扣一笔", async () => {
    await request(app)
      .post(`/api/v1/spots/${rejectedSpotUuid}/appeal`)
      .set("Authorization", `Bearer ${contributorToken}`)
      .send({ reason: "我认为这条记录符合要求，请复核" })
      .expect(201);

    const appeal = await prisma.reviewTask.findFirstOrThrow({
      where: { status: "appealed" },
      orderBy: { id: "desc" },
    });

    await request(app)
      .post(`/api/v1/moderation/appeals/${appeal.id}/decide`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "uphold", reason: "复核后维持原结论" })
      .expect(200);

    expect(await creditOf(contributorId)).toBe(90);

    const event = await prisma.creditEvent.findFirstOrThrow({
      where: { userId: contributorId, kind: "appeal_rejected" },
    });
    expect(event.delta).toBe(-2);
  });

  it("申诉改判通过则全额回抵驳回扣分", async () => {
    const spotUuid = await submitAndReject(`信用改判测试${suffix.slice(-4)}`);
    expect(await creditOf(contributorId)).toBe(82);

    await request(app)
      .post(`/api/v1/spots/${spotUuid}/appeal`)
      .set("Authorization", `Bearer ${contributorToken}`)
      .send({ reason: "这条其实信息齐全，请管理员再看看" })
      .expect(201);

    const appeal = await prisma.reviewTask.findFirstOrThrow({
      where: { status: "appealed" },
      orderBy: { id: "desc" },
    });

    await request(app)
      .post(`/api/v1/moderation/appeals/${appeal.id}/decide`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "approve", reason: "确实是误判，予以发布" })
      .expect(200);

    // -8 又 +8，回到驳回前的分数
    expect(await creditOf(contributorId)).toBe(90);

    const event = await prisma.creditEvent.findFirstOrThrow({
      where: { userId: contributorId, kind: "appeal_approved" },
    });
    expect(event.delta).toBe(8);
  });
});

describe("发布权限随信用分动态调整", () => {
  it("限制档（< 40）不能新建条目、不能传图、不能强行转人工", async () => {
    await prisma.user.update({ where: { id: contributorId }, data: { creditScore: 30 } });

    const created = await request(app)
      .post("/api/v1/spots")
      .set("Authorization", `Bearer ${contributorToken}`)
      .send({
        categoryCode: "bench",
        title: `限制档测试${suffix.slice(-4)}`,
        attributes: { has_backrest: true, condition: "good" },
        lat: 31.2,
        lng: 121.2,
      });
    expect(created.status).toBe(403);

    const uploaded = await request(app)
      .post("/api/v1/uploads/images")
      .set("Authorization", `Bearer ${contributorToken}`)
      .attach("files", Buffer.from("fake-image"), "test.png");
    expect(uploaded.status).toBe(403);

    // 评论仍然可以发（先审后发），这是信用回升的通道
    const published = await prisma.spot.findFirst({ where: { status: "published" } });
    expect(published).not.toBeNull();
    const comment = await request(app)
      .post(`/api/v1/spots/${published!.uuid}/comments`)
      .set("Authorization", `Bearer ${contributorToken}`)
      .send({ body: "这个地方我去过，补充一下" })
      .expect(201);
    expect(comment.body.data.pendingModeration).toBe(true);
  });

  it("待审评论通过审核后信用分回升", async () => {
    const before = await creditOf(contributorId);

    const pending = await prisma.comment.findFirstOrThrow({
      where: { userId: contributorId, status: "pending" },
      orderBy: { id: "desc" },
    });

    await request(app)
      .post(`/api/v1/moderation/comments/${pending.id}/approve`)
      .set("Authorization", `Bearer ${moderatorToken}`)
      .expect(200);

    expect(await creditOf(contributorId)).toBe(before + 1);

    const event = await prisma.creditEvent.findFirstOrThrow({
      where: { userId: contributorId, kind: "comment_approved" },
    });
    expect(event.delta).toBe(1);
  });

  it("受限档（40–59）每日上限与图片数收窄", async () => {
    await prisma.user.update({ where: { id: contributorId }, data: { creditScore: 45 } });

    const overview = await request(app)
      .get("/api/v1/me/credit")
      .set("Authorization", `Bearer ${contributorToken}`)
      .expect(200);

    expect(overview.body.data.tier).toBe("limited");
    expect(overview.body.data.permissions.dailySpotLimit).toBe(5);
    expect(overview.body.data.permissions.maxPhotosPerSpot).toBe(3);

    // 超过 3 张图直接被拒
    const tooMany = await request(app)
      .post("/api/v1/spots")
      .set("Authorization", `Bearer ${contributorToken}`)
      .send({
        categoryCode: "bench",
        title: `受限档图片${suffix.slice(-4)}`,
        attributes: { has_backrest: true, condition: "good" },
        lat: 31.21,
        lng: 121.21,
        mediaUuids: [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()],
      });
    expect(tooMany.status).toBe(400);
  });

  it("/me/credit 返回分数、等级、权限与事件流水", async () => {
    const response = await request(app)
      .get("/api/v1/me/credit")
      .set("Authorization", `Bearer ${contributorToken}`)
      .expect(200);

    const data = response.body.data;
    expect(data.score).toBe(45);
    expect(data.tier).toBe("limited");
    expect(data.permissions.commentTrust).toBe("premoderated");
    expect(data.passRate.decided).toBeGreaterThan(0);
    expect(Array.isArray(data.recentEvents)).toBe(true);
    expect(data.recentEvents.length).toBeGreaterThan(0);
    expect(data.recentEvents[0].label).toBeTruthy();
  });

  it("管理端可以查看任意用户的信用事件，普通用户不行", async () => {
    const asAdmin = await request(app)
      .get(`/api/v1/admin/users/${contributorUuid}/credit-events`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(asAdmin.body.data.total).toBeGreaterThan(0);
    expect(asAdmin.body.data.items[0].label).toBeTruthy();

    await request(app)
      .get(`/api/v1/admin/users/${contributorUuid}/credit-events`)
      .set("Authorization", `Bearer ${contributorToken}`)
      .expect(403);
  });
});

describe("历史通过率修正", async () => {
  it("通过率高加分、走低扣分、回到中间自动退回", async () => {
    const category = await prisma.category.findUniqueOrThrow({ where: { code: "bench" } });

    const makeTask = async (status: "approved" | "rejected") => {
      const spot = await prisma.spot.create({
        data: {
          ownerId: contributorId,
          categoryId: category.id,
          status: "published",
          title: `通过率${status}${suffix.slice(-4)}`,
          exactLat: 31.3,
          exactLng: 121.3,
        },
      });
      const revision = await prisma.spotRevision.create({
        data: { spotId: spot.id, revisionNo: 1, editorId: contributorId, snapshot: {}, schemaVersion: 1 },
      });
      await prisma.reviewTask.create({
        data: {
          spotId: spot.id,
          revisionId: revision.id,
          status,
          decidedAt: new Date(),
          slaDueAt: new Date(),
        },
      });
    };

    // 前面的流程留下 1 次改判通过（appeal_approved）与 1 次维持原判（appeal_rejected），
    // 即基线 1 过 1 拒；被申诉推翻的原驳回任务不计入。
    const baseline = await creditOf(contributorId);

    // 样本达到 5 条前不做评价：先补到 2 过 1 拒（66.7%，中间档）
    await makeTask("approved");
    const warmup = await reconcilePassRateAdjustment(contributorId);
    expect(warmup.stats.decided).toBe(3);
    expect(warmup.desired).toBe(0);
    expect(warmup.adjusted).toBe(false);

    // 再补 4 条通过 → 6 过 1 拒 ≈ 85.7% → 高档，+2
    await makeTask("approved");
    await makeTask("approved");
    await makeTask("approved");
    await makeTask("approved");

    const high = await reconcilePassRateAdjustment(contributorId);
    expect(high.stats.rate).toBeGreaterThanOrEqual(0.85);
    expect(high.desired).toBe(2);
    expect(high.adjusted).toBe(true);
    expect(await creditOf(contributorId)).toBe(baseline + 2);

    // 幂等：同样的通过率再跑一次，不再产生新事件
    const again = await reconcilePassRateAdjustment(contributorId);
    expect(again.adjusted).toBe(false);
    expect(await creditOf(contributorId)).toBe(baseline + 2);

    // 补 1 条驳回 → 6 过 2 拒 = 75%，回到中间档，之前加的分自动退回
    await makeTask("rejected");
    const reverted = await reconcilePassRateAdjustment(contributorId);
    expect(reverted.desired).toBe(0);
    expect(reverted.adjusted).toBe(true);
    expect(await creditOf(contributorId)).toBe(baseline);

    // 再补 7 条驳回 → 6 过 9 拒 = 40% → 低档，-2
    for (let i = 0; i < 7; i += 1) await makeTask("rejected");
    const low = await reconcilePassRateAdjustment(contributorId);
    expect(low.stats.rate).toBeLessThanOrEqual(0.4);
    expect(low.desired).toBe(-2);
    expect(low.adjusted).toBe(true);
    expect(await creditOf(contributorId)).toBe(baseline - 2);

    const events = await prisma.creditEvent.findMany({
      where: { userId: contributorId, kind: "pass_rate_adjustment" },
      orderBy: { id: "asc" },
    });
    expect(events.map((event) => event.delta)).toEqual([2, -2, -2]);
  });
});
