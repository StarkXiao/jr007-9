-- 用户信用分体系：信用流水账 + 权限分层快照
--
-- 本迁移为手工编写（与前两条迁移一样，请勿直接套用 prisma migrate diff
-- 生成的 SQL：它会误删 spots 上的 GIN / 部分索引）。
--
-- 设计要点：
-- 1. credit_events 是唯一事实来源，users.credit_score 只是重算结果的缓存；
-- 2. 违规与奖励流水按 180 天半衰期衰减，申诉返还与管理员调整永久有效；
-- 3. credit_tier 由信用分 + 是否有过审核结论共同决定，权限中间件只读它。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CreditEventType') THEN
    CREATE TYPE "CreditEventType" AS ENUM (
      'spot_rejected',
      'auto_rejected_override',
      'comment_hidden',
      'report_confirmed',
      'spot_approved',
      'appeal_restored',
      'appeal_compensation',
      'appeal_upheld',
      'admin_adjust'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CreditTier') THEN
    CREATE TYPE "CreditTier" AS ENUM ('new', 'trusted', 'standard', 'restricted', 'frozen');
  END IF;
END$$;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "credit_tier" "CreditTier" NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS "credit_violation_score" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "credit_appeal_score" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "credit_rate_score" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "credit_computed_at" TIMESTAMPTZ(6);

-- 存量用户按既有信用分回填分层；零贡献的满分用户视为新用户
UPDATE "users"
SET "credit_tier" = CASE
  WHEN "credit_score" < 40 THEN 'frozen'
  WHEN "credit_score" < 60 THEN 'restricted'
  WHEN "credit_score" >= 85 AND "approved_count" >= 5 THEN 'trusted'
  WHEN "approved_count" = 0 AND "credit_score" = 100 THEN 'new'
  ELSE 'standard'
END;

CREATE TABLE "credit_events" (
  "id" BIGSERIAL PRIMARY KEY,
  "user_id" BIGINT NOT NULL,
  "type" "CreditEventType" NOT NULL,
  "amount" SMALLINT NOT NULL,
  "decay_days" INTEGER,
  "reason_code" VARCHAR(48),
  "reason" TEXT,
  "target_type" VARCHAR(16),
  "target_id" BIGINT,
  "reverses_id" BIGINT,
  "actor_id" BIGINT,
  "meta" JSONB,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "credit_events_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "credit_events_reverses_id_fkey"
    FOREIGN KEY ("reverses_id") REFERENCES "credit_events"("id") ON DELETE SET NULL,
  CONSTRAINT "credit_events_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE INDEX "idx_credit_user_time" ON "credit_events" ("user_id", "occurred_at");
CREATE INDEX "idx_credit_user_type" ON "credit_events" ("user_id", "type");
CREATE INDEX "idx_credit_reverses" ON "credit_events" ("reverses_id");
CREATE INDEX "idx_users_credit_tier" ON "users" ("credit_tier");
