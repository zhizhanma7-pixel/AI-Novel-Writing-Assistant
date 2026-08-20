# ChangeProposal Phase 1 Implementation Plan

## Goal

在复用现有 `StateChangeProposal`、`StateCommitService`、Director Command、Artifact Ledger 与 Event Ledger 的前提下，完成可版本化、可追踪、可部分审批的 Change Proposal 后端核心。

## Architecture Input

- `docs/dev/ARCH_RECON_PROPOSAL.md`
- `ainovel_workflow_guide/PROJECT_GUIDE.md`
- `ainovel_workflow_guide/AGENT_COLLABORATION_GUIDE.md`

架构结论是扩展现有审批与状态提交基础设施，不建立第二套 workflow runtime。

## Scope

- `shared/types/changeProposal.ts`：提案、逐项变更、审阅输入与状态契约。
- `server/src/prisma/`：PostgreSQL / SQLite 双 schema 与双迁移。
- `server/src/services/novel/proposal/`：创建、查询、版本化、审批、拒绝、部分审批、执行与 stale 检测。
- `server/src/modules/novel/proposal/http/`：小说范围的 Proposal API。
- 现有 Director Policy / Command、Artifact、Event 和 State Commit 接缝。
- Proposal Core 聚焦测试、迁移测试与必要的现有链路回归测试。
- 持久化的工作流说明与本阶段实施报告。

## Non-goals

- Proposal 审阅 UI。
- Android 适配。
- SillyTavern 导入器与 Skills runtime。
- 章节正文生成、post-write divergence、任意新 prompt。
- 重写现有 State Commit、Director runtime 或章节生产链。

## Acceptance Criteria

1. ChangeProposal 可创建为 draft 或 pending_review，并保留 source refs、用户可见依据、warning 和版本链。
2. 用户可整体批准、部分批准、修改后批准或拒绝；非法状态转换和并发写入不会静默覆盖。
3. 执行只提交 accepted / modified 项，rejected 项不会进入正式状态。
4. 来源 artifact、artifact dependency 或章节内容变化时，批准和执行均阻止 stale proposal。
5. 带 taskId 的审阅动作复用 DirectorRunCommand；手动提案可直接走相同服务。
6. 旧 pending-review 自动处理链只读取 `changeProposalId = null` 的历史独立记录。
7. PostgreSQL / SQLite schema 与迁移保持一致，服务端构建与 Proposal Core 聚焦测试通过。
