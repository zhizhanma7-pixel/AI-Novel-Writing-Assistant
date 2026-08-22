# ChangeProposal Phase 1 Implementation Report

## Feature

Change Proposal 后端核心：把多条 `StateChangeProposal` 组织成可版本化的审阅信封，并复用现有状态提交、导演命令、产物依赖和事件账本完成审批与执行。

## Files Changed

- 新增共享 Proposal / ProposedChange 契约。
- 新增 Proposal application、domain、infrastructure 与 HTTP 模块。
- 扩展现有 Director Command / Policy、Artifact / Event 类型与旧 pending-review 查询边界。
- 新增 PostgreSQL / SQLite 配对 schema 和 migration。
- 新增 Proposal Core、schema migration、command 与 policy 聚焦测试。
- 新增真实 SQLite 验收测试，覆盖关系值编辑、正式落库、任务 checkpoint 与 artifact 人工来源保护。
- 新增 `docs/wiki/workflows/change-proposal-review.md` 记录长期工作流规则。

完整文件清单以 `git diff main...feat/change-proposal-core` 为准。

## Database Changes

- 新增 `ChangeProposal`。
- `StateChangeProposal` 新增 envelope 外键、diff 元数据、来源、严重度、用户编辑值和逐项审阅决定。
- PostgreSQL 与 SQLite 使用同名配对迁移；桌面 runtime column backfill 清单已同步。

## API Changes

小说模块新增 Change Proposal 的列表、详情、创建、提交审阅、逐项编辑、批准、部分批准、拒绝、再生和执行接口。绑定导演任务的批准、拒绝、再生与执行通过 `review_proposal` 命令排队。

部分审批现在要求显式指定每一项，或通过 `unlistedDecision` 声明未列项的处理方式；逐项 `after` 修改会同步改写可执行 payload。

## Review Remediation

- H1：引入覆盖全部九种状态类型的显式 applier registry。角色状态、角色资源和角色关系走正式状态写入；其余 ledger-only 类型在 Change Proposal 执行前返回 `unsupported_change`，不会伪装成 executed。
- H2：逐项 `after` / `editedValue` 通过类型与 path 映射写回 `userEditedPayloadJson`，执行前再次校验 diff 值和 payload 一致。
- M3：文档明确 Proposal policy 输入为 Phase 2 接线项；Phase 1 一律显式审阅。
- M4：pending proposal 会生产 `proposal_review_required` checkpoint，Director 审阅命令完成后按实际 proposal status 清理或保留 checkpoint。
- M5：Planner、replan、章节 pending-review context 与角色资源 context 统一复用 `changeProposalId: null` 的 legacy 查询边界。
- M6：artifact 状态更新保留 `user_edited` 来源和 `protectedUserContent`。
- L7/L8：record source ref 的追踪边界已写入 wiki；部分审批不再隐式拒绝未列项。

## Gate Follow-up

- N1：Change Proposal 信封执行保持整批事务与显式失败；legacy 独立项按行隔离，payload / 引用领域错误会拒绝坏行并继续合法项，基础设施错误仍会终止事务。
- N2：关系阶段保留逐项记录的真实 `sourceType`。
- N4：已通过 PATCH 保存编辑值的项可在审批时发送裸 `modified`；没有已保存编辑值时仍要求提交编辑后的值。
- 真实 SQLite Proposal 验收测试已归入 integration 集合，fast 不再隐式依赖 Prisma engine 子进程。
- 合并关口处置见 `CODE_REVIEW_PROPOSAL_CORE_GATE_DISPOSITION.md`，完整 fast 失败清单与差集见 `TEST_BASELINE_PROPOSAL_CORE.md`。

## Tests Added

- Proposal 创建、批准、拒绝、部分批准、修改后批准、stale 拦截、执行、非法转换和版本再生。
- 并发审批先完成时，迟到的逐项编辑返回版本冲突。
- SQLite migration 结构与外键检查。
- PostgreSQL / SQLite Prisma schema 同步检查。
- Director command lane 与 proposal policy 决策检查。
- 未列项审批模式、ledger-only 执行阻断和 legacy pending-review 隔离。
- 真实 SQLite：关系 trust `62 -> AI 52 -> user 55` 后只写入 55，并验证当前关系阶段、checkpoint 和 artifact 来源。

## Verification

- `@ai-novel/shared` build：通过。
- `@ai-novel/server` build：通过。
- Proposal Core、真实 SQLite、schema migration、legacy pending-review、State Commit、Director Proposal checkpoint / policy 与 pending-review context 共 46 项聚焦测试：通过。
- Director command proposal review checkpoint 专项测试：通过。
- `main@308ca1b` 与功能分支已用各自独立、按对应 schema 初始化的 SQLite 库枚举同一 fast 边界；main 为 51 个失败键、功能分支为 50 个，`feature - main` 差集为空。
- 单独运行 `directorRunCommandService.test.js` 时，Proposal command/checkpoint 用例通过；同文件现有 `runtime.worker_stale` policy 用例仍为 `queued !== failed`。

## Known Risks

- 本阶段没有 Proposal 审阅 UI，API 主要供后续客户端和章节 Proposal Step 接入。
- record 类型 source ref 当前用于来源追踪；stale 的确定性校验覆盖 Director Artifact、其依赖版本和 Chapter 内容哈希。
- 章节执行 Proposal 的 AI 生产者、Expected vs Actual 对比和自治等级 policy 接线属于 Phase 2。
- event、information disclosure、conflict、payoff、world rule 和 book contract 目前保持 ledger-only；它们在拥有正式状态 applier 前不能通过 Change Proposal 标记为 executed。
- 章节增量与 Proposal 关系写入共享同一 helper；同一角色对的当前阶段遵循最后一次成功正式写入，跨来源排序的专项验收留在后续关系状态协调阶段。
