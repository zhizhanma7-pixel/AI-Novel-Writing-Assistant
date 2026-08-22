# Change Proposal 审阅与执行

Change Proposal 是 `StateChangeProposal` 的审阅信封，不是新的编排运行时。它负责把一组状态变更、来源、风险和用户可见依据组织成可版本化的提案；正式写入仍由 `StateCommitService` 与 `CanonicalStateVersion` 完成。

## 数据模型

- `ChangeProposal` 保存小说、章节和可选导演任务范围，以及提案类型、版本、状态、来源引用、警告、期望状态和用户可见的 `reasoningSummary`。
- `StateChangeProposal.changeProposalId` 把逐项变更挂到信封。每项包含 path、add/remove/replace 操作、分类、minor/major 严重度、before/after、来源和 accepted/modified/rejected 审阅决定。
- `reasoningSummary` 只能保存面向用户的简短依据，禁止保存隐藏推理或模型 chain-of-thought。
- 再生不会覆盖原提案。新记录的 `version` 加一并通过 `supersedesId` 指向旧记录，旧记录进入 `superseded`。

## 状态机

允许的转换为：

```text
draft -> pending_review -> approved ---------> executed
                         -> partially_approved -> executed
                         -> rejected

draft / pending_review / approved / partially_approved / rejected -> superseded
executed / superseded -> 终态
```

非法转换和期望版本不一致都返回冲突，不会静默覆盖并发审阅结果。

## 审阅规则

- 整体批准时，未单独指定的变更按 accepted 处理；用户预先改写过 payload 的项按 modified 处理。
- 部分批准必须至少保留一个 accepted 或 modified 项；未出现在逐项决定中的项按 rejected 处理。
- 拒绝提案会拒绝全部逐项变更。
- draft 或 pending_review 阶段可以编辑 proposed value。编辑值保存在用户编辑字段中，执行时优先使用该值。
- 先通过逐项 PATCH 保存编辑值后，审批可以只提交该项的 `modified` 决定；如果服务端没有已保存编辑值，`modified` 必须同时携带 edited payload/value，避免把未修改内容误标为人工修改。
- 逐项编辑会在同一事务内校验提案版本、锁定父提案的可编辑状态，并校验逐项归属；如果并发审批先完成，迟到的编辑会返回版本冲突，不会改写已批准内容。
- 批准前和执行前都会检查 stale。来源 artifact 缺失、状态失效、版本/内容变化、依赖版本变化，以及章节内容哈希变化都会阻止继续。

## 执行与旧链路隔离

`ChangeProposalApplyService` 只把 reviewDecision 为 accepted 或 modified 的逐项 ID 交给 `StateCommitService.commitExistingProposals()`。拒绝项不会进入正式状态。所有批准项成功提交后，信封才能进入 `executed`。

旧的 pending-review 自动放行、导演状态解析、写作上下文和角色资源确认查询均只处理 `changeProposalId = null` 的历史独立记录，避免新提案在人工审阅前被旧自动链路放行。

Change Proposal 信封内的正式写入保持原子性：任一批准项失败，整次信封执行回滚并返回错误。legacy 独立记录按行隔离；payload 格式或已失效引用导致的领域失败会把坏行标为 rejected 并留下 `legacy_apply_failed` note，其余合法记录继续，数据库与基础设施错误不会被降级成业务拒绝。

## Policy、任务与审计复用

- `DirectorPolicyEngine` 已预留 `proposalSeverity` 和 `outlineFidelity` 输入，但章节 Proposal Step 尚未接线。Proposal Core 当前对所有信封都要求显式审阅；按自治等级自动放行 minor 提案属于 Phase 2 接线范围。
- 带 `taskId` 的批准、部分批准、拒绝、再生和执行请求通过 `review_proposal` DirectorRunCommand 排队，HTTP 返回 202，不创建第二套队列。
- 提案被索引为 `change_proposal` DirectorArtifact，并沿用 artifact dependency 进行 stale 检测。
- 事件沿用 `DirectorEvent`，记录 `proposal_created`、`proposal_reviewed`、`proposal_applied` 和 `proposal_superseded`。
- `record` 类型 source ref 在本阶段只用于来源展示与追踪；确定性 stale 检查覆盖 Director Artifact、其依赖版本与 Chapter 内容哈希。

## Apply 边界

- `character_state_update`、`character_resource_update` 和 `relation_state_update` 有正式状态 applier。
- 关系阶段写入保留逐项记录的真实 `sourceType`。章节增量和 Proposal 使用同一正式写入 helper；同一角色对的当前阶段由最后一次成功写入决定，历史阶段不会删除。
- 其他旧 `StateChangeProposal` 类型继续保持 ledger-only 兼容，供既有章节状态账本使用；Change Proposal 若批准了这些类型，执行接口会明确返回“不支持正式写入”，不会把信封标成 executed。
- 章节执行 Proposal 的 AI 生产者、`Expected vs Actual` 对比和自动导演正文前置暂停属于 Phase 2，当前只有后端创建与审阅入口。

## HTTP API

路由挂载在小说模块：

```text
GET    /api/novels/:id/change-proposals
GET    /api/novels/:id/change-proposals/:proposalId
POST   /api/novels/:id/change-proposals
POST   /api/novels/:id/change-proposals/:proposalId/submit
PATCH  /api/novels/:id/change-proposals/:proposalId/items/:itemId
POST   /api/novels/:id/change-proposals/:proposalId/approve
POST   /api/novels/:id/change-proposals/:proposalId/partial-approve
POST   /api/novels/:id/change-proposals/:proposalId/reject
POST   /api/novels/:id/change-proposals/:proposalId/regenerate
POST   /api/novels/:id/change-proposals/:proposalId/execute
```

本阶段只有后端与数据层，没有提案审阅 UI，也没有修改 Android 或接入其他外部运行时。
