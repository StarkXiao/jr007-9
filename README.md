# 公共空间细节地图

记录长椅、饮水处、遮雨棚、安静角落、夜间照明这些地图上查不到的细节，帮别人提前知道一个地方**实际待起来是什么体验**。

详细设计见 [`docs/项目文档.md`](docs/项目文档.md)——数据模型、API 契约、审核状态机、验收清单都在里面，本仓库是它的实现。

Vue3 + Leaflet 负责地图标注，Node.js 负责审核、评论与隐私模糊化。

## 快速开始

需要 Node.js ≥ 20 与 Docker。

```bash
cp .env.example .env          # 生产环境请改掉 JWT_SECRET
docker compose up -d postgres redis

cd backend  && npm install && cd ..
cd frontend && npm install && cd ..

cd backend
npx prisma migrate deploy
npm run seed                  # 会打印随机生成的种子账号密码，请立即保存

npm run dev                   # 终端 A：API
npm run dev:worker            # 终端 B：图片处理与定时任务
```

另一个终端：

```bash
cd frontend && npm run dev    # http://localhost:5173
```

完整容器化启动：`docker compose up -d --build`（前端 <http://localhost:8080>）。

## 验证

```bash
cd backend && npm run typecheck && npm test   # 56 个单元测试 + 27 个集成测试
cd frontend && npm run typecheck && npm run build
```

集成测试跑在真实数据库与 Redis 上，要求先执行 `docker compose up -d postgres redis`。测试会创建自己的账号并在结束后清理。

也可以用 `curl http://localhost:3000/readyz` 检查数据库与 Redis 是否就绪。

### 已经实际跑过的验证

- 后端构建、类型检查、51 个测试（含完整闭环与账号状态集成测试）全部通过
- 前端类型检查与生产构建通过，并已拆包
- `docker compose up -d --build` 整套栈拉起后四个容器均为 healthy
- 图片上传 → 元数据清除 → 人工打码 → 隐私确认 → 随条目发布，逐环节用真实图片验证过：公开变体中 EXIF 与 GPS 均已消失
- 审核、申诉改判、举报处置、评论分级审核、属性筛选、附近搜索、个人设置等接口逐条调通

worker 不监听端口，因此它用 Redis 心跳探活（`node dist/scripts/worker-health.js`）。

## 维护须知：手工索引与 Prisma 迁移

`spots` 表上有三个 Prisma schema 表达不了的索引，它们写在
`prisma/migrations/20260101000000_init/migration.sql` 末尾：

- `idx_spots_title_trgm`（GIN，标题模糊搜索）
- `idx_spots_attributes`（GIN，属性筛选）
- `idx_spots_geo_public`（部分索引，只覆盖已发布条目）

**不要直接套用 `prisma migrate diff` / `migrate dev` 生成的迁移。**
它会把这三个索引判定为"schema 里没有的多余索引"并生成 `DROP INDEX`。
新增迁移时请先 review 生成的 SQL，把这类语句删掉再提交。

## 隐私是怎么保证的

这是本项目最不能妥协的部分，共四道措施：

1. **上传即清除元数据。** EXIF、GPS、ICC、XMP 全部丢弃，并按 EXIF 方向摆正。这一步不可跳过，失败则整张图拒绝入库。
2. **图片默认不可公开访问。** 原图存私有目录，公开变体只有通过隐私确认后才会以可缓存的形式对外提供。
3. **发布门禁。** `privacy_status` 不是 `auto_clean` 或 `confirmed` 时，审核接口一律返回 422；改判申诉也不能绕过这道闸门。
4. **位置模糊化。** 对外只返回加了确定性偏移的坐标，偏移量由条目 UUID 派生，所以同一个地点每次显示位置一致，图上不会乱跳。

人脸与车牌检测是**可选增强项**（`ENABLE_FACE_DETECTION` / `ENABLE_PLATE_DETECTION`，默认关闭，需要自行安装依赖与模型）。关闭时系统走人工框选 + 必须确认的路径，隐私门禁强度不变。

## 目录

```
backend/    Node.js API、审核与隐私流水线、定时任务、Prisma 模型与种子数据
frontend/   Vue3 应用：地图、条目编辑、审核台、模糊工作台、管理后台
```

## 信用分体系与动态发布权限

信用分不是一个拍脑袋的数字，而是一条**可回放的流水账**（`credit_events`）在任意时刻的计算结果，`users.credit_score` 只是缓存。三个计算维度：

1. **违规记录**：驳回 −8、坚持转人工 −5、评论被隐藏 −10、举报成立 −15；隐私 / 广告 / 不当内容按原因码双倍权重。所有违规流水按 **180 天半衰期**衰减——犯错会被原谅，但不是立刻。
2. **申诉改判**：改判成立时记一条永久有效的等额返还（`appeal_restored`）撤销原扣分，再追加永久 +6 错判补偿；维持判只留零分流水，不重复扣分。
3. **历史通过率**：取每个条目的最近一次终审（「要求修改」不计），用 Beta 平滑 `(approved+1.2)/(total+2)` 映射到 ±30 分，单次驳回不会把新用户一棍打死。

总分映射为五个权限层，发布权限**随分数动态收窄 / 放开**：

| 层 | 分数 | 条目提交 | 评论 | 每日名额 | 配图 | 排队 |
|---|---|---|---|---|---|---|
| 可信 trusted | ≥85 且通过≥5 | ✅ | 先发后审 | 2× | 6 | +2 优先级 |
| 正常 standard | 60–84 | ✅ | 先发后审 | 1× | 6 | 正常 |
| 新用户 new | 无终审结论 | ✅ | 先审后发 | 1× | 6 | 正常 |
| 受限 restricted | 40–59 | ✅ | 先审后发 | 0.25×（至少 1） | 3 | 正常 |
| 冻结 frozen | <40 | ❌ | ❌ | 0 | — | — |

受限/冻结优先于「新用户」：新用户的评论被举报成立一样会被限制。冻结不封申诉与编辑驳回内容的通道；每天 03:30 的 `credit-sweep` 按流水重算，违规衰减后权限自动恢复。用户可在「我的空间 → 信用与权限」看到分项分数、当前权限、距可信层的差距与全部流水；管理员可查看任意用户档案、人工调整（必须填理由，永久流水 + 审计日志）、强制重算。

## 一些实现上的取舍

- **Access Token 只放内存**，刷新页面时用 HttpOnly 的 refresh cookie 重新换取，避免长期凭证暴露在 XSS 下。
- **审核任务的领取锁用一条带条件的 UPDATE 实现**，而不是"先查再改"，后者在并发下必然出现两个人拿到同一任务。
- **马赛克降采样用 cubic 而不是 nearest**：点采样会把某个原始像素的颜色原样保留，等于没打散信息。
- **队列不可用时降级为同步处理**：Redis 宕机时图片若一直停在 `processing`，用户会以为上传失败而不停重试。
- **原图保留 30 天后彻底删除**。代价是之后无法再调整模糊区域，此时只能下架整张图片——这是数据最小化必须付的成本。
