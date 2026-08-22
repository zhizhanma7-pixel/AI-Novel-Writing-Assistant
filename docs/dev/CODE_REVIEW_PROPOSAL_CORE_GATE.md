# Gate Review — Phase 1 Proposal Core（后端核心关闭复审）

> 复审对象：`feat/change-proposal-core` @ `e2231c3 fix(proposal): apply reviewed changes safely`（含 `dd38b9f`、`63c662f`）
> 对照基线：`docs/dev/CODE_REVIEW_PROPOSAL_CORE.md` 的 H1/H2、M3–M6、L7–L9
> 复审人：Claude Code（Reviewer）
> 方式：静态复审 + 逐路径追踪 + 测试代码审读。**本机仍无 node/pnpm，未实际执行测试**；下文所有 Pass 判定基于代码路径验证，测试通过与否采信 Codex 在 `IMPLEMENTATION_REPORT.md` 中的自述，未经我复跑。
> 边界：本次只评审，未修改任何实现代码。

---

## 1. 逐项结论

| 编号 | 问题 | 状态 | 判定依据 |
|---|---|---|---|
| H1 | 7/9 状态类型不落库，守卫是死代码 | **Pass** | 新增 `StateProposalApplierRegistry.ts`，`Record<全部 9 种>` 由 TS 强制穷举；`relation_state_update` 有真实 applier；6 种 ledger-only 显式声明，且在 `executeProposal` 前以 `unsupported_change`(409) 阻断，不再伪装 executed |
| H2 | 编辑 `after` 不影响实际写入值 | **Pass** | 新增 `ProposedChangeValueMapper`，`after` / `editedValue` 按 path（含别名表）写回 payload；`afterJson` 由 payload 反推；执行前 `assertEditedValueMatchesPayload` 二次校验；已编辑项禁止以 `accepted` 批准 |
| M3 | policy 提案门禁无调用方 | **Pass（文档口径关闭）** | 未接线，但 wiki 与实现报告已改口径为「输入已预留，Phase 2 接线，Phase 1 一律显式审阅」。符合原评审给出的第二个选项 |
| M4 | checkpoint 无生产者 / 任务状态无条件 waiting_approval | **Pass** | `markTaskPendingReview()` 在 create / submit / regenerate 写入 `proposal_review_required`，并排除终态任务；`buildProposalReviewResultTaskState()` 按 proposal 实际状态映射任务态 |
| M5 | planner / 资源上下文漏过滤 | **Pass** | 新增 `buildLegacyPendingReviewWhere()`，4 个消费点全部收敛，并有 `legacyPendingReviewWhere.test.js` |
| M6 | 执行后覆盖 `user_edited` 来源 | **Pass** | `markStatus` 先读现有 artifact 再透传 `source` / `protectedUserContent`；id 用 `buildDirectorArtifactId`（已核对：该 id 不含 novelId，键一致，查得到） |
| L7 | `record` sourceRef 不参与 stale | **Pass（文档边界关闭）** | schema 注释 + wiki 明确「仅用于来源追踪」。符合原评审给出的选项 |
| L8 | 部分批准「未列即拒绝」 | **Pass** | 新增 `unlistedDecision`；未覆盖且未声明时显式报错而非静默拒绝；schema 层 `superRefine` 把 `modified` 与 edited 值绑定 |
| L9 | 无真实 DB 回归 | **Pass（附工艺建议）** | `changeProposalRealSqlite.test.js` 建临时库跑 `62 → AI 52 → 用户 55 → 批准 → 执行`，断言 `CharacterRelation.trustScore === 55`、stage、item payload、artifact 来源、任务 checkpoint。建议见 §3 的 P2 |

**九项全部关闭。** 验收链路（关系值 62 → AI 建议 52 → 用户改 55 → 只写入 55）现在有真实 SQLite 断言背书。

---

## 2. 六个重点维度核验

**① 关系状态真实落库 —— 通过。** `applyCharacterRelationStateProposal` upsert `CharacterRelation` 后调用 `replaceCurrentCharacterRelationStage` 落 `CharacterRelationStage`，并且这个 helper 是从 `CharacterDynamicsMutationService` **抽出来复用**的（手工路径改为调用同一函数，逻辑逐字保持），不是另写一套写入。符合 Decision 001。

**② 用户编辑值一致性 —— 通过。** 四条口径现在同源：`PATCH payload`、`PATCH after`、`editedValue`、`editedPayload` 最终都收敛到 `userEditedPayloadJson`，`afterJson` 只作为该 payload 的投影。无法映射的 path 会返回 400 并提示改用 `editedPayload`——显式失败优于静默写错，方向正确。

**③ unsupported applier 处理 —— 通过，但失败点偏晚。** ledger-only 类型在 `executeProposal` 才被拒。用户可以创建、审阅、批准一个 `world_rule_change` 提案，直到点执行才知道它无法落库。建议后续在 `createProposal` 就校验（信封类型 × 逐项类型的可执行子集），把失败提前到创建时。当前不阻塞——因为不再有"假成功"。

**④ checkpoint —— 通过。** 有生产者、有清理、有终态保护、有测试断言。一处待观察：审批/拒绝/执行完成后任务被置为 `queued`（原为 `waiting_approval`）。这是让链路可继续的合理选择，但我无法运行，请确认调度器不会因此重新租用并重复执行同一任务的后续步骤。

**⑤ legacy pending-review 隔离 —— 通过。** 收敛为单一 helper。仅剩 `CharacterResourceExtractionService.ts:57` 的去重查询未带过滤，但它按 `sourceType + sourceStage + contentHash` 匹配、不看 status，影响面仅是"提案创建的资源项可能抑制一次重复抽取"，可忽略。

**⑥ artifact provenance —— 通过。** 见 M6。真实库测试断言执行后仍为 `user_edited` + `protectedUserContent = true`。

---

## 3. 本次修复引入的新问题（不阻塞合并，但需认领）

### N1（MEDIUM）— 新 applier 的硬失败扩散到旧链路

`applyCommittedProposal` 是共享入口，同时服务于三条链路：

```text
proposeAndCommit          ← ChapterArtifactDeltaService.ts:393（章节增量 → 状态提交）
commitExistingProposals   ← PendingReviewAutoPromotionService ← NovelDirectorService.ts:242
                                                              ← DirectorCoreStepModuleRuntime.ts:83
commitExistingProposals   ← ChangeProposalApplyService（新信封路径）
```

修复前这些类型是静默 `return`；现在会 `throw`。`validate()` 已经拦掉了大部分坏数据（缺 `characterId` 的 character_state_update、schema 不合法的 character_resource_update 都会被判 `rejected`），但**没有覆盖**：

- `character_state_update` 的 characterId 存在但角色已删除 / 属于别的小说 → applier 的 `updated.count !== 1` 抛错；
- `relation_state_update` 的 payload 结构不符（`validate()` 对该类型没有任何校验）或双方角色任一被删 → `.parse` / `characterCount !== 2` 抛错。

而 `commitExistingProposals` 的事务是**整批**的：一条坏项会让整批提交回滚，且每次重试都会在同一条上再失败——自动晋级会被这条脏数据永久卡住。

**建议：** 按行来源分流——`changeProposalId != null`（信封路径）保持抛错（这正是我们要的显式失败）；legacy 行改为记 `validationNotes` 并跳过，或者把关系 payload 的校验前置到 `validate()`，让坏行走 `rejected` 而不是炸事务。

### N2（LOW）— 关系阶段的 sourceType 标签失真

`applyCharacterRelationStateProposal` 固定写 `sourceType: "change_proposal"`。经旧链路（自动晋级）提交的关系项并没有 ChangeProposal 信封，却也会被标成 `change_proposal`，`CharacterRelationStage` 的来源统计会失真。建议按实际来源传入。

### N3（LOW）— 关系阶段出现第二个写入方

`ChapterArtifactDeltaService`（`ARTIFACT_DELTA_SOURCE_TYPE`，先 delete 同章同来源再重建）与新的提案路径现在都会翻转同一对角色的 `isCurrent`。同一章里既有章节增量又有关系提案时，"当前阶段"取决于两者的执行顺序。建议补一条针对该场景的回归。

### N4（LOW）— 已编辑项在部分批准时必须重发 payload

`proposedChangeItemDecisionSchema.superRefine` 要求 `modified` 必带 `editedPayload`/`editedValue`，而服务层又禁止已编辑项以 `accepted` 批准。于是"先 PATCH 改值、再部分批准"这条路径必须在 approve 时**再发一次**编辑后的 payload，只发 `{id, decision:"modified"}` 会被 400。整体批准（不传 itemDecisions）不受影响。这是 Phase 1 UI 必须知道的接口契约，建议要么写进 wiki 的审阅规则，要么放宽 schema：项上已有 `userEditedPayloadJson` 时允许裸 `modified`。

---

## 4. 是否同意推送合并

**同意合并到 beta 通道**（`feat/change-proposal-core` → beta → main，按 AGENTS.md 的分支纪律），但附两个交付前条件：

1. **N1 需要给出处置结论**——修掉，或者由你明确接受为已知风险并记入 `Known Risks`。它影响的是既有自动导演链路，不是新功能本身。
2. **测试基线需要自证**。实现报告写明"全量 fast baseline 仍有多组不在 Proposal 范围内的失败"。请在合并前于 `main` 上跑一次同样的 fast suite 并保存失败清单，与分支上的清单做差集——只要差集为空，就能证明这些失败是既有的而非本次引入。我这边无法执行，这一步只能由你或 Codex 完成。

工艺建议（P2，不影响合并）：把 `changeProposalRealSqlite.test.js` 移入 `run-tests.cjs` 的 `integrationTests` 集合。它会 `spawn pnpm prisma:push`，而同类的 `p0bRealPrismaChain.test.js` 正是登记在 integration 里的；放在 fast 会让 fast suite 依赖 pnpm 与 prisma engine，CI 上更脆。

---

## 5. Phase 1 剩余 UI 任务的处理建议

**同意按"Phase 1 后端核心完成"关闭本关口。** 理由：Roadmap 把 Proposal UI 放在 Phase 1，而协作指南明确 Codex 本阶段不做 UI——两份文档的边界冲突应该由拆分解决，而不是让后端一直不封板。

建议：

1. 从合并后的 main/beta 拉 **`feat/change-proposal-ui`**，由前端负责人接手，Scope 限定为：提案列表与详情、逐项 diff 的 `✓ 接受 / ✎ 修改 / ✗ 拒绝`、部分批准必须显式携带 `unlistedDecision`、编辑必须走 `editedPayload` 或可映射的 `after`、stale 提示与冲突（409）处理、以及 `proposal_review_required` checkpoint 在任务抽屉与 AI 驾驶舱的入口。N4 的接口契约要在这个分支的第一份 plan 里写清楚。
2. **不要**把"AI 侧的提案生产者"塞进 UI 分支。目前全仓只有 `POST /api/novels/:id/change-proposals` 一个创建入口，导演流程不会自己提交 Chapter Execution Proposal；这条接线连同 Expected vs Actual 对比、L0–L3 自治等级、policy 门禁，属于 Phase 2 的同一批工作，应在 Phase 2 的 `IMPLEMENTATION_PLAN.md` 里成组认领。
3. Roadmap 的 Phase 1 验收清单建议就地标注为「后端核心已关闭（`e2231c3`），UI 由 `feat/change-proposal-ui` 承接」，避免下次复盘时出现"Phase 1 到底关没关"的歧义。
