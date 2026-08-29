# Phase 2C.7 实施计划 — 偏离审阅界面与下游计划补丁

> 分支：`codex/chapter-divergence`（从 `beta@2c5614f` 拉出，未合入、未推送）
> 前置：2C.0–2C.6 后端链路已关闭，见 `IMPLEMENTATION_REPORT_CHAPTER_DIVERGENCE.md`
> 上游计划：`IMPLEMENTATION_PLAN_CHAPTER_DIVERGENCE.md` 的 2C.7 节（**本文取代之**）
> 阶段口径：Phase 2 = Outline Workflow，2C 是其子阶段；本文不扩张 2C 的产品边界

## 为什么要单独写一份

`IMPLEMENTATION_PLAN_CHAPTER_DIVERGENCE.md` 里的 2C.7 只有六行，写于 K8 被发现之前，
把这一阶段描述成「Drawer 里加两个按钮」。侦察后发现该描述不成立：

| 原计划假设 | 实际 |
|---|---|
| 只是渲染 + 两个按钮 | 「按计划修正」在仓库内**没有任何生产调用方**，缺 HTTP 入口 |
| 「接受偏离」已可用 | 生产者恒给空 `downstreamPlanPatches`，接受只记录结果、不改下游计划 |
| 编辑能力已具备 | 编辑通路确实存在，但入口是一个要作者手写 JSON 的 textarea |
| 编辑值会被校验 | `editProposedChange` 不按 proposalType 校验，写错要到点「批准」才报错 |

## 现状（侦察结论）

**已经存在、可直接复用的：**

- `PATCH /novels/:id/change-proposals/:proposalId/items/:itemId` → `ChangeProposalReviewService.editProposedChange`，
  把编辑结果写进 `userEditedPayloadJson`，逐项转 `reviewDecision = modified`。
- `ChangeProposalApplyService` 在 apply 时优先取 `userEditedPayloadJson`（`:153`），
  并在**最终 payload** 上做下游写目标冲突检查（复审 M4）。
- 前端 `changeProposal/` 目录已有 Drawer / List / Detail / Row / Editor 与 `useChangeProposals`，
  API 层 `client/src/api/novel/changeProposals.ts` 十个端点齐全。
- `ChapterDivergenceCorrectionService` 已带生产默认 adapter（H2 阻塞一已关闭），
  返回 `corrected` / `repair_failed` / `conflict` 三态。

**缺的：**

1. 修正命令没有 HTTP 入口，只有测试装配得起来。
2. 编辑期没有 proposalType 级校验。
3. 前端完全不认识 `chapter_execution_plan_update`——`changeProposalCopy.ts` 只有
   `chapter_execution: "章节执行"` 这一条分类文案，没有逐项类型的呈现。
4. 下游补丁没有结构化入口。

## 补丁的形状（决定了表单，不需要发明新契约）

`chapterExecutionPlanPatchSchema` 已经把边界定死：

```
{ chapterOrder: 正整数, purpose?, endingState?, nextChapterEntryState?, exclusiveEvent? }
.strict()，且至少要改一个非 chapterOrder 字段
```

只收卷规划文档自有字段是**有意为之**：`title` / `summary` / `taskSheet` 等的权威来源是
`Chapter` 数据列，`hydrateCanonicalChapterFields` 每次读工作区都会用 Chapter 行覆盖文档侧
的值。允许 patch 它们会让写入在下一次 hydrate 时被无声还原——apply 报成功、界面显示一次、
然后变化消失。**表单必须照抄这个边界，不得提供更多字段。**

## 决策（用户 2026-08-29 定）

### D1 — 补丁由 AI 生成草稿，用户编辑确认

不是纯手填。但**AI 不写库**：

```
用户点「让 AI 建议后续调整」
  → POST .../divergence-suggestions（只读上下文，调 prompt，过 sanitizer）
  → 返回建议 patch[]，不落库
  → 前端填进结构化表单，用户可改可删
  → 用户保存 → 走既有 editChangeProposalItem → userEditedPayloadJson
  → 用户批准 → 既有 apply 链路
```

**这条设计是本阶段的核心。** 它让 AI 建议不构成一条新的「AI 写状态」路径：
落库的永远是用户编辑动作，`reviewDecision` 仍是 `modified`，
`DirectorPolicyEngine` 门禁与 L0–L3 语义**一律不动**。2A 复审的 H1 教训
（policy 语义超载导致默认绕过人工审批）在这里不会重演，因为根本没有新的自治写入点。

代价是诚实的：AI 建议是一次**用户显式触发**的辅助，不在自动导演链路里跑。

### D2 — 「接受」拆成两个明确动作

| 动作 | 语义 | 落库 |
|---|---|---|
| 接受并更新后续计划 | 至少一条 patch | `downstreamPlanPatches` 非空 |
| 仅记录这次偏离 | 明说后续计划不变 | `downstreamPlanPatches: []` |

后端 schema 两者都已合法（`default([])`），不用改契约。作者的意图是选出来的，
不是靠记不记得填。

## 交付切分

| 批次 | 内容 | 用户可见 | 状态 |
|---|---|---|---|
| **P0** | 本计划（纯文档） | 否 | ✅ `5070272` |
| **P1** | 修正命令 HTTP 入口 + 编辑期 payload 校验 | 否（后端补课） | ✅ `225a19c` |
| **P2** | AI 补丁建议：prompt asset + registry + service + sanitizer + 端点 | 否（无调用方） | ✅ `abd52cf` |
| **P3** | 前端 + release notes + README | **是** | ✅ |

P1–P2 无用户可见影响，按仓库规则明确跳过发布说明。

**P4 已并入 P3**：原计划把发布说明单独放一批是错的——`AGENTS.md` 要求在**有用户可见影响的那次 Git 写入之前**更新发布说明，不能等提交完再补。

## P1 — 后端补课

- `POST /novels/:id/change-proposals/:proposalId/items/:itemId/correct`
  接 `ChapterDivergenceCorrectionService.correct`，三态映射到 HTTP：
  `corrected` → 200；`repair_failed` → 200 带 status（**不是** 5xx，修复失败是业务结果，
  逐项保持可审阅）；`conflict` → 409。
- `editProposedChange` 增加 proposalType 级 payload 校验：
  对 `chapter_execution_plan_update` 用 `chapterExecutionPlanUpdatePayloadSchema` 校验，
  失败返回 `invalid_review` 而不是存下去等 apply 报错。
  **只对已有 applier 的类型开校验**，避免误伤其他类型。

## P2 — AI 补丁建议

- `server/src/prompting/prompts/chapterExecution/divergencePlanSuggestion.prompts.ts`
  新 `PromptAsset`，id `chapter_execution.divergence.plan_suggestion`，
  `mode: "structured"`，`outputSchema` 用 shared 新增的建议 schema。
  必须在 `registry/promptAssetLoaderEntries.ts` 注册，并满足
  `prompting-governance.test.js`（不得直接 `getLLM(` / `invokeStructuredLlm(` /
  在 service 里拼 `systemPrompt`）。
- 调用走 `runStructuredPrompt`，形态照 `ReplanWindowDecisionService`。
- **确定性 sanitizer 是必须项**，照 `sanitizeAiReplanWindowDecision`：
  - `chapterOrder` 只保留真实存在且**在本章之后**的章节；
  - 丢弃 schema 之外的字段（`.strict()` 会拒，但要先清洗再校验，给出可读原因）；
  - 同一 `chapterOrder` 去重，避免前端拿到自相冲突的建议；
  - 空建议是合法结果，不是错误。
- 上下文只读：本章 expected/actual/kind/references + 下游章节现有计划字段。

## P3 — 前端

- `changeProposalCopy.ts` 补 `chapter_execution_plan_update` 的类型文案与
  Expected/Actual 标签；`before`/`after` 生产者已填好，直接用。
- 新增 `changeProposal/divergence/` 子目录（沿用 2B `outlineImport/` 的边界约定），
  `NovelEdit.tsx` 只挂载。
- 结构化补丁表单：选下游章节 + 四个字段，照 schema 生成，不提供额外字段。
- 「让 AI 建议后续调整」按钮 → P2 端点 → 填表单（可改可删，不自动保存）。
- 两个接受动作 + 「按计划修正」。修正是长耗时 LLM 调用，需要 loading 与三态反馈。
- 文案按 `AGENTS.md` UI Copy Rules 写用户视角，不出现
  divergence / patch / projection / payload 等实现词。

## 测试矩阵

| # | 用例 | 层级 |
|---|---|---|
| U1 | 修正端点三态各自映射到正确 HTTP 状态，`repair_failed` 不是 5xx | 集成 |
| U2 | 编辑期校验：非法 patch 字段被拒于编辑，不进 `userEditedPayloadJson` | 集成 |
| U3 | 编辑期校验不误伤其他 proposalType | 单测 |
| U4 | sanitizer 丢弃本章及之前的 `chapterOrder`、去重、清非法字段 | 单测 |
| U5 | AI 建议端点不写任何库表（调用前后行数一致） | 真实 SQLite |
| U6 | 建议 → 编辑落库 → 批准 → 下游计划真的改了；本章 Expected 逐字未变 | 真实 SQLite |
| U7 | 「仅记录这次偏离」落空数组，下游计划不动，仍记 `accepted_divergence` | 真实 SQLite |
| U8 | 前端表单只产出 schema 允许的四个字段 | 组件逻辑测试 |
| U9 | prompt 治理测试仍全绿（新 asset 合规注册） | 既有集成 |

U5 是 D1 的守门用例——它一旦失败，说明 AI 建议悄悄变成了写状态路径。

## 风险

| 编号 | 风险 | 处置 |
|---|---|---|
| K9 | AI 建议的下游改动可能与作者意图相悖，作者一路点确认 | 建议默认**不勾选**，作者必须逐条采纳；文案说明这是建议不是结论 |
| K10 | 建议基于读取时的下游计划，作者编辑期间计划可能被自动导演改动 | 落库走既有 `editProposedChange`，它已有 `expectedVersion` 乐观锁；冲突时提示重新获取建议 |
| K11 | 新 prompt 增加一次 LLM 调用成本，且在审阅交互中同步等待 | 用户显式触发，不进自动链路；失败只影响建议，不影响接受/修正两条既有出口 |

## 复审回填（2026-08-29）

复审结论：设计方向成立，但两项阻塞，修复见 `585bc8d`。

### 阻塞一 — 已修正的条目会被后续审批翻回接受

`ChapterDivergenceCorrectionService` 在信封仍待审时就把该逐项锁成
`reviewDecision = rejected` / `status = rejected`。但 `approveProposal`
**从不读这个已存决定**：它按 `explicit?.decision ?? unlistedDecision ?? "accepted"`
重新推导，于是「全部批准」会把已修正的条目改成 accepted。

后果是一个自相矛盾的状态：**正文已经改回原计划，下游计划却按偏离更新**。

修复：审批遇到已锁定的拒绝一律原样带过（连该条的记录都不更新），显式给出
相反决定时报 `invalid_review` 而不是静默翻转。`approveProposal` 是审批的唯一
入口，所以 approve / partial-approve / 导演命令 / AI 生产者四条路一并覆盖。

界面同步收掉该条的操作（`isCorrectedBackToPlan`），否则作者会以为还能改。

**另一层保护不能替代它：** 修正会改正文，带 `contentHash` 的提案随后会被
stale 检查挡住。但那是巧合而非设计——多章提案里被修正的章节未必在
`sourceRefs` 里。护栏测试刻意用不带 hash 的提案，把审批层的行为单独隔离出来验证。

### 阻塞二 — 手动章节输入只有形状校验

`chapterExecutionPlanPatchSchema` 管的是形状。它拦不住：

| 越界 | 后果 |
|---|---|
| 指向偏离章自己 | 直接违反「只改下游」的语义 |
| 指向已经写完的历史章 | 同上，且改的是作者已经定稿的部分 |
| 指向不存在的章节 | 此前只在 apply 期由 `missing` 检查发现 |
| 同一章两条补丁 | **静默覆盖**——applier 用 `new Map(patches.map(...))` 建索引，后一条盖掉前一条；`missing` 检查看不见，因为两个 order 都命中章节 |

修复：边界规则收进 `ChapterExecutionPatchBoundary`，**单一来源、两处调用**——
编辑期让作者当场知道，applier 侧作为最终可执行载荷的边界（复审 M4 的口径）。
`applyPatchToDocument` 的 `appliedOrders` 随之成为死代码，一并清掉。

因此原先「数字输入靠编辑期校验兜底」的说法在修复前**不成立**，现在成立。
数字输入保留为次要入口，主路径仍是 AI 建议。

### 两处判断的结论

1. **建议 prompt 声明 `management: { productPrompt: true, editModes: ["readonly"] }`。**
   采纳复审意见：能在目录中检索不等于完成产品 Prompt 管理声明，而它的理由文本
   直接呈现给作者、供其决策。只开 `readonly`——输出必须过确定性 sanitizer，
   开槽位编辑会让边界失控。
2. **数字输入保留为次要入口，不新增端点**，前提是上述后端校验补齐。

### 新增用例

| # | 用例 | 层级 |
|---|---|---|
| G1 | 当前章 / 历史章 / 不存在章节 / 重复章节，编辑期全部被拒且不落库 | 真实 SQLite |
| G2 | 真实修正后执行「全部批准」，该条仍 rejected，其余项正常批准，信封变部分批准 | 真实 SQLite |
| G3 | 显式批准已修正条目被拒，且信封保持可审阅 | 真实 SQLite |
| B1–B7 | 边界规则本身（含「历史章存在但不在下游」与全部违规都要报出） | 单测 |
| F1–F2 | 界面在条目已修正 / 修正失败两种情况下的操作可见性 | 组件逻辑 |

G1–G3 都验证过：回退审批修复后三条全部转红。

修复后：integration `151 / 149 通过 / 2 跳过 / 0 失败`（干净重建）；
fast 39 条既有失败、双向差集为空；client 190 项、4 条既有移动端布局失败与基线一致。

## 验收

- integration 保持 0 失败；fast 与本批次前的对照双向差集为空（差集非空时按
  `CODE_REVIEW_CHAPTER_DIVERGENCE.md` 5d 的更正流程追查，不能只看总数）。
- **跑 integration 前干净重建**（`rm -rf server/dist`），旧 `dist` 会掩盖加载期问题。
- 视觉验收由用户完成；代码侧只做 typecheck 与组件逻辑测试。
