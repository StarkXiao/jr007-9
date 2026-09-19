<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { api } from "@/api/client";
import type { CreditProfile } from "@/api/types";
import { EVENT_LABEL, TIER_LABEL, TIER_TAG_TYPE, scoreTagType } from "@/config/credit";

const profile = ref<CreditProfile | null>(null);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    profile.value = await api.get<CreditProfile>("/me/credit");
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <el-card v-if="profile" shadow="never" class="credit-head">
      <div class="credit-head-row">
        <div class="credit-score">
          <span class="credit-score-num" :class="`score-${scoreTagType(profile.score)}`">{{ profile.score }}</span>
          <span class="muted">/ 100</span>
        </div>
        <div>
          <el-tag :type="TIER_TAG_TYPE[profile.tier]" size="large">{{ TIER_LABEL[profile.tier] }}</el-tag>
          <p class="muted" style="margin: 8px 0 0; max-width: 420px">{{ profile.policy.description }}</p>
        </div>
        <div class="credit-rate">
          <div class="credit-rate-num">
            {{ profile.approvalRate === null ? "—" : `${Math.round(profile.approvalRate * 100)}%` }}
          </div>
          <div class="muted">历史通过率</div>
          <div class="muted" style="font-size: 12px; margin-top: 2px">
            通过 {{ profile.decisionStats.approved }} / 驳回 {{ profile.decisionStats.rejected }}
          </div>
        </div>
      </div>

      <el-alert
        v-if="profile.tier === 'frozen'"
        type="error"
        :closable="false"
        show-icon
        title="发布与评论权限已冻结"
        description="你仍可修改被驳回的内容并提出申诉；申诉成立或违规记录随时间衰减后，权限会自动恢复。"
        style="margin-top: 14px"
      />
      <el-alert
        v-else-if="profile.nextGoal"
        type="success"
        :closable="false"
        show-icon
        :title="
          profile.nextGoal.scoreGap > 0
            ? `距离「${TIER_LABEL.trusted}」还差 ${profile.nextGoal.scoreGap} 分`
            : `信用分已达标，再获 ${profile.nextGoal.approvedGap} 条通过即可成为「${TIER_LABEL.trusted}」`
        "
        :description="
          profile.nextGoal.approvedGap > 0
            ? '可信贡献者享有双倍提交名额与审核快速通道，继续保持高质量贡献。'
            : '保持高质量贡献即可获得双倍提交名额与审核快速通道。'
        "
        style="margin-top: 14px"
      />
    </el-card>

    <el-row v-if="profile" :gutter="12" style="margin-top: 12px">
      <el-col :span="6">
        <el-card shadow="never" class="factor-card">
          <div class="factor-title">违规记录</div>
          <div class="factor-num" :class="profile.breakdown.violation < 0 ? 'neg' : ''">
            {{ profile.breakdown.violation }}
          </div>
          <div class="muted factor-hint">按 180 天半衰期衰减，申诉改判后撤销</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" class="factor-card">
          <div class="factor-title">贡献奖励</div>
          <div class="factor-num pos">+{{ profile.breakdown.merit }}</div>
          <div class="muted factor-hint">每条通过审核 +2，随时间衰减</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" class="factor-card">
          <div class="factor-title">申诉与人工调整</div>
          <div class="factor-num" :class="profile.breakdown.adjustment < 0 ? 'neg' : 'pos'">
            {{ profile.breakdown.adjustment > 0 ? "+" : "" }}{{ profile.breakdown.adjustment }}
          </div>
          <div class="muted factor-hint">改判返还与错判补偿，永久有效</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" class="factor-card">
          <div class="factor-title">历史通过率</div>
          <div class="factor-num" :class="profile.breakdown.rate < 0 ? 'neg' : 'pos'">
            {{ profile.breakdown.rate > 0 ? "+" : "" }}{{ profile.breakdown.rate }}
          </div>
          <div class="muted factor-hint">Beta 平滑，范围 −30 ~ +30</div>
        </el-card>
      </el-col>
    </el-row>

    <el-card v-if="profile" shadow="never" style="margin-top: 12px">
      <template #header>当前发布权限</template>
      <el-descriptions :column="3" border>
        <el-descriptions-item label="提交新条目">
          <el-tag :type="profile.policy.canSubmitSpots ? 'success' : 'danger'" size="small">
            {{ profile.policy.canSubmitSpots ? "允许" : "冻结" }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="发表评论">
          <el-tag :type="profile.policy.canComment ? 'success' : 'danger'" size="small">
            {{ profile.policy.canComment ? "允许" : "冻结" }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="评论审核">
          {{ profile.policy.commentRequiresPremoderation ? "先审后发" : "先发后审" }}
        </el-descriptions-item>
        <el-descriptions-item label="每日提交名额">{{ profile.policy.dailySpotMultiplier }}× 基准</el-descriptions-item>
        <el-descriptions-item label="单条目配图上限">{{ profile.policy.maxSpotMedia }} 张</el-descriptions-item>
        <el-descriptions-item label="审核排队优先级">{{ profile.policy.priorityBoost }} 级加成</el-descriptions-item>
      </el-descriptions>
    </el-card>

    <el-card v-if="profile" shadow="never" style="margin-top: 12px">
      <template #header>信用流水（最近 100 条）</template>
      <el-table :data="profile.events" size="small" empty-text="暂无记录">
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ new Date(row.occurredAt).toLocaleString("zh-CN") }}</template>
        </el-table-column>
        <el-table-column label="事件" min-width="150">
          <template #default="{ row }">
            {{ EVENT_LABEL[row.type] ?? row.type }}
            <el-tag v-if="row.reversed" type="info" size="small" style="margin-left: 6px">已撤销</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="原因" min-width="200" show-overflow-tooltip />
        <el-table-column label="记账分值" width="100">
          <template #default="{ row }">
            <span :class="row.amount < 0 ? 'neg' : 'pos'">
              {{ row.amount > 0 ? "+" : "" }}{{ row.amount }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="当前生效" width="100">
          <template #default="{ row }">
            <span class="muted">{{ row.effective > 0 ? "+" : "" }}{{ row.effective }}</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.credit-head-row {
  display: flex;
  align-items: center;
  gap: 28px;
  flex-wrap: wrap;
}
.credit-score-num {
  font-size: 48px;
  font-weight: 700;
  line-height: 1;
}
.score-success {
  color: var(--el-color-success);
}
.score-primary {
  color: var(--el-color-primary);
}
.score-warning {
  color: var(--el-color-warning);
}
.score-danger {
  color: var(--el-color-danger);
}
.credit-rate {
  margin-left: auto;
  text-align: center;
}
.credit-rate-num {
  font-size: 28px;
  font-weight: 700;
}
.factor-card {
  text-align: center;
}
.factor-title {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.factor-num {
  font-size: 26px;
  font-weight: 700;
  margin: 6px 0;
}
.factor-hint {
  font-size: 12px;
}
.neg {
  color: var(--el-color-danger);
}
.pos {
  color: var(--el-color-success);
}
</style>
