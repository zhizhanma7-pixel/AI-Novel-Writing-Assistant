# Phase 4 实施计划 — Skills

> 前置：`docs/dev/ARCH_ANALYSIS_SKILLS.md`（Step 1 架构分析）
> 口径：Skills 是既有写法引擎的「可携带打包 + 任务匹配 + 注入可见」层，**不新建资产表**。
> 该口径由用户于 2026-09-01 拍板，显式覆盖 `03_SKILLS_INTEGRATION.md` §6 对 Skill / Preset 的切分。

## Goal

让作者能把自己炼化出来的写法**装成一个文件夹拷给别人**，也能装进别人的；并让这些写法在写具体章节时**自动命中**，而不是每次手动绑定。

现状缺口只有三处（其余能力写法引擎已交付，见架构分析 §1）：

1. `StyleProfile` 没有任何导出端点，炼出来的写法锁死在本地
2. 推荐是按**作品**（`StyleRecommendationService.recommendForNovel`），不是按**章节任务**
3. 命中结果在 prompt 预览里看不出来源

## Scope

允许改动：

```text
shared/types/skillPackage.ts            （新增）
shared/types/novel.ts                   （仅在需要时复用导出 ModelRouteTaskType）
server/src/services/styleEngine/**      （扩展，不新建并行服务）
server/src/services/skillPackage/**     （新增：格式解析/序列化）
server/src/routes/styleEngine.ts        （新增导出/导入端点）
server/src/prisma/schema.prisma
server/src/prisma/schema.sqlite.prisma
server/src/prisma/migrations/**
server/src/prisma/migrations.sqlite/**
server/tests/**
client/src/pages/styleEngine/**         （S4）
docs/dev/**、docs/wiki/**、docs/releases/**
```

## Non-goals

明确不做，写在这里是为了后续复核有据可依：

- **不新建 `SkillAsset` / `SkillBinding` 表**。Skill 就是 `StyleProfile` + `StyleBinding`，`sourceType` 取新值 `imported_skill`
- **不新建第二套提取 / 改写 / 注入路径**。`StyleExtraction*`、`StyleRewriteService`、`style_contract` 上下文块已存在
- **不自己写上下文预算裁剪**。`prompting/core/contextSelection.ts` 已实现按 `maxTokensBudget` 装箱与 `dropOrder` 丢弃
- **不执行任何脚本**。解析器纯只读，不 eval、不 require 包内文件、不发网络请求
- **不引入模型参与匹配**。规范 §5 明确第一版只做 tags / task type / 手动指定 / 项目默认
- **不把 references / templates / examples 注入上下文**。它们随包携带、可回溯，但只有 `instructions` 与四维规则进提示词（架构分析 R3）
- **不做工具型 Skill**（规范 §10 的 permission / sandbox / tool allowlist），那是独立大版本

## 包格式

```text
skill-name/
├─ SKILL.md
├─ references/*.md
├─ templates/*.md
└─ examples/*.md
```

`SKILL.md`：

```markdown
---
name: 慢热恋爱节奏
description: 距离变化、误读、停顿与递进的安排方式
category: 恋爱
tags: 慢热, 情绪递进
applicableGenres: 都市, 校园
applicableTasks: writer, repair
---

## 叙事规则
...

## 人物规则
...

## 语言规则
...

## 节奏规则
...
```

**frontmatter 手写解析，不引入 YAML 依赖**：只支持 `key: value` 与逗号分隔列表，遇到不认识的键**保留原值**进 `unknownFields`（沿用 Phase 3「认不出的字段一律留下并如实告知」的做法，见 `docs/wiki/workflows/sillytavern-import.md`）。

`applicableTasks` 的取值域**复用 `ModelRouteTaskType`**（`shared/types/novel.ts:213`：planner / writer / review / light_review / critical_review / repair / replan / state_resolution / summary / fact_extraction / chat）。`modelRouter.normalizeTaskType` 已把 `chapter_drafting` 之类别名映射回该域，**不自造字符串**。

### 与 StyleProfile 的字段映射

| 包 | StyleProfile |
|---|---|
| frontmatter `name` / `description` / `category` | 同名字段 |
| `tags` | `tagsJson` |
| `applicableGenres` | `applicableGenresJson` |
| `applicableTasks` | `applicableTasksJson`（**新增列**） |
| `## 叙事规则` 等四节 | `narrativeRulesJson` / `characterRulesJson` / `languageRulesJson` / `rhythmRulesJson`，各存 `{ summary }`（与 SillyTavern 卡片分流一致） |
| SKILL.md 正文全文 | `analysisMarkdown` |
| references / templates / examples | S2 决定存放位置；S1 只解析成内存结构 |
| — | `sourceType = "imported_skill"` |

## 交付切分

| 批次 | 内容 | 用户可见 |
|---|---|---|
| **S1** | 包格式契约 + 解析/序列化（纯函数）+ `applicableTasksJson` 迁移 | 否 |
| **S2** | 导出端点 + 导入链路（validate → preview → commit），无界面 | 端点就位 |
| **S3** | 任务匹配 + 命中结果进上下文块 + 预览区分来源 | 否（验收靠它） |
| **S4** | 导入/导出界面 + 启用禁用 + description 展示 | **是** |

S1 独立可测：解析与序列化是纯函数，能在没有任何写入路径时先锁死格式边界。这与 Phase 3 的 S1 同理。

## Acceptance Criteria

对应 `05_ROADMAP_AND_ACCEPTANCE.md` 的 Phase 4 验收：

```text
作者把 mystery-pacing/ 文件夹拖进来
↓
预览显示 name / description / 四维规则 / 认不出的字段
↓
导入后成为一条写法资产（sourceType=imported_skill）
↓
可启用 / 禁用；列表显示 description
↓
写第 22 章（task=writer）时自动命中，无需手动绑定
↓
Prompt 预览能看到它被注入，并标明来源是「自动命中」而非「人工绑定」
↓
导出该资产得到同构的文件夹，能再装回去
```

逐条可判定：

- **往返一致**：导出再导入，四维规则与 frontmatter 不丢字段、不改值
- **未识别字段**：包里多出的键在预览中如实列出，不静默丢弃
- **不执行脚本**：包内含 `.sh` / `.py` / 可执行文件时，解析器忽略且预览明示「不会执行」
- **任务匹配**：`applicableTasks` 含 `writer` 的资产在章节写作时命中；不含时不命中
- **预算**：命中多条时走 `contextSelection`，人工绑定优先于自动命中被保留
- **不污染 Story State**：包内不得携带具体剧情事实（见风险 R4）

## 风险

| 编号 | 风险 | 处置 |
|---|---|---|
| R1 | 导入是否走 `ChangeProposal` | **不走**。沿用 Phase 3 口径：`ChangeProposal` 是小说范围信封，写法是全局资产。规范 §8 的 `Import Proposal` 按此覆盖 |
| R2 | **顶层 eager 单例**。`IMPLEMENTATION_PLAN_SILLYTAVERN_IMPORT.md` §3b 记录过：路由里写顶层 `new XxxService()` 会改 app 初始化顺序，让**别处**测试转红；Phase 3 合并复核中 `autoDirectorFollowUpRoutes` 又撞了一次 | 新服务实例一律首次调用时创建 |
| R3 | 附件全文进 JSON 列会撑大行、拖慢查询 | S2 决定存放位置；无论如何**不进上下文** |
| R4 | 导入他人包**污染本书剧情设定**。「伏笔至少铺三章」属方法论可分享；「本书禁止用梦境收尾」属书级约束，不该随包散播 | 预览阶段以警示呈现，**不自动拦截**（误判代价高于漏判，同 Phase 3 未识别字段的处理） |
| R5 | 包里带原作人名等源作实体 | 既有 `styleGenerationSanitizer` 在生成时剥离；导入预览应显示将被剥离的实体，让作者看清装进来的是什么 |
| R6 | 自动命中导致上下文膨胀 | 走 R3 的预算；命中条数设上限；人工绑定优先级高于自动命中 |

## 待决（不阻塞 S1）

1. 自动命中要不要支持 per-agent（Writer / Planner / Reviewer）？`StyleBinding` 已有该维，影响 S3 接口形状
2. references / templates / examples 的存放位置（S2）
3. 命中条数上限的具体数值（S3）
