# Phase 4 架构分析 — Skills

> 依据：`ainovel_workflow_guide/03_SKILLS_INTEGRATION.md`、`05_ROADMAP_AND_ACCEPTANCE.md` 的 Phase 4 验收。
> 角色分工按 `AGENT_COLLABORATION_GUIDE.md`：本文件是 Claude Code 的 Step 1 产出，**不含代码改动**。

## 0. 口径决策（2026-09-01，用户拍板）

**Skills 不是一种新资产类型，而是既有写法引擎的「可携带打包 + 任务匹配 + 注入可见」层。**

这一条**显式覆盖** `03_SKILLS_INTEGRATION.md` §6 对 Skill 与 Preset 的切分。原规范把 Skill 定义为独立于 Preset 的「方法论」资产：

> Preset：克制、轻小说、低解释密度
> Skill：慢热恋爱场景应如何安排距离变化、误读、停顿和递进

用户对 Skills 的实际定义是「文风 / 润色 + 修改，作者可以自己炼化别人的优秀文笔，以及剧情设定上的偏好」。这与 `StyleProfile` 的职责重合，前人已经把这条链路做通了。按 `AGENT_COLLABORATION_GUIDE.md` Decision 001（扩展既有基础设施，不造并行系统）与第 12 条（遇到 upstream 已有实现优先复用），**不新建 `SkillAsset` 表**。

记录这条覆盖是必要的：否则后续读者会照规范 §6 再拆一次，导致两套提取 / 改写 / 注入并存。

## 1. 已经做完的部分（不要重做）

用户描述的能力，写法引擎大部分已经交付：

| 用户描述 | 现有实现 |
|---|---|
| 自己炼化别人的优秀文笔 | `POST /style-extractions/from-text`、`/style-extraction-tasks/from-text`（异步）、`/style-profiles/from-text`、`/style-profiles/from-extraction` |
| 文风 | `StyleProfile` 四维规则：`narrativeRulesJson` / `characterRulesJson` / `languageRulesJson` / `rhythmRulesJson`（`schema.prisma:1701-1704`） |
| 润色 + 修改 | `StyleDetectionService`（检测）+ `StyleRewriteService`（改写）+ `PostGenerationStyleReviewRunner`（生成后审校） |
| 学别人但不抄别人 | `styleGenerationSanitizer` 把源作实体从写手上下文剥离；正文若泄漏由 `chapterRuntimePipeline` 触发整章重写 |
| 启用 / 禁用、作用范围、优先级 | `StyleBinding`：`targetType`（novel / agent / chapter / task）+ `priority` + `weight` + `enabled`；Phase 3 刚补齐 per-agent |
| 按题材 / 标签推荐 | `StyleRecommendationService.recommendForNovel`，已按 `category` / `tags` / `applicableGenres` 匹配 |
| 注入写手上下文 | `chapterContextBlocks.ts:499` 以 `id: "style_contract"` / `group: "style_contract"` / `priority: 74` 的上下文块注入 |

**结论**：Phase 4 的绝大部分「能力」不需要新建，需要的是**让它可携带、会自动命中、看得见**。

## 2. 真正缺的三件事

### 2.1 可携带的包格式（核心缺口）

现状：`StyleProfile` **没有任何导出能力**（`src/routes/styleEngine.ts` 中无导出端点）。炼出来的写法锁在本地库里，无法拷给别人，也无法从别人那里装进来。

规范里的目录结构正是这个包：

```text
skill-name/
├─ SKILL.md          → StyleProfile 的 name/description/analysisMarkdown + 四维规则
├─ references/       → 参考资料
├─ templates/        → 结构模板
└─ examples/         → 示例片段（对应 sourceContent / extractedFeatures）
```

需要：**导出**（StyleProfile → 文件夹/ZIP）与**导入**（文件夹/ZIP → StyleProfile）双向。导入侧可直接复用 Phase 3 的 inspect → preview → commit 骨架。

### 2.2 按任务匹配（Skill Router）

现状：`recommendForNovel` 是**按作品**推荐，且要人工确认绑定。规范 §4 要的是**按章节任务**自动命中：

```text
Chapter 22 → 检测到 romance-dialogue / slow-burn-pacing → 注入
```

需要：在既有推荐逻辑上补 `applicableTasks` 维度 + 章节任务侧的调用点。规范 §5 明确第一版只做 tags / task type / 手动指定 / 项目默认，**不引入模型参与选择**。

### 2.3 注入可见

验收要求「Prompt preview 可看到 Skill 已被注入」。`prompting/workbench/`（`previewContextBuilder` / `writerPreviewContext`）已按上下文块渲染，命中的写法只要作为上下文块进入，预览**自动获得**该能力；需要确认块标题可读、并区分「人工绑定」与「自动命中」两种来源。

## 3. 上下文预算：已有实现，不要重造

规范 §4 的 `Context Budget Selection` 在仓库里已经实现：

- `prompting/core/contextBudget.ts:11` — `createContextBlock({ id, group, priority, required, allowSummary, content })`
- `prompting/core/contextSelection.ts` — 按 `policy.maxTokensBudget` 装箱，超预算按 `dropOrder` 分组丢弃，支持降级为摘要

自动命中的写法可能一次命中多条，**必须**走这套预算，且应排在人工绑定之后被丢弃（人工绑定优先级更高）。这是最容易被重复造轮子的一处。

## 4. 需要新增的部分

| 项 | 说明 | 归属 |
|---|---|---|
| `StyleProfile.applicableTasksJson` | 新增一列，与 `applicableGenresJson` 同构；**不是新表** | Codex |
| 包格式定义与序列化 | `SKILL.md` 的 frontmatter + 正文约定；纯函数、只读、**不 eval** | Codex |
| 导出端点 | StyleProfile → 文件夹/ZIP | Codex |
| 导入链路 | 复用 Phase 3 inspect/preview/commit 骨架 | Codex |
| Task Matcher | 在 `StyleRecommendationService` 上扩 `applicableTasks` 维度 | Codex |
| 命中结果进上下文块 | 新 group，接 `contextSelection` 预算；与 `style_contract` 的关系见 §3 | Codex |
| 预览区分来源 | 人工绑定 vs 自动命中 | Codex |
| 回归测试 | 协作指南第 11 条要求每阶段至少一组 | Codex |

**明确不新增**：`SkillAsset` 表、第二套提取服务、第二套改写服务、第二套注入路径。

## 5. 边界：Skill / Story State

规范 §7 的这条边界**依然成立**，不受 §0 覆盖影响：

Skill 可以说「写悬疑揭露时避免一次给出全部答案」；不能声明「凶手是张三」——后者属于 Story State（`CanonicalState` / 提案体系）。

用户提到的「剧情设定上的偏好」需要在实施计划里再切一刀：

- **写作方法论层面**的偏好（如「伏笔至少铺三章再回收」）→ 属 Skill，落在 `narrativeRules`
- **本书具体约束**（如「本书禁止用梦境收尾」）→ 更接近书级合约 / Story State，不应塞进可分享的包，否则把某一本书的设定散播给了所有作品

这条**建议在实施计划里明确**，否则导入别人的包会连带污染自己的剧情设定。

## 6. 风险

| 编号 | 风险 | 处置建议 |
|---|---|---|
| R1 | **导入走不走 Proposal**。规范 §8 写了 `Import Proposal → Commit`，但 Phase 3 已确立：全局资产（写法、世界设定）不进提案，只有小说范围的角色进——`ChangeProposal` 是小说范围信封。写法是全局资产。 | 建议**不走提案**，沿用 Phase 3 口径。否则要为全局资产另造信封，违反 Decision 001 |
| R2 | **顶层 eager 单例**。`IMPLEMENTATION_PLAN_SILLYTAVERN_IMPORT.md` §3b 记录过：路由文件里写顶层 `new XxxService()` 会改变 app 初始化顺序，让**别处**测试转红。本轮 Phase 3 合并复核中 `autoDirectorFollowUpRoutes` 再次出现同类顺序干扰。 | 新路由的服务实例**必须**首次调用时创建。这是已经重犯过的坑 |
| R3 | 导入他人包时**源作实体泄漏**。既有 `styleGenerationSanitizer` 只在生成时剥离，包本身仍可能带原作人名 | 导入预览应显示将被剥离的实体，让作者看清自己装进来的是什么 |
| R4 | 自动命中导致上下文膨胀 / 与人工绑定冲突 | 必须走 §3 的预算；命中条数设上限；人工绑定优先级高于自动命中 |
| R5 | **规范 §6 被覆盖后无人知晓**，后续有人照原文再拆一次 | 已在 §0 记录；实施计划应再引用一次 |
| R6 | 二阶段工具型 Skill（规范 §10）需要权限模型与沙箱 | MVP 不做；解析器现在就要保证只读，为将来留边界 |

## 7. 建议的交付切分

按协作指南「数据层先于 UI 层」：

| 批次 | 内容 | 用户可见 |
|---|---|---|
| S1 | 包格式定义 + `SKILL.md` 解析/序列化（纯函数，可独立测）+ `applicableTasksJson` 迁移 | 否 |
| S2 | 导出端点 + 导入链路（validate → preview → commit），无界面 | 端点就位 |
| S3 | Task Matcher + 命中结果进上下文块 + 预览可见性 | 否（验收靠它） |
| S4 | 导入/导出界面 + 启用禁用 + description 展示 | **是** |

S1 独立可测的理由与 Phase 3 的 S1 相同：解析与序列化是纯函数，能在没有任何写入路径时先锁死格式边界。

## 8. 待决问题

1. **R1**：导入走不走 `ChangeProposal`？（建议：不走）
2. 自动命中的写法要不要支持 per-agent（Writer / Planner / Reviewer）？`StyleBinding` 已有这一维，Matcher 是否也按环节命中，会影响 S3 的接口形状
3. `applicableTasks` 的取值域从哪来？应复用既有 task type 常量，不自造字符串——需要 Codex 在实施计划里指明来源
4. §5 那条「本书具体约束 vs 可分享方法论」的切法

## 9. 下一步

按协作指南 Step 2，下一份是 `IMPLEMENTATION_PLAN_SKILLS.md`（Goal / Scope / Non-goals / Acceptance Criteria）。本文件不预先替它决定实现细节。

---

**附：Phase 3 合并遗留（会影响 Skills 的测试基线）**

`beta` 当前有 8 条**自身继承**的红（已逐条双侧溯源，非 SillyTavern 集成引入）：

- `director root stays limited to compatibility facades` — beta 把非外观层文件放进 director 根目录却没更新自己的边界测试
- `startPipelineJob persists maxRetries as a single repair pass`
- `AI proposal producer enforces L1/L3 policy on real SQLite` — schema 要求 `autoRetryBudget`，而全仓库无任何地方产出该字段
- 客户端 5 条 — beta 新增 `market-radar` 路由但未补 CSS 落点与契约测试；progress panel query keys

建议 Skills 开工前先清干净，否则新增测试的绿红判断会被既有噪声干扰。
