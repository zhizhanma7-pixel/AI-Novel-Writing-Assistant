# Implementation Plan — Phase 2C Chapter Execution Divergence

> 基线：`beta@2c5614f`
> 架构分析：`docs/dev/ARCH_ANALYSIS_CHAPTER_DIVERGENCE.md`
> 口径来源：2026-08-27 用户拍板的六条修订。
>
> **分工变更（2026-08-27）：** Codex 额度耗尽，实现改由 Claude Code 承担，Codex 转为评审。
> 本文中标注「未编译草案」的代码块是**当初的设计草案**，已实现的子项以实际代码为准，
> 差异记录在各子项的「实现与草案的差异」小节。Claude Code 已确认本机可用的
> Node 24.19.0 / pnpm 11.19.0（在 `~/.cache/codex-runtimes/`，不在 PATH），
> 因此后续子项均自行编译与测试，不再以未验证草案交付。

## 进度

| 子项 | 状态 | 提交 |
|---|---|---|
| 规划文档 | ✅ | `846295b` |
| 2C.0 正文保护 guard | ✅ 7/7（6 fast + 1 real SQLite），Claude 独立复跑确认 | `e7ae664` |
| 2C.1 偏离契约 | ✅ 10/10 新增单测；prompt registry 相关 82 通过 0 失败 | 本次 |
| 2C.2–2C.7 | ⏳ 未开始 | — |

---

## Goal

让「AI 写出来的正文」与「计划要求它写的内容」之间的偏离变成可审阅、可追踪、可选择接受或修正的提案，同时**不打断全书自动生产**。

## Scope

`server/src/services/novel/planning/guards/`（新）、`server/src/services/novel/proposal/chapterExecution/`（新）、`server/src/services/novel/proposal/runtime/AiChangeProposalProducerService.ts`、`server/src/services/novel/runtime/`（章节执行链接线）、`shared/types/`、`server/src/prompting/prompts/novel/chapterAcceptance.prompts.ts`、既有 Proposal Drawer 前端。

## Non-goals

- 不新建第二个偏离检测 Prompt 或 Service（D1）。
- 不新建审批队列、提案表或 workflow engine。
- 不改 `buildBlockingPendingReviewProposalWhere` 的行为（D5：现状即正确）。
- 不动 Phase 3+ 的 SillyTavern / Skills / Android。
- 不把跨表规则内联进 `StateProposalApplierRegistry.ts`。

---

## 0. 六条定稿口径（实现时逐条对照）

| # | 口径 | 落点 |
|---|---|---|
| 1 | 章节局部偏离默认非阻塞；**2A producer 既有默认行为不变**，2C 显式传 `reviewProjection: "non_blocking"` | §2C.2 |
| 2 | **scope 不能决定阻塞**。只有 `replan_required` / `stop_for_replan` / 不可恢复生成失败 / 数据安全问题可停全书链 | §2C.2、§2C.3 |
| 3 | 只有六类跨章影响才建 Proposal；同章多项聚合成一份；局部表达与可补偿问题记 quality debt | §2C.1 阈值、§2C.3 聚合 |
| 4 | 「接受偏离」**不得改写并抹掉本章原始 Expected**；原合同留证，只更新下游，记 `accepted_divergence` | §2C.4 |
| 5 | 2B 正文保护不是公共服务，先设计 planning-owned guard 提取边界 | §2C.0 |
| 6 | 契约草案 + D2 接口 + 测试矩阵由我出，标记未编译；Codex 负责编译修正与实现 | 全文 |

---

## 2C.0 — 正文保护 guard（前置）

### 现状更正

架构分析 D3b 已核实：2B 的「已有正文不删不移」**不是一条规则**。

- `OutlinePlanProposalApplier.ts:44-52` 的 `tx.chapter.update` 只写 `title` / `expectation` / `taskSheet`，不含 `content`——保护来自「没写」，不是来自守卫。
- 检测侧（`hasExistingContent` / severity 抬升 / `existing_chapter_content` 影响项）在 `OutlineImportProposalService.ts:64,85-89,110`，与 outline 导入耦合，不可复用。
- 唯一兜底是 `outlineProposalRealSqlite.test.js:67` 一条集成断言。

所以这是**首次建立**，不是搬运。

### 提取边界

新建 `server/src/services/novel/planning/guards/ChapterContentProtectionGuard.ts`，planning 拥有（章节计划是 planning 的资产）。两个能力，**职责严格分开**：

```ts
// —— 未编译草案 ——

/** 提案期：探查一批章节计划改动会碰到哪些已有正文。纯读，不抛。 */
export interface ChapterPlanImpactProbeInput {
  novelId: string;
  /** 必须由已校验 payload 推导，不接受调用方预先计算的“是否危险”布尔值。 */
  mutations: Array<{
    operation: "update_plan_fields" | "remove" | "reorder";
    chapterId?: string;
    currentChapterOrder: number;
    nextChapterOrder?: number;
    /** 只允许计划字段；正文不属于本 guard 的可写集合。 */
    fields?: Array<"title" | "expectation" | "taskSheet">;
  }>;
}

export interface ChapterContentImpact {
  chapterOrder: number;
  chapterId: string;
  hasExistingContent: boolean;
  /** 稳定码，供 UI 与提案 warnings 复用 */
  code: "existing_chapter_content" | "chapter_removal_blocked" | "chapter_reorder_blocked";
  severityFloor: "minor" | "major";
}

export async function probeChapterPlanImpacts(
  input: ChapterPlanImpactProbeInput,
): Promise<ChapterContentImpact[]>;

/**
 * Apply 期：断言这批写入不会破坏已有正文。
 * 事务不变量：本函数只做 SELECT，随后在任何写入之前抛出；
 * 禁止在失败 SQL 之后调用（见 StateProposalDomainError 的 25P02 注释）。
 */
export async function assertChapterPlanWriteIsSafe(
  tx: Prisma.TransactionClient,
  input: ChapterPlanImpactProbeInput & { proposalType: StateChangeProposal["proposalType"] },
): Promise<void>;
```

`assertChapterPlanWriteIsSafe` 根据数据库当前章节与 `mutations` 自己判断删除/重排，不取信调用方传入的 `removed` / `reordered` 结论；检出「要删/要重排一个有正文的章节」时抛 `StateProposalDomainError`，reason 用稳定码 `chapter_content_protected`。**更新 `title`/`expectation`/`taskSheet` 不算破坏**——那是计划字段，正是 2B/2C 该改的。payload schema 与 applier 的写入数据都不得出现 `content`；guard 负责结构操作保护，类型与 applier 定向测试负责锁死字段白名单。

### 交付顺序（重要）

1. 建 guard + 单测。
2. 让 2B 的 `OutlinePlanProposalApplier` 在写入前调用 `assertChapterPlanWriteIsSafe`，`OutlineImportProposalService` 改用 `probeChapterPlanImpacts`。
3. **证明 `outlineProposalRealSqlite.test.js` 与 `outlineWorkflow.test.js` 仍全绿**，单独成一个 commit。
4. 之后 2C 才允许依赖它。

这一步在改已合入且全绿的代码，回归风险高于新增代码，不要和 2C 其他子项混在同一个 commit。

---

## 2C.1 — 偏离契约（Claude 草案，待 Codex 编译核验）

### 与既有六类 obligation kind 的边界（R5）

| 维度 | 归属 | 判据 |
|---|---|---|
| **漏做**（该写没写） | 既有 `missingObligations[]` | 合同里要求的项在正文中缺席 |
| **改做**（写了但与计划相反） | 新增 `divergences[]` | 正文写了某事，且与合同的明确期望**方向相反或互斥** |

Prompt 侧必须写死：同一个问题只能进其中一个数组，不得同时产出。

### shared 类型草案

新建 `shared/types/chapterDivergence.ts`：

```ts
// —— 未编译草案 ——
import { z } from "zod";

/** 六类正好对应用户拍板的「建 Proposal」阈值 */
export const chapterDivergenceKindSchema = z.enum([
  "next_entry_state_changed",   // 影响下一章入口状态
  "cross_chapter_commitment",   // 跨章承诺被改写
  "character_life_status",      // 角色生死
  "protected_reveal_touched",   // 保护揭露被提前/改动
  "payoff_timing_shifted",      // 伏笔兑现时机
  "relation_direction_reversed",// 关系主方向
]);

/**
 * 结构化引用：阈值判定不看 AI 的 kind 标签，而是拿这些引用回合同里交叉核对。
 * 这是 M1/M3 的教训——不能让被门禁的一方提供门禁的唯一入参。
 */
export const chapterDivergenceReferenceSchema = z.object({
  /** 合同中的角色条目原文；当前 Expected 不暴露稳定角色 id。 */
  affectedCharacterContractEntries: z.array(z.string().trim().min(1)).default([]),
  /** requiredPayoffTouches 中的原文；当前值是 operation + title，不是数据库 id。 */
  affectedPayoffContractEntries: z.array(z.string().trim().min(1)).default([]),
  touchedProtectedReveals: z.array(z.string().trim().min(1)).default([]),
  /** 引用 boundaryContract / obligationContract 里的原文条目，用于回查 */
  contractQuotes: z.array(z.string().trim().min(1)).default([]),
});

export const chapterDivergenceSchema = z.object({
  kind: chapterDivergenceKindSchema,
  summary: z.string().trim().min(1).max(500),
  /** 合同里的原文，便于 UI 直接展示 Expected */
  expected: z.string().trim().min(1).max(1000),
  /** 正文实际写成什么 */
  actual: z.string().trim().min(1).max(1000),
  evidence: z.string().trim().max(1000).nullable().optional(),
  references: chapterDivergenceReferenceSchema,
});

export const chapterDivergenceResolutionSchema = z.enum([
  "accepted_divergence",   // 承认正文，改下游计划
  "corrected_to_expected", // 按 Expected 修正正文
]);

export type ChapterDivergence = z.infer<typeof chapterDivergenceSchema>;
export type ChapterDivergenceKind = z.infer<typeof chapterDivergenceKindSchema>;
export type ChapterDivergenceResolution = z.infer<typeof chapterDivergenceResolutionSchema>;
```

### 确定性阈值判定（不取信 AI 标签）

新建 `server/src/services/novel/proposal/chapterExecution/domain/ChapterDivergenceThreshold.ts`：

```ts
// —— 未编译草案 ——

/**
 * 判定一条偏离是否值得建 Proposal。
 * 原则：AI 的 kind 只是展示分类；真正的判据是它给的合同原文引用能否在
 * 本章的 Expected 合同里精确回查。查不到就不建提案，进入一次结构化重试。
 */
export function isProposalWorthyDivergence(input: {
  divergence: ChapterDivergence;
  obligationContract: ChapterExecutionObligationContract;
  boundaryContract: ChapterBoundaryContract;
}): boolean {
  const { divergence: d, obligationContract: o, boundaryContract: b } = input;

  const expectedEntries = [
    ...o.mustHitNow,
    ...o.mustPreserve,
    ...o.requiredPayoffTouches,
    ...o.requiredCharacterAppearances,
    ...o.requiredGoalChanges,
    ...o.canDefer,
    ...o.forbiddenCrossings,
    b.exclusiveEvent,
    b.entryState,
    b.endingState,
    b.nextChapterEntryState,
    ...b.doNotCross,
    ...b.protectedReveals,
  ].filter((value): value is string => Boolean(value?.trim()));
  const hasVerifiedContractQuote = d.references.contractQuotes.some((quote) =>
    expectedEntries.includes(quote));

  // 所有六类都必须至少有一条可精确回查的合同原文；kind 本身永远不足以过门槛。
  if (!hasVerifiedContractQuote) return false;

  if (d.references.touchedProtectedReveals.some((r) => b.protectedReveals.includes(r))) {
    return true;
  }
  if (d.references.affectedPayoffContractEntries.some((entry) => o.requiredPayoffTouches.includes(entry))) {
    return true;
  }
  return d.kind === "next_entry_state_changed"
    || d.kind === "cross_chapter_commitment"
    || d.kind === "character_life_status"
    || d.kind === "relation_direction_reversed";
}
```

`affectedCharacterContractEntries` 是审阅与后续修复定位信息，不作为独立放行条件。这里刻意不叫 `affectedCharacterIds` / `affectedPayoffIds`：当前 acceptance Prompt 实际收到的 obligation 合同中，角色是姓名/说明文本，伏笔是 `operation: title`，并未暴露稳定数据库 id。草案若宣称输出 id，模型只能编造。

**K1 收口（本期不扩大为数据库语义比对）：** 初次输出存在空引用，或所有 `contractQuotes` 均无法在本次输入合同中精确命中时，由 PromptAsset 的 `postValidate(output, input)` 抛出带稳定原因的语义校验错误，并配置 `semanticRetryPolicy.maxAttempts = 1`，复用 Prompt Runner 的一次结构化语义重试与遥测；重试仍无法核验时通过 `postValidateFailureRecovery` 保留 acceptance 主结果，但剥离未核验 divergence，随后写入稳定码 `unverified_cross_chapter_divergence` 的显式 quality debt 与 DirectorEvent。不得静默丢弃，也不得因为 AI 自报 kind 就放行。这里选择保守少写状态，数据库现值交叉验证留作后续独立能力。

### Prompt 输出契约草案

`chapterAcceptanceAssessmentPrompt` 升版：现行注册 id 为 `novel.chapter.acceptance_assessment`、版本 `v2`，本阶段升级到 `v3`，并同步 registry loader key 与 Prompt manifest。

输出 schema 增加与 `missingObligations` 并列的 `divergences`：

```ts
// —— 未编译草案，接在既有 acceptance 输出 schema 上 ——
divergences: z.array(chapterDivergenceSchema).default([]),
```

指令增补（沿用既有编号风格，接在现有第 14 条之后）：

```
15. divergences 只记录「正文写了，但与本章合同的明确期望方向相反或互斥」的情况；
    「该写没写」一律进 missingObligations，同一个问题不得同时出现在两个数组里。
16. divergences.kind 只能使用 next_entry_state_changed、cross_chapter_commitment、
    character_life_status、protected_reveal_touched、payoff_timing_shifted、
    relation_direction_reversed。
17. 每条 divergence 必须填写 references：凡涉及角色须从合同原文填写
    affectedCharacterContractEntries，涉及伏笔须从合同原文填写
    affectedPayoffContractEntries，涉及保护揭露须给 touchedProtectedReveals，
    并在 contractQuotes 中原样引用合同条目。references 为空或引用无法回查时，
    系统只会重试一次，仍无法核验则记录为质量提醒，不会创建提案。
18. expected 必须引用合同原文，actual 必须是正文中的实际写法；两者都不得复述
    本条指令或解释判定过程。
19. 只影响本章表达、局部节奏或可后续补偿的问题不进 divergences，按既有规则
    放入 riskTags。
```

第 18 条后半句是为了满足 `AGENTS.md` 不保存隐藏推理的要求。

### 2C.1 实现与草案的差异（实测修正）

草案编译时暴露了四处与真实代码不符，已按实际结构修正：

| 草案 | 实际 | 原因 |
|---|---|---|
| `postValidate` 直接拿到合同 | `ChapterAcceptancePromptInput` 新增 `obligationContract` / `boundaryContract` | `postValidate(output, input, context)` 只能看到 prompt input，合同原本只存在于渲染后的上下文文本里，反解析不可靠 |
| 合同取自 `contextPackage.writeContext` | 取自 `contextPackage.chapterReviewContext`，回退 `chapterWriteContext` | `GenerationContextPackage` 上没有 `writeContext` 字段；`chapterReviewContextSchema` 继承自 `chapterWriteContextSchema`，两个合同都在，且 acceptance 属于 review 阶段 |
| 指令编号 15–19 | 实际编号 18–22 | 现行 prompt 已有 17 条指令 |
| 只加 `divergences` 到 schema | 还需给 `buildFallbackAssessment` 补 `divergences: []` | 该字段非可选，闸门降级路径也必须提供 |

另外把 `collectChapterDivergenceContractEntries` 与 `isVerifiableChapterDivergence` 放进
`shared/types/chapterDivergence.ts`，让 Prompt 的 `postValidate` 与服务端阈值模块共用同一套
回查逻辑——两处各写一份必然漂移，这正是 D1 想避免的问题在契约层的翻版。

**分层边界：** Prompt 层负责「这条偏离可不可核验」（不可核验→重试→剥离），
服务端阈值层负责「可核验的偏离够不够格建提案」。两层都做 default-deny。

---

## 2C.2 — D2 非阻塞投递接口

### 设计

`AiChangeProposalProducerService.produce()` 增加**可选** options，默认值等于 2A 现行为：

```ts
// —— 未编译草案 ——
export type ChangeProposalReviewProjection = "task_checkpoint" | "non_blocking";

export interface AiChangeProposalProduceOptions {
  /** 默认 "task_checkpoint"，即 2A 既有行为。2C 显式传 "non_blocking"。 */
  reviewProjection?: ChangeProposalReviewProjection;
}

async produce(
  novelId: string,
  rawInput: AiChangeProposalInput,
  options: AiChangeProposalProduceOptions = {},
): Promise<AiChangeProposalProductionResult>;
```

`produce()` 内部只有一处行为差异——需要审批时的投影方式：

| `reviewProjection` | 需要审批时 | 自动执行失败时 |
|---|---|---|
| `"task_checkpoint"`（默认，2A 不变） | `markTaskProposalReviewRequired(proposal)` | 现行为不变 |
| `"non_blocking"` | **不投 checkpoint、不改任务状态**；写一条 `DirectorEvent` 使其出现在驾驶舱时间线 | 同样不投 checkpoint；写 high severity 账本事件，提案留在可审阅状态 |

返回值增加 `reviewProjection`，便于调用方与测试断言。

### 为什么非阻塞下的 apply 失败也不停链

信封执行是原子的，失败即整体回滚，**没有半写状态**；失败的是「计划更新」而不是「正文生成」，本章正文仍然可用。因此它既不是"不可恢复生成失败且无可用正文"，也不是数据安全问题，不满足口径 2 的任何一条停止条件。停下来反而违反 `AGENTS.md`。

代价是失败会比较安静——所以必须写 high severity 账本事件，让它在驾驶舱时间线上显眼。这与 Phase 1 的 O2 处理同类问题（legacy apply 隔离）的做法一致。

### 不做的事

- 不改 producer 默认值（口径 1）。
- 不让 2C 绕开 producer 自己拼 proposal——那就是第二套审批。
- 不在 producer 里判断「要不要停全书链」；停链只由既有结构化判据决定（口径 2）。

---

## 2C.3 — 偏离提案生产者

位置：`server/src/services/novel/proposal/chapterExecution/application/ChapterDivergenceProposalService.ts`。

流程：

1. 从 acceptance 结果取 `divergences[]`。
2. 用 `isProposalWorthyDivergence` 逐条过滤；未通过的合并进既有 `riskTags` / 质量债路径（口径 3）。
3. **同章聚合成一份提案**（口径 3）：一个信封，每条偏离一个 `ProposedChange`，`proposalType: "chapter_execution_plan_update"`。每项 payload 只包含该偏离对应的下游 patch；生产期必须拒绝两个已批准项写同一下游章节的同一字段，避免部分审批后出现顺序相关的覆盖。
4. severity 走 2A 的 `ChangeProposalSeverityPolicy`，不另起一套（R6）。
5. 调 `produce(..., { reviewProjection: "non_blocking" })`。
6. **无论结果如何都不改变章节执行链的推进决定**——这是 R1 的实现约束，需要在代码里以显式注释固定，并由整书回归锁定。

若 acceptance 同时给出 `replan_required` / `stop_for_replan`，走既有 replan 路径，**不建偏离提案**（口径 2 末句）——避免同一件事既 replan 又留一份待审提案。

---

## 2C.4 — 接受分支（口径 4）

新增 proposalType `chapter_execution_plan_update`，在 `stateProposalApplication.ts` 注册为 `domain_state`，applier 落 `proposal/chapterExecution/application/ChapterExecutionPlanApplier.ts`（沿用 2B 的 `outline_plan_update` 先例）。

**payload 必须包含本章原始 Expected 快照**：

```ts
// —— 未编译草案 ——
chapterExecutionPlanUpdatePayloadSchema = z.object({
  divergenceId: z.string().trim().min(1),
  chapterId: z.string().trim().min(1),
  chapterOrder: z.number().int().positive(),
  /** 审计证据：偏离发生时本章的原始合同，apply 不得据此回写本章 */
  originalExpected: z.object({
    obligationContract: chapterExecutionObligationContractSchema,
    boundaryContract: chapterBoundaryContractSchema,
  }),
  divergence: chapterDivergenceSchema,
  resolution: z.literal("accepted_divergence"),
  /** 只有下游卷规划文档会被 patch；字段名与 VolumePlanDocument 契约一致。 */
  downstreamPlanPatches: z.array(z.object({
    volumeId: z.string().trim().min(1),
    volumeChapterId: z.string().trim().min(1),
    chapterOrder: z.number().int().positive(),
    patch: z.object({
      summary: z.string().trim().min(1).optional(),
      purpose: z.string().trim().min(1).nullable().optional(),
      endingState: z.string().trim().min(1).nullable().optional(),
      nextChapterEntryState: z.string().trim().min(1).nullable().optional(),
      taskSheet: z.string().trim().min(1).nullable().optional(),
      sceneCards: z.array(z.unknown()).optional(),
      payoffRefs: z.array(z.string().trim().min(1)).optional(),
    }).refine((patch) => Object.keys(patch).length > 0),
  })).default([]),
});
```

applier 行为，**逐条对应口径 4**：

- **不写本章的义务合同 / 边界合同**——原始 Expected 原样保留。
- 只 patch `downstreamPlanPatches` 指向的下游章节计划。`endingState` / `nextChapterEntryState` 属于版本化 `VolumePlanDocument`，**不是** `VolumeChapterPlan` 数据列；applier 必须经 `NovelVolumeService.updateVolumesWithOptions`（或为 proposal 提取的等价 owned facade）完成 active version + normalized workspace 的一致写入，禁止直接向 Prisma 虚构字段或只改一侧存储。
- 写入前调 `assertChapterPlanWriteIsSafe`（2C.0）。
- 在本章记录 `accepted_divergence` 解决结果，落 `riskFlags.divergenceResolutions[divergenceId]`。序列化必须先解析并保留全部未知顶层键及既有 `qualityLoop`，只 merge 本次 resolution；禁止整段覆盖 `riskFlags`。解析失败时以数据完整性错误拒绝 apply，不得清空旧值后继续。

审计证据的归宿：提案本身已经是不可变、带版本、进 Artifact Ledger 的记录，`originalExpected` 随 payload 留存即可，**不需要新表**。

---

## 2C.5 — 修正分支

「按 Expected 修正」= 触发既有局部修复。`chapterRepairRuntime.ts:114` 已经消费 `obligationCoverage.missing`，2C 只做接线：把被要求修正的偏离转成修复指令输入，复用既有修复预算与 `maxAutoRepairAttempts`。

这不是普通的「拒绝提案」按钮，必须有显式 application command（例如 `correctChapterDivergence`）：

1. 校验 proposal/item 仍为 pending 且未 stale；
2. 触发既有 repair；LLM 调用不包进数据库事务；
3. repair 成功并保存正文后，将该 item 记为 `reviewDecision: "rejected"`，同时在 `validationNotesJson` 写稳定码 `corrected_to_expected:<divergenceId>`，并 merge `riskFlags.divergenceResolutions[divergenceId] = "corrected_to_expected"`；
4. repair 失败时保持 item 可审阅，按既有预算记录质量债，不得先标 rejected 造成假完成；
5. UI 对用户始终展示「按计划修正」，不得暴露内部 rejected 映射。

这样复用既有三态审核存储，不引入第四个 `reviewDecision`，同时保留可审计的业务解决语义。

**不新建修复链路**，不绕过既有修复预算。

---

## 2C.6 — G4 锁定

`buildBlockingPendingReviewProposalWhere` 维持现状（D5）。本子项只做两件事：

- 补一条回归：存在 pending Change Proposal 时，下一章仍可正常生成。
- 在 `docs/wiki/workflows/change-proposal-review.md` 写明这是**有意为之**及其理由，防止后续被当成漏接线改掉。

---

## 2C.7 — 前端

- 入口复用既有 Change Proposal Drawer，不新建页面。
- 每条偏离展示 Expected / Actual 对照，操作为「接受偏离」与「按计划修正」。
- 新增业务进 `client/src/pages/novels/components/` 下的自有功能目录，`NovelEdit.tsx` 只挂载（沿用 2B 的 `outlineImport/` 边界）。
- 文案按 `AGENTS.md` UI Copy Rules 写用户视角，不出现 divergence / contract / projection 等实现词。
- 视觉验收留给用户；代码侧只做 typecheck 与组件逻辑测试。

---

## 测试矩阵

| # | 用例 | 层级 | 锁定的口径 |
|---|---|---|---|
| T1 | 整书自动执行途中产生偏离提案，全书跑完不中断 | 真实 SQLite / 整书回归 | 口径 1、2（**最关键**） |
| T2 | `reviewProjection` 缺省时行为与 2A 逐字一致（仍投 checkpoint） | 单测 | 口径 1 |
| T3 | `non_blocking` 下需要审批：不投 checkpoint、任务状态不变、有 DirectorEvent | 单测 | 口径 1 |
| T4 | `non_blocking` 下自动执行失败：不投 checkpoint、high severity 事件、提案可审阅 | 单测 | 口径 2 |
| T5 | acceptance 给出 `replan_required` 时走 replan，不建偏离提案 | 单测 | 口径 2 |
| T6 | 六类跨章影响的偏离 + 可精确回查合同引用 → 建提案；只有 kind/角色 id 不放行 | 单测（逐 kind） | 口径 3 |
| T7 | 仅本章表达/可补偿的偏离 → 只进 quality debt，不建提案 | 单测 | 口径 3 |
| T8 | `references` 为空或引用不命中 → 最多重试一次；仍失败则显式 quality debt + event，不建提案 | 单测 | 2C.1 / K1 |
| T9 | 同章多条偏离 → 聚合为一份提案、多个 ProposedChange；重复目标字段被拒绝 | 单测 | 口径 3 |
| T10 | 接受偏离后：卷规划版本与规范化工作区同步更新、**本章原始合同逐字未变**、旧 riskFlags 未丢、记录 `accepted_divergence` | 真实 SQLite | 口径 4 |
| T11 | 接受偏离不会删除或重排有正文的章节（guard 生效） | 真实 SQLite | 口径 5 |
| T12 | guard 接入后 2B 既有 outline 测试仍全绿 | 回归 | 口径 5 |
| T13 | guard 允许更新 `title`/`expectation`/`taskSheet`（不误伤计划字段） | 单测 | 2C.0 |
| T14 | 修正成功后才落内部 rejected + `corrected_to_expected`；失败保持 pending，并复用既有修复预算 | 单测 | 2C.5 |
| T15 | 存在 pending Change Proposal 时下一章仍可生成 | 集成 | 口径 2 / D5 |
| T16 | divergence 与 missingObligations 不对同一问题重复产出 | Prompt 契约测试 | R5 |
| T17 | 偏离提案 severity 走 2A 确定性下界，AI 低报不生效 | 单测 | R6 |

T1 是本阶段的核心验收——它是唯一能证明「2C 没有违反自动导演硬规则」的用例，建议第一个写、且在 2C.3 完成时就要能跑。

---

## 交付切分

| Commit | 内容 |
|---|---|
| A | 本计划 + 分析修订（纯文档，无发布说明） |
| B | 2C.0 guard + 单测 + 2B 接入 + 证明 2B 测试全绿 |
| C | 2C.1 契约（shared + prompt 升版 + 阈值判定）+ 单测 |
| D | 2C.2 `reviewProjection` + T2/T3/T4 |
| E | 2C.3 生产者 + 聚合 + **T1 整书不中断回归** |
| F | 2C.4 接受分支 applier + T10/T11 |
| G | 2C.5 修正接线 + 2C.6 G4 锁定 + wiki |
| H | 2C.7 前端 + release notes（本阶段有用户可见能力，须走 `readme-release-updater`） |

合入路径 `codex/chapter-divergence → beta → main`，不直接进 `main`。

---

## Verification

- shared / server build、client typecheck。
- 上述测试矩阵，其中 T1、T10、T11、T12 必须是真实 SQLite。
- 合入 `beta` 后跑完整 integration，与 2B 建立的「139 项 / 0 失败」基线对比，**任何新增失败都不得通过调整断言消化**。
- 浏览器视觉验收留给用户（`AGENTS.md` Verification Reuse Rules）。

## Wiki And Release Notes

- 更新 `docs/wiki/workflows/change-proposal-review.md`：非阻塞投影、偏离阈值、接受偏离的写入边界、以及 G4 为何维持现状。
- 新增或更新章节执行链 wiki：Expected vs Actual 的判定归属、divergence 与 missingObligations 的分工。
- Commit A–G 纯内部，跳过发布说明并说明原因；Commit H 有用户可见能力，须更新 `docs/releases/release-notes.md` 与 README。

## Known Risks

| 编号 | 风险 | 处置 |
|---|---|---|
| K1 | AI 留空或伪造 `references` 导致偏离漏报 | 最多一次结构化重试；仍不可核验则显式 quality debt + DirectorEvent；T8 锁定；本期不做数据库语义比对 |
| K2 | 2C.0 改动已合入的 2B 代码 | 独立 commit + T12 |
| K3 | 非阻塞下 apply 失败偏安静 | high severity 账本事件 + T4 |
| K4 | 六类 kind 覆盖不全真实偏离形态 | 首轮按定稿六类实现；扩类需回到本文档改阈值表，不得在 Prompt 里私自加 kind |
