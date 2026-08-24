# Smoke — State Apply Observability Combination Validation

> 对象：`beta@1e79966`（包含 state apply observability、组合 smoke 与 Phase 2 口径修订）
> 目的：`CODE_REVIEW_STATE_APPLY_OBSERVABILITY.md` 关闭的 O1/O2/L1 都只有**单点**覆盖（mock 边界或手写 fixture）。Phase 1 封板前要求的两项，是**组合**穿透真实代码路径的验证，本文件记录这两项的实现方式、静态推导结论，以及尚未完成的部分。
>
> **执行分工：** 测试代码由 Claude Code 编写，Codex 使用 Node `24.19.0` / pnpm `11.19.0` 完成真实执行并修正 fixture 装配问题。
> 执行人：Claude Code（静态推导 + 新增测试代码）、Codex（构建、真实 SQLite 执行、结果回填）。

---

## 0. 结论

两项组合场景均已通过真实 SQLite 集成测试（临时数据库 + `prisma:push` + 编译后 `dist/` 子进程脚本），并已登记进 `server/scripts/run-tests.cjs` 的 `integrationTests` 集合。专项执行结果为 **2/2 通过**，Phase 1 的 state apply 组合验证条件已满足。

| 组合项 | 测试文件 | 静态走查 | 真实执行 |
|---|---|---|---|
| 一：脏 legacy 项 → rejectedCount + medium 账本事件 | `pendingReviewAutoPromotionRealSqlite.test.js` | ✅ 应通过 | ✅ 通过（1/1） |
| 二：常规校验拒绝不触发 apply-failure warn | `stateCommitApplyFailureFilterRealSqlite.test.js` | ✅ 应通过 | ✅ 通过（1/1） |
| 三：驾驶舱提示 | —（不自动化，见第 5 节） | ✅ 数据层已证 | ⏳ 用户目视 |

首次执行组合项一时，fixture 传入了不存在的 `taskId`，触发 `DirectorEvent.taskId` 外键约束；事件写入按既有 best-effort 语义被忽略，导致只有 `ledgerEventFound` 断言失败。删除虚构任务关联后复跑通过。该问题属于测试装配错误，产品实现和验收断言均未放宽。

---

## 1. 组合验证一：脏 legacy 项 → rejectedCount + medium 账本事件

**新增文件：** `server/tests/pendingReviewAutoPromotionRealSqlite.test.js`

### 场景

同一批 pending-review 关系提案（`relation_state_update`，过审阈值设 14 天，两条都设为 20 天前创建）：

- 一条合法：`sourceCharacterId=Alice`、`targetCharacterId=Carol`（同小说内真实存在的两个角色）。
- 一条脏数据：`targetCharacterId` 指向一个不存在的角色 id。

用真实（未 mock）依赖调用 `pendingReviewAutoPromotionService.apply()`：真实 `StateCommitService.commitExistingProposals` → 真实 `applyCharacterRelationStateProposal`（`server/src/services/novel/dynamics/characterRelationStateMutation.ts:107-119`）在 `characterCount !== 2` 时抛 `character_outside_novel` → 真实 `directorAutomationLedgerEventService.recordEvent` 写入 `DirectorEvent` 表。

### 断言

- `commitResult.rejected.length === 1`，`committed.length === 1`。
- 脏提案行 `status === "rejected"`，`validationNotesJson` 含 `legacy_apply_failed:relation_state_update:character_outside_novel:` 前缀。
- 合法提案行 `status === "committed"`，且 `CharacterRelation.trustScore` 确实写入 40（证明不是空跑）。
- 读回真实 `DirectorEvent` 行：`severity === "medium"`，`summary` 含"其中 1 条因数据问题被拒绝"，`metadataJson.rejectedCount === 1`。

### 与既有测试的差异

`server/tests/pendingReviewAutoPromotionService.test.js` 里 `"PendingReviewAutoPromotionService reports rejected legacy apply results"` 这条用例是把 `stateCommitService.commitExistingProposals` 整个 mock 掉、手写返回值里塞一个 `rejected` 数组，只验证"如果收到 rejected，账本事件长这样"。它不会告诉你**真实的** `StateCommitService` 在遇到脏数据时是否真的会产出这样的 `rejected` 数组。这次新增的测试把 mock 边界去掉，让脏数据真正走一遍 `characterRelationStateMutation.ts` 的 applier。

---

## 2. 组合验证二：章节常规校验拒绝不触发 apply-failure warn

**新增文件：** `server/tests/stateCommitApplyFailureFilterRealSqlite.test.js`

### 场景

同一批提案（都是 `character_state_update`，因为它在 `AUTO_COMMIT_TYPES` 里,会立刻尝试落库，不会像 `relation_state_update` 那样先转 `pending_review`）：

- 一条 summary 为空 → 在 `StateCommitService.validate()` 里于第一步就被拒绝（`server/src/services/novel/state/StateCommitService.ts:351-358`，note 是纯文本 `"missing summary"`），根本不会尝试写库——这是"章节常规校验拒绝"的真实来源之一。
- 一条 `characterId` 指向不存在的角色 → 通过 `validate()`，进入 `persistValidated()` 的落库循环，真实触发 `tx.character.updateMany` 命中 0 行 → 抛 `character_not_found`（`StateProposalApplierRegistry.ts:72-78`）→ 落回 `rejected`,note 前缀 `legacy_apply_failed:character_state_update:character_not_found:`。
- 一条合法 → 真实写入 `Character.currentState/currentGoal`。

真实调用 `stateCommitService.proposeAndCommit({ proposals: [...], skipFactExtraction: true })`（跳过章节抽取，只测三条手写提案），拿到的**真实** `result.rejected` 数组，喂给真实（未 mock）的 `filterLegacyApplyFailureProposals()`（`server/src/services/novel/runtime/ChapterArtifactDeltaService.js` 编译产物）。

### 断言

- `result.rejected.length === 2`（两条都进了 rejected，混在一起）。
- `filterLegacyApplyFailureProposals(result.rejected).length === 1`，且过滤剩下的那条 note 前缀是 `legacy_apply_failed:character_state_update:character_not_found:`。
- 空 summary 那条的 note 里含 `"missing summary"`（普通文案，不带 `legacy_apply_failed:` 前缀）,证明它没有被误判。
- 合法提案真实写入了 `currentState`/`currentGoal`。

### 与既有测试的差异、以及仍未覆盖的部分

`server/tests/chapterRuntimeCoordinator.test.js:254-273` 的 `"chapter artifact delta warnings only include legacy apply failures"` 是纯函数单测：手写一个两条目的 `rejected` 数组（`validationNotes` 是硬编码字符串）直接喂给 `filterLegacyApplyFailureProposals`。它证明了过滤函数本身逻辑对,但如果 `StateCommitService` 未来改了 note 格式（比如去掉某个字段、换了分隔符),这条纯函数单测不会报错——因为它的输入从来不是真实产出的。新增的组合测试把这段接缝也测了进去。

**仍未覆盖：** `ChapterArtifactDeltaService.ts:411-422` 那段真正调用 `console.warn` 的代码本身（10 行,判断 `legacyApplyFailures.length > 0` 才 warn）。要把它纳入组合测试,需要构造一个完整、真实的章节生成 `output` 对象（`syncPlan`、`characterResourceDeltas` 等,该文件共 1096 行,此前没有任何测试用真实数据驱动过这条落库路径)。在无法编译/运行来迭代验证的情况下,盲写这一层风险较高,权衡后没有做——现有的纯函数单测 + 这次的真实 `rejected` 数组来源验证,合起来已经覆盖了 warn 逻辑两侧的输入正确性,只是没有端到端连起来。如果需要补这一层,建议交给能实际跑测试的环境（Codex 或用户本机）在确认前两层通过后再评估是否值得。

---

## 3. `beta` 工作区清洁性

两个新脚本都复用 `changeProposalRealSqlite.test.js` 已验证过的模式：临时数据库建在 `server/.tmp/<随机名>/` 下，`finally` 块里 `fs.rmSync(..., { recursive: true, force: true })` 清理。真实执行后 `git status --short` 只显示预期的测试 fixture 修正和本报告回填，没有 `.tmp` 或 SQLite 文件残留。

---

## 4. Codex 执行记录与复现说明

### 执行结果（2026-08-24）

```text
✔ dirty legacy pending-review item produces rejectedCount + medium ledger event on real SQLite
✔ routine validation rejection is excluded from the real apply-failure filter output; legacy apply rejection is kept
tests 2, pass 2, fail 0
```

完整 `pnpm --filter @ai-novel/server test:integration` 已实际启动并完成 shared/server 编译，但全套命令仍因既有基线问题退出 1，包括未迁移默认测试库、prompt governance 既有差异，以及 Windows Node 24 直接 `spawnSync pnpm.cmd` 的 `EINVAL`。因此本报告只声明两个新增组合 smoke 通过，不声明全量 integration 基线通过。

### 编写时为何交由 Codex 执行

编写这两个测试的环境没有任何 Node.js 运行时，重新确认过：

- `node` / `pnpm` / `npm` 在 Git Bash 和 PowerShell 里都是 command not found。
- `C:\Program Files\nodejs`、`%LOCALAPPDATA%\Programs\nodejs`、`%APPDATA%\npm`、`.volta`、`nvm` 等常见安装位置都不存在。
- 仓库根目录和 `desktop/` 下有 `node_modules`（说明曾在某处装过依赖），但整个仓库树里搜不到任何 `node.exe`，`desktop/node_modules/electron` 也只有包元数据，没有 Electron 二进制。
- `.github/workflows/` 里只有桌面发布和 site-pages 两条流水线，没有跑测试套件的 CI。

因此在 `1e79966` 提交时，这两个测试只有静态代码走查支撑；本节前面的 2026-08-24 执行结果补齐了这项验证缺口。

### 要跑的命令

```bash
pnpm --filter @ai-novel/server test:integration
```

这会先 build shared/server，再跑 `node scripts/run-tests.cjs integration`，覆盖这次新增的两个文件加上其余 10 个已登记的 integration 测试。

只想单独看这两个新文件（需先跑过一次 `pnpm --filter @ai-novel/server build` 让 `dist/` 最新）：

```bash
node --test server/tests/pendingReviewAutoPromotionRealSqlite.test.js server/tests/stateCommitApplyFailureFilterRealSqlite.test.js
```

### 失败时的处理原则

首次执行时测试本身也可能存在装配错误，因此失败时先判断是哪一类：

1. **测试写错**（断言的数字/字符串与真实产出不符、`dist/` 导出路径不对、Prisma 字段名不对）→ 直接改测试，改动记进本文件第 0 节。
2. **实现真的有问题**（`beta@36f4583` 的观测性加固在组合场景下不成立）→ **不要**改测试去迁就实现。按 `AGENT_COLLABORATION_GUIDE.md` §10 收集日志、定位层级、开 issue，并回报给 Claude Code 复评——这正是这两项组合验证存在的意义。

区分方法：单点测试（`pendingReviewAutoPromotionService.test.js`、`chapterRuntimeCoordinator.test.js`）此前是通过的，如果它们仍通过而只有新的组合测试失败，那大概率是第 2 类——mock 边界两侧的契约对不上。

### 回报格式

跑完请把结果填进本文件第 0 节的表格，并附：通过/失败、失败用例的具体断言差异、`git status --short` 的输出（验证第 3 节的工作区清洁性）。

---

## 5. 对 Phase 1 封板的建议

封板条件“两项组合验证通过”已经满足。Phase 1 的 Proposal Core、Proposal UI 与 state apply observability 在代码和数据链路层面可以正式封板。驾驶舱最终视觉呈现仍按仓库规则由用户目视确认，不改变本次数据层组合验证结论。

第三项"驾驶舱提示"按仓库 `AGENTS.md` 的 Verification Reuse Rules（"UI-facing…do not run browser/visual verification by default; the user will perform UI acceptance testing"）本就不该自动化——组合验证一已经在数据层证明了喂给驾驶舱投影（`DirectorBookAutomationProjectionService.ts:464`）的 `severity` / `summary` 字段是对的，且投影代码本身这次分支没有改动、已在 `CODE_REVIEW_STATE_APPLY_OBSERVABILITY.md` L2 走查过。剩下的"眼见为实"——AI 驾驶舱时间线上真的出现这条醒目提示——由用户跑起来后手动确认。

---

## 6. 封板之后：Phase 2 的正确入口

按 2026-08-24 的口径更正（见 `05_ROADMAP_AND_ACCEPTANCE.md`），**Phase 2 是 Outline Workflow**，不是"Proposal 后续接线批次"。Phase 1 遗留的接线项分属其子阶段：

- **Phase 2A — Proposal Runtime Bridge**：AI 提案生产者通用接线、`DirectorPolicyEngine` 门禁、L0–L3 → `DirectorPolicyMode` 映射。是 2B 的基础设施前置，范围限于 Outline Proposal 所需的最小能力。Proposal UI 评审遗留的 L6 / L7 也在此一并清理。
- **Phase 2B — Outline Workflow MVP**：Phase 2 产品主线，验收条件即 Roadmap 原文。
- **Phase 2C — Chapter Execution Divergence**：Chapter Execution Proposal 生产者、Expected vs Actual、正文偏离分流。

封板后的下一份实施计划应命名为 **`IMPLEMENTATION_PLAN_OUTLINE_WORKFLOW.md`**，覆盖 2A → 2B，而不是一份泛化的「Proposal Phase 2 计划」。

`fix/desktop-managed-server-spawn` 与 Proposal 生产链路没有交集，可并行或稍后处理，不阻塞上述任何一步。
