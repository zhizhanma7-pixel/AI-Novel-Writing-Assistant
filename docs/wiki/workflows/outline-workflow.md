# 自由文本大纲导入与忠实润色

## Background

写作新手通常只有一段自由文本、按章记下的事件或不完整故事顺序。系统需要帮助补足因果、情绪、转场和拆章，但不能把“润色”变成未经说明的改写，也不能另建一套与卷章规划平行的大纲来源。

## Decision

自由文本大纲采用“解析 → 忠实润色 → Change Proposal → 正式规划写入”主链。AI 负责结构化理解和创作建议；确定性代码负责事件身份、保留义务、顺序、已有正文保护、stale 检测和事务写入。

正式 source of truth 是 VolumePlan、VolumeChapterPlan 与 Chapter。`Novel.structuredOutline` 只作为兼容投影，由正式 applier 在同一事务末尾刷新，不得反向覆盖卷章规划。

## Current Rule

### Parse Contract

`novel.outline.import.parse` 把原文转换为 `NormalizedOutlineDraft`。每个核心事件必须带：

- 稳定且唯一的事件 ID；
- 原文证据和原始顺序；
- 可选的推断章序；
- 角色、因果前置、结果与置信度。

解析 Prompt 不得补造用户没有表达的事件。无法确定的内容通过低置信度表达，不使用关键词或正则 fallback 猜测故事语义。

### Fidelity Contract

- Strict 是默认值：核心事件、原顺序、结局、关系走向和关键揭露点形成 preservation obligations。
- Balanced 允许局部结构优化，但结构影响必须进入 Proposal warnings。
- Director 允许主动重构，但 major 变化和已有正文影响仍需人工审阅。

Strict 不只依赖 Prompt 文案。`faithfulPolish` 的 post-validation 同时检查全部核心事件是否被声明保留、是否出现在 proposed chapters，以及首次出现顺序是否一致。失败触发一次受控 semantic retry；仍失败则停止，不创建残缺 Proposal。

### Proposal And Dependency Contract

Outline 导入只能通过 2A `AiChangeProposalProducerService` 进入 Change Proposal。不得新增第二套审批状态、队列或抽屉。

依赖影响由服务端根据当前 Chapter 重新计算：

- 对已有正文的标题或规划变化为 major；
- 现有章节 source ref 带内容 hash，审批前正文变化会触发 stale；
- 模型提供的 impact 可补充解释，但不能降低服务端确定的风险。

### Apply Contract

批准的 `outline_plan_update` 由 outline-owned applier 在 State Commit 事务中执行：

1. upsert 正式 VolumePlan 和 VolumeChapterPlan；
2. 按章节序号更新或创建 Chapter；
3. 保留 Chapter.content，不删除或移动已有正文；
4. 保留提案未覆盖的已有章节；
5. 从最终 Chapter 列表刷新 `Novel.structuredOutline` 兼容投影。

任一写入失败会回滚整个信封的 domain-state apply，不得把 ledger-only 状态冒充执行成功。

## Failure Modes

- Strict 输出漏掉事件但 schema 合法：由 post-validation 拒绝并触发 semantic retry。
- AI 把事件声明为保留但没有放入任何章节：同样视为保留失败。
- AI 自报 minor 但影响已有正文：服务端 dependency analysis 升级为 major。
- 审批期间正文发生变化：chapter content hash 触发 stale，要求重新生成或审阅。
- applier 直接删除不在新大纲里的章节：违反正文保护与 source-of-truth 合同；只能保留并通过后续明确提案处理。
- route 或 Prompt 直接写 Prisma：绕过 Proposal、事务和审计边界，禁止使用。

## Related Modules

- `shared/types/outlineWorkflow.ts`
- `server/src/prompting/prompts/novel/outlineWorkflow.prompts.ts`
- `server/src/services/novel/proposal/outline/application/OutlineImportProposalService.ts`
- `server/src/services/novel/proposal/outline/application/OutlinePlanProposalApplier.ts`
- `client/src/pages/novels/components/outlineImport/OutlineImportPanel.tsx`
- `client/src/pages/novels/components/changeProposal/`

## Source Documents

- `docs/dev/IMPLEMENTATION_PLAN_OUTLINE_WORKFLOW.md`
- `docs/dev/IMPLEMENTATION_REPORT_OUTLINE_WORKFLOW.md`
- `docs/wiki/workflows/change-proposal-review.md`
