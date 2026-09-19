<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { api } from "@/api/client";
import type { Paged, ReviewQueueItem } from "@/api/types";
import { tierLabel, tierTagType } from "@/config/credit";

const router = useRouter();

const items = ref<ReviewQueueItem[]>([]);
const total = ref(0);
const loading = ref(false);
const onlyOverdue = ref(false);
const selecting = ref<string | null>(null);

async function load() {
  loading.value = true;
  try {
    const [queue, stats] = await Promise.all([
      api.get<Paged<ReviewQueueItem>>("/moderation/queue", {
        pageSize: 50,
        overdueOnly: onlyOverdue.value ? "true" : undefined,
      }),
      api.get<{
        queue: { pending: number; inReview: number; overdue: number };
        today: { decided: number; approved: number; rejected: number };
        appeals: number;
        reports: { open: number };
        privacy: { pending: number };
        averageReviewHours: number;
      }>("/moderation/stats"),
    ]);

    items.value = queue.items;
    total.value = queue.total;
    statsRef.value = stats;
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    loading.value = false;
  }
}

const statsRef = ref<{
  queue: { pending: number; inReview: number; overdue: number };
  today: { decided: number; approved: number; rejected: number };
  appeals: number;
  reports: { open: number };
  privacy: { pending: number };
  averageReviewHours: number;
} | null>(null);

// 领取锁在服务端保证唯一性，前端只要把并发失败的结果如实告诉审核员
async function openTask(task: ReviewQueueItem) {
  selecting.value = task.id;
  try {
    await api.post(`/moderation/tasks/${task.id}/claim`);
  } catch (error) {
    const message = (error as Error).message;
    if (!message.includes("领取")) {
      ElMessage.error(message);
      selecting.value = null;
      return;
    }
    // 已被他人领取时给出提示，但仍然允许打开查看
    ElMessage.warning(message);
  }

  selecting.value = null;
  void router.push({ name: "review-detail", params: { id: task.id } });
}

onMounted(load);
</script>

<template>
  <div class="page page--wide">
    <h1 class="page-title">
      审核台
      <el-button size="small" @click="load">刷新</el-button>
    </h1>

    <el-row v-if="statsRef" :gutter="12" style="margin-bottom: 16px">
      <el-col :xs="12" :sm="8" :md="4">
        <el-card shadow="never"><div class="stat"><span>待领取</span><strong>{{ statsRef.queue.pending }}</strong></div></el-card>
      </el-col>
      <el-col :xs="12" :sm="8" :md="4">
        <el-card shadow="never"><div class="stat"><span>审核中</span><strong>{{ statsRef.queue.inReview }}</strong></div></el-card>
      </el-col>
      <el-col :xs="12" :sm="8" :md="4">
        <el-card shadow="never">
          <div class="stat"><span>已超时</span><strong class="danger">{{ statsRef.queue.overdue }}</strong></div>
        </el-card>
      </el-col>
      <el-col :xs="12" :sm="8" :md="4">
        <el-card shadow="never"><div class="stat"><span>今日已处理</span><strong>{{ statsRef.today.decided }}</strong></div></el-card>
      </el-col>
      <el-col :xs="12" :sm="8" :md="4">
        <el-card shadow="never"><div class="stat"><span>待处理举报</span><strong>{{ statsRef.reports.open }}</strong></div></el-card>
      </el-col>
      <el-col :xs="12" :sm="8" :md="4">
        <el-card shadow="never"><div class="stat"><span>待确认隐私</span><strong>{{ statsRef.privacy.pending }}</strong></div></el-card>
      </el-col>
    </el-row>

    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 10px">
      <el-checkbox v-model="onlyOverdue" @change="load">只看超时的</el-checkbox>
      <span class="muted">共 {{ total }} 条待处理</span>
      <span v-if="statsRef" class="muted">近 30 天平均处理时长 {{ statsRef.averageReviewHours }} 小时</span>
    </div>

    <el-table v-loading="loading" :data="items" style="width: 100%">
      <el-table-column label="条目" min-width="240">
        <template #default="{ row }">
          <div style="display: flex; align-items: center; gap: 8px">
            <span class="category-chip" :style="{ background: row.spot.category.color }">
              {{ row.spot.category.name }}
            </span>
            <strong>{{ row.spot.title }}</strong>
          </div>
          <div class="muted" style="margin-top: 4px">
            作者 {{ row.spot.author.nickname }} ·
            <el-tag :type="tierTagType(row.spot.author.creditTier)" size="small" style="margin: 0 4px">
              {{ tierLabel(row.spot.author.creditTier) }}
            </el-tag>
            信用分 {{ row.spot.author.creditScore }} · 已通过 {{ row.spot.author.approvedCount }} 条
          </div>
        </template>
      </el-table-column>

      <el-table-column label="图片" width="80">
        <template #default="{ row }">{{ row.spot.mediaCount }} 张</template>
      </el-table-column>

      <el-table-column label="状态" width="140">
        <template #default="{ row }">
          <el-tag v-if="row.overdue" type="danger" size="small">已超时</el-tag>
          <el-tag v-else-if="row.lockActive" type="warning" size="small">已被领取</el-tag>
          <el-tag v-else type="info" size="small">待领取</el-tag>
          <div v-if="row.claimedBy" class="muted" style="margin-top: 4px">{{ row.claimedBy }}</div>
        </template>
      </el-table-column>

      <el-table-column label="提交时间" width="170">
        <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString("zh-CN") }}</template>
      </el-table-column>

      <el-table-column label="操作" width="110" fixed="right">
        <template #default="{ row }">
          <el-button size="small" type="primary" :loading="selecting === row.id" @click="openTask(row)">
            领取并审核
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-empty v-if="!loading && items.length === 0" description="队列已清空，暂时没有待审核的条目" />
  </div>
</template>

<style scoped>
.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--color-text-soft);
}

.stat strong {
  font-size: 22px;
  color: var(--color-text);
}

.danger {
  color: var(--color-danger);
}
</style>
