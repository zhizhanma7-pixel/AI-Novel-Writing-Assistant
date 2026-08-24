# Code Review — Proposal Review UI

> 评审对象：`feat/change-proposal-ui` @ `aef0f0c feat(proposal): add change proposal review ui`
> 对照基线：`docs/dev/IMPLEMENTATION_PLAN_PROPOSAL_UI.md`（`ffbffae`）的接口契约与 11 条验收标准
> 评审人：Claude Code（Reviewer）
> 方式：静态评审 + 界面逻辑走查。**未运行 typecheck / build / 测试**——本机无 node/pnpm；`pnpm --filter @ai-novel/client build` 与 `test` 的结果采信实现侧自述，未经我复跑。

---

## 0. 结论

计划里点名的三个高风险点都接住了：202 分流用可辨识联合在类型层面强制分支、`NovelEdit.tsx` 只增加 21 行、投影层给 `proposal_review_required` 加了 `open_details` 分支且排在 `waiting_approval` 分支最前。逐项 ✓/✎/✗、`unlistedDecision` 显式选择、stale 前置门禁、六种错误码中文映射、ledger-only 提前标注也都按契约实现了。

但**驾驶舱入口在一条可达路径上仍会退回被禁止的「确认并继续」**（H1），且这条路径正是提案 checkpoint 自己写出来的任务状态。这是本分支唯一的硬规则，需要修掉再合并。

| 严重度 | 数量 | 编号 |
|---|---:|---|
| BLOCKER | 0 | — |
| HIGH | 1 | H1 |
| MEDIUM | 3 | M2, M3, M4 |
| LOW | 3 | L5, L6, L7 |

**评审结论：H1 修复后可 `--no-ff` 合并进 `beta`。**

---

## 1. 做对的部分

1. **202 分流做到了类型层面。** `changeProposalActionResult.ts` 用 `{ kind: "proposal" } | { kind: "queued" }` 承载 200/201 与 202，`postProposalAction` 按 `response.status` 构造，调用点必须 `switch` 才能取值。计划 R1 点名的坑被结构性堵住，而不是靠自觉。
2. **`NovelEdit.tsx` 只 +21 行**，全部是挂载与参数透传；301 行的 query/mutation 逻辑住在 `useChangeProposals.ts`。R2 达成。
3. **投影分支位置正确。** `proposal_review_required` 放在 `waiting_approval` 内的第一顺位，复用 `open_details`，没有新增 action type，`buildNovelHref` 只加了一个可选参数。配套单测断言了 `type` 与 `label`。
4. **无自动重试。** 三个查询 `retry: false`，两个 mutation `retry: false`，错误文案里也明确写了"系统不会自动重复提交审阅决定"。
5. **全域 toast 被正确旁路。** 所有提案请求带 `silentErrorStatuses: [400, 404, 409]`，否则 axios 拦截器会把 `error` 字段（现在是机器码）当标题弹出来。这一步没做的话，界面上会出现 `stale_proposal` 这种字样。
6. **已编辑项的决定自动纠偏。** `ProposedChangeRow` 在有存量编辑时把 ✓ 按钮切成"按修改值接受"并发 `modified`，避开了服务端"已编辑项不得 accepted"的 400；`ProposedChangeEditor` 保存成功后也自动置为 `modified`。
7. **降级路径按契约实现。** 行内编辑吃到 `invalid_review` 后自动切到完整 payload 模式并给中文提示，不是把英文报错抛给用户。
8. **ledger-only 双层提示。** 逐项一条、整份一条，且执行按钮只在"仍被批准的 ledger-only 项存在"时禁用——已拒绝的 ledger-only 项不会误伤其他批准项。这比计划要求的更细。
9. **文案合规。** 新增中文文案都是用户视角、写清下一步，没有实现叙述。`docs/wiki` 增补了"审阅界面入口与错误恢复"整节，规则写得比计划还完整。

---

## 2. HIGH

### H1 — 进度面板的审阅入口依赖一个提案链路从不写入的字段，缺失时退回被禁止的「确认并继续」

**位置：** `client/src/pages/novels/components/NovelAutoDirectorProgressPanel.tsx:404-405`

```ts
const proposalReviewHref = task?.checkpointType === "proposal_review_required" && task.resumeTarget?.novelId
  ? `/novels/${task.resumeTarget.novelId}/edit?directorTaskId=...&proposalPanel=1`
  : null;
```

覆盖条件里除了 checkpointType，还串了一个 `task.resumeTarget?.novelId`。而写出这个 checkpoint 的地方是：

`server/src/services/novel/proposal/application/ChangeProposalService.ts` 的 `markTaskPendingReview()` —— 它只更新 `status` / `currentStage` / `currentItemKey` / `currentItemLabel` / `checkpointType` / `checkpointSummary` / `heartbeatAt`，**从不写 `resumeTargetJson`**。

`resumeTarget` 只在 `novelDirectorAutoExecutionCheckpointRuntime.ts`、`novelDirectorChapterTitleRepair.ts` 这些别的检查点里被 `buildNovelEditResumeTarget()` 填充。也就是说：**只要任务在进入提案审阅前没有经过那几个检查点，`resumeTarget` 就是 null**，`proposalReviewHref` 为 null，`resolveDashboardAction` 落回原分支，面板显示 `confirm_and_continue`——「确认并继续」，点下去是 resume，把导演推下去而不是审阅提案。

**故障场景：** 手工创建的导演任务，或在自动执行检查点之前就产生了 chapter_execution 提案的任务。进度面板给出的主操作是继续推进，用户按计划本该看到的"审阅变更提案"根本不出现。这正是计划 §2.2 写的硬规则「禁止落入 `continue` / `resume` 兜底分支」。

注意 **AI 驾驶舱本身没问题**——它读服务端投影，投影只看 `checkpointType`，分支正确。出问题的只有页面内这块进度面板。

**建议：** 覆盖条件只用 `checkpointType`，novelId 从路由取（该面板始终渲染在 `/novels/:id/edit` 下，`useParams()` 即可）或由父组件传 prop；`resumeTarget` 最多作为兜底，不作为前置条件。修完补一条断言：checkpoint 为 `proposal_review_required` 且 `resumeTarget` 为 null 时，主操作仍是"审阅变更提案"。

---

## 3. MEDIUM

### M2 — 202 排队轮询没有失败终止条件

**位置：** `useChangeProposals.ts:160-183`（清除条件）、`:75, :120, :137`（三处 `refetchInterval: 2000`）

`queuedAction` 只有在提案的 `version` / `updatedAt` / `status` 变化，或出现 `supersedesId` 指向它的后继版本时才会清除。可是 `review_proposal` 命令是可能失败的：`DirectorCommandExecutor` 在提案不属于该任务时抛 400，执行阶段抛 `unsupported_change`/`version_conflict` 时命令也会失败，worker 没在跑时命令根本不会被执行。这些情况下提案不会变，于是：

- 列表与详情**永久按 2 秒轮询**（抽屉开着期间，两个请求/2 秒）；
- 面板永远停在"操作已提交，等待导演处理"，用户既看不到失败原因，也没有退出这个状态的入口。

计划 AC8 只写了"正确轮询到最终状态"，失败路径确实没写进验收，但它是可达的。

**建议：** 给 `queuedAction` 加超时（例如 60 秒或 30 次），到点后清除并提示"导演未能处理这次操作，请重试或查看任务详情"；更好的做法是顺带读该任务的命令状态（`DirectorRunCommand.status === "failed"` 时直接失败退出）。

### M3 — 行内编辑用 `after` 推断类型，`after` 缺失时会把数字写成字符串

**位置：** `ProposedChangeEditor.tsx:11-25, 47`

```ts
await props.onSave({ after: parseInlineValue(inlineValue, props.change.after) });
```

`parseInlineValue` 拿 `change.after` 当类型参照：是 number 才转数字，是 boolean 才转布尔，**其余一律原样返回字符串**。而 `canEditProposedChangeInline()` 判定行内可编辑时看的是 **payload 是否有映射键**，跟 `after` 有没有值无关。

于是当一条 `relation_state_update` 的 `after` 缺失（`operation: "add"`、或历史数据里 `afterJson` 为 null）时：输入框初值是 `formatProposalValue(undefined)` 也就是字符串 `"未提供"`，用户改成 `55` 保存，参照类型不是 number → 发出 `after: "55"` → 服务端按 path 映射写进 payload 的 `trustScore: "55"`。审批时不会报错，**到执行阶段 `relationStateProposalPayloadSchema` 的 `z.number().int()` 抛 ZodError**；信封路径是严格模式，直接向上抛，且 ZodError 不是 `ChangeProposalError`，前端拿不到已知 code，只会显示"提案操作未完成"。

**建议：** 类型参照与输入框初值都改成取"映射后的 payload 值"（行内可编辑时该键必然存在），`after` 只作为兜底。顺带在 payload 模式的提示里说明哪些字段是执行必需的。

### M4 — 客户端复制了两张服务端知识表，其中一张还比服务端更严格

**位置：** `changeProposalCopy.ts:101-110`（`LEDGER_ONLY_CHANGE_TYPES`）、`:134-152`（`PAYLOAD_KEY_ALIASES` + `canEditProposedChangeInline`）

两处都是服务端已有事实的第二副本：

- ledger-only 集合的权威在 `server/src/services/novel/state/StateProposalApplierRegistry.ts` 的 `mode: "ledger_only"`。Phase 2A 给 `world_rule_change` 补了 applier 之后，界面还会继续说"暂不能写入正式状态"并禁用执行按钮，除非有人记得同步改前端。
- 别名表的权威在 `server/src/services/novel/proposal/domain/ProposedChangeValueMapper.ts`。而且两边逻辑**不等价**：服务端 `resolvePayloadKey` 是 `ALIASES[type][terminal] ?? terminal`，也就是 **path 末段直接等于 payload 键时无需别名也能映射**；客户端 `canEditProposedChangeInline` 要求别名条目存在才返回 true。结果是 path 形如 `...trustScore`（payload 里就有 `trustScore`）的项，服务端本可以行内改，客户端却判定不可行内编辑，强制用户去编 JSON。

这属于协作指南 §4 明确要查的"是否制造了重复逻辑"。

**建议：** 把两张表提到 `shared/`（别名表可直接从 `ProposedChangeValueMapper` 抽出常量，服务端与客户端同源导入），或者让 API 在逐项上返回 `applicationMode` 与 `inlineEditable`，前端不再自己推断。至少要把客户端的映射逻辑对齐服务端的 terminal-key 回退。

---

## 4. LOW

### L5 — 错误契约改了形状，结构化 details 丢了，且 wiki 没写这条约定

`novelChangeProposalRoutes.ts` 把 `new AppError(error.message, status, error.details)` 换成了 `new AppError(error.code, status, error.message)`。响应体因此变成 `{ error: "<code>", message: "<英文诊断>" }`，前端按 `error` 分支翻译——方向是对的，也有 `changeProposalHttpContract.test.js` 钉住。

两个副作用：

- `ChangeProposalError.details` 里的结构化信息被挤掉了：stale 的 `{ reasons }`、`unsupported_change` 的 `{ itemIds, proposalTypes }`、审阅的 `{ unknownIds }` 现在都传不出来。stale 靠详情接口的 `staleReasons` 兜住了，另外两个则只能靠前端自己猜（见 M4）。
- `message` 现在是英文诊断串。当前 UI 全量 silent 且本地翻译，所以用户看不到；但契约上 `message` 已经不再是可展示文案，后续任何消费者（桌面、Android、调试面板）照旧用它就会漏英文。

**建议：** wiki 的错误码小节补一句"`error` 为稳定机器码，`message` 为英文诊断细节，客户端必须本地翻译"；结构化 details 如需保留，可放进响应体的独立字段而不是挤占 `message`。

### L6 — 用字符串嗅探判断路由意图

`NovelEdit.tsx:1282` 用 `action.target.href?.includes("proposalPanel=1")` 决定是走提案面板还是打开任务中心。投影侧一旦调整参数顺序或编码方式，这里会静默退回任务中心。建议解析 search params，或直接看任务的 `checkpointType`。

### L7 — draft 提案在界面上无法逐项操作

`ChangeProposalDetailPanel` 的 `reviewEnabled` 要求 `status === "pending_review"`，而后端的逐项 PATCH 在 `draft` 也是允许的。draft 提案只能先"提交审阅"再编辑。当前没有 AI 生产者、提案多为手工创建，影响有限；如果这是有意简化，建议在 wiki 的审阅规则里写明"界面只在 pending_review 阶段开放逐项操作"。

---

## 5. 验收标准逐条核对

| # | 验收项 | 结论 |
|---|---|---|
| 1 | 驾驶舱/任务抽屉入口，不显示"确认并继续" | ⚠️ 驾驶舱（投影）通过；页面内进度面板见 H1 |
| 2 | 列表筛选 + 详情展示依据/来源/警告 | ✅ |
| 3 | 逐项 ✓/✎/✗ 与不可映射降级 | ✅（类型推断问题见 M3） |
| 4 | 已编辑项标记 + 自动 modified | ✅ |
| 5 | 部分批准显式选择未列项处理 | ✅ 未选择时按钮禁用并给出说明 |
| 6 | stale 进门即禁用批准与执行 | ✅ 重新生成被提为主操作 |
| 7 | 六种错误码中文提示 + 不自动重试 | ✅ |
| 8 | 202 排队与轮询 | ⚠️ 成功路径通过，失败路径见 M2 |
| 9 | 端到端手工验收（trust 改值链路） | 未验证（本机无法运行） |
| 10 | client build / typecheck、服务端聚焦测试 | 未复跑，采信实现侧自述 |
| 11 | 文案符合 UI Copy Rules | ✅ |

---

## 6. 修复清单

1. **H1** 进度面板覆盖条件只看 `checkpointType`，novelId 改从路由或 prop 取；补 `resumeTarget` 为空时的断言。
2. **M2** 给排队轮询加超时与失败退出，最好联动命令状态。
3. **M3** 行内编辑的类型参照与初值改用映射后的 payload 值。
4. **M4** 把 ledger-only 集合与别名表收敛到单一来源（`shared/` 或 API 字段）；至少补齐 terminal-key 回退。
5. **L5** wiki 补错误契约说明；结构化 details 另开字段。
6. **L6 / L7** 按上文处理，改注释或改判定均可。

H1 修完即可合并；M2–M4 建议同批处理，L 系列可留到 Phase 2A 一并清理。

---

## 7. 复核 — `2ba2e33 fix(proposal): close proposal UI review findings`

逐条核验修复实现，结论：**H1、M2、M3、M4、L5 关闭；L6、L7 仍开放（LOW，可留到 Phase 2A 一并清理，不阻塞主线启动）。同意合并进 `beta`。**

| 编号 | 状态 | 核验依据 |
|---|---|---|
| H1 | ✅ 关闭 | 覆盖条件抽成纯函数 `proposalReviewNavigation.ts`，只以 `checkpointType` 为前置，novelId 优先取 `useParams().id`、`resumeTarget` 降为兜底；并且不再只替换 `confirm_and_continue`，而是在该 checkpoint 直接接管整个动作列表 |
| M2 | ✅ 关闭 | 新增 `queuedProposalAction.ts`，轮询 `DirectorCommandResult`，`failed / cancelled / stale` 立即终止 + 60 秒超时兜底；三处 `refetchInterval` 全部随 `queuedAction` 清空而停止；失败在详情面板保留中文横幅 |
| M3 | ✅ 关闭 | `resolveProposedChangeInlineValue` 从 `userEditedPayload ?? payload` 的映射键取初值与类型参照，非标量直接回落 payload 模式；`after` 缺失不再导致数字被当字符串提交 |
| M4 | ✅ 关闭 | 新建 `shared/types/stateProposalApplication.ts` 作为单一来源，服务端 `ProposedChangeValueMapper` 与 `StateProposalApplierRegistry` 均已改为导入，客户端同源；terminal-key 回退口径两端一致 |
| L5 | ✅ 关闭 | wiki 错误码小节补入"`error` 是稳定机器码，`message` 是英文诊断细节，客户端必须本地翻译" |
| L6 | ⭕ 开放 | `NovelEdit.tsx:1282` 仍用 `href.includes("proposalPanel=1")` 判断路由意图 |
| L7 | ⭕ 开放 | draft 提案在界面上仍不开放逐项操作，wiki 未写明该边界 |

几处值得记录的实现细节：

- H1 的修法比评审建议更强。原建议只是把 `resumeTarget` 从前置条件降级，实际实现把该 checkpoint 下的 `dashboardActions` 整体替换为单一"审阅变更提案"，任何 continue / resume 动作在这个状态下都无法出现。代价是该 checkpoint 下这块面板也不再显示取消、查看详情等次级动作——考虑到失败提示里会引导"打开任务详情"，后续可以补一个次级入口，但不影响合并。
- M2 的终止状态集合 `{failed, cancelled, stale}` 与 `DIRECTOR_RUN_COMMAND_STATUSES` 的实际取值逐一对齐，`succeeded` 保持"继续等待"是对的——清除队列态的判定权仍在提案版本 / 状态变化与后继版本检测上。该集合目前是本地字面量，将来可从 shared 枚举派生，属于可选清理。
- M4 的 `DomainStateProposalType` 映射类型让 applier 记录与 shared 模式表在编译期绑定：往 shared 里加一个 `domain_state` 类型却不补 applier，会直接编译失败。这比运行时抛错更早一层。
- 60 秒超时对长耗时命令可能提前判定超时；此时轮询停止但提案本身不受影响，用户手动刷新即可看到最终结果。这是我要求的有界等待的必然取舍，不视为缺陷。

未复跑构建与测试（本机无 node/pnpm）。实现侧自述：shared / client / server build 通过，客户端聚焦 16/16、服务端聚焦 36/36、文档清单通过，客户端全量 177/181，4 项失败位于本次未改动的文件。这一结论与合并关口阶段建立的"差集为零"证据方法一致，合并后仍建议在 `beta` 上做一次前后端联合 smoke。
