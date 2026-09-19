import type { UserStatus, UserRole, CreditTier } from "@prisma/client";

export interface AuthUser {
  id: bigint;
  uuid: string;
  role: UserRole;
  status: UserStatus;
  nickname: string;
  creditScore: number;
  creditTier: CreditTier;
}

export const ROLE_RANK: Record<UserRole, number> = {
  visitor: 0,
  user: 1,
  moderator: 2,
  admin: 3,
};

export function hasRole(user: AuthUser | undefined, minRole: UserRole): boolean {
  if (!user) return false;
  return ROLE_RANK[user.role] >= ROLE_RANK[minRole];
}

export function isContentCreator(user: AuthUser | undefined): boolean {
  return hasRole(user, "user");
}

export function isModerator(user: AuthUser | undefined): boolean {
  return hasRole(user, "moderator");
}

export function isAdmin(user: AuthUser | undefined): boolean {
  return hasRole(user, "admin");
}
