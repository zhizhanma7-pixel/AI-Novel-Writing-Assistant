# Outline Workflow Implementation Report

> 分支：Phase 2A `codex/outline-workflow`；Phase 2B `codex/outline-workflow-2b`
> 计划：`docs/dev/IMPLEMENTATION_PLAN_OUTLINE_WORKFLOW.md`
> 当前状态：Phase 2A、Phase 2B 完成；待进入 Phase 2C

## Phase 2A — Proposal Runtime Bridge

### 已交付

1. Proposal 自治等级使用 runtime policy 中独立的 `proposalAutonomyLevel`，默认 L1；L0/L1/L2/L3 到 policy engine 的评估映射仍由 shared 单一来源维护，但不再复用 Director 的推进 `mode`。
2. `ChangeProposalApplyService.executeProposal()` 成为最终 policy 门禁，并区分：
   - `automation`：必须满足 `canRun=true && requiresApproval=false`；
   - `explicit_review`：用户审批已满足 approval gate，但不绕过 stale、状态机、正式 applier 和事务校验。
3. `AiChangeProposalProducerService` 统一处理 AI 提案：
   - 延后 task checkpoint 创建 Proposal；
   - 读取 task-bound Director runtime policy；
   - 审批型提案进入既有 `proposal_review_required`；
   - 可自动执行的提案复用正式 review 与 apply service；
   - apply 前 policy 改变时退回可审阅状态。
4. Planner 新增结构化 `propose_novel_change` intent、workflow 和 tool。模型只能提供 Change Proposal 结构化事实，不能传入 `autonomyLevel`、`policyMode` 或 `submitForReview`；tool 在服务端绑定当前小说的 Director task。
5. Planner prompt `planner.intent.parse` 升至 v2，以注册 Prompt 的结构化 schema 输出提案 intent；没有增加关键词、正则或非 AI 路由 fallback。
6. Director runtime 首次初始化会采纳初始推进 `policyMode`；已有 runtime 的 continue/resume 保留用户当前 mode 和独立 Proposal 授权，避免用户降权后被静默抬回。
7. AI 声明的 severity 增加确定性风险下界：角色状态、角色资源、删除和结构型关系变化至少为 major；关系数值跨度达到 20 时即使自报 minor 也必须审批。关系目标值以正式 payload 为准，展示值与 payload 不一致时按 major 处理，并在最终 apply 边界阻止任何不一致的已批准项执行。

### 策略验收结果

| 场景 | 结果 |
|---|---|
| L0/L1 + minor | `pending_review` |
| Proposal 授权显式 L2/L3 + 有效 minor + balanced/director | 可自动执行 |
| Director 推进 mode 为 L2/L3，但 Proposal 授权保持默认 L1 | `pending_review` |
| 任意等级 + major | `pending_review` |
| 任意等级 + strict outline | `pending_review` |
| 用户明确批准 major | 可通过 `explicit_review` 执行，不重复卡审批 |
| AI 输入自行指定 policy/autonomy | strict schema 拒绝 |

真实 SQLite 组合场景确认：默认生产式 L2 Director 任务仍以 Proposal L1 把 minor 留在审阅入口，关系值保持 50；显式 Proposal L3 的小幅关系变化把信任值写到 55；随后自报 minor 的大幅变化，以及展示为 55→54、payload 实际写 5 的不一致变化，均被确定性下界升级为 major 并留待审阅，正式值保持 55。

### Verification

- `pnpm --filter @ai-novel/shared build`：通过。
- `pnpm --filter @ai-novel/server build`：通过。
- `pnpm --filter @ai-novel/client typecheck`：通过。
- Proposal / policy / Director runtime / Prompt Registry / Prompt Workbench 定向测试：102 项，其中 100 项通过、2 项按原测试设计跳过，0 失败。
- Tool Registry 新工具存在性测试：通过。
- `aiChangeProposalProducerRealSqlite.test.js` 与 `changeProposalRealSqlite.test.js`：2 项通过，0 失败。

评审修复后重新执行 Proposal policy、Director runtime store、Director agent tools、正式 apply 和 AI producer 的定向测试：51 项通过，0 失败；上述两项真实 SQLite 组合测试重新执行仍为 2 项通过，0 失败。

M3 修复后执行 server build、Proposal policy 与 apply 定向测试：31 项通过，0 失败；AI producer 真实 SQLite 测试：1 项通过，0 失败。覆盖展示小幅变化但 payload 大幅改值时 L3 仍不得自动写入，以及 accepted 项在人工执行边界仍需通过展示值/payload 一致性校验。

“变更提案确认”字段的 Director policy command 入队用例隔离执行：1 项通过，0 失败。补跑整个 `directorRunCommandService.test.js` 时为 20/21：未被本阶段修改的 stale recovery 用例仍预期 `failed`、实际得到 `queued`；该用例及其覆盖的 `DirectorCommandService` 恢复逻辑均不在本次 diff 中，作为独立验证缺口保留，不以调整断言掩盖。

仓库完整 `tools.test.js` 仍有一个与本阶段无关的既有失败：未修改的 `bookAnalysisTools.ts` 含内联 Zod 声明，违反该测试要求的 schema 文件边界。本阶段没有扩大范围修改该模块；Proposal tool 已放在 `tools/proposal/` 且 schema 独立。

### Beta Integration Verification

Phase 2A 经 `718d745` 合入 `beta` 后，先在 `main@308ca1b` 与 `beta@cd58b86` 分别执行 `pnpm --filter @ai-novel/server test:integration`。两边的失败名称清单完全相同，均为 16 项；`beta` 新增失败差集为 0。这个对照证明 Phase 2A 没有引入新的 integration 回归，也补上了此前仓库没有 integration 基线、只能按 diff 范围推理归因的证据缺口。

随后在 `codex/beta-integration-stabilization` 处理这 16 项既有失败：统一 Windows 下真实 SQLite 测试的 pnpm 子进程调用与数据库 URL；补齐 Director pipeline/retry fixture；将漫画跨话事实抽取纳入 Prompt Registry；并修复真实 SQLite 链暴露的 NovelService 兼容门面 receiver 丢失和 legacy 卷迁移来源过早变为 `volume` 两个产品缺陷。P0-B 测试同时隔离在线 LLM，只验证真实 SQLite、共享上下文与恢复链路。

稳定化后的完整 integration 结果为：138 项中 136 项通过、0 项失败、2 项按设计跳过。Phase 1 / Phase 2A 的四条真实链路、P0-B、RAG compatibility、Director pipeline/retry 和 Prompt Governance 均在同一套件中通过；测试失败没有通过放宽业务断言处理。

### Architecture Notes

- Durable workflow rules 已同步到：
  - `docs/wiki/workflows/change-proposal-review.md`
  - `docs/wiki/workflows/auto-director-runtime.md`
  - `docs/wiki/workflows/comic-panel-production-prompt-governance.md`
  - `docs/wiki/debugging/real-sqlite-integration-baseline.md`
- 任务中心沿用现有 runtime policy 卡片，新增独立的“变更提案确认”选择项；没有新增页面。Phase 2A 是 2B Outline Workflow 的运行时前置。

## Phase 2B — Outline Workflow MVP

### 已交付

1. 新增 `novel.outline.import.parse@v1` 与 `novel.outline.faithfulPolish@v1` 两个注册 PromptAsset：自由文本先归一为带稳定事件 ID、原文证据和原顺序的 draft，再生成保留义务、章节建议、依赖影响与 warnings。
2. Strict 忠实度默认启用。Prompt post-validation 确认全部核心事件同时出现在 `preservedEventIds` 和 proposed chapters 的 `sourceEventIds`，并验证首次出现顺序；缺失或乱序会触发一次 semantic retry，重试仍失败则不创建 Proposal。
3. `OutlineImportProposalService` 使用数据库中的现有章节重新计算依赖影响。已有正文发生标题或规划变化时确定性升级为 major，并通过 chapter source ref 进入 stale 检测；风险不由模型自报决定。
4. Outline Proposal 继续经过 2A producer 和 policy gate，使用 `outline_edit` 信封与 `outline_plan_update` domain-state item，复用原有审阅抽屉、逐项决定、Artifact Ledger 和状态机。
5. `OutlinePlanProposalApplier` 在 State Commit 事务中写入 VolumePlan、VolumeChapterPlan、Chapter 和 `Novel.structuredOutline` 兼容投影。它按章节序号 upsert，不删除提案未覆盖章节，也不删除或移动已有正文。
6. 大纲工作区新增新手入口：粘贴文本、选择严格保留 / 平衡优化 / 导演重构，先查看“AI 会保留什么”和“AI 会补什么”，再打开现有变更提案审阅；没有新增第二套审批页面。

### Verification

- shared build、server build：通过。
- client typecheck：通过。
- Strict 22/23/24 核心事件保留、缺失与乱序拒绝：2 项通过。
- Proposal policy / producer / core / State Commit 聚焦回归：58 项通过，0 失败。
- 真实 SQLite Outline Proposal：批准后 3 个章节规划、VolumeChapterPlan 与 structured outline 一致；第 23 章已有正文保持不变。
- 完整 server integration：139 项中 137 项通过、0 失败、2 项按设计跳过。
- 浏览器与视觉验收按仓库规则留给用户执行。

## Next — Phase 2C Expected vs Actual

下一阶段是章节执行偏离检测、Expected vs Actual 对照和 Chapter Execution Proposal；不在本轮 2B 范围内。
