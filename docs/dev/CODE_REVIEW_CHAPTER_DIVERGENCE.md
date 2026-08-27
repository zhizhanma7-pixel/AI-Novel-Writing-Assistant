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

## 6. 建议修复顺序

1. 修 H1，并新增生产者 → review → apply 的真实 SQLite 组合测试。
2. 修 H3，锁定自动 apply 失败后的可审阅/可恢复状态。
3. 完成 H2 application command 与成功/失败测试。
4. 补 M1、M2、M3、M4、M5。
5. 再写并运行 T1 整书端到端。
6. 后端复审通过后进入 2C.7 前端；UI 视觉验收仍由用户完成。

## 7. 发布说明与 Wiki

本次只有内部评审文档，没有用户可见产品行为，发布说明与 README 应跳过。现有 wiki 已记录章节偏离的长期边界；本轮没有新增已决架构规则，不应把尚待修复的评审发现写成稳定 wiki 结论。
