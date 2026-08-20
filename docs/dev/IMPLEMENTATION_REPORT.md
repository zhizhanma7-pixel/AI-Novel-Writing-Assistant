# ChangeProposal Phase 1 Implementation Report

## Feature

Change Proposal 后端核心：把多条 `StateChangeProposal` 组织成可版本化的审阅信封，并复用现有状态提交、导演命令、产物依赖和事件账本完成审批与执行。

## Files Changed

- 新增共享 Proposal / ProposedChange 契约。
- 新增 Proposal application、domain、infrastructure 与 HTTP 模块。
- 扩展现有 Director Command / Policy、Artifact / Event 类型与旧 pending-review 查询边界。
- 新增 PostgreSQL / SQLite 配对 schema 和 migration。
- 新增 Proposal Core、schema migration、command 与 policy 聚焦测试。
- 新增 `docs/wiki/workflows/change-proposal-review.md` 记录长期工作流规则。

完整文件清单以 `git diff main...feat/change-proposal-core` 为准。

## Database Changes

- 新增 `ChangeProposal`。
- `StateChangeProposal` 新增 envelope 外键、diff 元数据、来源、严重度、用户编辑值和逐项审阅决定。
- PostgreSQL 与 SQLite 使用同名配对迁移；桌面 runtime column backfill 清单已同步。

## API Changes

小说模块新增 Change Proposal 的列表、详情、创建、提交审阅、逐项编辑、批准、部分批准、拒绝、再生和执行接口。绑定导演任务的批准、拒绝、再生与执行通过 `review_proposal` 命令排队。

## Tests Added

- Proposal 创建、批准、拒绝、部分批准、修改后批准、stale 拦截、执行、非法转换和版本再生。
- 并发审批先完成时，迟到的逐项编辑返回版本冲突。
- SQLite migration 结构与外键检查。
- PostgreSQL / SQLite Prisma schema 同步检查。
- Director command lane 与 proposal policy 决策检查。

## Verification

- `@ai-novel/shared` build：通过。
- `@ai-novel/server` build：通过。
- Proposal Core、schema migration、director policy 共 28 项聚焦测试：通过。
- Director command proposal review 专项测试 1 项：通过。
- 现有 `directorRunCommandService.test.js` 中与本功能无关的 `runtime.worker_stale` policy 用例在当前基线上失败；本阶段不修改该恢复策略。

## Known Risks

- 本阶段没有 Proposal 审阅 UI，API 主要供后续客户端和章节 Proposal Step 接入。
- record 类型 source ref 当前用于来源追踪；stale 的确定性校验覆盖 Director Artifact、其依赖版本和 Chapter 内容哈希。
- `StateCommitService` 现有 proposal type 的具体 applier 覆盖范围未在本阶段扩张；Change Proposal 不绕过该服务直接写业务表。
