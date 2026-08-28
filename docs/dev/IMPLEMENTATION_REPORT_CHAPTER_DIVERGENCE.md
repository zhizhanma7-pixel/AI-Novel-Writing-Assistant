# Chapter Execution Divergence Implementation Report

> 分支：`codex/chapter-divergence`（从 `beta@2c5614f` 拉出，未合入、未推送）
> 计划：`docs/dev/IMPLEMENTATION_PLAN_CHAPTER_DIVERGENCE.md`
> 架构分析：`docs/dev/ARCH_ANALYSIS_CHAPTER_DIVERGENCE.md`
> 当前状态：**Phase 2C 后端完成；2C.7 前端与 T1 端到端整书回归未做**

## Scope

| 子项 | 提交 | 状态 |
|---|---|---|
| 规划文档 | `846295b` | ✅ |
| 2C.0 正文保护 guard | `e7ae664` | ✅ Codex 实现，Claude 独立复跑确认 7/7 |
| 2C.1 偏离契约 | `b52551a` | ✅ |
| 2C.2 非阻塞投递 | `28bf161` | ✅ |
| 2C.3 生产者 + 章节链接线 | `86d1641` | ✅ |
| 2C.4 接受分支 applier | `79b4012` | ✅ |
| 2C.5 修正分支 mapper + 2C.6 G4 锁定 | `ae02c5d` | ✅ |
| 复审 H1 / M5 修复 | `5bf5527` | ✅ |
| 复审 H3 修复 | `ed14501` | ✅ |
| 复审 H2：修正分支 application command | 本次 | ✅ |
| 2C.7 前端 | — | ⏳ 未开始 |
| T1 端到端整书回归 | — | ⏳ 未开始 |

**分工变更：** `846295b` 与 `e7ae664` 由 Codex 实现；Codex 额度耗尽后，`b52551a`
起改由 Claude Code 承担实现，Codex 转为评审。Claude Code 确认本机可用的
Node 24.19.0 / pnpm 11.19.0（在 `~/.cache/codex-runtimes/`，不在 PATH），因此
`b52551a` 之后的每个子项都自行完成编译与测试，不再以未验证草案交付。

## 已交付

1. **偏离契约**（`shared/types/chapterDivergence.ts`）：六类 kind 对应用户拍板的
   跨章影响阈值，外加结构化 `references` 与两个共用回查函数。
2. **确定性阈值**：AI 自报的 `kind` 永远不足以单独过门槛；必须有一条
   `contractQuotes` 能在本章 Expected 合同原文里精确命中。查不到一律降级为质量债。
3. **acceptance Prompt 升到 v3**：新增 `divergences` 输出与第 18–22 条指令；
   K1 收口为 `postValidate` 回查失败 → 一次语义重试 → 仍不可核验则由
   `postValidateFailureRecovery` 剥离未核验项并保留 acceptance 主结果。
4. **非阻塞投影**（`reviewProjection`）：默认 `task_checkpoint` 与 Phase 2A 逐字相同；
   `non_blocking` 只写 `proposal_review_deferred` 账本事件，不投 checkpoint、
   不改任务状态。
5. **偏离提案生产者**：同章多条聚合成一份信封；命中 `replan_required` /
   `plan_misalignment` 整体跳过；生产期拒绝两条偏离写同一 path。
6. **章节链接线**：挂在 `ChapterContentFinalizationService` 定稿处、`needsRepair`
   计算之前且不参与该判定，整段 try/catch 降级为 warn。
7. **接受分支 applier**：只更新下游卷规划，本章原始 Expected 原样保留作审计证据；
   `riskFlags` 只 merge `divergenceResolutions`，保留全部既有顶层键。
8. **修正分支**（`ae02c5d` 时**只有 mapper、没有调用方**，复审 H2 指出后由
   `ChapterDivergenceCorrectionService` 补齐 application command；对外 HTTP 入口
   仍留到 2C.7 一起接）：偏离翻译成既有 `ChapterExecutionMissingObligation`，复用既有修复
   通路与修复预算，现有修复 Prompt 无需改动。
9. **G4 锁定**：待审 Change Proposal 不阻塞正文生成，补回归与 wiki 说明。

## 实测暴露的问题（草案静态走查发现不了的）

### 1. 下游 patch 的静默 no-op 陷阱（最重要）

`NovelVolumeService.hydrateCanonicalChapterFields`（`NovelVolumeService.ts:120-148`）
每次读取工作区时都用 `Chapter` 行覆盖文档侧字段：`title`←`row.title`、
**`summary`←`row.expectation`**、`taskSheet` / `targetWordCount` / `revealLevel` /
`mustAvoid` / `sceneCards` 同理。

计划草案允许 patch `summary` 与 `taskSheet`。实测结果：**写入成功、当次可见、
下一次 hydrate 后无声还原**——apply 报成功，用户看一次，然后变化消失。

处置：patch schema 收紧为 `.strict()` 且只收卷规划文档自有字段
（`purpose` / `endingState` / `nextChapterEntryState` / `exclusiveEvent`），
让这类写入在 schema 层被拒绝，而不是留到运行期变成看不见的丢失。

### 2. 事务原子性冲突

`updateVolumesWithOptions` 用 `runVolumeWorkspaceTransaction` 自开事务；从 applier
的信封 `tx` 里调用会破坏「任一批准项失败整次回滚」，SQLite 上还会撞
`database is locked`。为此在 volume 模块提取
`applyWorkspaceDocumentWithinTransaction(tx, …)`（内层三行本来就已参数化 `tx`）。

### 3. 信封类型与逐项类型是两个枚举

`ChangeProposal.proposalType`（`chapter_execution` / `outline_edit` / …）与
`StateChangeProposal.proposalType`（`relation_state_update` /
`chapter_execution_plan_update`）不是同一个枚举。信封用既有的 `chapter_execution`，
只有逐项类型需要新增。

### 4. `postValidate` 拿不到合同

`postValidate(output, input, context)` 只能看到 prompt input，而合同原本只存在于
渲染后的上下文文本里。因此把合同显式加进 `ChapterAcceptancePromptInput`，
取自 `contextPackage.chapterReviewContext`（继承自 write context），
回退 `chapterWriteContext`——`GenerationContextPackage` 上没有草案写的 `writeContext` 字段。

## Verification

- `pnpm --filter @ai-novel/shared build`、`pnpm --filter @ai-novel/server build`：通过。
- 新增定向用例：2C.1 十项、2C.2 六项、2C.3 九项、2C.4 一项（真实 SQLite）、
  2C.5+2C.6 四项，全部通过。
- 2C.4 的真实 SQLite 断言：下游 `purpose` / `nextChapterEntryState` 已改、
  **本章 Expected 逐字未变**、已有正文未动、`riskFlags` 的 `qualityLoop` 与未知顶层键均保留、
  写入经过版本化工作区（`activeVersionId` 存在）。

### 本分支 fast 基线与逐次对照

仓库此前只有 `main@308ca1b` 的 fast 基线（`TEST_BASELINE_PROPOSAL_CORE.md`），
本分支从未量过，导致「有没有新增失败」无法判定。本轮首次建立并逐次对照：

| 对象 | tests | pass | fail | 与基线失败集合差异 |
|---|---:|---:|---:|---|
| `b52551a`（2C.1，基线） | 1323 | 1272 | 39 | — |
| + 2C.2 | 1329 | 1278 | 39 | 双向差集为空 |
| + 2C.3 | 1338 | 1287 | 39 | 双向差集为空 |
| + 2C.4 | 1338 | 1287 | 39 | 双向差集为空 |
| + 2C.5/2C.6 | 1342 | 1291 | 39 | 双向差集为空 |

39 条中 38 条在 `main` 基线清单里。剩下的
`dramaPipelineContract.test.js::drama service pipeline keeps repairable quality issues
before storyboard and video tasks` 单独跑通过、进全套件才失败——该文件会手动删除
`require.cache` 里的 `prisma.js` / `promptRunner.js`，在 `run-tests.cjs fast` 的单进程
`require()` 模型下对执行顺序敏感。已用 `git stash` 退回不含改动的 HEAD 实测确认它在
基线全套件里同样失败。

同法确认 `chapterAcceptanceAssessmentService.test.js::normalizeAssessment routes
missing obligations to repairable draft obligation gaps` 也是既有失败，非本轮引入。

## Known Risks

| 编号 | 风险 | 处置 |
|---|---|---|
| K1 | AI 留空 `references` 导致偏离漏报 | 一次语义重试后仍不可核验则保守降级为质量债。方向是少建提案而非多写状态，不构成安全问题，但会漏报 |
| K5 | 接受偏离的卷规划写入**不发** `volume_updated` 事件、**不同步**伏笔账本 | 事务感知写入刻意剥离了提交后副作用。若下游依赖这两者，需在 apply 服务提交后补 post-commit 钩子；**不得**改成在事务内触发 |
| K6 | shared `chapterRuntime` 含 7 处无扩展名相对导入，纯 ESM 下 `ERR_MODULE_NOT_FOUND` | 既有问题。本阶段用宽松 schema 绕开（`originalExpected` 是 applier 从不解读的审计证据）。后续若有模块必须 value-import 它，需先统一补 `.js` |
| K7 | T1 端到端整书回归未写 | **在它跑通前不得声称 2C 满足自动导演硬规则。** 当前只锁定了旁路隔离：生产者抛错不逃出定稿、无偏离不调用生产者 |

## Next

1. **T1 端到端整书回归**（优先于前端）：整书自动执行途中产生偏离提案、全书跑完不中断。
   2C.4 落地后已具备编写条件。
2. **2C.7 前端**：偏离在既有 Change Proposal Drawer 里的「接受 / 修正」呈现。
   有用户可见能力，提交前须走 `readme-release-updater`。
3. 合入路径保持 `codex/chapter-divergence → beta → main`，本分支不直接进 `main`。

## Wiki And Release Notes

- `docs/wiki/workflows/change-proposal-review.md` 已补：待审提案不阻塞正文（含 G4
  为何维持现状）、接受/修正两条出口、下游 patch 只能改文档自有字段的原因。
- 本阶段全部提交均为内部接线与契约，偏离尚未在任何界面呈现，因此按仓库规则明确
  跳过发布说明；2C.7 落地时才需要更新 `docs/releases/release-notes.md` 与 README。
