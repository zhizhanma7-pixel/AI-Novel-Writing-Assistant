# Code Review — Phase 1 Proposal Core

> 评审对象：`feat/change-proposal-core` 分支上的 `63c662f feat(proposal): implement proposal core`，外加工作区尚未提交的逐项编辑并发加固（`ChangeProposalReviewService` / `changeProposal.ts` / `changeProposalCore.test.js` / wiki）。
> 评审人：Claude Code（Architect + Reviewer，见 `ainovel_workflow_guide/AGENT_COLLABORATION_GUIDE.md` §5）
> 对照基线：`docs/dev/ARCH_RECON_PROPOSAL.md`、`PROJECT_GUIDE.md`、`01_PROPOSAL_WORKFLOW.md`、`05_ROADMAP_AND_ACCEPTANCE.md`
> 评审方式：静态评审 + 全链路追踪。**未运行测试**——本机 PATH 上没有 node/pnpm（PowerShell 与 Bash 均找不到 `node.exe`），`pnpm --filter @ai-novel/server test` 需由 Codex 侧补跑。

---

## 0. 结论

架构方向正确，实现基本落在侦察报告建议的边界内：**没有第二套 runtime，没有第二套审批系统**（Decision 001 ✅）。迁移是纯增量的，双 Prisma schema 同步，桌面端旧库有补列路径，数据安全没有问题。

但 Phase 1 的验收用例目前**跑不通**：

```text
用户：把A与B关系改差一点
→ AI提交proposal
→ 用户把 trust 45 改成 55
→ 批准
→ 正式状态只写入55
```

这条链路上有两个独立的断点（HIGH-1、HIGH-2），任一条都会让"批准后写入 55"变成"什么都没写"或"写入了 45"。两个断点都不会被现有测试发现，因为测试把 `StateCommitService` 整个 stub 掉了。

**评审结论：不阻塞合入 feature 分支，但 HIGH-1 / HIGH-2 必须在 Phase 1 关闭前修复，否则验收不成立。**

| 严重度 | 数量 | 编号 |
|---|---:|---|
| BLOCKER | 0 | — |
| HIGH | 2 | H1, H2 |
| MEDIUM | 4 | M3, M4, M5, M6 |
| LOW | 3 | L7, L8, L9 |

---

## 1. 做得对的部分

先明确哪些不要在后续改动中弄丢：

1. **逐项变更复用 `StateChangeProposal`，没有新建 ProposedChange 表。** 信封 `ChangeProposal` 只加了 8 个字段挂在旧模型上（`changeProposalId` / `changePath` / `operation` / `category` / `severity` / `beforeJson` / `afterJson` / `userEditedPayloadJson` / `reviewDecision` / `sourceRefsJson`），旧的校验、提交、冲突检查全部继续可用。这正是侦察报告的建议。
2. **旧自动链路隔离一致。** `changeProposalId: null` 被加到了会"自动放行 pending_review"的四个查询上：`PendingReviewAutoPromotionService`（两处）、`DirectorStateProposalResolutionService`、`pendingReviewContext`、角色资源确认/拒绝路由。`StateCommitService.commitExistingProposals()` 又在提交入口加了一道 `changeProposal.status ∈ {approved, partially_approved} AND reviewDecision ∈ {accepted, modified}` 的守卫。**未经人工批准的提案项不会被旧链路悄悄提交** —— 这是本次实现最关键的一条安全性保证，做对了。
3. **迁移安全。** SQLite / PostgreSQL 两份 migration 都只有 `CREATE TABLE` + `ADD COLUMN`（全部 nullable，无 NOT NULL 无默认值回填），没有 DROP / RENAME / 数据重写。`runtimeMigrations.ts` 的 `REQUIRED_COLUMN_BACKFILLS` 补齐了 10 个新列，桌面端旧 SQLite 库升级不会因缺列崩。两份 `schema.prisma` 的 `ChangeProposal` 与 `StateChangeProposal` 段落逐字一致（已 diff 验证），符合 AGENTS.md 的双 schema 硬规则。
4. **状态机集中且乐观锁到位。** 转换表在 `ChangeProposalStateMachine.ts` 一处定义，所有写操作都用 `updateMany + where{status, version}` 再校验 `count === 1`，并发审批不会互相覆盖。
5. **不存 chain-of-thought。** `reasoningSummary` 是唯一理由字段，schema 里有明确注释，长度限制 1000。符合 PROJECT_GUIDE §5 与 `01_PROPOSAL_WORKFLOW` §8。
6. **账本复用。** 提案索引为 `change_proposal` 类型的 `DirectorArtifact`，依赖走 `DirectorArtifactDependency`，事件走 `DirectorEvent`（`proposal_created` / `reviewed` / `applied` / `superseded`），任务侧走已有的 `DirectorRunCommand`（新增 `review_proposal` 命令类型）而不是新队列。
7. **工作区未提交的那次并发加固是正确的修复方向**：逐项编辑现在在同一事务里校验 `expectedVersion`、锁父提案状态、校验项归属，迟到的编辑会返回 `version_conflict` 而不是改写已批准内容。顺带把编辑事件的 `idempotencyKey` 变成每次唯一（父提案 `updatedAt` 会被显式推进），审计不再丢编辑记录。建议连同下面的修复一起提交。

---

## 2. HIGH

### H1 — 批准项对 9 种状态类型中的 7 种不落库，且新增的守卫是死代码

**位置：** `server/src/services/novel/state/StateCommitService.ts:551-557`

```ts
if (proposal.proposalType !== "character_state_update") {
  if (!AUTO_COMMIT_TYPES.has(proposal.proposalType) && !ALWAYS_REVIEW_TYPES.has(proposal.proposalType)) {
    throw new Error(`No state proposal applier is registered for ${proposal.proposalType}.`);
  }
  return;
}
```

`AUTO_COMMIT_TYPES`（5 个）∪ `ALWAYS_REVIEW_TYPES`（4 个）**恰好等于** `stateChangeProposalTypeSchema` 的全部 9 个枚举值。因此这个 `throw` 永远不可能触发——它是死代码，只制造了"applier 已注册"的错觉。

实际写库的只有两种：`character_resource_update`（走 `characterResourceLedgerService.applyCommittedUpdate`）和 `character_state_update`（写 `Character.currentState/currentGoal`）。其余 7 种——`relation_state_update`、`information_disclosure`、`world_rule_change`、`book_contract_change`、`event_record`、`payoff_progression`、`conflict_update`——`applyCommittedProposal` 直接 `return`，不写任何正式表。

**故障场景：** 用户批准一条 `relationship_change` 提案（`proposalType: relation_state_update`，payload `trust: 62 → 52`）。执行成功，逐项 status 变 `committed`，信封变 `executed`，`CanonicalStateVersion` 记了一条版本，`proposal_applied` 事件也记了。但 `CharacterRelationStage` 表毫无变化——`CanonicalStateService.getSnapshot()` 读的是 `characterRelationStage` / `openConflict` / `payoffLedgerItem` 这些一等表，不是已提交的提案行。下一章生成时读到的关系值仍然是 62。**用户看到"已执行"，实际什么都没发生。**

这是从 upstream 继承的缺口（侦察报告已标注 "applyCommittedProposal 只实现了 2/9"），本次实现没有关闭它，反而用一个不可达的 guard 掩盖了。

**建议：** 把 guard 换成真正的 applier 注册表，未注册即抛：

```ts
const STATE_APPLIERS: Partial<Record<StateChangeProposal["proposalType"], StateApplier>> = { ... };
const applier = STATE_APPLIERS[proposal.proposalType];
if (!applier) {
  throw new Error(`No state proposal applier is registered for ${proposal.proposalType}.`);
}
await applier(tx, proposal);
```

Phase 1 至少要补 `relation_state_update`——**复用 `CharacterDynamicsMutationService` 已有的 `characterRelationStage` 写入路径**（`server/src/services/novel/dynamics/CharacterDynamicsMutationService.ts:373,384,812,824`），不要另写一套。其余类型如果本阶段不做，就必须在注册表里显式登记为 `ledgerOnly`（只记账、不写一等表），并在 wiki 与 API 响应里说清楚，而不是静默 return。

---

### H2 — 用户编辑 `after` 不影响实际写入值，改了等于没改

**位置：** `ChangeProposalReviewService.ts:105-109`（编辑）、`:245-252`（审批时的 `editedValue`）、`StateCommitService.ts:589`（执行取值）

三处的取值口径不一致：

| 用户动作 | 写入的列 | 执行时实际使用 |
|---|---|---|
| `PATCH .../items/:itemId` 带 `payload` | `userEditedPayloadJson` = 新 payload | ✅ 新值 |
| `PATCH .../items/:itemId` 只带 `after` | `afterJson` = 新值；`userEditedPayloadJson` = **原 payload 的拷贝** | ❌ 原值 |
| `approve` 带 `itemDecisions[].editedValue` | `afterJson` = 新值 | ❌ 原值 |
| `approve` 带 `itemDecisions[].editedPayload` | `userEditedPayloadJson` = 新 payload | ✅ 新值 |

执行时 `StateCommitService.toProposal()` 只看 `userEditedPayloadJson ?? payloadJson`，`afterJson` 从不参与。

**故障场景：** UI 按 `01_PROPOSAL_WORKFLOW` §3 的设计对单条 diff 做 `✎ 修改`——用户把展示的 `trust: 62 → 52` 改成 `→ 55`，前端自然会 PATCH `after: 55`。服务端把 `afterJson` 存成 55，同时把 `userEditedPayloadJson` 设成**原始 payload（52）**，于是这条项被判定为 `modified`（因为 `userEditedPayloadJson` 非空），审批通过，执行写入……52。用户在 UI 上看到的是自己改的 55，正式状态里是 52，且没有任何告警。

这条路径正是 Phase 1 唯一的验收用例，也是整个产品哲学"用户可修改单个状态变化"的落点，静默写错值比报错严重得多。

**建议（二选一，推荐前者）：**
1. 用已有的 `proposedChange.path` 建立 `after → payload` 的写回映射：编辑 `after` 时按 path 把值写回 payload 对应字段，两者始终同源。
2. 若暂不做映射，则在 schema 层禁止"只给 `after`"（`editProposedChangeInputSchema` 要求 `payload` 必填，`after` 仅作展示同步），并把 `itemDecisions[].editedValue` 一并去掉。

无论哪种，都应加一条断言：`modified` 项落库前，`afterJson` 与 `userEditedPayloadJson` 必须自洽。

---

## 3. MEDIUM

### M3 — DirectorPolicyEngine 的提案门禁没有任何调用方，Autonomy Level 未落地

**位置：** `DirectorPolicyEngine.ts:27-28, 173-193`

`proposalSeverity` / `outlineFidelity` 两个入参在全仓**只有测试在传**（`server/tests/directorRuntimePolicy.test.js`），生产代码没有任何调用点。而 `docs/wiki/workflows/change-proposal-review.md` 写的是"major 或 strict 提案需要人工批准"——文档描述了一个未接线的能力。

同时 `ChangeProposalApplyService.executeProposal()` 完全不查 policy，也读不到 `PROJECT_GUIDE` §7 的 Autonomy Level（L0–L3 目前在代码里不存在）。当前之所以还安全，只是因为执行必须由外部显式调用两次 HTTP；一旦 Phase 2A 把 AI 自动执行接上，这层门禁就是空的。

**建议：** `executeProposal` 前调用 policy engine，把信封的 `outlineFidelity` 与逐项最高 severity 传进去；或者在 wiki 明确标注"策略入参已预留，Phase 2A 接线"，不要让文档跑在实现前面。

### M4 — `proposal_review_required` checkpoint 只有文案没有生产者；待审提案不阻塞任何链路

**位置：** `novelWorkflowExplainability.ts:59,72,85`（三张映射表）、`DirectorCommandExecutor.ts:203-215`

- 新 checkpoint `proposal_review_required` 在三张展示映射里都加了中文文案，但全仓没有任何地方把 `task.checkpointType` 设成这个值——纯声明。
- `pendingReviewContext` 排除了 `changeProposalId != null`，所以一条 pending 的 `chapter_execution` 提案**不会阻塞章节生成**。自动导演会一边等审批一边继续写正文。Phase 1 后端阶段可以接受，但要记在 Phase 2C 的接线清单里（正文前置暂停与 Expected vs Actual 同批），否则 "AI 先提交 Proposal → 用户批准 → 生成正文" 这个 P0 范式落不了地。
- `DirectorCommandExecutor` 在 `review_proposal` 命令完成后，**无条件**把任务置为 `status: "waiting_approval"` 且 `checkpointType: null`——包括 `reject` 和 `execute` 之后。执行成功的任务被推进一个没有 checkpoint 说明的等待态，前端无法解释它在等什么。

**建议：** 按 decision 分支设置任务状态（execute 成功应回到可继续态；pending 的提案才设 `proposal_review_required`），并让 checkpoint 真正被写入。

### M5 — planner / replan 的 `pending_state_review` 计数把未审提案算了进去

**位置：** `PlannerService.ts:362`、`PlannerReplanService.ts:78`、`CharacterResourceLedgerService.ts:190`

隔离改动覆盖了 4 个消费点，漏了 3 个：

- 前两处是无过滤的 `stateChangeProposal.count({ novelId, status: "pending_review" })`，经 `plannerStateDirectives.ts:32` 注入 prompt 的 `pending_state_review=N`。一个等待人工审批的 ChangeProposal 会让规划模型以为有 N 条它看不见也处理不了的待确认状态。
- `CharacterResourceLedgerService` 把信封内的 `character_resource_update` 项当作可确认的 pending 项塞进写作上下文，但角色资源确认路由已经不再受理它们（`changeProposalId: null` 过滤）——用户在那个界面看不到、也无法处理这些项。

**建议：** 抽一个 `buildLegacyPendingReviewWhere()` helper（或复用现有的 `pendingReviewContext`），把 7 个消费点全部收敛过去，避免下次再漏。

### M6 — 执行后 artifact 上的 `user_edited` 标记被覆盖

**位置：** `ChangeProposalArtifactService.markStatus` → `ArtifactWriter.upsert`（`DirectorArtifactGateway.ts:79-129`）

`markUserEdited` 会把 artifact 置为 `source: "user_edited"` + `protectedUserContent: true` 并 bump version；之后审批/执行走 `markStatus` → `upsert`，而 `upsert` 无条件写 `source: input.source ?? "ai_generated"`、`protectedUserContent: ref.protectedUserContent`（未传即 null）。**含用户改写的提案一旦执行，账本上就看不出它被人工编辑过了**，与 Decision 004（重大 AI 变更必须对用户可见、可追溯）相悖。

**建议：** `markStatus` 对已是 `user_edited` 的 artifact 只更新 `status`，或把 `source` / `protectedUserContent` 一并透传。

---

## 4. LOW

### L7 — `record` 类 sourceRef 完全不参与 stale 检测

`ChangeProposalStalenessService.inspect()` 只处理 `director_artifact` 与 `chapter` 两种引用。`recordSourceReferenceSchema` 定义了 `table` / `id` / `version` 却没有任何一处校验，等于给调用方一个"可追踪来源"的假象。要么实现（按 table+id 查 `updatedAt`/版本），要么在 schema 注释里写明它只用于展示。

### L8 — 部分批准的默认语义是"未列出即拒绝"

`ChangeProposalReviewService.ts:196-197`：只要客户端传了 `itemDecisions`，没出现在里面的项一律按 `rejected` 处理。wiki 里写了，但 API 上没有显式开关。未来 UI 如果只提交"用户动过的项"，会把其余全部静默拒绝。建议加显式字段（如 `unlistedDecision: "accepted" | "rejected"`），或要求 `itemDecisions` 必须覆盖全部 id 否则 400。

### L9 — 测试全部走 fake prisma，两个 HIGH 都测不出来

`changeProposalCore.test.js` 用内存 Map 顶掉了 prisma，并把 `commitExistingProposals` 也 stub 成"直接把 status 改成 committed"。因此：

- H1（7 种类型不落库）测不到——stub 里没有 applier；
- H2（编辑 `after` 无效）测不到——stub 不读 `userEditedPayloadJson`；
- 断言停在 `store.committedBatches` 这一层，也就是"调用参数对不对"，而不是"正式状态对不对"。

`05_ROADMAP_AND_ACCEPTANCE.md` 的 Agent 执行规则第 11 条要求每阶段至少一组回归测试。**建议补一组真实 SQLite 端到端**：建库 → 建 novel/character → create proposal（含 relation + character_state 两类）→ 编辑值 → 部分批准 → execute → 直接查 `Character` / `CharacterRelationStage` 断言最终值等于用户改后的值。这一组测试同时就是 Phase 1 的验收凭证。

`changeProposalSchemaMigration.test.js` 校验迁移 SQL 与双 schema 同步，这部分做得好，保留。

---

## 5. 分类小结（按协作指南 §4 的评审维度）

**Architecture** — 复用充分，无重复系统。唯一的架构性欠账是 H1：applier 分派器仍然缺失，这是从侦察报告起就标出的三大缺口之一，本次只补了信封与审阅通道两个。

**Data** — 无数据丢失风险。迁移纯增量、双 schema 同步、桌面端补列齐全。`onDelete: SetNull` 的选择合理（删章节/任务不会连带删提案）。

**State** — 状态机正确，乐观锁到位，非法转换有拦截。剩余的一致性问题是 H2 的 `after` / `payload` 双写不同源，以及"逐项编辑不会 bump 信封 version"——`expectedVersion` 因此无法发现"我读取之后别人改了某一项"，只能发现"信封状态变了"。工作区那次加固修的是反方向（迟到的编辑），正方向仍有缝隙，Phase 6 的 "proposal source changed before approval" 用例要覆盖到。

**Compatibility** — 与 Auto Director 兼容：命令类型、artifact 类型、事件类型、checkpoint 都是加法；客户端对 checkpoint 用的是 `if (=== ...)` 而非穷举 Record，新增枚举不会打断前端编译。旧的角色资源审阅流程被正确地排除掉了信封内的项，没有出现两套审批入口。

**Testing** — 见 L9。结构清晰但深度不足，关键路径靠 stub 绕过了。

---

## 6. 给 Codex 的修复清单（按优先级）

1. **H1** `StateCommitService`：改成显式 applier 注册表；至少补 `relation_state_update`，复用 `CharacterDynamicsMutationService` 的写入路径；未注册类型必须抛。
2. **H2** 统一 `after` / `payload` 取值口径（推荐按 `path` 写回 payload），加自洽断言。
3. **L9** 补一组真实 SQLite 端到端回归，断言正式表最终值 —— 这组测试同时验证 1 与 2。
4. **M5** 抽 `buildLegacyPendingReviewWhere()`，收敛 `PlannerService` / `PlannerReplanService` / `CharacterResourceLedgerService` 三个漏网点。
5. **M4** `DirectorCommandExecutor` 按 decision 分支设置任务状态；让 `proposal_review_required` 真正被写入。
6. **M6** `markStatus` 保留 `user_edited` / `protectedUserContent`。
7. **M3** 要么给 `executeProposal` 接上 policy engine，要么把 wiki 改成"已预留、Phase 2A 接线"。
8. **L7 / L8** 按上文二选一处理，改 schema 注释也算处理。

另需补上 `IMPLEMENTATION_REPORT.md`（协作指南 §4 Step 3 要求的交付物，当前缺失），以及说明 Phase 1 验收链路里"AI 侧的提案生产者"目前尚未存在——全仓只有 `POST /api/novels/:id/change-proposals` 一个创建入口，导演流程不会自己提交 Chapter Execution Proposal。这一项是 Phase 1 → Phase 2A 之间必须有人认领的接线工作，建议写进 Phase 2A 的实施计划 Scope。
