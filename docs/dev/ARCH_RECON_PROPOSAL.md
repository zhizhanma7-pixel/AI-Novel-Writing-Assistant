# ChangeProposal 架构侦察报告

> 侦察范围：`ExplosiveCoderflome/AI-Novel-Writing-Assistant` main 分支（`308ca1b chore(release): prepare desktop v0.4.13`）。
> 目的：在**不新建第二套 runtime** 的前提下，找出实现 `ChangeProposal`（Proposal / Edit Request Workflow）所需的最小架构扩展。
> 本文档只做侦察与方案论证，未修改任何代码。

---

## 0. 结论摘要

仓库里**已经存在 Proposal 工作流所需的绝大多数底座**，缺的不是运行时，而是三样东西：

| 需求 | 现状 |
|---|---|
| ProposedChange 原子单元 | ✅ 已有 `StateChangeProposal`（Prisma 模型 + Zod schema + 校验 + 提交 + 冲突检查） |
| 提交后写入正式状态 | ✅ 已有 `StateCommitService` + `CanonicalStateVersion` 版本日志 |
| 策略/自治等级门禁 | ✅ 已有 `DirectorPolicyEngine` + `DirectorRuntimePolicySnapshot` + `DIRECTOR_AUTO_APPROVAL_POINTS` |
| Artifact / Event 账本 | ✅ 已有 `DirectorArtifact(+Dependency)` / `DirectorEvent` / `DirectorArtifactLedger` |
| Checkpoint / resume / retry | ✅ 已有 `NovelWorkflowTask.checkpointType` + `DirectorRunCommand` 租约 + `DirectorLangGraphPilot` checkpoint |
| 手动编辑影响检测 | ✅ 已有 `DirectorWorkspaceAnalyzer.evaluateManualEditImpact` + `novel.director.manual_edit_impact` prompt |
| **Proposal 封装体（信封）与版本** | ❌ 缺失：没有把一组 ProposedChange 打包成一次可审、可改、可部分批准的提案 |
| **人工审阅 API / UI** | ❌ 缺失：`StateChangeProposal` 只有 `character_resource_update` 一种类型暴露了 confirm/reject 路由，其余类型只能被 AI 自动放行或自动裁决 |
| **Apply 分派器** | ❌ 缺失：`StateCommitService.applyCommittedProposal` 只实现了 2/9 种 proposalType 的落库 |

因此建议的扩展是：**新增一个信封模型 `ChangeProposal` + 一个 applier 注册表 + 一条审阅 HTTP 通道 + 一个 review UI**，全部挂载到现有 Director runtime / State 模块 / Prompt Registry 之上。**不新建平行 runtime。**

---

## 1. 当前规划 / Auto Director 架构

### 1.1 分层

`server/src/services/novel/director/README.md` 定义了三层：

```text
用户动作
  -> Web API command route            (director/http/novelDirector.ts)
  -> DirectorRunCommand / NovelWorkflowTask queued
  -> Director Worker lease            (DirectorTaskQueue + taskDispatcher)
  -> DirectorCommandExecutor          (commands/DirectorCommandExecutor.ts)
  -> WorkflowStepModule / Pipeline    (workflowStepRuntime/*, phases/*)
  -> DirectorPolicyEngine             (runtime/DirectorPolicyEngine.ts)
  -> Artifact Ledger / DirectorEvent  (runtime/DirectorArtifactLedger.ts, DirectorEventProjectionService.ts)
  -> Runtime Projection               (projections/*)
  -> 前端轻量查询
```

控制面（Web API）与执行面（Worker）严格隔离，API 不 `await` 长任务。

### 1.2 相关文件

| 职责 | 文件 |
|---|---|
| HTTP 命令入口 | `server/src/services/novel/director/http/novelDirector.ts`（496 行，含 `createTaskSchema` / `appendCommandSchema` 判别联合） |
| 命令创建与租约 | `commands/DirectorCommandService.ts`、`commands/leases/DirectorCommandLeaseService.ts` |
| 命令解释与执行 | `commands/DirectorCommandInterpreter.ts`、`commands/DirectorCommandExecutor.ts` |
| 导演门面 | `NovelDirectorService.ts`（849 行） |
| 运行时编排 | `runtime/DirectorRuntimeService.ts`、`runtime/DirectorNodeRunner.ts`、`runtime/DirectorRuntimeStore.ts` |
| LangGraph 步进 + 中断 | `langgraphPilot/DirectorLangGraphPilot.ts` |
| 步骤模块注册表 | `workflowStepRuntime/WorkflowStepModuleRegistry.ts`、`directorWorkflowStepModules.ts`、`directorWorkflowPlans.ts`、`directorWorkflowStepIds.ts` |
| 阶段（候选/宏观/结构化大纲/执行） | `phases/novelDirectorPipelinePhases.ts`、`phases/novelDirectorStructuredOutlinePhase.ts`、`phases/novelDirectorStoryMacroPhase.ts` |
| 章节批量自动执行 | `automation/novelDirectorAutoExecutionRuntime.ts`（+ CheckpointRuntime / CircuitBreakerRuntime / ScopeRuntime） |
| 恢复 | `recovery/novelDirectorRecovery.ts`、`recovery/novelDirectorDownstreamReset.ts`、`recovery/novelDirectorStructuredOutlineRecovery.ts` |
| 投影 | `projections/DirectorDashboardViewBuilder.ts`、`DirectorTaskSnapshotService.ts`、`DirectorBookAutomationProjectionService.ts`、`novelDirectorRuntimeProjection.ts` |

### 1.3 规划域（Planner / StoryPlan）

- `server/src/services/planner/PlannerService.ts` — 生成 `StoryPlan`（层级 `StoryPlanLevel`，含 `mustAdvanceJson` / `mustPreserveJson` / `revealsJson`）。
- `server/src/services/planner/replan/PlannerReplanService.ts` + `ReplanWindowDecisionService.ts` — 局部窗口重规划，写 `ReplanRun`。
- `server/src/services/novel/planning/ChapterPlanJITService.ts`、`ChapterRouteWindowService.ts` — 章节即时细化与路线窗口。
- `server/src/services/novel/volume/` + `VolumePlan` / `VolumeChapterPlan` — 卷战略与拆章。
- **注意**：`PlannerService` 与 `PlannerReplanService` 已经在读写 `stateChangeProposal`，是 Proposal 与规划链路的天然接缝。

### 1.4 自治等级现状

设计文档要求 L0/L1/L2/L3，仓库里已有**两套并存的自治维度**：

1. `DirectorPolicyMode`（`shared/types/directorRuntime.ts:9`）：`suggest_only` | `run_next_step` | `run_until_gate` | `auto_safe_scope`
2. `NovelControlPolicy.advanceMode`（`shared/types/canonicalState.ts:227`）：`manual` | `stage_review` | `auto_to_ready` | `auto_to_execution` | `full_book_autopilot`
3. 另有细粒度审批点开关 `DIRECTOR_AUTO_APPROVAL_POINTS`（`shared/types/autoDirectorApproval.ts`），5 组 / 多个 code，可逐点授权。

> **不要新增第三个自治枚举**。L0–L3 应该映射到 `DirectorPolicyMode`（见 §12.4）。

---

## 2. 已有审批 / 人工介入机制

系统里目前存在 **4 条相互独立**的人工介入通道：

### 2.1 Director Checkpoint 审批（主通道）

- 事实源：`NovelWorkflowTask.status = waiting_approval` + `checkpointType`（Prisma 中是 `String?`，TS 侧枚举在 `shared/types/novelWorkflow.ts:18`）：
  `candidate_selection_required` / `book_contract_ready` / `character_setup_required` / `volume_strategy_ready` / `production_experience_required` / `chapter_batch_ready` / `step_review_required` / `replan_required` / `workflow_completed`
- 用户动作 → `DirectorRunCommand`，commandType 见 `novelDirector.ts` 的 `appendCommandSchema`：
  `approve_gate` / `continue`（`resume` | `auto_execute_range` | `skip_quality_repair`）/ `resume_from_checkpoint` / `retry` / `calibrate_step`（`validate`|`improve`|`regenerate`）/ `accept_manual_changes_and_continue` / `policy_update` / `cancel`
- 自动放行策略：`AutoDirectorAutoApprovalRecord` + `shared/types/autoDirectorApproval.ts`（`isAutoApprovalPointEnabled`）
- 前端：`client/src/components/autoDirector/AutoDirectorApprovalStrategyPanel.tsx`、`AutoDirectorApprovalPointMultiSelect.tsx`、`AICockpit.tsx`、`client/src/api/novelDirector.ts::approveDirectorGate / continueDirectorRuntime / calibrateDirectorStep`

### 2.2 Agent Runtime 审批

- 模型：`AgentRun` → `AgentStep` → `AgentApproval`（`approvalType` / `targetType` / `targetId` / `diffSummary` / `payloadJson` / `status`）
- 策略：`server/src/agents/approvalPolicy.ts::evaluateApprovalRequirement()` — 对 `queue_pipeline_run`、`start_full_novel_pipeline`、`run_director_*`、`switch_director_policy`、`apply_chapter_patch`（整章覆盖 / 跨章 / 世界规则变更）要求确认。
- 续跑：`server/src/agents/runtime/ApprovalContinuationService.ts`（`reconcileWaitingApprovalRun` / `resolve`，带 `withSharedRunLock`）
- 路由：`server/src/routes/agentRuns.ts`
- **`AgentApproval.diffSummary` 是仓库里最接近「给人看的 diff」的现成字段**，但它绑死在 AgentRun 上，不适合作为书级 Proposal 的宿主。

### 2.3 StateChangeProposal 的 pending_review（半通道）

- 校验后落 `status = pending_review` 的提案会**阻塞式进入写作上下文**：`server/src/services/novel/runtime/context/pendingReviewContext.ts::buildBlockingPendingReviewProposalWhere / loadPendingCharacterHardFactReviews`
- 人工出口目前**只有一种类型**：`character_resource_update`
  - `POST /novels/:id/character-resource-proposals/:proposalId/confirm`
  - `POST /novels/:id/character-resource-proposals/:proposalId/reject`
  - 实现：`server/src/modules/novel/characters/http/novelCharacterResourceRoutes.ts:294 / :344`
- AI 出口两条：
  - `runtime/DirectorStateProposalResolutionService.ts`（AI 裁决 `apply` / `defer` / `auto_replan_window` / `manual_required`，prompt `director.state_proposal_resolution`）
  - `state/PendingReviewAutoPromotionService.ts`（默认关闭；baseline + 14 天 age gate + 冲突跳过，见 `docs/wiki/workflows/pending-review-auto-promotion.md`）

### 2.4 CharacterSyncProposal（独立小审批）

- 模型 `CharacterSyncProposal`，字段 `safeUpdatesJson` / `novelOnlyUpdatesJson` / `riskyUpdatesJson` / `recommendedAction` / `status=pending_review`
- 路由：`server/src/modules/novel/characters/http/novelCharacterSyncRoutes.ts`（list / `:proposalId/apply` / `:proposalId/ignore`）
- 服务：`server/src/services/character/CharacterLibrarySyncService.ts`
- **这是仓库里唯一已经实现「安全变更 / 风险变更 分桶 + 部分应用」的先例**，是 ChangeProposal 部分批准 UI 的最佳参考实现。

> ⚠️ `CharacterInfluenceProposal` 已退役（见 `docs/wiki/workflows/character-influence-proposals.md`），只保留迁移兼容，**不得在其上新增行为**。

---

## 3. Policy Engine

**文件**：`server/src/services/novel/director/runtime/DirectorPolicyEngine.ts`（262 行，纯函数式，无 IO，易扩展）

**接口**：

```ts
class DirectorPolicyEngine {
  decide(input: DirectorPolicyRequest): DirectorPolicyDecision
}
```

`DirectorPolicyRequest` 关键输入：`mode` / `policy` / `action`（`analyze`|`run_node`|`repair`|`overwrite`|`auto_continue`）/ `reads` / `writes` / `targetType` / `affectedArtifacts` / `mayOverwriteUserContent` / `requiresApprovalByDefault` / `isExpensiveReview` / `mayRecomputeDownstream` / `isLargeScopeAutoRun` / `qualityGateResult`

`DirectorPolicyDecision`（`shared/types/directorRuntime.ts:329`）输出：`canRun` / `requiresApproval` / `gateType`(`none`|`approval`|`blocked_scope`) / `reason` / `mayOverwriteUserContent` / `affectedArtifacts` / `riskTags` / `autoRetryBudget` / `onQualityFailure`

**判定优先级（自上而下短路）**：

1. `analyze` → 直接放行
2. `qualityGateResult.status === "blocked_scope"` → 阻断
3. 命中 `protectedUserContent` 且策略不允许覆盖 → 需批准
4. `mode === "suggest_only"` → 一切写入需批准（**这就是设计文档的 L0**）
5. 昂贵审校 / 默认需批准步骤 / 下游重算 / 大范围自动执行 → 非 `auto_safe_scope` 时需批准
6. 质量门 `repairable` / `needs_manual_repair` / `continue_with_risk` → 分别给自动修复预算、人工修复、风险继续

**执行点**：`runtime/DirectorNodeRunner.ts` 在跑每个 node 前调用 `policyEngine.decide()`，决策写入 `DirectorStepRun.policyDecisionJson`，`requiresApproval` 时步骤 status 落 `waiting_approval`。

**策略快照**：`DirectorRuntimePolicySnapshot`（`mode` / `mayOverwriteUserContent` / `maxAutoRepairAttempts: 1` / `allowExpensiveReview` / `modelTier`）持久化在 `DirectorRun.policyJson`，由 `POST /tasks/:taskId/commands` 的 `policy_update` 命令修改。

**书级/全局问题策略**：`issues/DirectorIssuePolicyService.ts` + `Novel.directorIssuePolicyOverridesJson`，优先级 `安全规则 > 本书覆盖 > 全局设置 > 内置默认`，任务启动时冻结快照。

---

## 4. Artifact / Event Ledger

### 4.1 Artifact Ledger

| 层 | 位置 |
|---|---|
| 类型契约 | `shared/types/directorRuntime.ts` — `DIRECTOR_ARTIFACT_TYPES`（17 种）、`DirectorArtifactRef`、`DirectorArtifactStatus`(`draft`/`active`/`superseded`/`stale`/`rejected`)、`DirectorArtifactSource`(`ai_generated`/`user_edited`/`auto_repaired`/`imported`/`backfilled`) |
| 规范化/哈希/依赖 | `runtime/DirectorArtifactLedger.ts`（`buildDirectorArtifactId`、`stableDirectorContentHash`、`compactDirectorArtifactDependencies`、`normalizeDirectorArtifactTargets`） |
| 读写网关 | `runtime/DirectorArtifactGateway.ts`（`ArtifactReader.listActiveForNovel`、`ArtifactWriter.upsert`、`ArtifactWriter.markUserEdited`） |
| 查询 | `runtime/DirectorArtifactLedgerQueryService.ts` |
| 库存与体检 | `runtime/DirectorWorkspaceArtifactInventory.ts`、`DirectorWorkspaceQualityArtifactInventory.ts` |
| 持久化 | Prisma `DirectorArtifact` + `DirectorArtifactDependency`（`artifactId` ↔ `dependsOnArtifactId` + `dependsOnVersion`） |

`DirectorArtifact` 的 `contentTable` / `contentId` 是指向真实业务表的指针 —— artifact 本身不存内容，只存出处、版本、hash、来源、依赖与保护标记。**上游变化只把下游 artifact 标 `stale`，不删除 `chapter_draft`。**

### 4.2 Event Ledger

- 模型：`DirectorEvent`（`id` / `runId?` / `taskId?` / `novelId?` / `type` / `nodeKey?` / `artifactId?` / `artifactType?` / `summary` / `affectedScope?` / `severity?` / `metadataJson?` / `occurredAt`）
- 类型枚举：`shared/types/directorRuntime.ts:291`，22 种，含 `approval_required`、`policy_changed`、`artifact_indexed`、`quality_issue_found`、`replan_run_created`、`pending_review_auto_promotion`、`issue_detected`、`issue_action_applied`
- 写入：`runtime/DirectorAutomationLedgerEventService.ts::recordEvent({ idempotencyKey, ... })` — **幂等键必填**
- 投影：`runtime/DirectorEventProjectionService.ts` → `DirectorRuntimeProjectionEvent`
- 问题治理事件的完整记录保存在 `DirectorEvent.metadata`，**不另建问题表**（AGENTS.md 硬规则）

> `DirectorEvent` 的 `runId` / `taskId` / `novelId` 全部可空 —— 这意味着**书级 Proposal 事件可以在没有导演任务时也写入同一个账本**，不需要新表。

### 4.3 其它并行账本

- `PayoffLedgerItem`（伏笔账本，见 `docs/wiki/workflows/payoff-ledger-contract.md`）
- `CharacterResourceLedgerItem` + `CharacterResourceEvent`（角色资源账本）
- `NovelFactEntry`（事实账本）
- `CanonicalStateVersion`（正史状态版本，`acceptedProposalIdsJson` 已经把版本与提案 id 关联）
- `DirectorLlmUsageRecord`（用量遥测，带 `stepIdempotencyKey` 归因）

---

## 5. 章节生产链

权威文档：`docs/wiki/workflows/chapter-production-chain.md`（**必读，含大量硬约束**）

### 5.1 唯一执行链（AGENTS.md 最高优先级硬约束）

```text
控制入口（手动单章 / 批量 / 自动导演 / 修复）
  → novelProductionOrchestrator                (production/NovelProductionOrchestrator.ts)
  → ChapterExecutionStageRunner / QualityRepairStageRunner
  → ChapterRuntimeCoordinator                  (runtime/ChapterRuntimeCoordinator.ts) ← 唯一稳定门面
      ├─ ChapterRuntimeReadinessService        轻量预检
      ├─ ChapterStreamGenerationOrchestrator → ChapterWritingGraph  整章一次性生成
      ├─ ChapterAcceptanceAssessmentService    结构化接收闸门
      ├─ ProseQualityDetector                  确定性正文退化检测（无 LLM）→ mode_fit / prose_*
      ├─ ChapterQualityGateService             质量门
      ├─ repair/ChapterRepairStreamRuntime     patch repair → 最多一次 heavy_repair
      ├─ ChapterContentFinalizationService     等待 artifact_delta
      └─ ChapterTimelineFinalizationService    时间线定稿（进入下一章的必经步骤）
```

`NovelProductionStage` = `project_framing` → `story_macro` → `book_contract` → `character_prep` → `volume_planning` → `chapter_preparation` → `chapter_execution` → `quality_repair`

### 5.2 后置资产回灌

`ChapterArtifactDeltaService`（`runtime/ChapterArtifactDeltaService.ts`）**一次低温结构化调用**产出：
`summary` / `concreteFacts` / `stateDeltas` / `characterResourceDeltas` / `payoffDeltas` / `relationDynamics` / `factionUpdates` / `characterCandidates` / `characterKnowledgeStates` / `syncPlan`

→ 交给 `StateCommitService.proposeAndCommit()` → 生成 `StateChangeProposal` → 校验 → 提交或挂 `pending_review` → 写 `CanonicalStateVersion`

幂等：`ChapterArtifactSyncCheckpoint`（`@@unique([novelId, chapterId, contentHash, artifactType, syncMode])`，抢占式 `running` 标记）

> **这条通道就是设计文档要求的「Post-write Analysis / Actual State Diff」的现成实现。** 缺的只是「与已批准计划对比」。

### 5.3 状态提交链

```text
ChapterFactExtractor.extract()                     → StateChangeProposal[]
StateCommitService.validate()                      → { accepted, pendingReview, rejected }
  ├─ applyCharacterResourceConflictChecks()        资源冲突检查
  ├─ resolveProposalSourceQuality()                confirmed / debt（stateProposalSourceQuality.ts）
persistValidated()                                 落库
applyCommittedProposal(tx, proposal)               ⚠️ 只实现 character_resource_update / character_state_update
stateVersionLog.createVersion()                    → CanonicalStateVersion（version 自增）
prisma.stateChangeProposal.updateMany({ committedVersionId })
```

---

## 6. 手动编辑影响检测

**已实现，可直接复用。**

| 层 | 位置 |
|---|---|
| 类型 | `shared/types/directorRuntime.ts:1131-1192` — `DirectorManualEditImpactLevel`(`none`/`low`/`medium`/`high`)、`DirectorManualEditRepairAction`、`DirectorManualEditChangedChapter`、`DirectorManualEditRepairStep`、`AiManualEditImpactDecision`、`DirectorManualEditInventory`、`DirectorManualEditImpact` |
| 实现 | `runtime/DirectorWorkspaceAnalyzer.ts:403 evaluateManualEditImpact()` / `:498 buildManualEditInventory()` |
| 检测方式 | 拿当前 `chapter_draft` artifact 的 `contentHash` 与 `snapshot.lastWorkspaceAnalysis.inventory.artifacts` 的历史 hash 对比 → `changedChapters` |
| AI 解释 | PromptAsset `novel.director.manual_edit_impact`（`prompting/prompts/novel/directorManualEditImpact.prompts.ts:80`），失败有 `buildManualEditFallbackDecision` 兜底 |
| 门面 | `DirectorRuntimeService.evaluateManualEditImpact()` |
| HTTP | `GET /manual-edit-impact/:novelId?workflowTaskId&chapterId&ai=` （`director/http/novelDirector.ts:480`）+ `POST /tasks { taskType: "manual_edit_impact" }` |
| Agent 工具 | `evaluate_manual_edit_impact`（Planner / Reviewer / Continuity 均可用） |
| 前端 | `client/src/pages/tasks/components/TaskCenterManualEditImpactCard.tsx`（127 行，已渲染 impactLevel badge / changedChapters / minimalRepairPath / riskNotes） |

输出的 `minimalRepairPath: DirectorManualEditRepairStep[]`，每步带 `requiresApproval` —— **这已经是一个「AI 提出、逐条可批准的修复计划」的雏形**，语义上就是 ProposedChange 的近亲。

> 设计文档 §5「Outline Edit Proposal 的后续依赖检查」应该扩展这条链路（把检测范围从 `chapter_draft` 扩到 `chapter_task_sheet` / `volume_chapter_list`），而不是另写一个依赖分析器。

---

## 7. Prisma 模型清单

Schema：`server/src/prisma/schema.prisma`（4059 行，155 个 model）
双 schema：`schema.prisma`（PostgreSQL 主）与 `schema.sqlite.prisma`（SQLite），迁移目录 `src/prisma/migrations` 与 `src/prisma/migrations.sqlite` **必须成对维护**。

### 7.1 projects（小说项目）

| 模型 | 行 | 要点 |
|---|---|---|
| `Novel` | 324 | 项目根。含 `creationExperience`、`narrativeForm`、`projectMode`、`writingMode`、`aiFreedom`、`directorIssuePolicyOverridesJson`、`directorRiskNoticeThreshold/PauseThreshold`、`structuredOutline`、`storyWorldSliceJson`。已有 `stateChangeProposals` / `canonicalStateVersions` / `directorEvents` / `directorArtifacts` 反向关系 |
| `NovelSnapshot` | 651 | 项目快照（回滚用） |
| `NovelIntentVersion` | 456 | 创作意图版本 |
| `BookContract` | 2169 | 书级合同 |
| `StoryMacroPlan` | 2154 | 总纲 |
| `NovelBible` / `PlotBeat` | 1829 / 1843 | 故事圣经 / 节拍 |

### 7.2 chapters

| 模型 | 行 | 要点 |
|---|---|---|
| `Chapter` | 663 | `content` / `order` / `generationState` / `chapterStatus` / `taskSheet` / `sceneCards` / `repairHistory` / `riskFlags` / `hook` / `expectation`。已关联 `stateChangeProposals` / `storyPlans` / `canonicalStateVersions` / `auditReports` |
| `ChapterSummary` | 1860 | 章摘要 |
| `ChapterArtifactSyncCheckpoint` | 719 | 后置抽取幂等 checkpoint |
| `QualityReport` / `AuditReport` / `AuditIssue` | 2133 / 2977 / 2995 | 质量与审计 |
| `VolumeChapterPlan` | 2107 | 规划态章节（含 `conflictLevelSource` 用户锚定） |

### 7.3 characters

| 模型 | 行 | 要点 |
|---|---|---|
| `Character` | 739 | 稳定档案 + `currentState` / `currentGoal` / `lastEvolvedAt` + 硬事实字段（`identityLabel` / `factionLabel` / `stanceLabel` / `powerLevel` / `realm` / `currentLocation` / `availability` / `prohibitionsJson`）+ arc 四段 |
| `CharacterState` | 2640 | 快照内动态状态（`currentGoal` / `emotion` / `stressLevel` / `secretExposure` / `knownFactsJson` / `misbeliefsJson`） |
| `CharacterMindSnapshot` | 811 | 心智快照 |
| `BaseCharacter` / `BaseCharacterRevision` / `CharacterLibraryLink` | 1199 / 1225 / 1242 | 跨书角色库 |
| `CharacterSyncProposal` | 1264 | **部分批准先例** |
| `CharacterCandidate` / `CharacterCastOption(+Member/Relation)` | 1100 / 1006 | 候选阵容 |
| `CharacterInfluenceProposal` | 841 | ⚠️ 已退役，只保留迁移兼容 |

### 7.4 relationships

| 模型 | 行 | 要点 |
|---|---|---|
| `CharacterRelation` | 977 | **正式关系表**：`surfaceRelation` / `hiddenTension` / `conflictSource` / `secretAsymmetry` / `trustScore` / `conflictScore` / `intimacyScore` / `dependencyScore`，`@@unique([novelId, sourceCharacterId, targetCharacterId])` |
| `RelationState` | 2660 | **快照内关系状态**，同样带 4 个分数，`@@unique([snapshotId, source, target])` |
| `CharacterRelationStage` | 1169 | 卷级关系阶段 |
| `CharacterDialogueInfluence` | 908 | 对话层软性影响 |

> 设计文档的 `A→B trust: 62 → 52` 直接落在 `RelationState.trustScore` / `CharacterRelation.trustScore` 上，`proposalType = relation_state_update` 已存在。

### 7.5 world state

| 模型 | 行 |
|---|---|
| `World` / `NovelWorld` / `WorldAsset` / `WorldSnapshot` / `WorldPropertyLibrary` | 1480 / 1520 / 1568 / 1605 / 1590 |
| `WorldConsistencyIssue` / `WorldSyncRecord` / `WorldDeepeningQA` | 1633 / 1553 / 1616 |
| `Novel.storyWorldSliceJson` | 324 区 | 开篇世界切片 |
| 规范化视图 | `canonicalWorldStateSchema`（`rules` / `forces` / `locations` / `tabooRules` / `currentSituation`） |

`proposalType = world_rule_change` 已在枚举中，但 **`applyCommittedProposal` 未实现它的落库**。

### 7.6 planning

| 模型 | 行 | 要点 |
|---|---|---|
| `StoryPlan` | 2904 | 层级规划（`level` / `planRole` / `mustAdvanceJson` / `mustPreserveJson` / `revealsJson` / `riskNotesJson` / `sourceIssueIdsJson` / `replannedFromPlanId` / `externalRef`），自关联 `StoryPlanHierarchy` |
| `ChapterPlanScene` | 2944 | 场景拆解 |
| `ReplanRun` | 2960 | 重规划记录 |
| `VolumePlan` / `VolumePlanVersion` / `VolumeChapterPlan` | 2078 / 2061 / 2107 | 卷规划与版本 |
| `StorylineVersion` | 2046 | 故事线版本 |

### 7.7 tasks

| 模型 | 行 | 要点 |
|---|---|---|
| `NovelWorkflowTask` | 2186 | 统一任务：`lane` / `status` / `progress` / `currentStage` / `checkpointType` / `checkpointSummary` / `resumeTargetJson` / `seedPayloadJson` / `milestonesJson` / `pendingManualRecovery` / `heartbeatAt` / `attemptCount` / `maxAttempts` / token 计数 |
| `DirectorRunCommand` | 2232 | 活动命令队列（租约 `leaseOwner` / `leaseExpiresAt`，`@@unique([taskId, commandType, idempotencyKey])`） |
| `DirectorRun` / `DirectorStepRun` / `DirectorEvent` / `DirectorArtifact(+Dependency)` | 2405 / 2424 / 2485 / 2510 / 2546 | 运行时快照与账本 |
| `DirectorRuntimeInstance` / `Command` / `Execution` / `Checkpoint` / `Event` | 2259–2404 | ⚠️ **Legacy 队列，只读兼容，禁止新增写入路径** |
| `GenerationJob` | 1893 | 章节流水线任务 |
| `NovelSideEffectJob` | 3389 | 持久化副作用队列 |
| `TaskCenterArchive` | 3414 | 任务归档 |

### 7.8 状态与提案（核心）

| 模型 | 行 | 要点 |
|---|---|---|
| `StoryStateSnapshot` | 2617 | 状态快照根，`@@unique([novelId, sourceChapterId])` |
| `CharacterState` / `RelationState` / `InformationState` / `ForeshadowState` | 2640 / 2660 / 2680 / 2695 | 快照子表 |
| `OpenConflict` | 2714 | 未解决冲突（提案冲突检查依据） |
| `PayoffLedgerItem` | 2744 | 伏笔账本 |
| `CanonicalStateVersion` | 2857 | **正史版本**：`version` 自增 + `snapshotJson` + `acceptedProposalIdsJson` |
| **`StateChangeProposal`** | **2877** | **`sourceType` / `sourceStage` / `proposalType` / `riskLevel` / `status` / `summary` / `payloadJson` / `evidenceJson` / `validationNotesJson` / `committedVersionId`** |

`stateChangeProposalTypeSchema`（`shared/types/canonicalState.ts:7`）9 种：
`event_record` / `character_state_update` / `relation_state_update` / `information_disclosure` / `conflict_update` / `payoff_progression` / `character_resource_update` / `world_rule_change` / `book_contract_change`

`status` 4 种：`validated` / `pending_review` / `committed` / `rejected`
`riskLevel` 3 种：`low` / `medium` / `high`

---

## 8. Checkpoint / Retry / Resume

### 8.1 三套 checkpoint 并存

| 层 | 载体 | 用途 |
|---|---|---|
| 任务级 | `NovelWorkflowTask.checkpointType` + `checkpointSummary` + `resumeTargetJson` | 用户可见的等待点，驱动 `waiting_approval` |
| 步骤级 | `DirectorLangGraphPilotCheckpoint`（`completedGraphNodes` / `completedStepIds` / `pendingStep` / `interrupt` / `trace`） | LangGraph 步进与中断恢复 |
| 资产级 | `ChapterArtifactSyncCheckpoint` | 后置抽取幂等（content hash 维度） |
| Legacy | `DirectorRuntimeCheckpoint` | ⚠️ 只读兼容 |

### 8.2 关键实现

- `automation/novelDirectorAutoExecutionCheckpointRuntime.ts` — `syncAutoExecutionTaskState` / `recordCompletedCheckpoint` / `recordQualityRepairCheckpoint` / `resolveQualityRepairNoticeAction`
- `recovery/novelDirectorRecovery.ts` — `DIRECTOR_PIPELINE_PHASE_ORDER`、`resolveObservedResumePhaseFromWorkspace`、`resolveSafeDirectorPipelineStartPhase`、`resolveAssetFirstRecoveryFromSnapshot`（**asset-first recovery：从真实产物事实定位断点，不信任 task.status**）
- `commands/leases/DirectorCommandLeaseService.ts` — 租约领取/续约/失联治理/重排队
- `runtime/DirectorCircuitBreakerService.ts` + `DirectorQualityLoopBudgetLedgerService.ts` — 熔断与质量循环预算
- `runtime/DirectorRuntimeSnapshotMerge.ts` — 快照合并
- `DirectorRunCommand.attempt` / `NovelWorkflowTask.attemptCount / maxAttempts(3)` — 重试预算

### 8.3 硬规则（AGENTS.md + wiki）

- 读路径必须只读：`recover` / 事实检查 / 投影**不得写入** `run_resumed` 或恢复事件
- 步骤就绪性/完成度必须优先读**真实产物事实**（`Chapter.content` / `AuditReport` / 阻塞 issue / `StoryStateSnapshot` / `CanonicalStateVersion`），`task.status` / `chapterStatus` 只能作为投影
- 服务重启后不静默续跑长任务

---

## 9. Prompt Registry

**唯一入口**：`server/src/prompting/`（AGENTS.md「Prompt Governance」硬规则）

### 9.1 结构

```text
prompting/
├─ registry.ts                     懒加载注册表（key = `${id}@${version}`，重复注册直接抛错）
├─ registry/promptAssetLoaderEntries.ts   资产 loader 清单
├─ core/promptTypes.ts             PromptAsset / ContextPolicy / PromptEditableSlot / PromptInvocationMeta / PromptRunTrace
├─ core/promptRunner.ts            runStructuredPrompt / runTextPrompt / streamTextPrompt / streamStructuredPrompt
├─ core/contextBudget.ts, contextSelection.ts, renderContextBlocks.ts
├─ context/ContextBroker.ts, ContextResolverRegistry.ts, runtimeContextResolvers.ts
├─ materials/                      材料分组导出
├─ slots/                          可编辑 slot
├─ templates/, workbench/, addendums/
├─ workflows/directorWorkflowDefinitions.ts
└─ prompts/<family>/               23 个 family
```

### 9.2 与 Proposal 相关的已有资产

| id | 文件 |
|---|---|
| `novel.director.workspace_analysis` | `prompts/novel/directorWorkspaceAnalysis.prompts.ts:114` |
| `novel.director.manual_edit_impact` | `prompts/novel/directorManualEditImpact.prompts.ts:80` |
| `director.state_proposal_resolution` | `prompts/novel/directorStateProposalResolution.prompts.ts:21` |
| `state.snapshot.extract` | `prompts/state/state.prompts.ts:64` |
| `novel.director.planning`（规划） | `prompts/novel/directorPlanning.prompts.ts` |
| `director.risk_assessment` / `director.issue_assessment` | `prompts/director/*` |
| 章节链 | `prompts/novel/chapterWriter.prompts.ts`、`chapterAcceptance.prompts.ts`、`chapterArtifactDelta.prompts.ts`、`chapterPatchRepair.prompts.ts` |

### 9.3 新增 prompt 的硬要求

必须提供：`id` / `version` / `taskType` / `mode` / `language` / `contextPolicy` / (`outputSchema` 或 text 模式 `postValidate`) / `render()`；并在 `registry.ts` 注册、进入提示词管理目录。
可选：`repairPolicy`（JSON/schema repair 次数）、`semanticRetryPolicy`（postValidate 失败后语义重试）。
**禁止**在 service 内直接拼 `systemPrompt/userPrompt` 调 `invokeStructuredLlm`，或裸调 `getLLM()`。

上下文拼装顺序由 `ContextBroker` + `contextPolicy.requiredGroups / preferredGroups / dropOrder` 决定，**`required` 块不可被模板静默移除**。

---

## 10. 可复用前端组件

| 组件 | 路径 | 复用价值 |
|---|---|---|
| `TaskCenterManualEditImpactCard` | `client/src/pages/tasks/components/` (127) | ★★★ 影响等级 badge + 受影响章节 + 推荐处理路径 + 风险提示。**Proposal「变更影响」区可直接改造** |
| `ResourceRiskPanel` | `client/src/pages/novels/components/chapterInsights/` | ★★★ 已有 `pendingProposals` + `onConfirm/onReject` + per-item pending id 状态。**逐条 ✓/✗ 交互的现成范式** |
| `DirectorRuntimeProjectionCard` | `client/src/components/autoDirector/` (497) | ★★★ 运行态 + 事件流 + 策略 + artifact 展示 |
| `AutoDirectorApprovalStrategyPanel` + `AutoDirectorApprovalPointMultiSelect` | `client/src/components/autoDirector/` (81 + 121) | ★★★ 审批点分组多选。**Autonomy Level 设置面板可直接复用** |
| `TaskCenterRuntimePolicyCard` | `client/src/pages/tasks/components/` (155) | ★★ 策略模式切换 UI |
| `AICockpit` | `client/src/components/autoDirector/` (615) | ★★ 主状态裁决 + 主按钮；Proposal 待办应挂在这里，**不要另起入口** |
| `AITakeoverContainer` / `WorkflowProgressBar` | `client/src/components/workflow/` | ★★ 接管容器与进度条 |
| `AiRevisionWorkspace` | `client/src/components/common/` (208) | ★★ Plate 编辑器 + 左右分栏，**「编辑后批准」的文本编辑面板** |
| `NovelTaskDrawer` | `client/src/pages/novels/components/` | ★★ 任务抽屉，Proposal 待办的第二入口 |
| `CollapsibleSummary` / `MarkdownViewer` / `StreamOutput` | `components/common`, `pages/novels/components` | ★ 折叠摘要 / Markdown / 流式输出 |
| `client/src/mobile/autoDirector/mobileSupportContracts.ts` | — | ★★ 移动端契约，Android Proposal UI 的落点 |
| shadcn 基座 | `client/src/components/ui/` | badge / button / toast / dialog / tabs |

**前端主状态硬规则**：Proposal 待办**不得**自行裁决主 badge / 主进度 / 主按钮，必须经 `DirectorDashboardView`（`projections/DirectorDashboardViewBuilder.ts`）。

---

## 11. 差距分析

| 设计文档要求 | 现状 | 差距 |
|---|---|---|
| `ChangeProposal` 信封（8 种 proposalType、summary、reasoningSummary、warnings、6 种 status） | 无 | **需新增** |
| `ProposedChange`（path / operation / before / after / category / severity / reason / sourceRefs） | `StateChangeProposal` 覆盖 ~70%（缺 path / operation / before / after / category / severity 显式字段，但 `payloadJson` 可承载） | **需补字段** |
| Proposal 版本 v1→v2→Approved | 无（`CanonicalStateVersion` 是状态版本不是提案版本） | **需新增** |
| 部分批准 | 仅 `CharacterSyncProposal` 有 safe/risky 分桶 | **需通用化** |
| 逐条 ✓/✎/✗ | `character-resource-proposals` confirm/reject（无 ✎） | **需补「修改后批准」** |
| Approval API | 仅 2 类 proposalType 暴露 | **需通用审阅路由** |
| Apply engine | `applyCommittedProposal` 只实现 2/9 | **需 applier 注册表** |
| Expected vs Actual State | `ChapterArtifactDeltaService` 已产出 Actual；无 Expected 对比 | **需 divergence service** |
| Outline Edit Proposal 依赖检测 | `evaluateManualEditImpact` 只看 `chapter_draft` | **需扩展 artifact 范围** |
| Outline Fidelity（Strict/Balanced/Director） | 无；但 `StoryPlan.mustPreserveJson` / `mustAdvanceJson` 已是同类语义 | **需策略字段** |
| Autonomy L0–L3 | `DirectorPolicyMode` 4 档已等价 | **只需映射，不新增枚举** |
| 不存 chain-of-thought | `StateChangeProposal` 只存 summary + evidence + validationNotes，已合规 | ✅ |

---

## 12. 建议的最小架构扩展

### 12.1 总原则

> **`ChangeProposal` 是 `StateChangeProposal` 的信封，不是新的运行时。**

- 提案的**生成**：作为 `WorkflowStepModule` 进入现有 director workflow，或由现有 `ChapterArtifactDeltaService` / `PlannerService` 产出。
- 提案的**门禁**：走 `DirectorPolicyEngine.decide()`，新增一个 input 字段，不新增引擎。
- 提案的**等待**：走 `NovelWorkflowTask.checkpointType`（新增字符串值，Prisma 无需迁移）。
- 提案的**审批动作**：走 `DirectorRunCommand`（新增 commandType），不新增队列。
- 提案的**留痕**：走 `DirectorEvent`（新增 event type），不新增事件表。
- 提案的**落库**：走 `StateCommitService` + `CanonicalStateVersion`，不新增写入路径。
- 提案的**过期检测**：走 `DirectorArtifact` 依赖 + `stale` 状态，不新增依赖图。

### 12.2 数据层（唯一必须的 schema 变更）

**新增 1 张表**：

```prisma
model ChangeProposal {
  id                 String   @id @default(cuid())
  novelId            String
  chapterId          String?
  taskId             String?              // NovelWorkflowTask，可空（手动入口无任务）
  proposalType       String               // chapter_execution | outline_edit | character_state |
                                          // relationship_change | world_edit | plot_replan |
                                          // asset_import | post_write_state
  version            Int      @default(1)
  supersedesId       String?              // 版本链：v1 → v2
  status             String   @default("draft")
                                          // draft | pending_review | approved |
                                          // partially_approved | rejected | executed | superseded
  outlineFidelity    String?              // strict | balanced | director
  summary            String
  reasoningSummary   String?              // 仅用户可见简要依据，禁止 chain-of-thought
  sourceRefsJson     String?              // SourceReference[]：artifactId / table:id / chapterOrder
  warningsJson       String?              // ProposalWarning[]（冲突检测结果）
  expectedStateJson  String?              // 供 post-write divergence 对比
  approvedAt         DateTime?
  executedAt         DateTime?
  novel              Novel    @relation(fields: [novelId], references: [id], onDelete: Cascade)
  chapter            Chapter? @relation(fields: [chapterId], references: [id], onDelete: SetNull)
  task               NovelWorkflowTask? @relation(fields: [taskId], references: [id], onDelete: SetNull)
  supersedes         ChangeProposal?  @relation("ChangeProposalVersion", fields: [supersedesId], references: [id], onDelete: SetNull)
  supersededBy       ChangeProposal[] @relation("ChangeProposalVersion")
  changes            StateChangeProposal[]
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  @@index([novelId, status, updatedAt])
  @@index([taskId, status])
  @@index([chapterId, createdAt])
  @@index([supersedesId])
}
```

**扩展现有 `StateChangeProposal`（全部可空，向后兼容）**：

```prisma
  changeProposalId   String?    // FK → ChangeProposal
  changePath         String?    // "Character.A.relationship.B.trust"
  operation          String?    // add | remove | replace
  category           String?    // outline|character|relationship|knowledge|world|plot|foreshadowing|timeline
  severity           String?    // minor | major
  beforeJson         String?
  afterJson          String?
  userEditedPayloadJson String? // 「编辑后批准」的用户改写值
  reviewDecision     String?    // accepted | modified | rejected
```

> **不要**改 `StateChangeProposal.status` 的现有 4 个取值，也不要改 `proposalType` 已有 9 项的语义 —— `PendingReviewAutoPromotionService`、`DirectorStateProposalResolutionService`、`pendingReviewContext.ts` 都在按它们过滤。新 `proposalType` 值（如 `outline_edit`）只在带 `changeProposalId` 的行上出现，并且**必须同步扩展这三处的过滤白名单**，否则会被自动放行链路误判。

**双 schema**：`schema.prisma` 与 `schema.sqlite.prisma` 必须同步，`migrations/` 与 `migrations.sqlite/` 必须成对新增。

### 12.3 服务层

```text
server/src/services/novel/proposal/            ← 新增模块目录
├─ ChangeProposalService.ts        创建 / 版本化 / 状态机 / 查询
├─ ChangeProposalReviewService.ts  approve / partial approve / modify / reject / regenerate
├─ ChangeProposalApplyService.ts   调用 StateCommitService，不自己写业务表
├─ ChangeProposalDivergenceService.ts  Expected vs Actual（§12.6）
├─ appliers/                       ← Apply 分派器
│  ├─ ProposalApplierRegistry.ts
│  ├─ characterStateApplier.ts     （从 StateCommitService 迁入）
│  ├─ characterResourceApplier.ts  （从 StateCommitService 迁入）
│  ├─ relationStateApplier.ts      ← 新增，写 CharacterRelation / RelationState
│  ├─ worldRuleApplier.ts          ← 新增
│  ├─ outlineEditApplier.ts        ← 新增，写 VolumeChapterPlan / StoryPlan
│  └─ ...
└─ http/novelChangeProposalRoutes.ts
```

`StateCommitService.applyCommittedProposal()` 改为委托 `ProposalApplierRegistry.get(proposalType)?.apply(tx, proposal)`。**这是唯一需要动 StateCommitService 的地方，且是纯提取重构。**

### 12.4 Autonomy Level 映射（不新增枚举）

| 设计文档 | 映射到 `DirectorPolicyMode` | 附加 |
|---|---|---|
| L0 Manual | `suggest_only` | 已有：策略引擎对一切写入返回 `requiresApproval` |
| L1 Approval（默认） | `run_next_step` | + `requiresApprovalByDefault=true`（结构性变更） |
| L2 Guarded Auto | `run_until_gate` | + 新增 `proposalSeverity` 输入：`minor` 自动、`major` 需批准 |
| L3 Director | `auto_safe_scope` | + 保留 `protectedUserContent` / 冲突 / 低置信度 强制门 |

`DirectorPolicyEngine.decide()` 只需新增两个可选输入：

```ts
proposalSeverity?: "minor" | "major";
outlineFidelity?: "strict" | "balanced" | "director";
```

并在 `suggest_only` 分支之后、`requiresApprovalByDefault` 分支之前插入一条判定；`riskTags` 新增 `"proposal_major"` / `"outline_fidelity_strict"`。**不改判定顺序，不改已有分支语义。**

### 12.5 Runtime 接入点

| 接入点 | 改动 |
|---|---|
| `shared/types/novelWorkflow.ts:18` | `NovelWorkflowCheckpoint` 新增 `"proposal_review_required"`（Prisma 侧是 `String?`，**无需迁移**） |
| `director/http/novelDirector.ts` `appendCommandSchema` | 新增 `commandType: "review_proposal"`，payload `{ proposalId, decision: "approve"|"partial"|"reject"|"replan", itemDecisions?: Array<{ id, decision, editedPayload? }> }` |
| `commands/DirectorCommandExecutor.ts` | 新增分支 → `ChangeProposalReviewService` |
| `workflowStepRuntime/directorWorkflowStepModules.ts` | 新增 `chapter.proposal.compose` StepModule（在 `chapter.draft.write` 之前），产出 `change_proposal` artifact，policy 判定 `requiresApproval` 时落 `proposal_review_required` checkpoint |
| `shared/types/directorRuntime.ts` `DIRECTOR_ARTIFACT_TYPES` | 新增 `"change_proposal"` —— **这样提案自动获得 stale 传播、依赖追踪、`protectedUserContent` 保护**，直接解决 Phase 6 验收项「proposal source changed before approval / stale proposal」 |
| `shared/types/directorRuntime.ts` `DirectorEventType` | 新增 `"proposal_created"` / `"proposal_reviewed"` / `"proposal_applied"` / `"proposal_superseded"` |
| `shared/types/autoDirectorApproval.ts` | 新增审批点 `proposal_minor_auto_approved`（归 `low_risk_continue` 组） |
| `runtime/context/pendingReviewContext.ts` | 扩展：把「已批准未执行」的 ChangeProposal 注入写作上下文（对应设计文档「Approved Proposal」上下文层） |

### 12.6 Expected vs Actual State

复用现成链路，只补一个对比器：

```text
approved ChangeProposal.expectedStateJson
        +
ChapterArtifactDeltaService 产出的 stateDeltas（= Actual）
        ↓
ChangeProposalDivergenceService.compare()
        ├─ subject key 对齐：复用 state/stateProposalSubjectKey.ts（已实现 relation / information 的 key）
        │   → 需扩展到 character_state / payoff / world_rule
        ├─ 输出 divergence 列表（expected vs actual，含幅度差）
        └─ 超阈值 → 生成新的 post_write_state ChangeProposal（v1）
                  → 走同一条 review 通道
```

三个用户选项（改正文 / 接受新状态 / 手动设定）分别映射到：`quality_repair` stage、approve 新提案、逐条 `modified` 决策。

### 12.7 HTTP 面

挂到小说模块（不是 `server/src/routes/` 根目录，AGENTS.md 硬规则）：

```text
GET    /api/novels/:id/change-proposals?status=&type=&chapterId=
GET    /api/novels/:id/change-proposals/:proposalId
PATCH  /api/novels/:id/change-proposals/:proposalId/items/:itemId   （✎ 编辑后批准）
POST   /api/novels/:id/change-proposals/:proposalId/approve         （支持 itemDecisions 部分批准）
POST   /api/novels/:id/change-proposals/:proposalId/reject
POST   /api/novels/:id/change-proposals/:proposalId/regenerate      （→ v2）
```

写入类动作若属于导演任务，**必须转成 `DirectorRunCommand` 再返回 202**，不在 route 里 `await` 执行链。

### 12.8 前端

```text
client/src/pages/novels/components/proposal/
├─ ChangeProposalDrawer.tsx        桌面三栏：来源/依据 · Proposal · State Diff
├─ ProposedChangeList.tsx          逐条 ✓ / ✎ / ✗（改造自 ResourceRiskPanel）
├─ ProposedChangeEditor.tsx        单条编辑（复用 AiRevisionWorkspace 思路）
├─ ProposalWarningList.tsx         冲突/风险（改造自 TaskCenterManualEditImpactCard）
└─ ProposalDivergenceCard.tsx      Expected vs Actual
client/src/mobile/proposal/        Tabs[分析|计划|变更|风险] + 底部固定 [拒绝][修改][批准]
```

入口挂在 `AICockpit` / `NovelTaskDrawer` / `TaskCenterDetailPanel`，主状态仍由 `DirectorDashboardView` 裁决。

### 12.9 Prompt

新增 PromptAsset（`prompting/prompts/proposal/`）：

| id | 用途 |
|---|---|
| `proposal.chapter_execution@v1` | 章节执行提案（本章职责/节奏/情绪/信息释放/计划状态变化/章末状态/下一章入口） |
| `proposal.outline_edit@v1` | 大纲编辑提案 + 后续依赖联动 diff |
| `proposal.post_write_divergence@v1` | Expected vs Actual 解释与建议 |

`outputSchema` 必须直接产出结构化 `ProposedChange[]`（**Plan 给人看，Diff 给机器执行**）；`reasoningSummary` 限长，禁止存推理过程。

---

## 13. 迁移风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | **双 schema 漂移** | `schema.prisma` / `schema.sqlite.prisma` 与两个 migrations 目录不同步 → 桌面端（SQLite）启动失败 | 每次 schema 变更必须四处同步；跑 `pnpm --filter @ai-novel/server prisma:generate` 与桌面打包验证 |
| R2 | **`runtimeMigrations.ts` 列回填清单** | `server/src/db/runtimeMigrations.ts` 维护 `REQUIRED_COLUMN_BACKFILLS` 硬编码清单，新列不登记 → 老库升级后缺列 | 新增列同步登记 |
| R3 | **自动放行链路误吞新提案** | `PendingReviewAutoPromotionService` 只白名单 2 类，`DirectorStateProposalResolutionService` 白名单 3 类。若新 proposalType 用了 `pending_review` 且落进这些查询 → 被 AI 自动提交或自动 reject | 新类型必须显式排除；`listPendingRows` 增加 `changeProposalId: null` 条件 |
| R4 | **`pendingReviewContext` 阻塞写作** | `buildBlockingPendingReviewProposalWhere` 会让任何 `pending_review` 提案进入写作上下文 | ChangeProposal 下挂的 item 默认不进该查询，避免未审提案污染正文上下文 |
| R5 | **`applyCommittedProposal` 静默 no-op** | 现在对未实现类型 `return`，新增类型若忘记注册 applier → 提案标 committed 但正式数据没变 | Applier 注册表对未知类型**抛错**而非静默返回；补回归测试 |
| R6 | **`AutoDirectorQualityGate` 硬规则** | 局部质量债不得阻塞全局链。若 Proposal 审批被当成 blocking checkpoint 滥用 → 全书自动成书链被卡死 | 只有 `major` / 冲突 / `protectedUserContent` 才产生 `proposal_review_required`；`minor` 走自动放行并记事件 |
| R7 | **前端主状态被污染** | Proposal 待办若自行改主 badge/主按钮 → 与 `DirectorDashboardView` 冲突，出现「正在运行却显示等待确认」 | 提案状态经 `DirectorDashboardViewBuilder` 派生，携带 `sourceTrace` |
| R8 | **Legacy 队列误用** | `DirectorRuntimeCommand` / `DirectorRuntimeExecution` / `DirectorRuntimeCheckpoint` 仍在 schema 中 | 只读；排队一律走 `DirectorCommandService` |
| R9 | **文件行数硬阈值** | AGENTS.md：>1300 行必须先拆分。`NovelDirectorService.ts` 849 行、`DirectorWorkspaceAnalyzer.ts` 888 行 | 新能力放新模块目录，不往这两个文件塞 |
| R10 | **同前缀平铺** | 「同一 feature 前缀超过 4 个文件必须建目录」 | 一开始就建 `services/novel/proposal/` |
| R11 | **Prompt 治理** | 内联 prompt 会被治理规则判为违规 | 全部走 `prompting/prompts/proposal/` + `registry.ts` |
| R12 | **章节执行链唯一性** | Proposal 若自带 writer / repair → 违反最高优先级硬约束 | 提案只产出结构化计划，正文仍由 `ChapterRuntimeCoordinator` 生成 |
| R13 | **DirectorEvent 幂等键** | `recordEvent` 要求 `idempotencyKey`，重复写会失败或重复 | 用 `${proposalId}:${version}:${action}` |
| R14 | **`CanonicalStateVersion.version` 竞争** | `StateVersionLog.createVersion` 用 `findFirst(orderBy version desc) + 1`，在事务内但并发下仍可能冲突（有 `@@unique([novelId, version])` 兜底） | 部分批准要复用同一次 commit，不要拆成 N 次 createVersion |
| R15 | **分支流程** | 影响端到端主链的功能不得直接在 `main` 开发 | feature branch → `beta` → `main`；每阶段必须提交 |

---

## 14. 禁止修改区域

### 14.1 绝对不改

| 区域 | 原因 |
|---|---|
| `server/src/services/novel/runtime/ChapterRuntimeCoordinator.ts` 及 `runtime/` 内部服务 | 正文生成/修复唯一执行链，外部只能通过门面调用；深链内部服务违反模块边界 |
| `ChapterTimelineFinalizationService` 及 timeline 表写入规则 | 只有 timeline 模块可写 `ChapterTimeAnchor` / `StoryTimelineEvent` / `TimelineHook` |
| `DirectorRuntimeInstance` / `DirectorRuntimeCommand` / `DirectorRuntimeExecution` / `DirectorRuntimeCheckpoint` / `DirectorRuntimeEvent` | Legacy 只读投影，禁止新增写入路径 |
| `CharacterInfluenceProposal` | 已退役，禁止新增产品行为 |
| `server/src/llm/structuredInvoke.ts` / `connectivity.ts` 的例外 prompt | Prompt 治理豁免项，不要顺手「规范化」 |
| `docs/public/**` 与 `site/src/docsManifest.ts` 的对应关系 | `pnpm check:docs-manifest` 会失败 |

### 14.2 改动需先评审

| 区域 | 约束 |
|---|---|
| `StateCommitService.validate()` / `persistValidated()` | 现有 9 种类型的校验与风险分级语义必须保持不变；只允许提取 applier |
| `DirectorPolicyEngine.decide()` 判定顺序 | 只允许**插入**新分支，不允许调整已有分支相对顺序（`analyze` → `blocked_scope` → `protectedUserContent` → `suggest_only` → ...） |
| `NovelWorkflowTask.checkpointType` 已有 9 个取值 | 只增不改；`replan_required` 的阻塞语义是硬规则 |
| `DIRECTOR_ARTIFACT_TYPES` / `DirectorEventType` | 只增不删；前端投影按这些做穷举 |
| `shared/types/canonicalState.ts` 的 `stateChangeProposalStatusSchema` | 4 个状态被多处 `where` 依赖 |
| `AutoDirectorAutoApprovalRecord` / `DIRECTOR_AUTO_APPROVAL_POINTS` | 已有 code 不可重命名（持久化在 `AppSetting` 与任务 seed） |
| `client/src/components/autoDirector/AICockpit.tsx` | 615 行，主状态裁决入口；只允许挂载新分区，不允许重构主状态逻辑 |

### 14.3 流程约束（AGENTS.md）

- 任何破坏性数据操作前必须有**已验证的备份路径**
- 意图识别 / 任务分类 / 规划 / 路由必须 AI-first，**禁止关键词匹配、正则路由、硬编码分支表**作为产品核心行为
- 局部质量问题**不得**阻塞全局自动导演链
- 提交/推送/PR 前必须走 `readme-release-updater` 流程更新 `docs/releases/release-notes.md`
- 每个阶段结束必须提交，且至少增加一组回归测试（`server/tests/`，251 个测试文件，`node --test`）

---

## 15. 建议实施顺序（Phase 1 Proposal Core）

```text
1. feat(proposal): add ChangeProposal schema
   - 双 schema + 双 migrations + runtimeMigrations 列登记
   - shared/types/changeProposal.ts（zod）
   - 回归测试：schema 往返 + 迁移可用性

2. feat(proposal): extract proposal applier registry
   - 纯提取重构：StateCommitService.applyCommittedProposal → appliers/
   - 未知类型抛错
   - 回归测试：现有 character_state / character_resource 落库不变

3. feat(proposal): add ChangeProposalService + review service
   - 版本链、状态机、部分批准、修改后批准
   - 回归测试：partial approval / version conflict / stale proposal

4. feat(proposal): wire policy engine + checkpoint + command
   - DirectorPolicyEngine 新增 proposalSeverity / outlineFidelity
   - proposal_review_required checkpoint + review_proposal command
   - change_proposal artifact type + 4 个 event type

5. feat(proposal): add change proposal HTTP module

6. feat(proposal): add chapter execution proposal prompt + step module

7. feat(proposal): add proposal review UI (desktop)

8. feat(proposal): add post-write divergence service

9. test: add proposal consistency regression
```

每个 commit 独立可验证，**不把 schema + UI + runtime 混在一个提交里**。

---

## 附录 A：关键文件速查

```text
# 提案与状态
server/src/prisma/schema.prisma                                    :2877 StateChangeProposal
shared/types/canonicalState.ts                                     :151  stateChangeProposalSchema
server/src/services/novel/state/StateCommitService.ts              :100  StateCommitService
server/src/services/novel/state/CanonicalStateService.ts           :76   CanonicalStateService
server/src/services/novel/state/StateVersionLog.ts                       stateVersionLog
server/src/services/novel/state/PendingReviewAutoPromotionService.ts
server/src/services/novel/state/stateProposalSubjectKey.ts
server/src/services/novel/state/stateProposalSourceQuality.ts

# 策略与门禁
server/src/services/novel/director/runtime/DirectorPolicyEngine.ts
server/src/services/novel/director/runtime/DirectorNodeRunner.ts
shared/types/directorRuntime.ts                                    :329  DirectorPolicyDecision
shared/types/autoDirectorApproval.ts

# 账本
server/src/services/novel/director/runtime/DirectorArtifactLedger.ts
server/src/services/novel/director/runtime/DirectorArtifactGateway.ts
server/src/services/novel/director/runtime/DirectorAutomationLedgerEventService.ts
server/src/services/novel/director/runtime/DirectorEventProjectionService.ts

# 命令与恢复
server/src/services/novel/director/http/novelDirector.ts           :250  appendCommandSchema
server/src/services/novel/director/commands/DirectorCommandExecutor.ts
server/src/services/novel/director/recovery/novelDirectorRecovery.ts
server/src/services/novel/director/automation/novelDirectorAutoExecutionCheckpointRuntime.ts

# 章节链
server/src/services/novel/production/NovelProductionOrchestrator.ts
server/src/services/novel/runtime/ChapterRuntimeCoordinator.ts
server/src/services/novel/runtime/ChapterArtifactDeltaService.ts

# 手动编辑影响
server/src/services/novel/director/runtime/DirectorWorkspaceAnalyzer.ts :403
server/src/prompting/prompts/novel/directorManualEditImpact.prompts.ts

# Prompt
server/src/prompting/registry.ts
server/src/prompting/core/promptTypes.ts
server/src/prompting/README.md

# 前端
client/src/components/autoDirector/AICockpit.tsx
client/src/pages/tasks/components/TaskCenterManualEditImpactCard.tsx
client/src/pages/novels/components/chapterInsights/ResourceRiskPanel.tsx
client/src/api/novelDirector.ts
```

## 附录 B：必读 wiki

- `docs/wiki/workflows/chapter-production-chain.md`
- `docs/wiki/workflows/auto-director-runtime.md`
- `docs/wiki/workflows/pending-review-auto-promotion.md`
- `docs/wiki/workflows/quality-debt-attribution.md`
- `docs/wiki/architecture/module-boundaries.md`
- `docs/wiki/prompts/prompt-registry-and-structured-output.md`
- `server/src/services/novel/director/README.md`
- `server/src/services/novel/production/README.md`
