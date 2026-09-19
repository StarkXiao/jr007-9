import { describe, expect, it } from "vitest";
import {
  clampCredit,
  CREDIT_DELTAS,
  CREDIT_EVENT_LABELS,
  creditTier,
  desiredPassRateAdjustment,
  PASS_RATE_BONUS,
  PASS_RATE_MIN_DECIDED,
  PASS_RATE_PENALTY,
  publishPermissions,
  RESTRICTED_CREDIT_THRESHOLD,
  TRUSTED_CREDIT_THRESHOLD,
  type CreditEventKind,
} from "../../src/services/moderation/credit";

describe("信用分钳制", () => {
  it("分数被钳制在 0–100", () => {
    expect(clampCredit(120)).toBe(100);
    expect(clampCredit(-5)).toBe(0);
    expect(clampCredit(60)).toBe(60);
    expect(clampCredit(59.6)).toBe(60);
  });
});

describe("信用事件分值表", () => {
  it("每种事件都有中文说明，前端不会拿到裸代码", () => {
    for (const kind of Object.keys(CREDIT_DELTAS) as CreditEventKind[]) {
      expect(CREDIT_EVENT_LABELS[kind]).toBeTruthy();
    }
  });

  it("申诉改判通过全额回抵驳回扣分，误判不让用户长期背着", () => {
    expect(CREDIT_DELTAS.appeal_approved + CREDIT_DELTAS.spot_rejected).toBe(0);
  });

  it("违规类事件扣分，建设类事件加分", () => {
    expect(CREDIT_DELTAS.spot_rejected).toBeLessThan(0);
    expect(CREDIT_DELTAS.comment_hidden).toBeLessThan(0);
    expect(CREDIT_DELTAS.report_confirmed).toBeLessThan(0);
    expect(CREDIT_DELTAS.appeal_rejected).toBeLessThan(0);
    expect(CREDIT_DELTAS.spot_approved).toBeGreaterThan(0);
    expect(CREDIT_DELTAS.comment_approved).toBeGreaterThan(0);
  });
});

describe("信用等级划分", () => {
  it("按分数线分四档", () => {
    expect(creditTier(100)).toBe("trusted");
    expect(creditTier(TRUSTED_CREDIT_THRESHOLD)).toBe("trusted");
    expect(creditTier(TRUSTED_CREDIT_THRESHOLD - 1)).toBe("standard");
    expect(creditTier(60)).toBe("standard");
    expect(creditTier(59)).toBe("limited");
    expect(creditTier(RESTRICTED_CREDIT_THRESHOLD)).toBe("limited");
    expect(creditTier(RESTRICTED_CREDIT_THRESHOLD - 1)).toBe("restricted");
    expect(creditTier(0)).toBe("restricted");
  });

  it("评论免预审线可配置", () => {
    expect(creditTier(70, 75)).toBe("limited");
    expect(creditTier(70, 60)).toBe("standard");
  });
});

describe("发布权限随信用动态调整", () => {
  it("优质档：完整权限，评论直接信任", () => {
    const permissions = publishPermissions(90, { dailySpotLimit: 20, maxPhotosPerSpot: 6 });
    expect(permissions.tier).toBe("trusted");
    expect(permissions.dailySpotLimit).toBe(20);
    expect(permissions.maxPhotosPerSpot).toBe(6);
    expect(permissions.canUploadImages).toBe(true);
    expect(permissions.commentTrust).toBe("full");
    expect(permissions.canOverrideAutoReject).toBe(true);
  });

  it("正常档：完整权限，评论需积累过审记录", () => {
    const permissions = publishPermissions(60);
    expect(permissions.tier).toBe("standard");
    expect(permissions.commentTrust).toBe("conditional");
    expect(permissions.dailySpotLimit).toBe(20);
  });

  it("受限档：每日上限与图片数收窄，评论一律先审", () => {
    const permissions = publishPermissions(45, { dailySpotLimit: 20, maxPhotosPerSpot: 6 });
    expect(permissions.tier).toBe("limited");
    expect(permissions.dailySpotLimit).toBe(5);
    expect(permissions.maxPhotosPerSpot).toBe(3);
    expect(permissions.canUploadImages).toBe(true);
    expect(permissions.commentTrust).toBe("premoderated");
    expect(permissions.canOverrideAutoReject).toBe(true);
  });

  it("限制档：暂停新发布与传图，但保留评论回升通道", () => {
    const permissions = publishPermissions(10);
    expect(permissions.tier).toBe("restricted");
    expect(permissions.dailySpotLimit).toBe(0);
    expect(permissions.maxPhotosPerSpot).toBe(0);
    expect(permissions.canUploadImages).toBe(false);
    expect(permissions.commentTrust).toBe("premoderated");
    expect(permissions.canOverrideAutoReject).toBe(false);
  });

  it("受限档的收窄有下限，不会出现 0 张图配 5 条提交的怪组合", () => {
    const permissions = publishPermissions(45, { dailySpotLimit: 2, maxPhotosPerSpot: 1 });
    expect(permissions.dailySpotLimit).toBe(1);
    expect(permissions.maxPhotosPerSpot).toBe(1);
  });
});

describe("历史通过率修正", () => {
  it("样本不足时不做评价", () => {
    expect(desiredPassRateAdjustment({ decided: 0, rate: null })).toBe(0);
    expect(desiredPassRateAdjustment({ decided: PASS_RATE_MIN_DECIDED - 1, rate: 1 })).toBe(0);
    expect(desiredPassRateAdjustment({ decided: PASS_RATE_MIN_DECIDED - 1, rate: 0 })).toBe(0);
  });

  it("通过率 ≥ 85% 加分", () => {
    expect(desiredPassRateAdjustment({ decided: 10, rate: 0.85 })).toBe(PASS_RATE_BONUS);
    expect(desiredPassRateAdjustment({ decided: 20, rate: 1 })).toBe(PASS_RATE_BONUS);
  });

  it("通过率 ≤ 40% 扣分", () => {
    expect(desiredPassRateAdjustment({ decided: 10, rate: 0.4 })).toBe(PASS_RATE_PENALTY);
    expect(desiredPassRateAdjustment({ decided: 10, rate: 0 })).toBe(PASS_RATE_PENALTY);
  });

  it("中间档不修正", () => {
    expect(desiredPassRateAdjustment({ decided: 10, rate: 0.7 })).toBe(0);
    expect(desiredPassRateAdjustment({ decided: 10, rate: 0.84 })).toBe(0);
    expect(desiredPassRateAdjustment({ decided: 10, rate: 0.41 })).toBe(0);
  });
});
