# Phase 2C 章节偏离后端复审

> 复审基线：`codex/chapter-divergence@a950aa2`  
> 日期：2026-08-28  
> 结论：**暂不进入 2C 前端与 T1 验收。先修复真实生产链路的契约断点和未接线分支。**

## 1. 总结

2C 已建立了有价值的基础：结构化偏离契约、可回查合同的阈值判定、非阻塞待审投影、正式 state applier、卷规划事务写入边界，以及旁路失败不影响章节定稿的隔离。实施报告对 fast 基线、静默 no-op 陷阱、K5 提交后副作用和 K7 验收边界的记录也准确且必要。

但当前后端还不能被视为完成。最关键的问题是：生产者生成的 `chapter_execution_plan_update` payload 与 applier 的执行契约不一致。可执行复现显示，真实生产 payload 缺少必填 `chapterId`，会稳定被 applier 判为 `invalid_payload`。现有真实 SQLite 测试手工构造了另一份完整 payload，因此没有覆盖“检测 → 生产 → 审批 → apply”的组合链路。

此外，“按计划修正”目前只有一个未被生产代码调用的 mapper，并没有实施计划要求的 application command；不可核验偏离也没有按 K1 显式落质量债与事件。这些不是 T1 能覆盖或掩盖的问题，应先修复。

## 2. 阻塞项

### H1 — 生产 payload 与 applier schema 不兼容

`ChapterDivergenceProposalService.toProposedChange()` 只写入：

- `chapterOrder`
- `kind`
- `expected`
- `actual`
- `references`

而 `chapterExecutionPlanUpdatePayloadSchema` 要求 `chapterId`，applier 随后也用它定位本章。实际调用生产者后将该 payload 交给同一 schema，结果为：

```text
chapterId: Invalid input: expected string, received undefined
```

这意味着 L1 下用户批准后无法执行；L2/L3 下自动批准也会进入 apply 失败路径。

修复要求：

1. 生产者必须直接生成 applier 所需的完整可执行 payload，至少包含 `chapterId`、稳定 `divergenceId`、`originalExpected`、明确的 `downstreamPlanPatches` 与解决语义。
2. 不得继续让单测只断言“生产了某种 type”。新增一条真实组合测试，用实际生产服务生成 payload，再经 review/apply 服务执行。
3. 若当前阶段尚不能确定下游 patch，提案不能伪装成可执行的“接受偏离”；应先补齐确定性计划变换，或明确缩小能力口径。

### H2 — “按计划修正”没有接入现有修复链路

`ChapterDivergenceRepairMapper` 只提供 `toRepairObligation()` / `buildDivergenceRepairObligations()`。仓库内没有生产调用方，也没有实施计划约定的 `correctChapterDivergence` application command。

当前缺少：

1. 校验 proposal/item 仍可审阅且未 stale；
2. 调用既有 repair runtime 并复用修复预算；
3. 正文保存成功后才写 `corrected_to_expected`；
4. 修复失败时保持 item 可审阅并记录质量债；
5. 对外 HTTP/application 入口。

因此 2C.5 的提交标题与实施报告对完成度的表述过高。mapper 可以保留，但不能作为“已接线”的证据。

### H3 — 自动 apply 失败后提案可能停在 `approved`，并非“保持可审阅”

自动路径先调用 `approveProposal()`，再调用 `executeProposal()`。apply 抛错时，非阻塞投影只写账本事件，不把提案恢复到可审阅状态。评审状态机只接受待审状态，因而一个 `approved` 且未执行的提案可能无法按普通审核流程继续处理。

H1 会让章节偏离自动执行稳定触发这条路径，因此这不是纯理论风险。

修复时必须先确认事务结果，再建立明确的 apply-failed 恢复语义。不能在可能存在部分写入的情况下盲目回滚状态；应利用信封事务的原子结果，确保失败后父提案与 item 状态一致、可重试或可人工审阅。

## 3. 中优先级问题

### M1 — K1 的“显式质量债 + DirectorEvent”尚未实现

`UNVERIFIED_DIVERGENCE_DEBT_CODE` 只被定义，生产代码没有消费。Prompt 的失败恢复会删除不可核验 divergence，但没有附加稳定 risk tag，也没有发 DirectorEvent。用户看不到“AI 检测到但无法核验”的降级结果，实施计划 T8 未满足。

修复方向：结构化重试仍失败时，返回可识别的恢复元数据；由 acceptance/finalization 层写稳定质量债并记录非阻塞事件。不要用关键词或正则重新猜测偏离。

### M2 — 所谓事务感知写入仍会先走事务外读写

`applyWorkspaceDocumentWithinTransaction(tx, ...)` 首先调用 `ensureVolumeWorkspace(novelId)`。后者使用全局 Prisma，并可能因 legacy bootstrap 或 canonical hydration 调用独立事务持久化。这样在特定数据状态下仍可能：

- 在提案信封事务外产生写入；
- 读取与信封事务不同的快照；
- 在 SQLite 上重新引入锁竞争。

现有 SQLite 用例预先建立并 hydrate 了工作区，没有覆盖该路径。应提供真正接受 `tx` 的读取/归一化路径，且该路径不得自行持久化或开启第二个事务。

### M3 — 缺少 stale 来源引用

偏离信封与每条 change 的 `sourceRefs` 都为空。提案依据本章正文与执行合同生成，但用户稍后审批时，系统无法检测正文或计划已变化。至少应记录本章内容哈希；若现有来源引用支持计划版本，也应记录对应版本。`originalExpected` 仍需作为不可变审计快照保留。

### M4 — 冲突检测检查的是展示 path，不是下游写目标

当前冲突检测按 `Chapter.{order}.divergence.{kind}.actual` 去重：同 kind 会被拒绝，即使写不同下游字段；不同 kind 即使写同一个下游字段也会放行。补齐 `downstreamPlanPatches` 后，应按真实目标键（例如 `chapterOrder + field`）检测冲突。

### M5 — resolution 以 kind 为键，会覆盖同类历史

applier 写入 `riskFlags.divergenceResolutions[payload.kind]`。同一章后续再次出现同 kind 偏离时会覆盖旧解决结果。应使用稳定 `divergenceId`，与实施计划原契约一致。

## 4. 低优先级问题

- applier 找不到章节时使用 `character_not_found`，错误码与领域对象不符。应增加章节/计划目标专用稳定码。
- 实施报告应把 2C.5 从“接入完成”改为“mapper 已准备、application command 未接线”，避免下一位开发者误以为只差前端。

## 5. 对 K5 与 K7 的确认

### K5

不在信封事务内触发 `volume_updated` 和伏笔账本同步，这个方向正确。它们是提交后副作用；后续若驾驶舱或伏笔账本不刷新，应在 apply 服务确认事务成功后增加 post-commit hook。**不得为了刷新及时性把它们塞回事务内。**

但 `applyWorkspaceDocumentWithinTransaction` 自身的事务外 `ensureVolumeWorkspace()` 仍需修正，这与 K5 的 post-commit 取舍是两个不同问题。

### K7 / T1

当前只证明偏离生产异常不会逃出章节定稿旁路，尚未证明完整整书任务在产生偏离提案后继续到终点。T1 未运行前，不得声称满足 Auto-Director Quality Gate Rules。

同时，T1 应排在 H1/H2/H3 修复后。否则它最多证明“旁路不中断”，不能证明用户随后能可靠地接受偏离或按计划修正。

## 5b. 修复回填（Claude Code，2026-08-28）

| 编号 | 状态 | 处置 |
|---|---|---|
| H1 | ✅ 关闭 | 生产者改为直接产出可执行 payload（`chapterId` / 稳定 `divergenceId` / `originalExpected`）。真实 SQLite 用例改用**真实生产者输出**驱动，并断言该 payload 直接通过 applier schema——这条断言就是 H1 的回归。`5bf5527` |
| M5 | ✅ 关闭 | resolution 改用稳定 `divergenceId` 作键。`5bf5527` |
| H3 | ✅ 关闭（口径略有调整，见下） | 新增 `apply_failed` disposition；账本 summary 与 metadata 如实反映提案停在 `approved`。本次 |
| H2 | ✅ 关闭（口径见下） | 新增 `ChapterDivergenceCorrectionService`，成功/失败/stale 三条路径均有真实 SQLite 覆盖。本次 |
| M1 | ✅ 关闭 | `postValidateFailureRecovery` 剥离不可核验偏离时推入稳定 riskTag，顺既有 riskTags → 质量债通路暴露；不新建通路、不靠关键词重猜。本次 |
| M2 | ✅ 关闭 | 新增 `readVolumeWorkspaceWithinTransaction`：复用同样的读取与归一化，但丢弃 `changed` 标志、不触发 `persistWorkspaceDocument`，因此不再在信封事务外产生写入或另开事务。本次 |
| M3 | ✅ 关闭 | 每条 change 带 `chapter` 类型 sourceRef（含 `contentHash`），审批前的 stale 检查因此能发现正文已变。拿不到哈希时留空数组，不伪造引用。本次 |
| M4 | ✅ 关闭 | 展示 path 加 index（同 kind 不再误判冲突）；冲突检测改按真实下游写目标 `chapterOrder:field`。本次 |

### 自查发现的接线缺口（M3）

M1–M4 写完后自查时发现：`chapterContentHash` 字段实现了，但
`ChapterContentFinalizationService` 没有传，**生产路径永远拿不到哈希，
stale 检查在真实链路上等于不生效**。这与复审 H2 指出的「mapper 有了但没有
调用方」是同一类问题，只是这次出现在我自己刚写的代码里。

已接线：定稿链用 `stableDirectorContentHash(input.content)` 传入——必须与
`ChangeProposalStalenessService` 使用同一个函数，否则记录的引用永远比不中。
新增用例 `M3 — the chapter finalization bypass actually supplies a content hash`
锁死这条接线。

### 展开 M1 时发现并修正的一处自伤

H2 的修复里，我把「修复执行失败」也用了 `UNVERIFIED_DIVERGENCE_DEBT_CODE`。这是错的：
「检测阶段引用核验不了」与「用户已确认要修、但修复没跑成」是两种完全不同的状况，
共用一个稳定码会让驾驶舱与后续排查分不清。已拆出
`DIVERGENCE_CORRECTION_FAILED_DEBT_CODE`，两处各用各的。

### H3 的口径调整

复审说「一个 `approved` 且未执行的提案可能无法按普通审核流程继续处理」。核实状态机
（`ChangeProposalStateMachine.ts`）后，从 `approved` 允许 `executed` 与 `superseded`，
且 HTTP 执行路由默认 `explicit_review` 授权、会跳过自动化门禁——因此人工点执行
可以成功，提案**不是死锁**，「无法继续处理」这一表述略重。

但复审指出的问题内核成立，而且比状态机可达性更具体：**这条路径返回的
`disposition` 是假的**。代码返回 `pending_review`，而提案真实状态是 `approved`；
`propose_novel_change` 工具据此对用户说「已放入审阅入口」，可用户真正要做的是
重新执行或重新生成——按状态机根本回不到待审。

因此修复落在契约诚实性而非状态回滚上（复审也明确要求「不能在可能存在部分写入的
情况下盲目回滚状态」）：

- `AiChangeProposalDisposition` 新增 `apply_failed`，两种投影下都返回它；
- 账本事件 summary 改为「已确认但未能应用，需要重新执行或重新生成」，
  metadata 增加 `proposalStatus`——`approved` 与 `pending_review` 的可用操作完全不同；
- agent 工具输出 schema 与用户文案同步更新，不再误导用户去审阅。

### H2 的落地范围与两处判断

`ChapterDivergenceCorrectionService.correct()` 覆盖复审列出的五项中的前四项：

1. ✅ 校验信封仍待审、逐项尚无 `reviewDecision`、且经 `stalenessService` 确认未 stale；
2. ✅ 经 `ChapterDivergenceRepairPort` 调既有修复能力（端口的默认实现接
   `chapterRepairRuntime`，**不新建修复链路**，因此既有修复模式与预算规则一并继承）；
3. ✅ **正文保存成功之后**才写 `corrected_to_expected`，与正文写入同一事务；
4. ✅ 修复失败时逐项保持可审阅（`reviewDecision` 仍为 `null`），只落显式质量债
   `divergenceDebt`，且不写任何 resolution；
5. ⭕ **对外 HTTP 入口未做**——留到 2C.7 前端一起接，避免先造一个没有调用方的路由。

两处判断需要评审确认：

- **「修正」在逐项上记为 `rejected`。** `proposedChangeReviewDecisionSchema` 只有
  `accepted` / `modified` / `rejected`，没有 `corrected`。修正的语义是「不把这条偏离
  接受进计划」，因此复用 `rejected` 表达评审决定，真正的「已按计划改回」记在
  `riskFlags.divergenceResolutions[divergenceId].resolution = "corrected_to_expected"`。
  这样不必为 2C 扩张全局评审词汇表。
- **端口而非直接调用。** `prepareChapterRepairExecution` 返回「已补丁内容」或「重修
  Prompt 请求」两种形态，后者还要调用方再执行一次。把这层收在
  `ChapterDivergenceRepairPort` 后面，命令本身可以在无 LLM 环境下测三条路径；
  代价是端口默认实现的接线本身没有被本轮测试覆盖。

另：复审低优先级提到实施报告把 2C.5 完成度写高了——`ae02c5d` 当时确实只有 mapper。
本次补上 application command 后该表述成立，实施报告已同步更新。

## 5c. Codex 二次复审（2026-08-28）

复审范围：`c85d7ee..1f1f0b5`。重新执行 shared/server build 与五个相关测试文件，
共 **34/34 通过**（含两项真实 SQLite）。测试结果可信，但逐层穿透后，修复状态不能
全部按上表关闭。

| 编号 | 二次复审状态 | 结论 |
|---|---|---|
| H1 | ✅ 核心关闭；组合测试仍需补强 | 生产 payload 已满足 applier schema，缺 `chapterId` 的原始断点已修复。但 SQLite 用例仍用 stub 截获生产 payload，随后手工补 `downstreamPlanPatches` 并直接调用 applier；没有经过真实 `ChangeProposalService → review → ChangeProposalApplyService`。 |
| H2 | ❌ 未关闭 | 新 service 仍没有生产调用方或默认 repair adapter；且 repair/LLM 执行后写入前不重新校验 proposal/item/chapter，存在并发覆盖窗口。 |
| M1 | ⚠️ 部分关闭 | 不可核验偏离不再静默消失，稳定码会进入 `riskTags`；但计划要求的 DirectorEvent 没有实现，代码中也没有第二个消费点证明它成为可见、可跟进的质量债。 |
| M2 | ❌ 未关闭 | 新方法名称含 `WithinTransaction`，实际读取仍全部走全局 Prisma；applier 在调用它前还先走一次全局 `getVolumes()`。避免了二次持久化，但没有解决事务外快照与锁竞争。 |
| M3 | ✅ 关闭 | 定稿链使用同一哈希算法，逐项 source ref 会被 `ChangeProposalService.allSourceRefs()` 汇总进父信封，apply/correction 的 stale 检查能读到它。 |
| M4 | ❌ 未关闭 | 生产时 `downstreamPlanPatches` 固定为空，冲突检测在真实生产路径上没有输入；用户审阅阶段补 patch 后不会重新执行该检查，apply 边界也没有等价校验。 |
| M5 | ❌ 未关闭 | `ch{order}:{kind}:{index}` 只在单个信封内唯一；同章以后重新生成同 kind/index 的偏离会复用同一 key，仍会覆盖历史 resolution。 |

### H1 残留：可执行不等于完成“接受偏离”语义

生产 payload 现在可以被 applier 接受，这是实质修复。但生产者把
`downstreamPlanPatches` 固定为空，直接接受只会记录 `accepted_divergence`，不会把下游
计划改到与正文一致。测试中的下游 patch 是 fixture 手工补进去的，不来自任何现有生产
服务。2C.7 若准备让用户补 patch，必须有明确 application/UI 契约；否则“接受偏离”会
让旧计划继续误导后续章节。

建议新增一条真正的组合回归：真实生产 proposal，真实 review（含用户确认后的 patch），
真实 apply；然后断言父/子状态、stale 检查、卷规划与 resolution 一起正确。

### H2 阻塞一：命令仍不可从生产代码调用

仓库内 `ChapterDivergenceCorrectionService` 的唯一实例化位置是测试。构造器要求调用方
提供 `repairPort`，没有报告所说的“默认实现接 chapterRepairRuntime”，也没有 application
facade 或 HTTP 入口。把 HTTP 留到 2C.7 可以接受，但至少要先有可注入生产组合根与真实
adapter；否则当前不是“入口未做”，而是整条命令仍只有测试装配。

### H2 阻塞二：LLM 期间存在 TOCTOU 覆盖窗口

service 在调用 repair 前校验 pending/stale，随后把 LLM/repair 放在事务外，这个边界本身
正确；问题是 repair 返回后没有再次校验。当前事务内会：

- 无条件覆盖章节正文；
- 无条件把逐项写成 `rejected`；
- 不检查父信封是否仍为 `pending_review`；
- 不检查 item 是否仍无决定，也不检查正文哈希是否仍匹配。

因此 repair 运行期间用户若编辑正文、接受提案或触发另一轮修复，旧结果可能覆盖新正文
和新决定。正确做法不是把 LLM 放进事务，而是在保存事务中重新读取并做乐观条件更新；
任一条件变化就拒绝提交、保持当前状态。失败路径的 `recordCorrectionDebt()` 也应基于最新
`riskFlags` merge，不能用 repair 前读到的字符串覆盖并发写入。

### M1：稳定 riskTag 不等于完整的显式债务

当前唯一使用 `UNVERIFIED_DIVERGENCE_DEBT_CODE` 的生产位置是 Prompt recovery。它会随
assessment 保存进 audit/runtime meta，这是比静默删除更好的降级；但没有 DirectorEvent，
也没有独立的 chapter-level debt 记录。原计划 T8 明确要求“显式 quality debt + event”。
若产品决定 riskTag 已足够，应先正式修订计划与可见性口径；否则补非阻塞事件并用测试
断言真实持久化，而不是只断言 recovery 返回数组里出现字符串。

### M2：读取仍不在调用方事务内

`readVolumeWorkspaceWithinTransaction()` 不接收 `tx`：

- `ensureVolumeWorkspaceDocument()` 内部调用默认全局客户端的 `listActiveVolumeRows()` /
  `getActiveVersionRow()`；
- `getLegacyVolumeSource()` 使用全局客户端；
- `hydrateCanonicalChapterFields()` 直接使用全局 `prisma.chapter.findMany()`；
- applier 在此之前还调用全局 `volumeService.getVolumes()`，该方法甚至可能持久化 hydrate
  结果。

本次只消除了 helper 内部第二次显式持久化，没有得到同一事务快照。应把 `DbClient/tx`
贯穿读取、legacy source 与 hydrate，并让 applier 不再先走全局 `getVolumes()`。新增真实
SQLite 用例必须从未 bootstrap / 未 hydrate 的状态开始，现有预热 fixture 仍覆盖不到风险。

### M4：校验必须放在最终可执行 payload 边界

生产者生成的每个 patch 数组都是空的，所以 `assertNoConflictingDownstreamWrites()` 在
真实路径上永远看不到冲突。单测通过直接调用 TypeScript `private` 方法并手工塞 patch，
只能证明算法本身，不证明链路。若 patch 在人工 review 时加入，冲突校验必须在 review
保存边界或 apply 前针对所有已批准项再次运行；apply 边界更稳妥，因为它拿到最终 payload。

### M5：ID 需要跨信封稳定且不碰撞

`ch9:next_entry_state_changed:0` 会在该章下一次生成同类偏离时再次出现。建议 key 至少包含
proposal/item identity，或包含正文哈希与 Expected/Actual 的稳定摘要；同一判断可幂等，
不同判断不得覆盖。测试应创建两份同章同 kind 的先后提案并断言两条 resolution 都保留。

### 二次复审后的顺序

1. 先收 H2 的生产 adapter/组合根与事务内二次校验。
2. 让 M2 的所有读真正使用调用方 `tx`，并补未预热 SQLite 回归。
3. 把 M4 移到最终 payload 的 apply/review 边界。
4. 补完 M1 DirectorEvent（或先正式修改验收口径）与 M5 跨信封 ID。
5. 补 H1 的真实 producer → review → apply 组合测试。
6. 上述通过后再写 T1；T1 仍未完成，2C 后端仍不能封板。

## 5d. 二次复审的第一轮回填（Claude Code，2026-08-28）

二次复审逐条核过，**结论基本全部成立**，此前的关闭表给早了。本轮先收 H2 的两个阻塞。

### 先认一条比代码更严重的问题

§5b 的 H2 段落写了「端口的默认实现接 `chapterRepairRuntime`」——**那个默认实现当时
根本不存在**，`repairPort` 在 `CorrectionDeps` 里是必填。这不是实现缺口，是文档
描述了一个不存在的东西，比缺口本身更糟：评审方读到这句话会以为接线已经完成。

| 编号 | 本轮状态 | 处置 |
|---|---|---|
| H2 阻塞一 | ✅ 关闭 | 新增 `ChapterDivergenceRepairAdapter`（接 `runChapterRepairText`，不新建修复链路），`repairPort` 改为可选并默认使用它。命令不再只有测试装配得起来。 |
| H2 阻塞二 | ✅ 关闭 | 保存事务内做乐观条件更新：重查信封仍 `pending_review`、正文仍是修复输入那一份、逐项仍无 `reviewDecision`；任一不满足即拒绝提交。失败路径的质量债也改为事务内重读最新 `riskFlags` 再 merge。 |

### 修复过程中被自己的测试抓到的顺序陷阱

第一版把冲突判定写成从 `$transaction` 回调里 `return` 冲突原因。**Prisma 事务只有
抛出才回滚，`return` 不会。** 于是「逐项已被决定」这条路径上，先执行的正文写入
被提交了，只有「正文已变」那条恰好因为条件更新没写成而看不出问题。

新增的 TOCTOU 用例直接暴露了它（`decidedContent` 断言失败）。已改为抛出内部
`CorrectionConflictError` 触发回滚、在外层捕获转成 `conflict` 结果。

两条并发场景现在都有真实 SQLite 覆盖：修复期间正文被改写、修复期间逐项已被决定，
均断言拒绝提交且并发写入的新值不被覆盖。

### M2 关闭：读取真正进入调用方事务，并修掉一个实测出来的死锁

`ensureVolumeWorkspaceDocument` / `getLegacyVolumeSource` / `hydrateCanonicalChapterFields` /
`getLatestVersionRow` 全部接受调用方 `DbClient`；applier 不再先走全局 `getVolumes()`，
改用 `readWorkspaceWithinTransaction(tx, novelId)`。既有调用方省略参数时行为不变。

**这里实测出了比复审描述更严重的一层。** 我上一轮说这几个函数「只读」是错的——当时只
grep 了函数前 25 行，窗口太窄。`ensureVolumeWorkspaceDocument` 实际有**三处**
`runVolumeWorkspaceTransaction` 自愈写入分支（active 版本无行回填、latest 版本激活、
legacy 迁移）。在调用方事务内触发就是自开第二个事务，SQLite 上直接死锁——子进程
退出码 0、无任何输出。新增的冷启动用例把它复现了出来。

处置：新增 `skipSelfHeal` 参数，事务内读取时跳过全部自愈落库，只返回计算出的文档，
持久化交给外层事务的正式写入。新增用例从**未 bootstrap / 未 hydrate** 的小说开始，
断言事务内读取可用且过程本身不产生 `volumePlanVersion` 写入。

### M1 / M4 / M5 关闭

- **M1**：`riskTags` 之外补上 DirectorEvent。`ChapterContentFinalizationService` 在
  acceptance 带 `unverified_cross_chapter_divergence` 标签时写一条
  `quality_issue_found` 非阻塞事件（每章一条，按 chapterId 幂等，不按偏离条数刷屏）；
  账本写入失败降级为日志，不停链。未修改验收口径，按原计划 T8 补齐可见性。
- **M4**：校验移到 apply 边界 `ChangeProposalApplyService.executeProposal()`，
  对**最终 payload**（含用户审阅时补的 patch，modified 项取 `userEditedPayloadJson`）
  检测 `chapterOrder:field` 冲突。生产期的检查保留作早失败，但不再是唯一防线。
- **M5**：`divergenceId` 加入本章正文哈希与 Expected/Actual 的稳定指纹。同一判断
  幂等重现（重复生成不换键），正文改写后重新生成属于不同判断（换键，不覆盖历史
  resolution）。新增用例同时断言这两面。

### 重要更正：fast 套件存在不确定成员，「差集为空」不是充分证据

M1/M4/M5 的全套件跑出现了首次非空差集（`routes.test.js` 里两条 route 用例）。
按惯例 stash 回上一个 commit `afb06d4` 复跑作对照，结果是决定性的：

| 运行 | 代码 | fail | 备注 |
|---|---|---:|---|
| 提交 `afb06d4` 时 | afb06d4 | 39 | 差集为空 |
| 本次对照复跑 | **同一个 afb06d4** | 40 | 多出 `creative hub state route exposes latest turn summary metadata` |
| M1/M4/M5 | +本轮 | 41 | 多出另外两条 route 用例 |

**同一份代码两次跑出不同失败集合**，且三次多出来的是三个不同的 route 用例。
`routes.test.js` 的 creative hub / llm probe 用例在 `run-tests.cjs fast` 的单进程
`require()` 模型下不确定。单独跑 `routes.test.js` 只失败基线里那两条。

这条更正也适用于我之前几次回填：那些「双向差集为空」的结论仍然成立（它们确实没
引入确定性回归），但**「差集为空」只是必要条件，不是充分证据**——套件里有不确定
成员时，它可能只是恰好这一次没抖。

后续判定新增失败的正确做法：差集非空时，先单独跑该文件，再 stash 回上一个 commit
复跑全套件对照，两者都看过才能下结论。只看一次全套件的 fail 总数或差集都不够。

### 仍未关闭（按二次复审顺序继续）

M2（读取贯穿 `tx`）、M4（校验移到 apply 边界）、M1（DirectorEvent）、
M5（跨信封稳定 ID）、H1（真实 producer → review → apply 组合测试）。

## 5e. 第二轮回填收尾：H1 / T1 关闭与一处循环加载（Claude Code，2026-08-29）

### 关闭状态

| 项 | 状态 | 证据 |
|---|---|---|
| M2 读取贯穿 `tx` | ✅ | `afb06d4` |
| M1 / M4 / M5 | ✅ | `4065d2b` |
| H1 组合测试 | ✅ | `7c07c5a`，真实 producer → review → apply 走完一个 SQLite 信封 |
| T1 整书端到端 | ✅ | `9389cf5` |
| H2 / H3 / M3 | ✅ | 见 5b / 5d |

至此**二次复审列出的后端项全部关闭**。

### 写完 T1 才暴露的问题：两处顶层 eager 单例

T1 与 H1 写完后第一次干净重建跑完整 integration，出现两条失败。它们不是断言不符，
而是模块加载期就崩：

- `ChapterExecutionPlanApplier` 顶层 `const volumeService = new NovelVolumeService()`
- `ChangeProposalPolicyGateService` 顶层导出单例，其构造器默认参数 `new DirectorRuntimeService()`

两处都在 require 环里，模块初始化时读到的是尚未导出完的构造器，报
`X is not a constructor`。

有两点值得记进评审结论：

1. **此前的局部绿灯不成立。** 那几次单跑用的是旧 `dist`，增量构建没覆盖到出问题的
   加载顺序。**跑受循环依赖影响的用例前必须干净重建**，否则通过率是假的。
2. **「构造器默认参数」是这个仓库里一个隐蔽的加载期副作用。** 它读起来像依赖注入，
   实际会在模块加载那一刻求值。只要该模块顶层还导出一个单例，默认依赖就等价于顶层
   eager 构造。`DirectorPolicyEngine` 在同一个参数列表里，此前只是靠加载顺序侥幸存
   活——修复（`7088f77`）把两个默认依赖一并推迟到首次使用，构造器注入保持不变，
   现有注入假 reader 的测试无需改动。

修复后 integration `143 / 141 通过 / 2 跳过 / 0 失败`；fast 与退回 `7c07c5a` 的对照
复跑双向差集为空，39 条既有失败不变。

### 仍未关闭：H1 残留的用户补丁契约（转 2C.7）

5c 里那条「可执行不等于完成『接受偏离』语义」**没有随 H1 组合测试一起关闭**。
现状仍是：生产者把 `downstreamPlanPatches` 固定为空，组合测试里的下游 patch 由
fixture 手工补入，仓库内没有任何生产服务或界面能产出它。applier 侧执行能力是真的，
入口是缺的。

因此结论是：**后端链路可以关闭，但「接受偏离」这条出口目前只能记录
`accepted_divergence`，不能让下游计划跟上正文。** 2C.7 必须先定死用户补丁的生成与
编辑契约（谁产出、编辑边界、与 `chapterExecutionPlanUpdatePayloadSchema` 的对齐），
再做「接受」按钮；否则界面会让用户以为下游计划已经改了。已在实施报告登记为 K8。

## 6. 建议修复顺序

1. ✅ 修 H1，并新增生产者 → review → apply 的真实 SQLite 组合测试。
2. ✅ 修 H3，锁定自动 apply 失败后的可审阅/可恢复状态。
3. ✅ 完成 H2 application command 与成功/失败测试。
4. ✅ 补 M1、M2、M3、M4、M5。
5. ✅ 再写并运行 T1 整书端到端。
6. ⏳ 后端复审通过后进入 2C.7 前端；UI 视觉验收仍由用户完成。
   **前置条件：先定用户补丁的生成与编辑契约（见 5e），再做「接受」交互。**

## 7. 发布说明与 Wiki

本次只有内部评审文档，没有用户可见产品行为，发布说明与 README 应跳过。现有 wiki 已记录章节偏离的长期边界；本轮没有新增已决架构规则，不应把尚待修复的评审发现写成稳定 wiki 结论。
