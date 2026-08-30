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
入场券。

**口径更正（复审指出前后矛盾）：** 本阶段的导入**一律不自动创建绑定**，S2/S3/S4
都只产出资产，绑定由用户在既有的写法绑定 / 知识绑定界面完成。此处原先写的
「本阶段绑到 novel」与交付切分表冲突，以「不自动绑定」为准。

**per-agent 仍未做，而 Roadmap 的 Phase 3 Preset 验收里列了它**——这构成一个
未满足的验收条件，不是可以静默延期的实现细节。是否把它纳入 Phase 3、还是
显式改写验收口径，需要在封板前定，见本文末尾的待决口径。

### D2 — 生成参数导入但不接管模型路由

`temperature` / `topP` / `frequencyPenalty` 等原样存进 `StyleProfile` 的既有
JSON 字段作为参考并在界面展示，**不写进模型路由、不改变实际调用参数**。

理由：模型选择与参数是另一套已有系统（`modelRouter` / `APIKey` / 模型路由设置），
让一份导入的 preset 静默改写它会让用户的模型配置以最难察觉的方式失效——和 2A 的
H1 是同一类错误（用一个来源覆盖另一个系统的权威配置）。

### D3 — 角色卡走「解析 → 分流 → 用户确认」

```
上传 V2/V3 JSON 或 PNG
  → 确定性解析（含 PNG tEXt chunk 提取）
  → 切段并给出建议去向：世界设定 / 文风约束 / 角色事实
  → 用户逐段确认
  → 各自走 Knowledge / StyleProfile / Character 的正式写入
```

**S4 实施时的修正：分流建议没有用 AI，全部确定性。**

原计划写的是「AI 给建议、判定边界确定性」。实际做下来，AI 在这里帮不上忙，
反而会添乱：

- 归属明确的字段**根本不需要判断**。`system_prompt` / `post_history_instructions`
  本来就是写作指令，`first_mes` / `mes_example` 是语气样本，`personality` 是角色
  事实，`character_book` 是世界设定——依据「这段来自哪个字段」就能定，不必问模型。
- 真正含糊的只有 `description` 与 `scenario`。而它们含糊，恰恰是因为**只有作者
  知道自己把什么写进去了**。让模型猜，两个方向的错都不便宜：世界设定被判成角色
  事实，世界观就只在这个角色身上生效；角色事实被判成世界设定，它会对所有角色生效。

所以这两个字段按空行切段，逐段标成 `needs_review`，**用户不表态就拒绝导入**，
而不是按默认值悄悄落地。整块二选一也不行——那会逼用户把世界观和角色事实一起
归到同一边，而它们经常就写在相邻两段里。

AI 预判可以作为后续增强（段落很多时省力），但它不是这条链路的前提。
这样 S4 没有引入 LLM 依赖，全部行为可确定性回归。

### D4 — World Book 默认 Semantic Mode

设计文档的 Preserve Mode（保留 ST 触发逻辑）与本仓库的 RAG 检索是两套并行机制，
同时维护会让「为什么这条没被检索到」永远说不清。**本阶段只做 Semantic Mode**，
`keys` / `secondary keys` 转成检索提示保留在文档元数据里，不实现关键词注入引擎。
Preserve Mode 登记为后续项。

## 3. 交付切分

| 批次 | 内容 | 用户可见 | 状态 |
|---|---|---|---|
| **S0** | 本计划（纯文档） | 否 | ✅ `67f6a93` |
| **S1** | 解析层：V2/V3 JSON + PNG 内嵌 metadata + 版本探测 + 无损原文留存 | 否 | ✅ `6911bf9` |
| **S2** | Preset → `StyleProfile` 导入 | 端点就位，无界面 | ✅ `f63c5c9` |
| **S3** | World Book → `KnowledgeDocument` 导入与检索提示 | 端点就位，无界面 | ✅ `c64c21c` |
| **S4** | 角色卡分流：切段、确认、三路写入 | 端点就位，无界面 | ✅ 本批 |
| **S5** | 统一识别入口 + 导入页面 + 错误恢复 | **是** | ✅ 本批，含发布说明 |

绑定在 S2/S3/S4 都不做：写法与知识库各自的绑定接口已经存在，其中知识库那个
还是替换语义（先清空目标的全部绑定），拿它「追加一条」会静默删掉用户已有的绑定。

S1 先行且独立可测——解析是纯函数，能在没有任何写入路径时就锁死格式边界。
S2 早于 S3：`StyleProfile` 的承接面更完整，能最快跑通一条端到端。

## 3b. S5 的两处实施记录

### 统一识别放在服务端

用户手上通常只有「一个从 SillyTavern 导出的文件」，未必分得清类型。`/sillytavern/inspect`
按结构特征确定性识别（spec 标记 → 指令片段/采样参数 → 顶层 entries → 旧版扁平字段），
**并把识别依据一起返回**，认错了用户能看出来。前端不重复一套判断逻辑。

### 路由里的顶层 eager 单例又踩了一次

S5 第一版在三个路由文件里写了顶层 `new XxxImportService()`。这会在模块加载期就
拉起写法、知识库与角色三条服务链，改变整个 app 的初始化顺序——`novelDirectorRiskPolicyRoutes`
因此在 fast 全套件里转红（单跑通过、退回改动前也通过）。

**这与 `7088f77` 修的是同一个坑**（顶层 eager 单例导致加载期问题），只是这次表现为
影响别处的测试而不是自己崩。三处都改成首次调用时创建后，fast 恢复 39 条既有失败、
双向差集为空。

值得记住的是**它是怎么被发现的**：fast 差集非空 → 单跑该文件（通过）→ `git stash`
退回改动前复跑全套件（通过）。三步都做完才敢断定"与我有关"。只看单跑或只看一次
差集，都会把它当成套件的既有不确定性放过去。

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
| P8 | 角色卡分流规划只读，不写任何库（照 2C.7 的全表快照回归） | 真实 SQLite |
| P10 | 需要判断的段落未表态即拒绝导入；未知段落 id 拒绝 | 真实 SQLite |
| P11 | 有内容要进角色却没指定小说即拒绝 | 真实 SQLite |
| P12 | 一张卡三路分流后各归其位，选择跳过的段落不出现在任何去处 | 真实 SQLite |
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

## 5b. 待决的验收口径（复审提出，封板前必须定）

两条 Roadmap 验收条件与当前实现不一致，都不是纯实现问题，需要先定口径：

### 口径一 — Character Import Proposal

`02_SILLYTAVERN_COMPAT.md` 第 3 节明确写着「**导入不要直接写正式角色库**」，
流程是 `Import Proposal → User Review → Commit`；Roadmap 的 Character Card
验收里也列了 `import proposal`。

当前实现是：服务端给出分流方案 → 用户在页面上逐段确认 → **直接写三个子系统**。
用户审阅确实发生了，但它只存在于前端会话里：没有持久化的提案记录，不进
`DirectorEvent` 账本，中断后无法续做，事后也无法追溯谁把哪一段导到了哪。

不能简单套用既有 `ChangeProposal`：那套信封绑 `novelId` 且面向小说状态，
而世界设定与写法资产是**全局**的，角色才是小说范围的。三路里只有一路适配。

可选口径：
1. 只把**角色**那一路走 `ChangeProposal`，世界/文风保持直接写入（语义最正，
   但一次导入会分成"立即生效"和"待审"两种结果，体验割裂）；
2. 为导入单开一份轻量提案记录（满足可追溯与可续做，但等于新增一套平行审批）；
3. 明确改写 Phase 3 的验收口径，承认"页面内逐段确认"即为 review，放弃提案账本。

### 口径二 — per-agent preset assignment

Roadmap 的 Preset 验收列了 `per-agent assignment`（Planner / Writer / Reviewer
各自选 preset）。现有 `StyleBindingTargetType` 只有 `novel` / `chapter` / `task`，
支持它要改枚举、迁移并触及全部消费方。

当前是延期。要么纳入 Phase 3，要么明确改写验收口径——不能只在实施计划里写
"后续项"就当作满足了。

## 6. 风险

| 编号 | 风险 | 处置 |
|---|---|---|
| R1 | 角色卡分流判错，把角色事实塞进世界观或反之 | 建议默认不采纳、逐条确认；原文永远保留可回溯 |
| R2 | ST 格式版本演进，解析器落后 | 版本探测显式化，未知版本降级并告警，不假装解析成功 |
| R3 | 导入的 preset 与用户既有 StyleProfile 冲突 | 导入产生新 profile 而非覆盖；绑定由用户显式启用 |
| R4 | worldbook 条目量大冲击 RAG 索引 | 走既有索引队列与状态机，不新建索引路径 |
| R5 | 角色卡三路写入不是原子的：跨知识库 / 写法 / 角色三个子系统，无法放进一个事务 | 能提前发现的校验全部前置（角色缺 novelId、未知段落、未表态段落）。仍可能出现世界设定写成功而角色写失败，此时没有回滚。与口径一相关：走提案账本能顺带解决可追溯与续做 |
| R6 | 世界设定文档按标题幂等，同名不同卡会互相覆盖成版本 | 分流产出的标题是 `{卡名} · 世界设定`；两张角色重名的卡第二次导入会变成第一份的新版本。未解决 |
