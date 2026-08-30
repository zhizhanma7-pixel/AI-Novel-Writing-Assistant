# Phase 3 实施计划 — SillyTavern 资产导入

> 分支：待建 `codex/sillytavern-import`（从 `beta` 拉出）
> 设计文档：`C:\class_shit\ainovel_workflow_guide\02_SILLYTAVERN_COMPAT.md`
> 验收口径：`05_ROADMAP_AND_ACCEPTANCE.md` 的 Phase 3 三节
> 前置：Phase 2（2A/2B/2C）已全部合入 `beta`

## 0. 方向修正（**先读这一节**）

设计文档把 Character Card / World Book / Preset 描述成并列的三块，Character Card
那节给的是一张纯角色映射表（`description → Character.stableProfile`）。

**不要照抄这个并列关系。** 用户 2026-08-29 明确定调：

> SillyTavern 宝贵的是世界观 / 文风预设；角色卡反倒不像是单独描述的一个「角色」。

照格式做会做出一个低价值的角色导入器：SillyTavern 用户习惯把大量世界设定、语气
要求和写作约束塞进 character card 的 `description` / `scenario` 里，把它们整块写进
`Character.stableProfile` 等于把世界观埋进一个角色实体。

因此本阶段的主次是：

| | 定位 | 归宿 |
|---|---|---|
| **World Book** | 主线 | 既有 Knowledge / RAG + 世界结构 |
| **Preset** | 主线 | 既有 `StyleProfile` + `StyleBinding` |
| **Character Card** | **素材来源**，不是第三条主线 | 解析后**分流**到上面两条，角色事实才进角色 |

## 1. 仓库现状（侦察结论）

不需要新建平行体系，三块都有现成归宿：

| 需求 | 既有承接 | 匹配度 |
|---|---|---|
| Preset 的文风规则 | `StyleProfile.narrativeRulesJson` / `characterRulesJson` / `languageRulesJson` / `rhythmRulesJson` | 高 |
| Preset 的来源追踪 | `StyleProfile.sourceType` / `sourceRefId` / `sourceContent` | 高，已有字段 |
| Preset 的启用与优先级 | `StyleBinding.priority` / `weight` / `enabled` | 高 |
| World Book entries | `KnowledgeDocument` + `KnowledgeDocumentVersion`（含索引状态） | 高 |
| entries 的绑定 | `KnowledgeBinding.targetType` = `novel` / `world` | 高，枚举已够 |
| 导入前预览与审阅 | `ChangeProposal` 信封 + 2B 的 `outlineImport` 模式 | 高 |

**缺口只有两处**，都不该靠扩表解决：

- `StyleBindingTargetType` = `novel` / `chapter` / `task`，**没有 agent**。
- `StyleProfile` 没有 `temperature` / `topP` 这类生成参数字段。

## 2. 范围决策（用户已授权「随你，加速进度」）

### D1 — per-agent preset 本阶段不做

设计文档提到 Planner / Writer / Reviewer 各自选 Preset。现有 `StyleBinding` 绑的是
novel / chapter / task，改成支持 agent 要动枚举、迁移和所有消费方。

**Preset 的核心价值（文风）通过 novel 级绑定就能拿到**，per-agent 是精细化，不是
入场券。本阶段绑到 novel，per-agent 登记为后续项。

### D2 — 生成参数导入但不接管模型路由

`temperature` / `topP` / `frequencyPenalty` 等原样存进 `StyleProfile` 的既有
JSON 字段作为参考并在界面展示，**不写进模型路由、不改变实际调用参数**。

理由：模型选择与参数是另一套已有系统（`modelRouter` / `APIKey` / 模型路由设置），
让一份导入的 preset 静默改写它会让用户的模型配置以最难察觉的方式失效——和 2A 的
H1 是同一类错误（用一个来源覆盖另一个系统的权威配置）。

### D3 — 角色卡走「解析 → 分流提案 → 用户确认」

复用 2C.7 刚验证过的形态：AI 只产出建议，**不直接写状态**，落库走用户确认。

```
上传 V2/V3 JSON 或 PNG
  → 确定性解析（含 PNG tEXt chunk 提取）
  → 分流建议：哪些是世界设定 / 文风约束 / 角色事实
  → 用户逐条确认去向
  → 各自走 Knowledge / StyleProfile / Character 的正式写入
```

**分流建议由 AI 给，但判定边界是确定性的**：解析与字段提取不经过模型，
只有「这段描述属于世界设定还是角色事实」这类语义判断才问模型，且必须过 sanitizer。

### D4 — World Book 默认 Semantic Mode

设计文档的 Preserve Mode（保留 ST 触发逻辑）与本仓库的 RAG 检索是两套并行机制，
同时维护会让「为什么这条没被检索到」永远说不清。**本阶段只做 Semantic Mode**，
`keys` / `secondary keys` 转成检索提示保留在文档元数据里，不实现关键词注入引擎。
Preserve Mode 登记为后续项。

## 3. 交付切分

| 批次 | 内容 | 用户可见 |
|---|---|---|
| **S0** | 本计划（纯文档） | 否 |
| **S1** | 解析层：V2/V3 JSON + PNG 内嵌 metadata + 版本探测 + 无损原文留存 | 否 |
| **S2** | Preset → `StyleProfile` 导入与 novel 级绑定 | **是** |
| **S3** | World Book → `KnowledgeDocument` 导入、检索提示与绑定 | **是** |
| **S4** | 角色卡分流提案：建议、审阅、三路写入 | **是** |
| **S5** | 统一导入页面与错误恢复 | **是** |

S1 先行且独立可测——解析是纯函数，能在没有任何写入路径时就锁死格式边界。
S2 早于 S3：`StyleProfile` 的承接面更完整，能最快跑通一条端到端。

## 4. 测试矩阵

| # | 用例 | 层级 |
|---|---|---|
| P1 | V2 / V3 JSON 各字段解析，未知字段进 `rawImportedMetadata` 不丢失 | 单测 |
| P2 | PNG 内嵌 metadata 提取；损坏 PNG、缺 metadata、非角色卡 PNG 均给可读错误 | 单测 |
| P3 | 未知 / 更高版本 ST 格式：降级解析并明确告知，不静默丢字段 | 单测 |
| P4 | Preset 导入产出 `StyleProfile`，`sourceType` 标为 sillytavern，可回溯原文 | 真实 SQLite |
| P5 | 生成参数被保留但**不改变**实际模型调用参数 | 真实 SQLite |
| P6 | World Book entries 进 Knowledge，`enabled: false` 的条目不进检索 | 真实 SQLite |
| P7 | 重复导入同一 worldbook 不产生重复条目 | 真实 SQLite |
| P8 | 角色卡分流建议只读，不写任何库（照 2C.7 的全表快照回归） | 真实 SQLite |
| P9 | 20MB 级文件不撑爆内存（Phase 6 也列了这条） | 集成 |

P8 是 D3 的守门用例，形态直接照搬 `chapterDivergencePlanSuggestionRealSqlite`。

## 5. 硬规则对照

- 新增 prompt 必须进 `server/src/prompting/` 并在 registry 注册，声明
  `management`；分流建议属产品级 prompt（理由直接呈现给用户），按 2C.7 的结论
  声明 `productPrompt: true` + `editModes: ["readonly"]`。
- 双 Prisma schema（`schema.prisma` 与 `schema.sqlite.prisma`）必须同步。
  **本阶段目标是不加新表**；若确实要加，两份都改并说明为什么无法复用既有模型。
- 分支路径 `codex/sillytavern-import → beta → main`。
- S2–S5 有用户可见能力，提交前走 `readme-release-updater`。
- 跑 integration 前干净重建（`rm -rf server/dist`），旧 `dist` 会掩盖加载期问题。

## 6. 风险

| 编号 | 风险 | 处置 |
|---|---|---|
| R1 | 角色卡分流判错，把角色事实塞进世界观或反之 | 建议默认不采纳、逐条确认；原文永远保留可回溯 |
| R2 | ST 格式版本演进，解析器落后 | 版本探测显式化，未知版本降级并告警，不假装解析成功 |
| R3 | 导入的 preset 与用户既有 StyleProfile 冲突 | 导入产生新 profile 而非覆盖；绑定由用户显式启用 |
| R4 | worldbook 条目量大冲击 RAG 索引 | 走既有索引队列与状态机，不新建索引路径 |
