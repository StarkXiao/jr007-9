import type { CreditTier } from "@/api/types";

export const TIER_LABEL: Record<CreditTier, string> = {
  new: "新用户",
  standard: "正常",
  trusted: "可信贡献者",
  restricted: "受限",
  frozen: "冻结",
};

export const TIER_TAG_TYPE: Record<CreditTier, "info" | "success" | "warning" | "danger" | "primary"> = {
  new: "info",
  standard: "primary",
  trusted: "success",
  restricted: "warning",
  frozen: "danger",
};

export const EVENT_LABEL: Record<string, string> = {
  spot_rejected: "条目被驳回",
  auto_rejected_override: "坚持转人工复核",
  comment_hidden: "评论被隐藏",
  report_confirmed: "举报成立",
  spot_approved: "条目通过审核",
  appeal_restored: "申诉改判返还",
  appeal_compensation: "错判补偿",
  appeal_upheld: "申诉维持原判",
  admin_adjust: "管理员调整",
};

export function tierLabel(tier: string): string {
  return TIER_LABEL[tier as CreditTier] ?? tier;
}

export function tierTagType(tier: string): "info" | "success" | "warning" | "danger" | "primary" {
  return TIER_TAG_TYPE[tier as CreditTier] ?? "info";
}

export function scoreTagType(score: number): "success" | "primary" | "warning" | "danger" {
  if (score >= 85) return "success";
  if (score >= 60) return "primary";
  if (score >= 40) return "warning";
  return "danger";
}
