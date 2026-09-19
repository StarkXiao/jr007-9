-- 信用分体系：信用事件流水表
--
-- 每一次信用分变动（违规扣分、申诉改判、评论过审、历史通过率修正）
-- 都落一条 credit_events 记录，使分数可解释、可追溯、可重算。
--
-- 注意：本迁移为手工编写，未使用 prisma migrate diff，
-- 以避免误删 spots 表上三个手工维护的高级索引
-- （idx_spots_title_trgm / idx_spots_attributes / idx_spots_geo_public）。

CREATE TABLE "credit_events" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "delta" SMALLINT NOT NULL,
    "score_after" SMALLINT NOT NULL,
    "target_type" VARCHAR(24),
    "target_id" BIGINT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "credit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_credit_events_user" ON "credit_events"("user_id", "created_at" DESC);
CREATE INDEX "idx_credit_events_kind" ON "credit_events"("kind", "created_at" DESC);

ALTER TABLE "credit_events"
    ADD CONSTRAINT "credit_events_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
