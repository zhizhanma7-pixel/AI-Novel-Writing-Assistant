# Change Proposal 审阅与执行

Change Proposal 是 `StateChangeProposal` 的审阅信封，不是新的编排运行时。它负责把一组状态变更、来源、风险和用户可见依据组织成可版本化的提案；正式写入仍由 `StateCommitService` 与 `CanonicalStateVersion` 完成。

## 数据模型

- `ChangeProposal` 保存小说、章节和可选导演任务范围，以及提案类型、版本、状态、来源引用、警告、期望状态和用户可见的 `reasoningSummary`。
- `StateChangeProposal.changeProposalId` 把逐项变更挂到信封。每项包含 path、add/remove/replace 操作、分类、minor/major 严重度、before/after、来源和 accepted/modified/rejected 审阅决定。
- `reasoningSummary` 只能保存面向用户的简短依据，禁止保存隐藏推理或模型 chain-of-thought。
- 再生不会覆盖原提案。新记录的 `version` 加一并通过 `supersedesId` 指向旧记录，旧记录进入 `superseded`。

## 状态机

允许的转换为：

```text
draft -> pending_review -> approved ---------> executed
                         -> partially_approved -> executed
                         -> rejected

draft / pending_review / approved / partially_approved / rejected -> superseded
executed / superseded -> 终态
```

非法转换和期望版本不一致都返回冲突，不会静默覆盖并发审阅结果。

## 审阅规则

- 整体批准时，未单独指定的变更按 accepted 处理；用户预先改写过 payload 的项按 modified 处理。
- 部分批准必须至少提交一条逐项决定，并通过 `unlistedDecision` 显式声明其余项全部接受或全部拒绝；服务端和客户端都不猜测默认决定。
- 拒绝提案会拒绝全部逐项变更。
- draft 或 pending_review 阶段可以编辑 proposed value。编辑值保存在用户编辑字段中，执行时优先使用该值。
- 先通过逐项 PATCH 保存编辑值后，审批可以只提交该项的 `modified` 决定；如果服务端没有已保存编辑值，`modified` 必须同时携带 edited payload/value，避免把未修改内容误标为人工修改。
- 逐项编辑会在同一事务内校验提案版本、锁定父提案的可编辑状态，并校验逐项归属；如果并发审批先完成，迟到的编辑会返回版本冲突，不会改写已批准内容。
- 批准前和执行前都会检查 stale。来源 artifact 缺失、状态失效、版本/内容变化、依赖版本变化，以及章节内容哈希变化都会阻止继续。

## 执行与旧链路隔离

`ChangeProposalApplyService` 只把 reviewDecision 为 accepted 或 modified 的逐项 ID 交给 `StateCommitService.commitExistingProposals()`。拒绝项不会进入正式状态。所有批准项成功提交后，信封才能进入 `executed`。正式执行前必须在 apply 边界重新评估 Director policy；自动化调用只有在 policy 允许且不要求审批时才能继续，用户在审阅界面明确批准后的调用则视为已经满足审批门禁。

旧的 pending-review 自动放行、导演状态解析、写作上下文和角色资源确认查询均只处理 `changeProposalId = null` 的历史独立记录，避免新提案在人工审阅前被旧自动链路放行。

Change Proposal 信封内的正式写入保持原子性：任一批准项失败，整次信封执行回滚并返回错误。legacy 独立记录按行隔离；payload 格式或已失效引用导致的领域失败会把坏行标为 rejected 并留下 `legacy_apply_failed` note，其余合法记录继续，数据库与基础设施错误不会被降级成业务拒绝。

legacy 隔离只按 `StateProposalDomainError` 类型与稳定 reason 码判定，不读取错误文案，也不把 applier 下游的裸校验异常一概当成领域失败。事务内捕获该错误后会继续使用同一个 transaction client，因此新增领域错误抛出点必须位于 SQL 之前，或仅位于已成功返回的 SQL 之后；禁止在失败 SQL 之后转换并抛出领域错误，否则 PostgreSQL 会进入 aborted transaction 并以 `25P02` 拒绝后续写入，而 SQLite 可能无法暴露该问题。

旧 pending-review 自动放行若隔离出 rejected 项，沿用 `pending_review_auto_promotion` 事件并追加拒绝计数与截断后的 item ID，severity 至少为 medium；全拒绝批次的幂等键包含 rejected 分量，避免被同时间点的空结果覆盖。无拒绝项时事件字段和幂等键保持原格式。

## 待审提案与正文生产的关系（不阻塞，有意为之）

**待审 Change Proposal 一律不阻塞正文生成。** `buildBlockingPendingReviewProposalWhere`
（`server/src/services/novel/runtime/context/pendingReviewContext.ts`）通过
`changeProposalId: null` 把信封逐项排除在阻塞集合之外——这是**设计结论，不是漏接线**，
修改它之前必须先推翻下面的理由。

`AGENTS.md` 的 Auto-Director Quality Gate Rules 是最高优先级硬规则：章节局部质量问题
不得中断全书执行链。需要停下来的情形只由既有结构化判据表达——`replan_required`、
`stop_for_replan`、不可恢复且无可用正文的生成失败、数据安全问题——走既有 replan 与
熔断路径。让一条 pending 提案间接把链路卡住，等于绕过这套判据另开一个停链入口。

因此章节执行偏离提案使用**非阻塞投影**（`reviewProjection: "non_blocking"`）：写账本事件
让 AI 驾驶舱时间线可见，但不投 checkpoint、不改任务状态，全书继续生产，用户事后审阅。
`CODE_REVIEW_PROPOSAL_CORE.md` 早期把这条记为「Phase 2C 待接线缺口」，其前提是
「提案要能拦住正文」；该前提在 2026-08-27 的 D2 定稿后不再成立。

## 章节执行偏离的三条出口

- **接受并更新后续计划**（`accepted_divergence` + 非空下游补丁）：承认正文，
  同时更新**下游**卷规划条目。本章原始 Expected 合同原样保留作审计证据，
  随提案 payload 留存。
- **仅记录这次变化**（`accepted_divergence` + 空下游补丁）：承认正文，明确不动
  后续计划。**这是与上一条并列的独立出口，不是"忘了填补丁"**——界面必须让作者
  选出意图，不能靠默认值替他决定。切到这一条时要清空此前存过的补丁，否则作者
  以为不改计划、执行时却把旧补丁写了进去。
- **按计划修正**（`corrected_to_expected`）：不新建修复链路，把偏离翻译成既有的
  `ChapterExecutionMissingObligation` 交给现有修复通路，从而复用既有修复预算与
  `maxAutoRepairAttempts`。

### 下游补丁的边界（两处强制，规则单一来源）

补丁只能改卷规划文档自有字段（`purpose` / `endingState` / `nextChapterEntryState` /
`exclusiveEvent`）；`title` / `summary` / `taskSheet` 等由 `Chapter` 数据列权威拥有，
`hydrateCanonicalChapterFields` 每次读工作区都会用 Chapter 行覆盖文档侧的值，
改文档侧会在下一次 hydrate 时被无声还原。

除字段形状外，目标章节还必须满足：**在偏离章之后、真实存在、同一份载荷内不重复**。
重复目标尤其不能只靠 schema——applier 用 `Map` 建索引，不挡住的话后一条会静默
覆盖前一条，而"目标章节缺失"检查看不见它（两个 order 都命中章节）。

规则实现在 `ChapterExecutionPatchBoundary`，**编辑期与 applier 两处都要调**：
编辑期让作者当场知道，applier 是最终可执行载荷的边界，可以被别的路径抵达。

### 已修正的条目不可被后续审批翻回接受

「按计划修正」成功后，该逐项在信封仍待审时就被锁为 `rejected`。**后续审批必须
原样保留这个决定**：显式给出相反决定要报 `invalid_review`，未列出时也不得按
`unlistedDecision` 或默认值推导成 accepted。

不挡住会产生自相矛盾的状态：**正文已经改回原计划，下游计划却按偏离更新**。
stale 检查不能替代这条——修正会改正文、通常会触发 stale，但那是巧合，多章提案里
被修正的章节未必在 `sourceRefs` 里。界面同样要收掉该条的操作。

### AI 下游调整建议不写状态

「接受偏离」时可以让 AI 起草下游补丁。**该路径只读**：读提案与卷规划工作区
（只读事务、`skipSelfHeal`，因为 `getVolumes` 会把 rehydrate 结果持久化），
调一次模型，经确定性 sanitizer 清洗后返回界面，**不落任何库**。

作者逐条采纳后的保存仍走既有用户编辑通路（`userEditedPayloadJson` +
`reviewDecision: modified`）。因此这里不构成新的 AI 自治写入点，
`DirectorPolicyEngine` 门禁与 L0–L3 映射一律不参与。**不得把建议改成直接落库**，
那会让它变成一条绕过人工审批的写状态路径。sanitizer 会丢弃指向偏离章及更早章节、
不存在章节、重复目标与越界字段的建议；空建议是合法结果。

## Policy、任务与审计复用

- Director runtime policy 中的 `mode` 只表达一次推进多远；`proposalAutonomyLevel` 独立表达 Proposal 是否可免审写入。两者正交，禁止再从 `mode` 反推 Proposal 授权。旧快照没有新字段时必须归一化为 L1，Director 以 L2/L3 推进也不改变这个默认值。
- Proposal 自治等级内部使用唯一评估映射：L0=`suggest_only`、L1=`run_next_step`、L2=`run_until_gate`、L3=`auto_safe_scope`。该映射只用于把独立授权翻译给 `DirectorPolicyEngine`，不能回写或替代 Director 的推进 `mode`。
- `ChangeProposalApplyService.executeProposal()` 是最终 policy 门禁。它把已批准项的有效最高 severity 与提案的 `outlineFidelity` 交给 `DirectorPolicyEngine`；自动化执行必须同时满足 `canRun=true` 与 `requiresApproval=false`，否则返回稳定错误码 `approval_required`，且不得写入正式状态。人工执行不查询此自动化门禁。
- AI 声明的 severity 只能抬高风险，不能压低确定性风险下界。角色状态、角色资源、删除操作、非数值型关系结构变化，以及关系分值跨度达到 20 的变化至少为 major；只有可识别且跨度小于 20 的关系数值调整可保留 minor。关系分值的目标值必须从正式执行 payload 读取，展示 `after` 与 payload 不一致时按 major 处理。
- 正式执行前，所有已批准项（accepted 与 modified）都必须校验展示 `after` 与最终执行 payload 一致；不一致返回 `invalid_review` 且不得提交。该规则既约束自动批准，也约束人工误接受，保证审阅界面展示的 diff 就是实际写入内容。
- policy 判定必须区分执行授权来源：`automation` 表示无人值守执行，必须服从上述自动放行条件；`explicit_review` 表示用户已经完成审阅，可以越过“需要审批”这一等待条件，但仍保留 stale、状态转换、正式 applier 与事务原子性检查。禁止把这两种授权混成一个布尔开关，否则 major 提案会在批准后再次要求批准。
- 带 `taskId` 的提案读取冻结 policy 中独立的 `proposalAutonomyLevel`；没有 DirectorRun 绑定的手工提案和旧 runtime 快照都使用保守的 L1 默认值。运行时缺失或兼容读取不能静默升级到更高自治等级。
- AI 提案统一通过 `AiChangeProposalProducerService` 进入 Proposal Core：先创建提案但延后 task checkpoint，再读取冻结 policy；需要确认时保留 `pending_review` 并写入既有 checkpoint，允许自动执行时复用正式 review service 接受全部项，并以 `authority=automation` 进入 apply 边界。自动执行失败必须把任务留在可审阅恢复状态，不能吞成成功。
- Planner 的 `propose_novel_change` 结构化 intent 和同名 tool 是 AI 入口。Planner prompt 只负责输出通过 schema 校验的提案事实；workflow registry 负责生成 tool call，tool 负责绑定当前小说的 Director task。AI 输入不得接收 `autonomyLevel`、`policyMode`、`submitForReview` 或同类绕过字段，权限只能来自服务端冻结的 runtime snapshot。
- `propose_novel_change` 只授权 Planner 使用，也不设置静态的“一律审批”工具门禁；最终是 `pending_review` 还是 `executed` 必须由独立 Proposal 授权、有效最高 severity 与 outline fidelity 决定。Director 节奏切到 L2/L3 不会提高 Proposal 授权；节奏切到 L2/L3 本身仍需 Agent 审批。
- 带 `taskId` 的批准、部分批准、拒绝、再生和执行请求通过 `review_proposal` DirectorRunCommand 排队，HTTP 返回 202，不创建第二套队列。
- 提案被索引为 `change_proposal` DirectorArtifact，并沿用 artifact dependency 进行 stale 检测。
- 事件沿用 `DirectorEvent`，记录 `proposal_created`、`proposal_reviewed`、`proposal_applied` 和 `proposal_superseded`。
- `record` 类型 source ref 在本阶段只用于来源展示与追踪；确定性 stale 检查覆盖 Director Artifact、其依赖版本与 Chapter 内容哈希。

## Apply 边界

- `character_state_update`、`character_resource_update` 和 `relation_state_update` 有正式状态 applier。
- 关系阶段写入保留逐项记录的真实 `sourceType`。章节增量和 Proposal 使用同一正式写入 helper；同一角色对的当前阶段由最后一次成功写入决定，历史阶段不会删除。
- 其他旧 `StateChangeProposal` 类型继续保持 ledger-only 兼容，供既有章节状态账本使用；Change Proposal 若批准了这些类型，执行接口会明确返回“不支持正式写入”，不会把信封标成 executed。
- 章节执行 Proposal 的 AI 生产者、`Expected vs Actual` 对比和自动导演正文前置暂停属于 Phase 2C（Chapter Execution Divergence），后端与审阅界面均已落地。通用的 AI 提案生产者接线本身属于其前置的 Phase 2A。

## 审阅界面入口与错误恢复

- 小说专业工作台提供“变更提案”入口；自动导演停在 `proposal_review_required` 时，AI 驾驶舱和任务抽屉的主操作必须是 `open_details / 审阅变更提案`，目标链接携带 `proposalPanel=1`。该 checkpoint 禁止落入 `continue / resume` 兜底；当前编辑路由的小说 ID 是入口主来源，任务的 resume target 只作兼容兜底，不能成为显示审阅入口的前置条件。
- 审阅面板通过 URL 控制开关，并保留 `directorTaskId`、手工工作区任务和当前创作步骤参数。关闭面板只移除 `proposalPanel`，不能改写其他任务绑定。
- 列表和详情、所有查询与变更集中在 Change Proposal 自有 hook；小说总编辑页只负责挂载和 URL 透传，避免继续扩张超长页面文件。
- 逐项审阅支持接受、修改和拒绝。path 到 payload 字段的映射以及状态类型的正式写入模式由 shared 契约统一提供给服务端与客户端；可映射的字符串、数字和布尔值可直接修改，其他结构切换到完整 payload 编辑。输入初值和类型以最终 payload 字段为准，避免 `after` 缺失时把数字误写成字符串。
- 已保存人工编辑的项必须按 `modified` 提交；全部批准由服务端自动区分原值和人工修改值。部分批准始终要求显式选择未列项处理方式。
- 章节执行偏离项走专属呈现，不用通用的 path + `before`/`after` + JSON 编辑器：对照展示「原计划要求」与「正文实际写成」，下游调整是按可执行契约生成的表单，**字段与 `chapterExecutionPlanPatchSchema` 双向锁死**——多给一个字段作者就会填一个写下去会被静默还原的值。AI 建议默认不采纳，必须逐条确认。
- 详情中的 `isStale` 是进入审阅时的前置门禁：立即展示原因、禁用批准与执行，并把重新生成作为主操作。
- `not_found`、`version_conflict`、`stale_proposal`、`invalid_transition`、`unsupported_change` 和 `invalid_review` 使用稳定错误码映射为中文恢复指引。HTTP `error` 是稳定机器码，`message` 是英文诊断细节，客户端必须本地翻译，不能直接展示 `message`。审阅写操作不自动重试；版本冲突和状态冲突先刷新详情，再由用户重新决定。
- 带 `taskId` 的批准、部分批准、拒绝、再生和执行返回 202 Director Command；客户端用可辨识联合与同步 Proposal 响应分开，显示排队状态并同时轮询命令与提案详情，禁止把 command 当作 proposal 渲染。命令进入 failed / cancelled / stale 时立即停止；等待超过 60 秒也停止自动刷新并保留中文失败提示，避免抽屉永久停在等待状态。
- ledger-only 类型在逐项详情和整份提案上提前标注。只有仍被批准的 ledger-only 项会阻止执行；已明确拒绝的 ledger-only 项不影响其他批准项写入。

## HTTP API

路由挂载在小说模块：

```text
GET    /api/novels/:id/change-proposals
GET    /api/novels/:id/change-proposals/:proposalId
POST   /api/novels/:id/change-proposals
POST   /api/novels/:id/change-proposals/:proposalId/submit
PATCH  /api/novels/:id/change-proposals/:proposalId/items/:itemId
POST   /api/novels/:id/change-proposals/:proposalId/approve
POST   /api/novels/:id/change-proposals/:proposalId/partial-approve
POST   /api/novels/:id/change-proposals/:proposalId/reject
POST   /api/novels/:id/change-proposals/:proposalId/regenerate
POST   /api/novels/:id/change-proposals/:proposalId/execute
POST   /api/novels/:id/change-proposals/:proposalId/items/:itemId/plan-suggestions
POST   /api/novels/:id/change-proposals/:proposalId/items/:itemId/correct
```

后两个是章节执行偏离专用。`plan-suggestions` 只读，不写任何库。
`correct` 的三态里只有并发冲突走 409；**修复失败返回 200 并带 `repair_failed`**
——逐项仍可审阅、质量债已记，那是业务结果而不是服务故障，不得映射成 5xx。

审阅 UI 复用 Web / Electron 的 React 工作台和现有响应式布局；没有新增 Android 专用业务逻辑或外部运行时。
