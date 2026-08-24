# Proposal UI Implementation Plan

> 分支：`feat/change-proposal-ui`（从 `beta@b9c5914` 拉出）
> 作者：Claude Code（Architect）
> 前置：`docs/dev/CODE_REVIEW_PROPOSAL_CORE_GATE.md`、`CODE_REVIEW_PROPOSAL_CORE_GATE_DISPOSITION.md`、`docs/wiki/workflows/change-proposal-review.md`

## Goal

给已经跑通的 Change Proposal 后端核心补上审阅界面：用户能看到 AI 提出的状态变更、逐项接受 / 修改 / 拒绝、批准后执行，并且从自动导演的既有入口（AI 驾驶舱、任务抽屉）能找到"有提案等你审"。

后端契约本阶段**不改**（唯一例外见 Scope 的服务端最小改动），UI 适配既有 API。

## Architecture Input

- 后端 API 与状态机：`docs/wiki/workflows/change-proposal-review.md`
- 审阅规则与边界：`docs/dev/CODE_REVIEW_PROPOSAL_CORE_GATE_DISPOSITION.md`
- 交互范式：`ainovel_workflow_guide/01_PROPOSAL_WORKFLOW.md` §3
- 客户端约定：`client/src/api/`（axios + `ApiResponse<T>`）、`client/src/api/queryKeys.ts`（react-query key 集中定义）、shadcn/ui（`.claude/skills/shadcn-ui`）

---

## 1. 接口契约（本阶段固定，不得在实现中改口径）

### 1.1 端点与响应形态

| 动作 | 请求 | 成功码 | 返回 |
|---|---|---|---|
| 列表 | `GET /api/novels/:id/change-proposals?status=&type=&chapterId=` | 200 | `ChangeProposal[]`（最多 100，按 updatedAt desc） |
| 详情 | `GET /api/novels/:id/change-proposals/:proposalId` | 200 | `ChangeProposal`（含 `isStale` / `staleReasons`） |
| 提交审阅 | `POST .../:proposalId/submit` body `{ expectedVersion? }` | 200 | `ChangeProposal` |
| 逐项编辑 ✎ | `PATCH .../:proposalId/items/:itemId` body `{ expectedVersion?, payload?, after? }` | 200 | `ChangeProposal` |
| 全部批准 ✓ | `POST .../:proposalId/approve` body `{ expectedVersion? }` | 200 | `ChangeProposal` |
| 部分批准 | `POST .../:proposalId/partial-approve` body `{ expectedVersion?, itemDecisions[], unlistedDecision? }` | 200 | `ChangeProposal` |
| 拒绝 ✗ | `POST .../:proposalId/reject` body `{ expectedVersion?, reason? }` | 200 | `ChangeProposal` |
| 重新规划 | `POST .../:proposalId/regenerate` body `RegenerateInput` | **201** | 新版本 `ChangeProposal`（v+1，旧版 superseded） |
| 执行 | `POST .../:proposalId/execute` | 200 | `ChangeProposal`（status=executed） |

### 1.2 最容易做错的一条：taskId 提案返回 202

**只要 `proposal.taskId` 非空**，approve / partial-approve / reject / regenerate / execute 五个端点都不会同步返回 proposal，而是把动作作为 `review_proposal` DirectorRunCommand 入队，返回：

```
202 Accepted
{ success: true, data: <DirectorCommandAcceptedResponse>, message: "导演提案审批命令已入队。" }
```

UI 必须按状态码分流：

- `200` / `201` → `data` 是 `ChangeProposal`，直接更新缓存。
- `202` → `data` **不是** proposal。展示"已提交，等待导演执行"，并开始轮询该提案详情直到状态变化（或复用既有任务轮询）。把 202 的响应体当 proposal 用会直接渲染出空白面板。

手工创建（无 taskId）的提案走同步路径。两条路径都要有测试覆盖。

### 1.3 逐项决定的合法组合

`itemDecisions[]` 每项 `{ id, decision, editedPayload?, editedValue? }`，服务端约束：

- `decision !== "modified"` 时**不得**携带 `editedPayload` / `editedValue` → 否则 400。
- `decision === "modified"` 且既没带编辑值、该项服务端也没有存量编辑 → 400。
- 该项已有存量编辑（先 PATCH 过）时：
  - 可以只发 `{ id, decision: "modified" }`（**裸 modified 合法**）；
  - 发 `{ id, decision: "accepted" }` → 400，服务端要求已编辑项必须以 modified 批准。
- 部分批准路由要求 `itemDecisions` 至少 1 条。
- **未列出的项不会默认接受**：必须显式传 `unlistedDecision: "accepted" | "rejected"`，否则服务端报"决定缺失"400。UI 不允许提交隐式默认——把它做成一个明确的单选（"其余项：全部接受 / 全部拒绝"）。
- 全部批准（不传 `itemDecisions`）时：未编辑项按 accepted，已编辑项自动按 modified，无需前端特殊处理。

**没有单项拒绝端点。** 拒绝某一项 = 用 partial-approve 把它的 decision 设成 `rejected`；`/reject` 是整份拒绝。

### 1.4 编辑 `after` 的降级路径

`PATCH` 只传 `after` 时，服务端按该项的 `path` 把值映射回可执行 payload（`trust→trustScore`、`state→currentState` 等别名表）。**路径无法映射时返回 400 `invalid_review`**，消息明确要求改用 `editedPayload`。

UI 必须捕获这一条并降级：把该项的行内编辑切换成"编辑完整 payload"的 JSON/表单模式，而不是把英文报错原样弹给用户。可映射的类型（关系分值、角色状态/目标）走行内轻编辑，其余一律走 payload 表单。

### 1.5 错误码 → 用户动作

| HTTP | code | 界面处理 |
|---|---|---|
| 404 | `not_found` | 提案已不存在，回列表并刷新 |
| 409 | `version_conflict` | 有人先改了。刷新详情、展示最新版本，让用户重新决定。**禁止自动重试** |
| 409 | `stale_proposal` | 来源已变化。展示 `staleReasons`，主操作降级为"重新生成提案" |
| 409 | `invalid_transition` | 当前状态不支持该动作，刷新后按新状态重渲染按钮 |
| 409 | `unsupported_change` | 该变更类型暂不支持写入正式状态（ledger-only）。需翻译成人话并说明可做什么，不弹原始英文 |
| 400 | `invalid_review` | 决定组合非法（见 1.3 / 1.4），就地提示并指出缺哪一项 |

### 1.6 stale 是"进门就知道"，不是"提交才发现"

详情响应里已经带 `isStale` / `staleReasons[]`。打开提案时如果 `isStale`，立刻显示横幅、禁用批准与执行、把"重新生成"提为主操作。不要等提交后吃 409。

---

## 2. Scope

### 2.1 客户端（主体）

```
client/src/api/novel/changeProposals.ts                     新增：10 个端点封装 + 202 分流
client/src/api/queryKeys.ts                                 新增：changeProposals / changeProposalDetail
client/src/pages/novels/components/changeProposal/          新增目录
  ├─ ChangeProposalListPanel.tsx                            待审列表（按状态分组）
  ├─ ChangeProposalDetailPanel.tsx                          摘要 / 依据 / 警告 / 来源 / 逐项列表
  ├─ ProposedChangeRow.tsx                                  单条 diff：before → after + ✓ ✎ ✗
  ├─ ProposedChangeEditor.tsx                               行内编辑 + payload 表单降级
  ├─ ChangeProposalReviewDrawer.tsx                         抽屉容器（与任务抽屉同级）
  ├─ useChangeProposals.ts                                  查询 / 变更 hooks，含 202 轮询
  └─ changeProposalCopy.ts                                  错误码与状态的中文文案表
client/src/pages/novels/components/NovelTaskDrawer.tsx      +checkpoint 文案 +审阅入口按钮
client/src/pages/novels/components/NovelAutoDirectorProgressPanel.tsx  +checkpoint 文案
```

**硬约束：不得把新逻辑塞进 `NovelEdit.tsx`。** 该文件已 2865 行，远超 AGENTS.md 的 1300 行硬阈值；提案相关的 query / mutation 必须住在 `useChangeProposals.ts` 里，`NovelEdit.tsx` 最多只做抽屉挂载与 URL 参数透传。

### 2.2 服务端最小改动（必须在本分支做）

`server/src/services/novel/director/projections/DirectorBookAutomationProjectionModel.ts:450-490`

当前 `waiting_approval` 分支只特判了 `candidate_selection_required` / `production_experience_required` / `chapter_batch_ready`，其余**全部落到兜底的 `type: "continue"` + `continuationMode: "resume"`**。也就是说：一个停在 `proposal_review_required` 的任务，驾驶舱现在会显示"确认并继续"，点下去是恢复导演运行——**把用户引向绕过审阅的操作**。

必须补一个分支：

```ts
if (input.task?.checkpointType === "proposal_review_required") {
  return action({
    type: "open_details",                       // 复用既有类型，不新增 action type
    label: "审阅变更提案",
    target: { novelId, taskId, href: buildNovelHref(novelId, { taskId, proposalPanel: true }) },
    emphasis: "primary",
  });
}
```

`buildNovelHref` 加一个 `proposalPanel?: boolean` 选项即可（与既有 `taskPanel` 同构），`DirectorBookAutomationActionType` 与 `target.tab` 联合类型**都不需要动**。改动必须严格限定在这个 checkpointType 上，不能影响其他 `waiting_approval` 任务的兜底动作。

硬性规则：`proposal_review_required` 必须走 `open_details` 且链接携带 `proposalPanel`，**禁止落入 `continue` / `resume` 兜底分支**。

### 2.3 Non-goals

- AI 侧提案生产者、L0–L3 自治等级与 policy 门禁 → Phase 2A；Expected vs Actual 对比 → Phase 2C。
- O1（typed error 替换消息前缀分类）、O2（legacy rejected 告警）→ 另开短后端加固分支，不进本分支。
- ledger-only 类型的正式 applier。
- Android / 移动端专项布局（沿用现有响应式即可，不做单独适配）。
- 任何 prompt、runtime、migration 改动。

---

## 3. Acceptance Criteria

1. 任务停在 `proposal_review_required` 时，驾驶舱与任务抽屉显示"审阅变更提案"入口；**不再显示"确认并继续"**。
2. 列表能按状态筛选并进入详情；详情展示摘要、`reasoningSummary`、warnings、source refs、逐项 diff。
3. 逐项 ✓ / ✎ / ✗ 可用；可映射路径走行内编辑，不可映射路径自动降级为 payload 表单，不出现英文原始报错。
4. 已编辑项在列表上有"已修改"标记，提交时自动使用 `modified`，不会误发 `accepted`。
5. 部分批准必须显式选择未列项的处理方式，UI 不允许提交隐式默认。
6. `isStale` 的提案打开即提示原因，批准与执行禁用，主操作为"重新生成"。
7. 1.5 表中六种错误都有对应中文提示与恢复动作，且没有任何自动重试。
8. taskId 提案的 202 响应显示"已入队"并正确轮询到最终状态；无 taskId 提案走同步刷新。
9. 端到端手工验收：创建 → 编辑 trust 值 → 部分批准 → 执行 → 关系值等于用户改后的值（与后端验收用例同一条链路）。
10. `pnpm --filter @ai-novel/client build` 与 typecheck 通过；服务端聚焦测试（proposal + 投影）通过。
11. 新增文案符合 AGENTS.md UI Copy Rules：用户视角、说明下一步，不写实现叙述，不用"现在 / 不再 / 已经"这类改动叙述词。

---

## 4. 风险与对策

| 编号 | 风险 | 对策 |
|---|---|---|
| R1 | 202 被当成 proposal 渲染 | API 层按状态码分流，类型上用可辨识联合 `{ kind: "proposal" } \| { kind: "queued" }`，让 TS 强制前端处理两支 |
| R2 | 逻辑堆进 `NovelEdit.tsx` | 所有 query/mutation 进 `useChangeProposals.ts`；review 时检查 `NovelEdit.tsx` 增量行数 |
| R3 | 投影改动波及其他任务 | 分支条件严格等于 `proposal_review_required`；补一条投影单测覆盖"其他 checkpoint 兜底动作不变" |
| R4 | 没有 AI 生产者，无法造数据验收 | 计划内提供一段 `POST /change-proposals` 的示例 payload（relation_state_update，path `Character.A.relationship.B.trust`），验收脚本化，不靠手搓 |
| R5 | ledger-only 提案能创建却执行不了 | UI 在详情里对这些类型提前标注"暂不支持写入正式状态"，不要让用户走到执行才吃 409 |

---

## 5. 交付物

- 上述客户端模块与服务端投影分支。
- 投影单测 + 客户端 API 分流的聚焦测试。
- `docs/wiki/workflows/change-proposal-review.md` 增补"审阅界面入口与错误恢复"小节。
- `docs/dev/IMPLEMENTATION_REPORT_PROPOSAL_UI.md`（按协作指南 §4 Step 3 格式）。

完成后合回 `beta` 做前后端联合 smoke，再进入 Phase 2（自 2A 起）。
