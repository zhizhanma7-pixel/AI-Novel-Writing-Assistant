# Outline Workflow Implementation Plan

> 分支：`codex/outline-workflow`（从 `beta@ab09655` 拉出）
> 范围：Phase 2A Proposal Runtime Bridge → Phase 2B Outline Workflow MVP
> 前置：Phase 1 Proposal Core / Proposal UI / State Apply Observability 已满足组合 smoke 封板条件

## Goal

让写作新手可以粘贴一段自由文本大纲，由 AI 识别其中不可丢失的核心事件，在忠实度约束下补足因果、情绪、转场与拆章建议，并把结果作为现有 Change Proposal 提交审阅或按自治策略安全执行。

Phase 2 不创建第二套审批系统。Outline Proposal 必须复用 Phase 1 的 Proposal 状态机、审阅界面、Director checkpoint、Artifact Ledger、stale 检测和正式状态写入边界。

## Scope Boundary

本计划按依赖顺序交付：

1. **2A — Proposal Runtime Bridge**：打通 AI 结构化提案生产者、自治等级映射和 `DirectorPolicyEngine` 门禁。
2. **2B — Outline Workflow MVP**：自由文本解析、Faithful polish、依赖影响分析、Outline Proposal 和批准后的正式大纲写入。

明确不在本计划内：

- Phase 2C 的 Chapter Execution Proposal、Expected vs Actual 和正文偏离分流。
- SillyTavern 导入、Skills、Android 专项 UI。
- 新建独立 workflow engine、独立 proposal 表或独立审批队列。
- 用关键词、正则或手写分支识别自由文本大纲意图。Outline 解析和忠实度判断必须使用注册 Prompt 的结构化 AI 输出；确定性代码只负责 schema 校验、安全保护和已结构化结果的后处理。

---

## Architecture Recon

### Proposal Core

- `ChangeProposalService` 已负责信封创建、版本、Artifact Ledger、事件和 `proposal_review_required` checkpoint。
- `ChangeProposalReviewService` 已负责逐项审阅与批准。
- `ChangeProposalApplyService` 已负责正式 applier 写入，但尚未调用 `DirectorPolicyEngine`。
- `DirectorPolicyEngine` 已支持 `proposalSeverity` / `outlineFidelity`，生产代码尚无 Proposal 调用点。
- `DirectorRuntimeStore` 把任务启动时的 policy snapshot 持久化在 `DirectorRun.policyJson`，Proposal 门禁必须读取这份冻结策略，不能让模型从工具输入里自选自治等级。

### Existing Outline System

- `Novel.outline` / `Novel.structuredOutline` 是旧兼容入口；`structuredOutline.ts` 只接受严格 JSON 数组，并由旧生成链直接写库和同步章节。
- 当前正式规划主线已经扩展为卷战略、卷骨架、节奏板、章节列表和章节执行合同；`OutlineTab` 与 `StructuredOutlineWorkspace` 是现有用户入口。
- Phase 2B 不能另建一套与卷规划平行的“大纲编辑器”。自由文本导入应先归一化为内部 Outline Draft，再通过 owned adapter 写入现有规划资产，并保留 `Novel.structuredOutline` 兼容投影。

### Architecture Decision

新增能力归属 `server/src/services/novel/proposal/` 与后续 module-owned outline application，不把逻辑塞入超长页面或 flat `utils`：

```text
AI / Outline Prompt structured output
        ↓
AiChangeProposalProducerService
        ↓
ChangeProposalPolicyGateService ── DirectorRuntime policy snapshot
        ↓
pending_review                 auto approved + executed
        ↓                              ↓
现有 Proposal UI               现有 ChangeProposalApplyService
```

---

## Phase 2A — Proposal Runtime Bridge

### 2A.1 Shared autonomy contract

新增共享 schema 和单一映射：

| Autonomy Level | DirectorPolicyMode | Proposal 行为 |
|---|---|---|
| L0 Manual | `suggest_only` | AI 可生成建议型 Proposal，不得自动写入正式状态 |
| L1 Approval | `run_next_step` | 所有结构性 Proposal 必须人工审批 |
| L2 Guarded Auto | `run_until_gate` | minor 且非 strict 可自动执行；major / strict 必须审批 |
| L3 Full Director | `auto_safe_scope` | 安全范围内 minor 可自动执行；major / strict / 受保护内容必须审批 |

映射是确定性结构化后处理，不做文本推断。模型不得在 `propose_novel_change` 输入中传自治等级或 policy mode。

### 2A.2 Policy gate

新增 `ChangeProposalPolicyGateService`：

- 读取 task-bound Proposal 对应的 `DirectorRuntimeStore.getSnapshot(taskId).policy`。
- 无任务绑定时使用安全的 L1 / `run_next_step` 默认值；手工 API 行为保持显式审阅。
- 从 Proposal 逐项取最高 severity，并把信封 `outlineFidelity` 一起传入 `DirectorPolicyEngine.decide()`。
- L1 通过 `requiresApprovalByDefault` 固定为显式审批；L0 由 `suggest_only` 阻止自动写入。
- 返回完整 policy decision 和实际使用的 policy mode，供应用服务、工具输出、日志和测试复用。

`ChangeProposalApplyService.executeProposal()` 增加执行来源：

- `automation`：只有 `canRun=true && requiresApproval=false` 才能进入正式 applier。
- `explicit_review`：Proposal 必须已经处于 approved / partially_approved；人工审批满足 approval gate，但 stale、状态机和正式 applier 校验仍不可绕过。

默认保持 `explicit_review`，兼容现有 HTTP 和 Director `review_proposal` 命令；任何 AI 自动执行调用必须显式传 `automation`，避免新调用方无意越权。

### 2A.3 AI producer

新增 `AiChangeProposalProducerService`，输入是 `createChangeProposalInputSchema` 已校验的结构化对象，流程为：

1. 创建 Proposal，但延后 task checkpoint 投影。
2. 调用 policy gate。
3. 若需审批：保留 `pending_review` 并写入现有 `proposal_review_required`。
4. 若允许自动执行：复用 `ChangeProposalReviewService` 自动接受全部项，再以 `automation` 来源调用 `ChangeProposalApplyService`。
5. 返回 `{ proposal, disposition, policyMode, policyDecision }`，不返回或保存隐藏推理。

自动执行失败不得改断言或吞成成功。Proposal 和任务必须留在可解释、可恢复的状态，并记录稳定错误码。

### 2A.4 Agent structured tool

在 `server/src/agents/tools/proposal/` 新增 `propose_novel_change`：

- 只允许 Planner 使用。
- schema 复用 Change Proposal shared contract，不接收 `autonomyLevel`、`policyMode`、`submitForReview` 等越权字段。
- 必须绑定小说与 Director task；工具使用任务冻结 policy。
- 工具输出明确区分 `pending_review` 与 `auto_executed`。
- 不增加关键词路由；该工具进入现有 Agent Tool Registry，由 AI planner 根据 schema 与工具语义选择。

`server/src/agents/tools/` 已超过 12 个同级 `.ts` 文件，因此本能力必须进入 `tools/proposal/` 子目录，不能继续增加 flat peer 文件。

### 2A.5 Acceptance

1. AI 工具提交 major Proposal：所有 L0–L3 都返回 `pending_review`，正式状态未变化。
2. AI 工具提交 strict Outline Proposal：所有等级都进入审批。
3. L0/L1 提交 minor Proposal：进入审批，正式状态未变化。
4. L2/L3 提交 minor + balanced/director Proposal：自动批准、执行并写入正式状态。
5. 用户批准 major Proposal 后仍可显式执行；policy gate 被调用，但不会形成“批准后再次卡审批”的死锁。
6. `proposalSeverity` / `outlineFidelity` 在生产调用路径可由测试观测，不再只有 `directorRuntimePolicy.test.js` 直接传参。
7. 现有 Proposal HTTP / Director command / 真实 SQLite 验收保持通过。

---

## Phase 2B — Outline Workflow MVP

### 2B.1 User flow

面向新手提供一个主路径：

```text
粘贴自由文本大纲
  ↓
AI 标出必须保留的核心事件与原顺序
  ↓
选择忠实度（默认 Strict）并生成润色 / 拆章建议
  ↓
查看依赖影响与逐项 diff
  ↓
审阅 Outline Proposal
  ↓
批准后写入现有大纲 / 章节规划资产
```

默认 Strict，界面先展示“AI 会保留什么”和“会补什么”，不要求新手理解内部 StoryPlan、Artifact 或 policy 名称。

### 2B.2 Prompt governance

新增产品 Prompt 必须注册到 `server/src/prompting/`：

- `novel.outline.import.parse@v1`：自由文本 → `NormalizedOutlineDraft`。
- `novel.outline.faithfulPolish@v1`：原始 draft + fidelity + 当前规划上下文 → polished draft、变更项、保留义务和依赖影响。

结构化输出至少包含：

- 原始条目标识、原文、推断章序。
- `coreEvents[]`、角色、因果前置、结果和置信度。
- `preservationObligations[]`，Strict 下作为确定性验收输入。
- proposed chapters / beats。
- dependency impacts、warnings、逐项 severity。

Prompt 不得直接写数据库；输出先经 schema 验证，再交 2A producer。

### 2B.3 Faithful policy

- **Strict**：主要事件、顺序、结局、关系走向和关键揭露点形成 preservation obligations。后处理必须逐项验证其仍存在；缺失时拒绝生成 Proposal 并触发一次受控 AI repair，不用关键词 fallback 补救。
- **Balanced**：允许局部结构优化，但结构变化必须进入 Proposal。
- **Director**：允许主动重构；major 变化仍由 policy gate 转人工审批。

输入示例 `22 吃饭 / 23 A离开 / 24 B调查` 在 Strict 输出中必须保留三个核心事件及顺序；AI 可以补因果、情绪、铺垫、转场和拆章建议。

### 2B.4 Formal apply boundary

新增 Outline domain-state proposal type 与 owned applier，不使用 ledger-only 类型伪装执行成功。具体写入适配器必须：

- 以当前卷规划 / 章节规划服务为正式写入入口，避免路由或 Prompt 直接操作 Prisma。
- 在同一事务内应用批准项；任一批准项失败时保持 Change Proposal 信封原子性。
- 已有正文的章节不得被静默删除或重排；此类影响升级为 major warning 并要求人工审阅。
- 更新现有正式规划资产后，再刷新 `Novel.structuredOutline` 兼容投影和章节目录，不让兼容字段反向成为新的 source of truth。
- dependency impact 作为 Proposal warnings/source refs 进入 stale 检测与 UI，不另建不可追踪的提示表。

正式选择 proposal payload 与 planning facade 前，先完成 StoryPlan / VolumeChapterPlan / Chapter 三者的写入责任清单；不得把跨表规则直接堆进 `StateProposalApplierRegistry.ts`。

### 2B.5 Frontend boundary

- 入口复用现有小说“大纲 / 章节规划”工作区和 Change Proposal Drawer。
- 新导入与忠实润色 UI 进入独立 `outlineImport/` 功能目录；`NovelEdit.tsx` 只挂载，不增加业务编排。
- 用户文案只说明“粘贴大纲、保留核心事件、查看 AI 建议、审阅后应用”，不展示迁移、schema、runtime 等实现术语。
- UI 视觉验收由用户执行；代码侧只做 typecheck、组件逻辑测试和 API 契约测试。

### 2B.6 Acceptance

1. 自由文本示例能生成结构化 Outline Proposal。
2. Strict 下 22/23/24 三个核心事件及顺序不可丢失；故意缺失时 schema/obligation gate 拒绝提交。
3. 逐项 diff 能在现有 Proposal UI 中审阅、修改、拒绝和批准。
4. 批准后正式规划资产、兼容 structured outline 与章节目录一致。
5. 修改已有章节时能列出后续依赖影响；已有正文保护规则不会被绕过。
6. Outline Proposal 全程复用 2A producer/policy，没有第二套审批状态或队列。
7. Prompt Registry governance、真实 SQLite apply、服务端/客户端 typecheck 和聚焦测试通过。

---

## Delivery Phases And Commits

### Commit A — Plan and boundary

- 本实施计划。
- 纯内部开发文档，无用户可见发布说明。

### Commit B — 2A shared policy and apply gate

- Autonomy mapping schema。
- Proposal policy gate。
- `executeProposal` 执行来源与稳定错误契约。
- 单元测试。

### Commit C — 2A AI producer and agent tool

- producer orchestration。
- Planner tool registry 接线。
- 真实 SQLite 组合测试。
- Wiki 与 implementation report。

### Commit D — 2B parse and faithful proposal

- Prompt assets / registry / structured schemas。
- Outline application facade 与 dependency analysis。
- Outline Proposal producer。
- 聚焦测试。

### Commit E — 2B beginner workflow UI and formal apply

- 导入 / 忠实润色工作区。
- 正式 outline applier 与兼容投影同步。
- 前后端契约、真实 SQLite smoke、Wiki、implementation report 和用户可见 release notes。

每个开发阶段完成后必须独立提交。合入路径保持 `codex/outline-workflow → beta → main`；本分支不得直接进入 `main`。

## Verification

按改动范围使用最窄充分验证：

- shared/server typecheck 或 build。
- `directorRuntimePolicy`、`changeProposalCore`、Agent tool registry / approval policy 聚焦测试。
- 2A 新增真实 SQLite：major 留待审批、minor 自动执行、用户审批后 major 可执行。
- 2B 新增 Prompt governance、Strict preservation obligations、dependency impact 和正式 apply 的真实 SQLite 测试。
- 客户端 typecheck 与组件逻辑测试；浏览器和视觉验收留给用户。

## Wiki And Release Notes

- 2A 更新 `docs/wiki/workflows/change-proposal-review.md`：自治映射、policy 门禁、AI producer 和人工审批满足 gate 的规则。
- 2B 更新 Outline workflow 的 module boundary / source-of-truth 文档；若无现有页面，新增 `docs/wiki/workflows/outline-workflow.md`。
- 计划提交纯内部，不写 release notes。
- 2A 若只改变内部接线且没有用户入口，发布说明可跳过并明确原因。
- 2B 有用户可见能力，提交前必须运行 `readme-release-updater`，更新 date-based release notes 与 README 最新更新。

## Risks

| 编号 | 风险 | 对策 |
|---|---|---|
| R1 | 把 major policy gate 直接套在已审批执行上，导致用户批准后仍无法落库 | 显式区分 `automation` / `explicit_review`，两条路径都测试 |
| R2 | 模型在工具输入里自行提高自治等级 | 自治策略只读 Director runtime snapshot，工具 schema 不暴露 policy 字段 |
| R3 | 自动执行前短暂写入 waiting checkpoint，任务卡死 | producer 延后 checkpoint；仅 policy 要求审批时投影 review checkpoint |
| R4 | 旧 structured outline 和新卷规划形成双 source of truth | 正式 planning facade 为权威，`Novel.structuredOutline` 只做兼容投影 |
| R5 | Strict 只靠 Prompt 自觉，核心事件仍可能丢失 | structured preservation obligations + 确定性 post-validation + 一次 AI repair |
| R6 | Outline applier 跨表逻辑膨胀 state registry | registry 只委托 owned outline application facade，不内联跨表规则 |
| R7 | 自动执行中途失败留下不可解释状态 | 信封原子性、稳定错误码、任务 checkpoint 和组合测试共同约束 |
