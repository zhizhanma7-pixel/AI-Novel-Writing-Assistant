# Code Review — State Apply Observability

> 评审对象：`fix/state-apply-observability` @ `40b727e fix(state): harden legacy apply observability` + `596bd62 fix(state): narrow apply failure warnings`
> 对照基线：`docs/dev/IMPLEMENTATION_PLAN_STATE_APPLY_OBSERVABILITY.md`（`1b0ac01`）
> 评审人：Claude Code（Reviewer）
> 方式：静态评审 + 测试代码走查。未复跑构建与测试（本机无 node/pnpm），实现侧自述：server build 通过，聚焦测试 38/38（`40b727e` 阶段为 StateCommit + AutoPromotion 24/24、Proposal Core + 真实 SQLite 21/21，`596bd62` 补入章节增量过滤用例）。

---

## 0. 结论

O1、O2 按计划关闭，评审中发现的两项 LOW 已由 `596bd62` 一并关闭。**没有 BLOCKER / HIGH / MEDIUM，无遗留开放项。**

**评审结论：通过，可 `--no-ff` 合并进 `beta`。**

---

## 1. O1 核验 — 通过

| 计划要求 | 结论 |
|---|---|
| 四个抛出点改 typed error + 稳定 reason | ✅ `missing_character_id` / `character_not_found`（`StateProposalApplierRegistry.ts`）、`same_character_relation` / `character_outside_novel`（`characterRelationStateMutation.ts`） |
| 删除消息前缀数组与宽泛 ZodError 判据 | ✅ `LEGACY_APPLY_DOMAIN_ERROR_PREFIXES` 与 `ZodError` import 一并移除，分类收敛为单一 `instanceof` 类型谓词 |
| payload 解析失败在 applier 边界包成 `invalid_payload` | ✅ 两处 `.parse` 改 `.safeParse`，包装时通过 `cause` 保留原始 ZodError，裸 ZodError 不再逃逸 |
| 写下 `25P02` 事务不变量 | ✅ 三处：`StateProposalDomainError` 类 JSDoc + `StateCommitService.ts` 两个 catch 旁；措辞明确到"禁止把失败的 SQL 转换成领域错误" |
| 不再按文案分类的回归守卫 | ✅ 新增用例抛出 `Error("Character state proposal database connection lost")`——旧实现会把它隔离成 rejected，现在断言它严格上抛且没有任何提案行被更新 |

不变量本身也确实成立：`character_not_found` 抛在 `updateMany` **成功返回之后**（按 `count` 判定），`character_outside_novel` 抛在 `count` 成功之后，另两个抛在任何 SQL 之前。没有一处是在失败语句之后转换的。

`legacy_apply_failed:<proposalType>:<reason>:<message>` 的 note 格式比原来多了 reason 段，可检索性提升，且 `proposalType` 改为从 error 取而不是从 proposal 取——两者一致，无副作用。

## 2. O2 核验 — 通过，并额外修正了一处语义

| 计划要求 | 结论 |
|---|---|
| 账本事件带 rejected 计数与截断 ID | ✅ `rejectedCount` + `rejectedItemIds`（上限 50），且只在有拒绝项时才追加字段 |
| summary 中文说明 | ✅ 追加"其中 N 条因数据问题被拒绝。" |
| 有拒绝项时 severity ≥ medium | ✅ |
| 幂等键纳入 rejected，且成功批次键不变 | ✅ `rejected=` 分量仅在 `rejectedCount > 0` 时追加，无拒绝项时键逐字保持原格式 |
| `warnApply` 加计数 | ✅ |
| 章节增量链路也要有告警 | ✅ `ChapterArtifactDeltaService.ts:399` 之后新增 warn |
| 事件类型与既有字段不变（只做加法） | ✅ 仍是 `pending_review_auto_promotion`，既有字段名与结构未动 |

**额外修正（正向）：** `promotedIds` 的语义被纠正了。原实现把"打算提交的"（`preview.promotable`）当作 promoted 写进事件，即使其中部分被拒绝；现在拆成 `promotableIds`（提交入参）与 `promotedIds`（取自 `commitResult.committed`）。于是全拒绝批次的事件是"零 promoted + N rejected"，`affectedScope` 也不会再指向实际没有提交的 id。这不在计划要求内，但让账本从"意图"变成"事实"，是对的。

`pendingReviewAutoPromotionService.test.js` 新增用例把这一组断言钉死了，包括那条我担心的撞键：`book:novel-1:<ts>:none:none:rejected=relation-invalid` 与同时间点的空结果键 `...:none:none` 不同。

---

## 3. LOW（均已由 `596bd62` 关闭）

### L1 — 章节增量链路的新告警把"校验拒绝"和"apply 隔离"混在一起 ✅ 已关闭

**位置：** `server/src/services/novel/runtime/ChapterArtifactDeltaService.ts:402-412`

该处判定条件是 `stateCommitResult.rejected.length > 0`。但 `proposeAndCommit` 走的是 `persistValidated`，那里 `rejectedRows` 有**两个**来源：

- `StateCommitService.ts:457` —— legacy apply 隔离（本次 O2 想要暴露的信号）；
- `StateCommitService.ts:472` —— `validation.rejected`，也就是常规校验拒绝（缺 summary、角色资源校验不过等）。

后者在章节生成里是**routine**：抽取器每章都可能产出若干条不合格 fact。于是这条 warn 会在正常运行中频繁出现，把真正需要注意的 apply 隔离淹掉。

对比自动晋级那边没有这个问题：`commitExistingProposals` 的 `rejected` 只由 legacy 隔离填充，所以账本事件的计数是精确的。

**建议：** 按 `legacy_apply_failed:` note 前缀过滤后再决定是否告警（`proposal.validationNotes.some((note) => note.startsWith("legacy_apply_failed:"))`），或者让 `persistValidated` 在返回值里把两类拒绝分开。

**修复核验（`596bd62`）：** 抽出导出函数 `filterLegacyApplyFailureProposals()`，按 `LEGACY_APPLY_FAILURE_NOTE_PREFIX` 过滤后再判定是否告警，计数与 item id 也都取过滤后的集合。新增用例断言常规校验拒绝（`["missing evidence"]`）被排除、带 `legacy_apply_failed:` note 的项被保留。做成导出的纯函数顺带解决了观察 2 提到的可测性问题。

### L2 — "无用户可见变化"的判断略有偏差，账本 summary 会出现在驾驶舱时间线 ✅ 已关闭

实现报告据此跳过了 README 与发布说明。但 `DirectorEvent.summary` 会经 `DirectorBookAutomationProjectionService.ts:464` 投影成 `DirectorBookAutomationTimelineItem.title`，由 AI 驾驶舱时间线渲染。也就是说：

- "其中 N 条因数据问题被拒绝。" 是**会出现在界面上的新文案**；
- severity 从 `low` 提到 `medium` 会改变该条目的展示权重（`severity` 一并投影到 timeline item）。

文案本身合规（用户视角、说明发生了什么、没有实现叙述、没有"现在 / 不再 / 已经"），所以不是文案问题。只是"纯内部加固、零用户可见变化"这个前提不完全成立。是否补发布说明由你判断——我倾向补一行（比如"自动放行的时间线条目会显示被拒绝的条数"），因为盯着驾驶舱的用户确实会看到新文字和不同的严重度配色。

**修复核验（`596bd62`）：** 发布说明新增 `2026-08-24（状态更新异常提示）` 条目，README「最新更新」同步为该日期条目（按仓库既有约定，README 只保留最新日期，完整历史留在发布说明里，08-23 的 Proposal UI 条目仍在发布说明中）。文案「自动导演处理历史状态变化时，如果个别变化因数据问题未能安全应用，AI 驾驶舱时间线会显示更醒目的提示，其余有效变化仍会继续处理」是用户视角描述，符合 UI Copy Rules，且如实覆盖了"更醒目"（severity 提升）与"其余继续"（隔离语义）两层。

---

## 4. 两条记录性观察（非缺陷）

1. **分类收窄带来的行为变化值得知道。** 现在只有 `StateProposalDomainError` 会被隔离，因此 `characterResourceLedgerService.applyCommittedUpdate` 内部若抛出 ZodError 或其他校验异常，会作为基础设施错误上抛并使整批失败——而旧实现会把任何 ZodError 当成"这行数据坏了"。这正是计划要的收窄方向（宽泛 ZodError 判据本来就是 O1 的一半问题），且该服务收到的是已解析过的 payload，实际触发面很小。记下来是因为它的故障形态与改动前不同。
2. **两处 warn 的可测性不对称。** `PendingReviewAutoPromotionService` 的 `warn` 是可注入依赖（新测试正是靠它断言 `rejectedCount`），而章节增量链路直接用 `console.warn`，没有测试覆盖。该文件此前没有任何 warn，所以不算破坏既有风格；如果 L1 要改这段逻辑，顺手做成可注入会更好。
   —— `596bd62` 通过把过滤逻辑抽成导出的纯函数解决了覆盖问题（`console.warn` 本身仍未注入，但要断言的判定逻辑已可单测）。

---

## 5. 逐条结论

| 计划项 | 状态 |
|---|---|
| O1 typed error + reason 码 | ✅ 关闭 |
| O1 applier 边界包装 `invalid_payload` | ✅ 关闭 |
| O1 `25P02` 不变量写入代码 | ✅ 关闭（3 处） |
| O1 不按文案分类的回归守卫 | ✅ 关闭 |
| O2 账本 rejected 计数 / ID / summary / severity | ✅ 关闭 |
| O2 幂等键撞键处理 | ✅ 关闭 |
| O2 两条链路都有告警 | ✅ 关闭（章节链路见 L1） |
| R2 账本只做加法 | ✅ 事件类型与既有字段未变 |
| R3 幂等键不影响历史事件 | ✅ 无拒绝项时键逐字不变 |
| L1 章节链路告警只针对 apply 隔离 | ✅ `596bd62` 关闭 |
| L2 驾驶舱可见文案补发布说明 | ✅ `596bd62` 关闭 |
| 遗留开放项 | 无 |
