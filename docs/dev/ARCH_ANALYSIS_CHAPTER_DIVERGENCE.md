# Arch Analysis — Phase 2C Chapter Execution Divergence

> 基线：`beta@2c5614f`（Phase 2B 已合入）
> 作者：Claude Code（Architect）
> 阶段：`AGENT_COLLABORATION_GUIDE.md` §4 Step 1 —— 只做侦察与设计，不含实现
> 范围依据：`05_ROADMAP_AND_ACCEPTANCE.md` 的 Phase 2C（Chapter Execution Proposal 生产者、Expected vs Actual、正文偏离接受/修正分流）

---

## 0. 提案要点

**Expected vs Actual 的骨架已经存在，2C 不是从零建对比引擎。** 仓库里已有完整的「本章应该做什么」合同（`chapterExecutionObligationContractSchema`）、一个把正文比对进去的注册 Prompt（`chapterAcceptanceAssessmentPrompt`），以及结构化的比对产物（`obligationCoverage` / `missingObligations`）。这套东西每章都在跑。

2C 真正缺的是四件事：

1. 比对只识别**漏做**（omission），不识别**改做**（deviation）。
2. 比对结果只能流向「修复」或「质量债」，**没有「接受偏离」这条路**——把计划改成与正文一致，目前在系统里无法表达。
3. 没有任何调用方把偏离交给 2A 的提案生产者，因此偏离不可审阅、不进提案账本。
4. 一条待审 Change Proposal 不会阻塞下一章生成（`pendingReviewContext.ts:5-13`），`CODE_REVIEW_PROPOSAL_CORE.md` 早已记录，2C 必须给出结论。

**最重要的一条约束：偏离提案默认必须非阻塞。** 详见 D2——这是 2C 与 2A 接口处最容易做错的地方，也是我建议优先敲定的设计点。

---

## 1. 架构侦察：已经存在什么

### 1.1 Expected 侧（本章硬合同）

`shared/types/chapterRuntime.ts:355-363`：

```ts
chapterExecutionObligationContractSchema = {
  mustHitNow, mustPreserve, requiredPayoffTouches,
  requiredCharacterAppearances, requiredGoalChanges,
  canDefer, forbiddenCrossings,
}
```

同文件 `:345-353` 还有 `chapterBoundaryContractSchema`（`entryState` / `endingState` / `doNotCross` / `protectedReveals` / `allowedRevealLevel`）。这两份合同经 `chapterContextBlocks.ts:324-328` 注入写作上下文，是**已经喂给写手**的期望。

### 1.2 Actual 比对（已在跑）

`chapterAcceptanceAssessmentPrompt`（注册 Prompt，符合 Prompt Governance）输出 `missingObligations[]`，kind 限定为六类：`must_hit_now` / `must_preserve` / `payoff_touch` / `character_appearance` / `goal_change` / `forbidden_crossing`（`chapterAcceptance.prompts.ts:343`）。

Prompt 里已经写明判定口径（`:335`）：`must hit now` 与 `forbidden crossing` 缺口必须进 `missingObligations`；可后续承接的 payoff / 露面 / 目标缺口只有影响下一章入口时才进，否则降级为 `riskTags`。

### 1.3 比对产物的去向

| 消费方 | 位置 | 行为 |
|---|---|---|
| 覆盖度汇总 | `chapterRuntimePackageBuilders.ts:110-128` | `satisfied` / `partial` / `unmet` |
| 失败分类 | 同文件 `:130-165` | `draft_obligation_unmet` / `replan_required` / `draft_repair_exhausted` |
| 局部修复 | `repair/chapterRepairRuntime.ts:114` | 拿 `obligationCoverage.missing` 驱动补写 |
| 事实账本过滤 | `fact/factLedgerFilter.ts:160` | 过滤未命中的 `must_hit_now` |
| 质量债 | `ChapterQualityLoopService.ts` | 写 `riskFlags.qualityLoop` + `DirectorEvent` |

**结论：Expected、Actual、比对、以及「修正」分支都已存在且互相接好了。**

---

## 2. 2C 的真实缺口

### G1 — 只有 omission，没有 deviation

六类 obligation kind 里只有 `forbidden_crossing` 勉强表达「做了不该做的事」，其余五类都是「该做没做」。因此这类偏离目前**检测不到**，除非恰好被写进 `forbiddenCrossings` 或 `mustPreserve`：

- 计划让角色活着，正文把人写死了；
- 伏笔提前回收；
- 章节结束状态与 `boundaryContract.endingState` 不符，但没有硬冲突；
- 关系走向与计划相反（计划升温、正文写崩）。

`boundaryContract` 已经定义了 `endingState` / `nextChapterEntryState`，但**没有任何比对逻辑读它**（全仓 grep `boundaryContract` 只有 prompt 侧消费）。这是现成的 Expected 字段被闲置。

### G2 — 「接受偏离」在系统里无法表达

今天一条未满足的义务只有三个去向：补写修复、降级为质量债、触发 replan。**没有第四条：承认正文是对的，把计划改过来。**

这不是漏实现一个按钮，是缺一种写入语义——所有现存 applier 写的都是 canonical state（角色 / 关系 / 资源 / 大纲计划），而「接受偏离」要写的是**本章义务合同与下游章节计划**。

### G3 — 偏离不进提案链路

2A 建好了 `AiChangeProposalProducerService`，但生产链路里没有任何调用方为章节偏离创建提案。偏离目前只存在于 `riskFlags` JSON 与质量债事件里，**不可逐项审阅、不可修改、不进 Artifact Ledger、不做 stale 检测**。

### G4 — 待审提案不阻塞正文（历史遗留）

`pendingReviewContext.ts:5-13` 的 `buildBlockingPendingReviewProposalWhere` 复用 `buildLegacyPendingReviewWhere`，后者排除 `changeProposalId != null`。因此一条 pending 的 Change Proposal 不会拦住下一章生成。`CODE_REVIEW_PROPOSAL_CORE.md` 把它记为「必须在 2C 认领」的接线项。

---

## 3. 核心架构决策（建议）

### D1 — 扩展既有 acceptance 输出，不新建偏离检测器

在 `chapterAcceptanceAssessmentPrompt` 的结构化输出里增加 `divergences[]`（与 `missingObligations[]` 并列），而不是新起一个 Prompt / Service。

**理由：** 同一段正文再跑一次 LLM 比对是纯粹的成本浪费；更要紧的是两套判定必然漂移，出现「acceptance 说没问题、divergence 说有问题」这种无法解释的状态。且既有 Prompt 已经拿到了 obligation contract 与 boundary contract 的完整上下文（`chapterContextPolicies.ts` 的 `obligation_contract` / `structure_obligations` 上下文组）。

`prompting/README.md` 的版本规则要求 prompt 结构化输出变更升版本。真实注册项是 `novel.chapter.acceptance_assessment@v2`，因此 2C 升为 `v3`，并同步 registry loader 与 manifest。

### D2 — 偏离提案非阻塞投递（**已采纳，2026-08-27**）

`AGENTS.md` 的 Auto-Director Quality Gate Rules 是最高优先级硬规则，明确禁止局部章节质量问题中断全书执行链，并点名 `patchable_obligation_gap`、`draft_obligation_unmet`、`defer_and_continue`。

而 2A 的 `AiChangeProposalProducerService` 在需要审批时会调 `markTaskProposalReviewRequired`，把任务置为 `waiting_approval` + `proposal_review_required`。**直接复用这条默认路径会让每一次章节偏离都停住全书执行链，正面违反上述硬规则。**

定稿口径：

- 章节局部偏离默认非阻塞——创建提案、进 Artifact Ledger 与驾驶舱时间线，但不投 checkpoint、不改任务状态，章节继续推进。
- **2A producer 的既有默认行为不变。** 新增显式参数 `reviewProjection`，默认 `"task_checkpoint"`（即 2A 现行为），2C 调用方显式传 `"non_blocking"`。不得把 producer 的默认值改成非阻塞——那会让所有既有调用方静默失去 checkpoint。
- **scope 本身不能决定阻塞。** 我初稿写的「全局作用域变更也阻塞」是错的，已废弃。只有结构化结果明确为 `replan_required`、`stop_for_replan`、不可恢复生成失败（无可用正文）或数据安全问题时才可停止全书链——这与 `AGENTS.md` 逐字一致。「明确要求邻章重新规划」的偏离走既有 replan 路径，而不是靠一条 pending Proposal 间接把链路卡住。

接口设计见实施计划 §D2。

### D3 — 「接受偏离」是新的 proposalType + owned applier

沿用 2B 的先例：`outline_plan_update` 注册为 `domain_state`，applier 落在 `proposal/outline/application/OutlinePlanProposalApplier.ts` 这样的自有模块，而不是内联进 `StateProposalApplierRegistry.ts`（2B 计划 R6 明文规则）。

2C 对应新增 `chapter_execution_plan_update`，applier 落在 `proposal/chapterExecution/application/`。

**「接受偏离」不得回写并抹掉本章原始 Expected（2026-08-27 定稿）。** 原义务合同必须作为审计证据保留；apply 只更新**下游**章节计划，并记录一条 `accepted_divergence` 解决结果。理由：原合同是判断「AI 当时偏离了什么」的唯一证据，抹掉之后事后无法复盘，等于把偏离洗成从未发生。

### D3b — 正文保护目前不是可复用服务，2C 前必须先建立

侦察更正：2B 的「已有正文不删不移」**在 applier 里根本不是一条规则**，而是「这段代码恰好没写 `content`」——`OutlinePlanProposalApplier.ts:44-52` 的 `tx.chapter.update` 只更新 `title` / `expectation` / `taskSheet`，不含 `content`，也没有任何断言或守卫。

真正存在的只有两半，且都不可复用：

| 环节 | 位置 | 性质 |
|---|---|---|
| 检测 | `OutlineImportProposalService.ts:64,85-89,110` | 提案期算 `hasExistingContent`、抬 severity 到 major、发 `existing_chapter_content` 影响项。**与 outline 导入耦合** |
| 强制 | 无 | 靠「没写 content」这一事实成立 |
| 兜底 | `outlineProposalRealSqlite.test.js:67` | 一条集成断言 |

因此对 2C 而言这是**首次建立**一个 guard，不是搬运既有规则——工作量和风险都比「提取」大。任何未来 applier（含 2C 的）只要写了 `chapter.content` 或删改 order，现有代码不会拦，现有测试也发现不了。

建议在 planning 侧建 owned guard，提供两个能力：提案期的影响探查（供 2B 导入与 2C 偏离共用）与 apply 期的写入断言（抛 `StateProposalDomainError`）。guard 根据已校验 payload 推导的 mutation descriptor 与数据库当前章节自行判断删除/重排，不接受调用方预先给出的“是否危险”结论；payload 与 applier 写入字段另以白名单锁死，正文不进入可写集合。详见实施计划 §2C.0。

### D4 — 「修正」分流复用既有 repair，不新建链路

`chapterRepairRuntime.ts:114` 已经消费 `obligationCoverage.missing`。用户选「按 Expected 修正」时应触发既有局部修复，只是入口从自动改为人工确认。2C 在这条分支上应该**只做接线**。该操作不是普通拒绝：必须先修复并保存成功，再把 item 映射为内部 `rejected` 并记录稳定的 `corrected_to_expected` 解决语义；修复失败时 item 保持待审，避免出现“正文没修好、提案却已关闭”的假完成。

### D5 — G4 的收口口径（已按 D2 修正）

初稿写的「全局作用域提案阻塞下一章」与 D2 定稿冲突，作废。正确口径：

**待审 Change Proposal 一律不阻塞正文生成。** 需要停下的情形由既有结构化判据表达（`replan_required` / `stop_for_replan` / 不可恢复生成失败 / 数据安全问题），走既有 replan 与熔断路径，不经由 pending Proposal 间接阻塞。

因此 `buildBlockingPendingReviewProposalWhere`（`pendingReviewContext.ts:5-13`）**维持现状**——它排除 `changeProposalId != null` 恰好就是正确行为。G4 从「待接线缺口」改判为「现状即正确，补一条锁定该行为的回归测试与 wiki 说明」，避免后续有人以为这是漏接线又把它改回去。

这是本轮侦察对 `CODE_REVIEW_PROPOSAL_CORE.md` 原记录的更正：当时把它记为必须在 2C 认领的接线项，前提是「提案要能拦住正文」；D2 定稿后该前提不成立。

---

## 4. 建议范围与切分

| 子项 | 内容 | 依赖 |
|---|---|---|
| **2C.0** 正文保护 guard | planning-owned guard：提案期影响探查 + apply 期写入断言；2B 改为调用它 | —（前置） |
| **2C.1** 偏离契约 | shared 类型 `divergences[]`、确定性阈值判定、acceptance prompt 升版 | — |
| **2C.2** 非阻塞投递 | 2A producer 增加 `reviewProjection` 参数（默认不变）；账本与时间线接线 | 2C.1 |
| **2C.3** 偏离提案生产者 | 章节执行链把 `divergences[]` 聚合后交给 producer | 2C.0–2C.2 |
| **2C.4** 接受分支 | `chapter_execution_plan_update` + owned applier + 下游更新 + 原合同留证 | 2C.3 |
| **2C.5** 修正分支 | 接线既有 repair | 2C.3 |
| **2C.6** G4 锁定 | 补回归与 wiki，锁死「待审提案不阻塞正文」 | 2C.2 |
| **2C.7** 前端 | 偏离在既有 Proposal Drawer 里的「接受 / 修正」呈现 | 2C.4, 2C.5 |

`2C.0` 是前置：它要改已合入且全绿的 2B 代码，必须单独成一个 commit 并证明 2B 既有测试仍通过，再让 2C 依赖它。

`2C.1 + 2C.2` 是地基，建议落完单独评审——尤其 D2，做错了会以最难察觉的方式违反自动导演硬规则（表现为「全书跑着跑着停了」，而不是报错）。

---

## 5. 分工建议

已按 2026-08-27 协调定稿：

**Claude Code（我）**
- 本文档与后续修订；
- `IMPLEMENTATION_PLAN_CHAPTER_DIVERGENCE.md`；
- **2C.1 shared/schema 与 Prompt 输出契约草案**（跨 shared / prompt / runtime / proposal 四层）；
- **D2 非阻塞接口设计**；
- **测试矩阵**；
- 全程复审。

**Codex**
- 编译核验并修正 2C.1 草案；
- producer、生产链、owned applier、UI 的全部实现；
- 真实 SQLite 与整书不中断回归；
- 实施报告。

**边界提醒（不因分工调整而改变）：** 我本机没有 Node/pnpm，跑不了编译与测试。契约与计划我可以出，但凡是「编译通过 / 测试通过」只能由 Codex 给出。我写的所有代码一律标记为**未编译草案**——Phase 1 我盲写的 fixture 撞过 `DirectorEvent.taskId` 外键，2C.1 的草案同样要按这个前提对待。

---

## 6. 风险

| 编号 | 风险 | 对策 |
|---|---|---|
| R1 | 偏离提案阻塞全书链，违反 `AGENTS.md` 硬规则 | D2 非阻塞默认；补一条「整书自动执行遇到章节偏离仍跑完」的回归 |
| R2 | 新建第二套偏离检测，与 acceptance 判定漂移 | D1 单一 Prompt 单一输出 |
| R3 | 「接受偏离」把跨表规则堆进 state registry | D3 owned applier，沿用 2B 先例 |
| R4 | 「接受偏离」改计划时动到已有正文 | 2C.0 先建 planning-owned guard；**不能依赖 2B 的隐式行为**（见 D3b） |
| R5 | divergence 与 missingObligations 语义重叠，同一问题出两条 | 2C.1 契约显式划边界：omission 归 `missingObligations`，deviation 归 `divergences`，禁止同时产出 |
| R6 | AI 自报分类绕过阈值 | 六类都要求 `contractQuotes` 精确命中本次 Expected；kind、角色 id 均不能单独放行；空引用/伪引用最多语义重试一次，仍失败则显式质量债；severity 复用 2A 下界 |
| R7 | 每章都产生偏离提案，淹没审阅入口 | 阈值已定稿（§7）；同章多项聚合成一份提案 |
| R8 | 抹掉原始 Expected，事后无法复盘偏离 | D3 定稿：只写下游，原合同快照随提案留存 |
| R9 | 同章多项部分批准后重复覆盖同一下游字段 | 每项只带自身 patch，生产期拒绝重复目标字段；同章仍只建一个 Proposal 信封 |
| R10 | 下游边界字段只写规范化表或写到不存在的列 | 经卷规划 owned facade 同步写 active version document 与 normalized workspace，不直接拼 Prisma 字段 |

---

## 7. 已定稿口径（2026-08-27，用户拍板）

**偏离进提案的阈值：**

| 情形 | 去向 |
|---|---|
| 影响 `nextChapterEntryState`、跨章承诺、角色生死、保护揭露、伏笔兑现时机、关系主方向 | **每章聚合成一份非阻塞 Proposal** |
| 仅影响本章表达、局部节奏、可后续补偿的细节 | 继续走 `riskTags` / 质量债，不建 Proposal |
| 明确要求邻章重新规划 | 进入既有 replan 路径，不靠 pending Proposal 间接阻塞 |

**D2 已采纳**，且修正两点：producer 既有默认行为不变（2C 显式传参）、scope 本身不能决定阻塞。

**「接受偏离」保留原始 Expected 作审计证据**，只更新下游计划并记 `accepted_divergence`。

实施计划见 `IMPLEMENTATION_PLAN_CHAPTER_DIVERGENCE.md`。
