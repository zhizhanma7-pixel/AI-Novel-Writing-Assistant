# State Apply Observability Implementation Report

## Scope

本分支只处理 Proposal Core 关口评审留下的 O1 / O2：把 legacy 状态写入的领域失败从文案前缀分类改为显式类型，并让自动放行中被隔离的 rejected 项进入账本事件与运行告警。Proposal 审阅、UI、ledger-only applier、桌面运行时均未修改。

## O1 — Typed Domain Error

- 新增 `StateProposalDomainError`，携带 `proposalType` 与稳定 `reason`：
  - `invalid_payload`
  - `missing_character_id`
  - `character_not_found`
  - `same_character_relation`
  - `character_outside_novel`
- 角色状态和关系状态的四个领域抛出点全部改用 typed error。
- 角色资源与关系 payload 在各自 applier 边界使用 `safeParse`；解析失败转换为 `invalid_payload`，下游服务抛出的裸 ZodError 不再被扩大分类为 legacy 数据问题。
- `StateCommitService` 删除消息前缀表和 ZodError 宽泛判据，只用 `instanceof StateProposalDomainError` 决定是否隔离。
- `validationNotes` 使用稳定格式：`legacy_apply_failed:<proposalType>:<reason>:<message>`。
- 错误类型定义和两处事务 catch 都记录了 PostgreSQL 事务不变量：领域错误只能在 SQL 前或成功 SQL 后抛出，失败 SQL 不得转换成领域错误后继续使用同一个 transaction client。

信封项仍走整批严格事务；typed domain error 不会改变 Change Proposal 的原子执行语义。普通 Error 即使以旧文案前缀开头，也会作为基础设施错误上抛。

## O2 — Rejected Visibility

- 自动放行账本事件接收真实 `commitResult`。
- 出现 rejected 时，现有 `pending_review_auto_promotion` 事件追加：
  - `metadata.rejectedCount`
  - `metadata.rejectedItemIds`（最多 50 条）
  - 中文 summary 后缀
  - 至少 medium severity
- promoted 计数改用真实 committed 结果，而不是放行前候选数。因此全拒绝批次会记录为零 promoted，并通过 `rejected=...` 幂等键分量形成独立事件。
- 仅在存在 rejected 时追加新的 metadata 与 key 分量；全成功批次的既有字段、事件类型和幂等键保持不变。
- 自动放行运行告警增加 `rejectedCount`。
- 章节增量链路若 `proposeAndCommit` 返回 rejected，输出包含小说、章节、数量和截断 item ID 的服务端 warning，避免返回值被静默丢弃。

## Verification

- `pnpm --filter @ai-novel/server build`：通过。
- `stateCommitService.test.js` + `pendingReviewAutoPromotionService.test.js`：24 项通过。
  - 覆盖 5 个稳定 reason 码和两类 `invalid_payload` 边界。
  - 覆盖旧消息前缀普通 Error 仍严格上抛。
  - 覆盖 legacy 行隔离、信封严格事务和基础设施错误严格上抛。
  - 覆盖 rejected metadata、summary、severity、warning 计数和全拒绝幂等键。
  - 逐字断言无 rejected 时的旧幂等键不变。
- `changeProposalCore.test.js` + `changeProposalRealSqlite.test.js`：21 项通过。
  - 真实 SQLite 的关系值 `62 -> AI 52 -> user 55 -> execute` 继续通过。

## Release Notes Decision

本次改动是内部错误分类与运行可观测性加固，不改变用户可见功能、接口操作方式或 UI，因此不更新 README 与用户发布说明。长期维护规则已写入工作流 wiki。

## Residual Risk

- “领域错误不得位于失败 SQL 之后”是跨 PostgreSQL / SQLite 的代码约束，无法由当前 SQLite 测试完整证明；后续新增 reason 或抛出点时必须人工审查事务位置。
- Windows 桌面 managed server 的 `.cmd` spawn 问题仍由独立分支处理，不属于本实现范围。
