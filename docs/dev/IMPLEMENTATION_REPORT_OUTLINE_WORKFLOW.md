# Outline Workflow Implementation Report

> 分支：`codex/outline-workflow`
> 计划：`docs/dev/IMPLEMENTATION_PLAN_OUTLINE_WORKFLOW.md`
> 当前状态：Phase 2A 完成；Phase 2B 待开始

## Phase 2A — Proposal Runtime Bridge

### 已交付

1. Proposal 自治等级使用 shared 单一映射：L0/L1/L2/L3 分别对应 `suggest_only`、`run_next_step`、`run_until_gate`、`auto_safe_scope`。
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
6. 修复 Director runtime 初始化时忽略显式 `policyMode` 的问题，保证任务选择的自治策略确实进入持久化快照。

### 策略验收结果

| 场景 | 结果 |
|---|---|
| L0/L1 + minor | `pending_review` |
| L2/L3 + minor + balanced/director | 可自动执行 |
| 任意等级 + major | `pending_review` |
| 任意等级 + strict outline | `pending_review` |
| 用户明确批准 major | 可通过 `explicit_review` 执行，不重复卡审批 |
| AI 输入自行指定 policy/autonomy | strict schema 拒绝 |

真实 SQLite 组合场景确认：L3 minor 把关系信任值从 50 写到 55；随后 L3 major 与 L1 minor 都只创建待审阅提案，关系信任值保持 55，两个任务均进入 `proposal_review_required`。

### Verification

- `pnpm --filter @ai-novel/shared build`：通过。
- `pnpm --filter @ai-novel/server build`：通过。
- Proposal / policy / Director runtime / Prompt Registry / Prompt Workbench 定向测试：102 项，其中 100 项通过、2 项按原测试设计跳过，0 失败。
- Tool Registry 新工具存在性测试：通过。
- `aiChangeProposalProducerRealSqlite.test.js` 与 `changeProposalRealSqlite.test.js`：2 项通过，0 失败。

仓库完整 `tools.test.js` 仍有一个与本阶段无关的既有失败：未修改的 `bookAnalysisTools.ts` 含内联 Zod 声明，违反该测试要求的 schema 文件边界。本阶段没有扩大范围修改该模块；Proposal tool 已放在 `tools/proposal/` 且 schema 独立。

### Architecture Notes

- Durable workflow rules 已同步到：
  - `docs/wiki/workflows/change-proposal-review.md`
  - `docs/wiki/workflows/auto-director-runtime.md`
- 当前没有新增前端页面或 UI 文案；Phase 2A 是 2B Outline Workflow 的运行时前置。

## Next — Phase 2B Outline Workflow MVP

下一阶段按实施计划进入自由文本大纲解析、Faithful polish、依赖影响分析、Outline Proposal 与正式大纲写入 adapter。Phase 2C 的 Expected vs Actual 和章节执行偏离仍不在本轮 2A/2B 范围内。
