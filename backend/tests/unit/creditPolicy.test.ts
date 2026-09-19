import { describe, expect, it } from "vitest";
import {
  APPEAL_COMPENSATION,
  CREDIT_HALF_LIFE_DAYS,
  TRUSTED_MIN_APPROVED,
  TIER_POLICY,
  clampCredit,
  computeCredit,
  effectiveAmount,
  effectiveDailySpotLimit,
  nextTierGoal,
  rateScore,
  severityForReason,
  tierForScore,
  violationAmount,
  type DecayingEvent,
} from "../../src/services/moderation/creditPolicy";
import type { CreditEventType } from "@prisma/client";

const DAY = 86400000;

function event(
  type: CreditEventType,
  amount: number,
  ageDays: number,
  extra: Partial<DecayingEvent> = {},
): DecayingEvent {
  return {
    id: extra.id,
    type,
    amount,
    // null 是合法值（永久有效），不能用 ?? 回退
    decayDays: "decayDays" in extra ? (extra.decayDays ?? null) : CREDIT_HALF_LIFE_DAYS,
    occurredAt: new Date(Date.now() - ageDays * DAY),
  };
}

describe("违规严重度与扣分", () => {
  it("普通驳回按基准 8 分扣", () => {
    expect(violationAmount("spot_rejected", "INSUFFICIENT_DETAIL")).toBe(-8);
  });

  it("隐私 / 广告 / 不当内容双倍扣分", () => {
    expect(violationAmount("spot_rejected", "PRIVACY_RISK")).toBe(-16);
    expect(violationAmount("report_confirmed", "ADVERTISING")).toBe(-30);
    expect(violationAmount("comment_hidden", "INAPPROPRIATE")).toBe(-20);
  });

  it("重复、侵权按 1.5 倍", () => {
    expect(violationAmount("spot_rejected", "DUPLICATE")).toBe(-12);
    expect(severityForReason("INFRINGEMENT")).toBe(1.5);
  });

  it("扣分封顶 100，不会溢出", () => {
    expect(violationAmount("report_confirmed", "PRIVACY_LEAK")).toBe(-30);
    expect(clampCredit(-200)).toBe(0);
    expect(clampCredit(250)).toBe(100);
  });
});

describe("时间衰减", () => {
  it("一个半衰期后影响减半，两个半衰期后剩四分之一", () => {
    const e = event("spot_rejected", -16, CREDIT_HALF_LIFE_DAYS);
    expect(effectiveAmount(e, new Date())).toBeCloseTo(-8, 5);
    expect(effectiveAmount(event("spot_rejected", -16, CREDIT_HALF_LIFE_DAYS * 2), new Date())).toBeCloseTo(
      -4,
      5,
    );
  });

  it("decayDays 为空时永久有效，不随时间衰减", () => {
    const e = event("appeal_restored", 16, 3650, { decayDays: null });
    expect(effectiveAmount(e, new Date())).toBe(16);
  });

  it("发生时间在未来（时钟回拨等异常）按原值处理", () => {
    const e = event("spot_rejected", -8, -10);
    expect(effectiveAmount(e, new Date())).toBe(-8);
  });
});

describe("历史通过率", () => {
  it("没有记录时是中性基线，得 0 分", () => {
    expect(rateScore({ approved: 0, rejected: 0 })).toBe(0);
  });

  it("一次驳回不会直接判死刑（Beta 平滑）", () => {
    expect(rateScore({ approved: 0, rejected: 1 })).toBeGreaterThan(-30);
    expect(rateScore({ approved: 0, rejected: 1 })).toBeLessThan(0);
  });

  it("长期 100% 通过接近 +30 上限，长期全败接近 -30", () => {
    expect(rateScore({ approved: 20, rejected: 0 })).toBe(27);
    expect(rateScore({ approved: 1000, rejected: 0 })).toBe(30);
    expect(rateScore({ approved: 0, rejected: 1000 })).toBe(-30);
  });

  it("70% 通过率是正分，对应产品质量指标", () => {
    expect(rateScore({ approved: 7, rejected: 3 })).toBeGreaterThan(0);
  });
});

describe("综合信用分", () => {
  it("新用户（无流水、无结论）满分 100", () => {
    const result = computeCredit({ events: [], decisionStats: { approved: 0, rejected: 0 } });
    expect(result.score).toBe(100);
    expect(result.violationScore).toBe(0);
    expect(result.rateScore).toBe(0);
  });

  it("一次普通驳回 + 一次通过：违规 -8 + 奖励 +2，通过率仍在正分", () => {
    const result = computeCredit({
      events: [
        { ...event("spot_rejected", -8, 1), id: 1 },
        { ...event("spot_approved", 2, 0), id: 2 },
      ],
      decisionStats: { approved: 1, rejected: 1 },
    });
    expect(result.violationScore).toBe(-8);
    expect(result.meritScore).toBe(2);
    expect(result.score).toBeGreaterThan(85);
    expect(result.score).toBeLessThan(100);
  });

  it("两条隐私红线当场进入冻结区", () => {
    const result = computeCredit({
      events: [
        { ...event("report_confirmed", -30, 0), id: 1 },
        { ...event("spot_rejected", -16, 0), id: 2 },
      ],
      decisionStats: { approved: 0, rejected: 2 },
    });
    expect(result.score).toBeLessThan(40);
  });

  it("违规超过一年后自然恢复到接近满分", () => {
    const result = computeCredit({
      events: [{ ...event("spot_rejected", -16, 400), id: 1 }],
      decisionStats: { approved: 3, rejected: 1 },
    });
    expect(result.score).toBeGreaterThan(90);
  });

  it("被申诉撤销的违规流水不再计分，永久返还把分补回来", () => {
    const result = computeCredit({
      events: [
        { ...event("spot_rejected", -8, 30), id: 1 },
        { ...event("appeal_restored", 8, 20, { decayDays: null }), id: 2 },
        { ...event("appeal_compensation", APPEAL_COMPENSATION, 20, { decayDays: null }), id: 3 },
      ],
      reversedEventIds: new Set([1]),
      decisionStats: { approved: 1, rejected: 1 },
    });
    // 原违规被排除，只剩返还 +8 与补偿 +6（合计 14）
    expect(result.violationScore).toBe(0);
    expect(result.adjustmentScore).toBe(14);
    expect(result.score).toBeGreaterThan(95);
  });

  it("最终分钳制在 0–100", () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      ...event("report_confirmed", -30, 0),
      id: i + 1,
    }));
    expect(computeCredit({ events, decisionStats: { approved: 0, rejected: 10 } }).score).toBe(0);
  });
});

describe("权限分层", () => {
  it("无审核结论的用户即使满分也是 new，不能冒充可信", () => {
    expect(tierForScore(100, { approved: 0, rejected: 0 })).toBe("new");
  });

  it("没有审核结论但有违规记录的新用户仍会被受限 / 冻结", () => {
    // 评论被举报成立、坚持转人工等场景不产生审核结论，但不能继续享受默认权限
    expect(tierForScore(55, { approved: 0, rejected: 0 })).toBe("restricted");
    expect(tierForScore(30, { approved: 0, rejected: 0 })).toBe("frozen");
    // 分数正常时依旧按新用户预审
    expect(tierForScore(70, { approved: 0, rejected: 0 })).toBe("new");
  });

  it("低于 40 冻结，40–59 受限，60+ 正常", () => {
    expect(tierForScore(39, { approved: 1, rejected: 5 })).toBe("frozen");
    expect(tierForScore(55, { approved: 1, rejected: 3 })).toBe("restricted");
    expect(tierForScore(70, { approved: 2, rejected: 1 })).toBe("standard");
  });

  it(`85 分且通过数 ≥ ${TRUSTED_MIN_APPROVED} 才是可信`, () => {
    expect(tierForScore(90, { approved: 4, rejected: 0 })).toBe("standard");
    expect(tierForScore(90, { approved: 5, rejected: 0 })).toBe("trusted");
  });

  it("冻结层不能发条目也不能评论", () => {
    expect(TIER_POLICY.frozen.canSubmitSpots).toBe(false);
    expect(TIER_POLICY.frozen.canComment).toBe(false);
  });

  it("受限层每日名额为基准的四分之一且至少 1 个", () => {
    expect(effectiveDailySpotLimit(20, "restricted")).toBe(5);
    expect(effectiveDailySpotLimit(10, "restricted")).toBe(3);
    expect(effectiveDailySpotLimit(1, "restricted")).toBe(1);
    expect(effectiveDailySpotLimit(20, "frozen")).toBe(0);
    expect(effectiveDailySpotLimit(20, "trusted")).toBe(40);
  });

  it("受限与新用户的评论必须先审后发", () => {
    expect(TIER_POLICY.restricted.commentRequiresPremoderation).toBe(true);
    expect(TIER_POLICY.new.commentRequiresPremoderation).toBe(true);
    expect(TIER_POLICY.standard.commentRequiresPremoderation).toBe(false);
  });

  it("给出到可信层的可执行差距", () => {
    const goal = nextTierGoal(70, { approved: 2, rejected: 1 });
    expect(goal?.tier).toBe("trusted");
    expect(goal?.scoreGap).toBe(15);
    expect(goal?.approvedGap).toBe(3);
    expect(nextTierGoal(90, { approved: 5, rejected: 0 })).toBeNull();
    expect(nextTierGoal(30, { approved: 0, rejected: 5 })).toBeNull();
  });
});
