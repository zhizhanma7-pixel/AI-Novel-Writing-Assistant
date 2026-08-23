# Change Proposal UI Implementation Report

## Feature

为 Proposal Core 增加 Web / Electron 共用的审阅界面。用户可以从小说工作台、AI 驾驶舱和任务抽屉进入提案列表，查看来源与风险，逐项接受、修改或拒绝，并在批准后执行可写入的正式状态变化。

## Files Changed

- 新增 Change Proposal 客户端 API 与同步 / 排队响应的可辨识联合。
- 新增列表、详情、逐项 diff、轻量编辑、完整 payload 编辑和审阅抽屉模块。
- 新增集中式查询 / mutation hook，负责缓存、202 轮询、冲突刷新和无自动重试错误恢复。
- 小说编辑页只增加 URL 参数透传和抽屉挂载；桌面和移动响应式工作台各增加一个提案入口。
- 自动导演书级投影为 `proposal_review_required` 生成 `open_details` 操作，链接携带 `proposalPanel=1`。
- 任务抽屉和导演进度面板增加提案审阅 checkpoint 文案，并阻止旧进度面板把该 checkpoint 当作确认继续。
- 更新 Change Proposal 工作流 wiki，记录入口、202 分流、错误恢复与 ledger-only 边界。

## Database Changes

无。复用 Proposal Core 已合并的 `ChangeProposal`、`StateChangeProposal` 和 runtime migration。

## API Changes

- 客户端封装列表、详情、创建、提交审阅、逐项编辑、全部批准、部分批准、拒绝、再生和执行接口。
- approve / partial-approve / reject / regenerate / execute 按 HTTP 状态分为：
  - `200 / 201 -> { kind: "proposal", proposal }`
  - `202 -> { kind: "queued", command }`
- Proposal 领域错误在 HTTP `error` 字段返回稳定 code，领域消息保留在 `message`，客户端静默接管 400 / 404 / 409 并显示中文恢复动作。
- 部分批准必须携带 `unlistedDecision`；已 PATCH 保存编辑值的项发送裸 `modified`，未编辑项不能伪装成 `modified`。

## UI Behavior

- 列表按状态分组，可按状态和提案类型筛选；绑定当前导演任务的待审提案优先展示。
- 详情显示摘要、用户可见判断依据、warnings、source refs、版本、stale 原因和逐项 before / after。
- 关系 trust / intimacy / conflict / dependency 与角色 state / goal 使用建议值编辑；其他结构使用完整 payload JSON 编辑。轻编辑收到 `invalid_review` 时切换完整内容模式。
- 已编辑项显示标记，并只能按 `modified` 进入部分批准。未逐项选择的内容必须明确选择“其余全部接受”或“其余全部拒绝”。
- stale 提案打开即禁用批准和执行，并突出重新生成。
- ledger-only 类型提前说明正式写入限制；被拒绝的 ledger-only 项不阻止其他批准项执行。
- task-bound 操作显示“等待导演处理”并轮询提案状态；同步操作直接更新详情缓存。

## Acceptance Fixture

可用以下创建请求准备关系值验收数据；把示例 ID 替换为测试库中的小说、任务和角色 ID：

```json
{
  "taskId": "DIRECTOR_TASK_ID",
  "proposalType": "relationship_change",
  "summary": "A 与 B 的信任降低",
  "reasoningSummary": "冲突让双方减少信息共享",
  "changes": [
    {
      "proposalType": "relation_state_update",
      "path": "Character.A.relationship.B.trust",
      "operation": "replace",
      "category": "relationship",
      "severity": "major",
      "before": 62,
      "after": 52,
      "payload": {
        "sourceCharacterId": "CHARACTER_A_ID",
        "targetCharacterId": "CHARACTER_B_ID",
        "surfaceRelation": "合作伙伴",
        "stageLabel": "谨慎合作",
        "stageSummary": "双方仍会合作，但保留关键信息",
        "trustScore": 52
      },
      "reason": "正面冲突降低了相互信任",
      "sourceRefs": [],
      "evidence": ["双方都隐瞒了下一步计划"]
    }
  ]
}
```

验收路径：创建提案 → 把 trust 52 修改为 55 → 选择 modified → 部分批准并显式处理其余项 → 执行 → 正式关系值为 55。

## Tests Added

- 客户端同步 Proposal 与 202 Director Command 响应分流测试。
- 六类 Proposal 错误码中文恢复文案与原始服务端文本隔离测试。
- 轻编辑字段白名单与 payload 降级边界测试。
- proposalPanel URL 参数保留其他任务 / 工作区参数测试。
- 导演进度面板提案 checkpoint 不走确认继续的契约测试。
- 书级投影提案审阅入口测试，以及其他 waiting-approval checkpoint 保持原兜底的回归测试。

## Verification

- `pnpm --filter @ai-novel/client typecheck` 与正式 build：通过；Vite 仅报告仓库既有的大 chunk 提示。
- `pnpm --filter @ai-novel/server build`：通过。
- 客户端 Proposal API / copy / URL / 导演进度聚焦测试：16 项通过。
- 客户端全量测试：175 项中 171 通过；4 个失败位于未改动的风险规则入口、移动路由 CSS、任务筛选布局和移动导航顺序，Proposal 新增用例无失败。
- `server/tests/changeProposalCore.test.js` 与 `directorBookAutomationProjection.test.js`：35 项通过。
- Proposal HTTP 稳定错误码契约测试：1 项通过。
- beta 上已通过的真实 SQLite `62 -> AI 52 -> user 55 -> execute` 后端验收仍可复用：本分支没有修改状态 applier、review service、schema 或 migration。
- UI 浏览器手工验收留给评审方，未在实现阶段运行视觉自动化。

## Known Risks

- Phase 1 仍没有 AI 侧 Proposal 生产者；自动生成 Chapter Execution Proposal、Expected vs Actual、L0–L3 自治等级与 policy 门禁属于 Phase 2。
- 六种 ledger-only 状态类型仍不能执行为正式状态；界面只提前说明并阻止包含已批准 ledger-only 项的执行。
- O1 typed domain error 与 O2 legacy rejected 告警仍按关口处置留在独立后端加固分支。
- 视觉与逐项交互的浏览器手工验收由评审方执行；本实现阶段按 AGENTS.md 只做代码级检查。
