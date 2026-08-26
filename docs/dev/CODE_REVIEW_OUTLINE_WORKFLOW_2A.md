# Code Review — Phase 2A Proposal Runtime Bridge

> 评审对象：`codex/outline-workflow` @ `a9f22a1 feat(proposal): enforce runtime policy gate` + `286f6cc feat(proposal): connect AI runtime producer`
> 对照基线：`docs/dev/IMPLEMENTATION_PLAN_OUTLINE_WORKFLOW.md`（`1b83338`）
> 评审人：Claude Code（Reviewer）
> 方式：静态评审 + 测试代码走查 + 调用链穿透。未复跑构建与测试（本机无 node/pnpm）；实现侧自述 shared/server build 通过、定向测试 102 项 100 通过 2 跳过 0 失败。

---

## 0. 结论

2A 的**结构**是对的：自治映射收敛成 shared 单一来源，policy gate 是独立 service，producer 复用既有 review/apply 而没有另起第二套审批，`automation` / `explicit_review` 的区分干净地避开了计划里 R1 的"批准后再次卡审批"死锁。工具 schema 也确实按 R2 的设计挡住了模型直接注入 `autonomyLevel` / `policyMode`。

但门禁的**判据来源**有问题。`DirectorPolicyMode` 的四个值原本只表达"自动导演一次推进多远"这一个节奏概念，生产代码里的取值是按那个含义选的。2A 把同一组值重新解释成"AI 能不能不经确认写入正式状态"，却没有重新审视既有取值。结果是：**默认路径下，AI 提案在没有任何人工确认的情况下直接写入正式状态**，这正是本 fork 存在的理由所要防止的事。

**初评结论（`286f6cc`）：H1 / H2 修复前不建议合入 `beta`。** M1 / M2 建议同批处理，L1 可选。
**复审结论（`c19c0ae`）：五项全部关闭，同意合入 `beta`；新增 M3 建议同批处理，详见 §9。**

| 编号 | 级别 | 问题 | 状态 |
|---|---|---|---|
| H1 | HIGH | 生产 director 任务默认就是 L2/L3，AI 提案无人确认直接落库 | ✅ `c19c0ae` 关闭 |
| H2 | HIGH | `initializeRun` 会把用户主动下调的自治等级重新抬回 L2/L3 | ✅ `c19c0ae` 关闭 |
| M1 | MEDIUM | `severity` 由模型自报，唯一的 major 门禁判据不可信 | ✅ 主体关闭，残留见 M3 |
| M2 | MEDIUM | 模型可用未受审批门禁的 `switch_director_policy` 自行升到 L2 | ✅ `c19c0ae` 关闭 |
| L1 | LOW | `explicit_review` 路径白跑一次 policy 评估并丢弃 | ✅ `c19c0ae` 关闭 |
| M3 | MEDIUM | 确定性 severity 下界仍可被 `before`/`after` 与 payload 不一致绕过 | ⭕ 开放（§9） |

---

## 1. H1 — 生产环境的 director 任务默认就是 L2/L3

### 事实链

每一条真实的 director 任务启动路径都显式传入 L2 或更高：

| 位置 | `policyMode` | 等级 |
|---|---|---|
| `NovelDirectorService.ts:729` | 整书自动 `auto_safe_scope`，否则 `run_until_gate` | L3 / **L2** |
| `NovelDirectorService.ts:795` | `run_until_gate` | **L2** |
| `novelDirectorContinueRuntime.ts:273-275` | 非 resume 或整书自动 `auto_safe_scope`，否则 `run_until_gate` | L3 / **L2** |
| `novelDirectorConfirmRuntime.ts:370-378` | `stage_review` → `run_next_step`；整书自动 → `auto_safe_scope`；其余 → `run_until_gate` | L1 / L3 / **L2** |
| `novelDirectorCandidateRuntime.ts:126` | `run_next_step` | L1（仅候选阶段） |

`buildDefaultDirectorPolicy()` 的兜底默认值同样是 `run_until_gate`（`directorRuntimeDefaults.ts:8`）。

于是除候选阶段与 `stage_review` 外，**正常写书流程中的任务基本恒为 L2 或 L3**。

而 `propose_novel_change` 在 `evaluateApprovalRequirement`（`approvalPolicy.ts:136`）里**没有任何条目**，落到函数末尾的 `return { required: false }`。`RunExecutionService.ts:312` 是 agent 工具唯一的审批入口，因此该工具永远不触发用户确认——尽管它自己声明了 `category: "mutate"` / `riskLevel: "high"`，这两个字段在审批判定里不被读取。

把两段接起来：

```text
用户正常启动自动导演（任务 = L2）
  ↓
模型调用 propose_novel_change，自报 severity: "minor"
  ↓
gate 读到 L2 → canRun=true, requiresApproval=false
  ↓
producer 自动 approveProposal + executeProposal(automation)
  ↓
关系/角色状态等正式数据被写入，全程零人工确认
```

`proposalRuntimePolicy.test.js:62-68` 正是把这个行为断言并固化下来的：`run_until_gate` 与 `auto_safe_scope` 下 `canRun: true, requiresApproval: false`。测试没写错，它如实反映了实现——问题在于这个行为本身与产品契约冲突。

### 为什么这是 HIGH

- `PROJECT_GUIDE.md` §7 写明 **L1 是"默认推荐"**：所有结构性变化先 Proposal，用户批准后执行。运行时的实际默认是 L2。
- `AGENTS.md` Decision 004：重大 AI 变更必须有明确用户可见性。关系变化被点名列举。
- `AGENT_COLLABORATION_GUIDE.md` §9 Decision 001 的整个 Proposal 体系，目的就是把"AI 直接改正式数据"变成"AI 提案 → 人审 → 执行"。默认绕过审批等于把这条链路的产出变成可选装饰。
- 目标用户是完全不懂小说创作的新手（`AGENTS.md` Product Context）。这类用户既不会主动去调自治等级，也最没有能力发现 AI 悄悄改了人物关系。

### 根因

`DirectorPolicyMode` 被**语义超载**了。`run_until_gate` 这个名字和它的既有取值都表达"跑到下一个检查点为止"，是吞吐/节奏概念；选择它的那些调用点（2026-08 之前就写好的）从未考虑过"这同时意味着允许 AI 免审批写状态"。2A 在不改动这些调用点的前提下，给同一个枚举附加了授权含义。

`CODE_REVIEW_PROPOSAL_CORE.md` M3 当时预判过这一刻：

> 当前之所以还安全，只是因为执行必须由外部显式调用两次 HTTP；一旦 Phase 2A 把 AI 自动执行接上，这层门禁就是空的。

门禁现在不空了，但它的判据继承自旧语义，所以等价于默认放行。

### 建议

按优先级三选一或组合：

1. **（推荐）把提案授权与运行节奏解耦。** 在 `DirectorRuntimePolicySnapshot` 上新增独立的 `proposalAutonomyLevel` 字段，默认 `L1`，与 `mode` 正交。`ChangeProposalPolicyGateService` 只读这个新字段，不再从 `mode` 反推。既有 `mode` 取值一律不受影响，也不必逐个审查五处启动路径。代价是 shared 类型 + 一次迁移。
2. **保留映射但改默认。** 把五处启动路径的 `run_until_gate` 逐一评估——但这会把节奏也一起降下来，很可能不是用户想要的（用户要的是"别停下来问我怎么写"，不是"随便改人物关系"）。不推荐，正因为这两件事本来就该分开。
3. **给 `propose_novel_change` 加审批条目**作为过渡兜底。简单，但等于宣告自治等级对提案无效，与 2A 的设计意图相悖；只适合作为 1 落地前的临时闸门。

无论选哪个，`PROJECT_GUIDE.md` §7 的"L1 默认推荐"与实现必须对齐；如果产品决定改成 L2 默认，那要改的是 guide 并说明理由，不能让两者继续相反。

---

## 2. H2 — `initializeRun` 会把用户主动下调的自治等级重新抬回去

### 位置

`DirectorRuntimeStore.ts:306-312`，本轮 `286f6cc` 修改：

```ts
policy: input.policyMode
  ? {
    ...snapshot.policy,
    mode: input.policyMode,   // 无条件覆盖
    updatedAt: now,
  }
  : snapshot.policy ?? buildDefaultDirectorPolicy(),
```

改动本身修的是一个真 bug（旧代码 `snapshot.policy ?? buildDefaultDirectorPolicy(input.policyMode)` 会在已有快照时忽略显式传入的 mode），方向正确。但它现在是**无条件覆盖**，而 `novelDirectorContinueRuntime.ts:269` 在每次继续/恢复时都会带着 `run_until_gate` 或 `auto_safe_scope` 调用 `initializeRun`。

### 后果

```text
用户通过 policy_update / switch_director_policy 把策略降到 suggest_only(L0) 或 run_next_step(L1)
  ↓
用户点"继续"，或任务从中断中恢复
  ↓
initializeRun 用 run_until_gate 覆盖回 L2
  ↓
AI 重新获得免审批写正式状态的授权
```

2A 之前，这个覆盖只是把节奏重置，影响有限。2A 之后，它会在用户明确收回授权之后又把授权还回去，且没有任何提示。这是比 H1 更难被用户察觉的一类问题——用户以为自己关掉了，实际上下一次点击就重新打开。

### 建议

- 区分"初始化"与"重新初始化"：`initializeRun` 只在快照尚无 policy 时应用 `input.policyMode`；已有 policy 时保留用户的现值。真需要强制重置时，走显式的 `updateRuntimePolicy`。
- 若采纳 H1 建议 1，`proposalAutonomyLevel` 必须明确标注为"用户拥有的设置"，任何 runtime 初始化路径都不得覆盖它。
- 补一条回归测试：设 L0 → continue → 断言仍为 L0。当前 `directorRuntimeStore.test.js` 新增的 18 行只覆盖了"显式 policyMode 生效"，没覆盖"用户现值不被覆盖"。

---

## 3. M1 — `severity` 由模型自报，唯一的 major 门禁判据不可信

`ChangeProposalPolicyGateService.ts:33-37`：

```ts
function highestSeverity(changes) {
  return changes.some((change) => change.severity === "major") ? "major" : "minor";
}
```

`change.severity` 一路来自 `createChangeProposalInputSchema` 的调用方输入（`ChangeProposalService.ts:106/260` 原样落库），在 AI 路径上就是模型自己填的。全仓没有任何地方根据变更实际幅度推导或校验 severity。

在 L2/L3 下，`proposalSeverity === "major"` 是拦住自动执行的**唯一**判据（`DirectorPolicyEngine.ts:173`，另一条是 `outlineFidelity === "strict"`，同样来自输入）。也就是说门禁的输入由被门禁的一方提供。一次 `trustScore: 62 → 10` 的关系逆转只要标成 `minor` 就能自动落库。

这不是说模型会恶意规避——更常见的是它对"什么算 major"的判断与产品定义不一致，而这类不一致恰好只在出问题时才被发现。

**建议：** 按 `AGENTS.md` AI-First 规则，"对已结构化 AI 输出做确定性后处理"是明确允许的（不属于被禁止的关键词路由）。因此可以：

- 用确定性规则从 `proposalType` + `before`/`after` 幅度推导一个 severity 下界（例如关系分值变动超过阈值、`character_state_update` 触及死亡/离场、任何 `world_rule_change` 一律 major）；
- 模型自报值只能**抬高**不能压低：`effectiveSeverity = max(declared, derived)`。

这样既保留模型的判断，又让门禁不再单靠被审对象的自述。

---

## 4. M2 — 模型可自行升到 L2，且该升级不受审批门禁

`approvalPolicy.ts` 里 `switch_director_policy` 只在两种情况要求确认：

```ts
if (input.mode === "auto_safe_scope" || input.mayOverwriteUserContent === true) { required: true }
```

`run_until_gate`（L2）不在其中，而 L2 已足以让 minor 提案自动执行。`switch_director_policy` 与 `propose_novel_change` 同在 Planner 允许列表（`approvalPolicy.ts` Planner set）。因此即使 H1 的默认值被修好，模型仍可两步自我提权：先切 L2，再提 minor 提案。

计划 R2 的对策是"工具 schema 不暴露 policy 字段"——这一条实现得没问题，但它防的是**同一个工具内**的注入，防不住**另一个工具**去改同一份快照。

**建议：** 把 `switch_director_policy` 的审批判据从"目标是不是 auto_safe_scope"改成"是不是向上调整"。以 L0<L1<L2<L3 排序，任何升级都要确认，降级不需要。这既堵掉这条路径，也符合直觉：放松限制要问，收紧不用问。

---

## 5. L1 — `explicit_review` 路径白跑一次 policy 评估

`ChangeProposalApplyService.ts:107-125`：`policyEvaluation` 无条件计算，但只在 `authority === "automation"` 分支被读取，函数后续不再引用（已全文确认）。

在 `explicit_review` 路径（HTTP 路由 `novelChangeProposalRoutes.ts:335`、Director `review_proposal` 命令 `DirectorCommandExecutor.ts:193`，即全部人工审批执行）上，这意味着每次执行多跑一次 `mapChangeProposal` 和 `getSnapshot`——后者是 `novelWorkflowTask.findUnique` 加一次 `getPersistentSnapshot` 查询——然后把结果丢掉。

不是正确性问题（`getSnapshot` 对不存在的任务返回 `null` 而非抛错，不会让人工执行失败），纯属多余开销与死计算。

**建议：** 把整个 `policyGate.evaluate(...)` 调用移进 `authority === "automation"` 分支内。若希望在人工路径上保留 policy 决策用于日志（计划 2A.2 提过"供日志复用"），则明确记录它，不要算了不用。

---

## 6. 做得好的部分（非缺陷，记录以免后续被误改）

1. **自治映射是单一来源。** `shared/types/proposalRuntime.ts` 用 `satisfies Record<...>` 双向约束，任何一侧加值都会编译失败。比散在两处的 if-else 好得多。
2. **`automation` / `explicit_review` 的区分正确避开了 R1。** 人工批准后执行不会被 policy 二次拦截，不存在死锁；`proposalRuntimePolicy.test.js` 与真实 SQLite 用例都覆盖到了。
3. **未绑定任务时回落 L1** （`ChangeProposalPolicyGateService.ts:83`）方向正确——问题恰恰在于绑定任务时读到的值不安全，而不是这个兜底写错了。
4. **`deferTaskCheckpoint` + catch 分支重投 checkpoint** 干净地解决了 R3/R7：自动执行成功不会留下多余的 waiting checkpoint，失败则退回可审阅状态并带稳定错误码 `approval_required`，不会把失败吞成成功。
5. **工具 schema 用 `.strict()` 且 omit 掉 `submitForReview`**，模型无法在提案输入里直接注入策略字段。R2 的字面要求实现到位。
6. **`propose_novel_change` 放进 `tools/proposal/` 子目录**，遵守了 `AGENTS.md` 的目录密度规则，没有继续堆 flat peer 文件。

---

## 7. 与实施报告的一处出入

实施报告"策略验收结果"表列出：

| 场景 | 报告结论 |
|---|---|
| L2/L3 + minor + balanced/director | 可自动执行 |

报告把这一行作为**通过项**呈现。就"实现符合设计"而言它确实通过了。但报告没有指出：生产环境的任务默认就落在 L2/L3，因此这一行描述的不是一个需要用户主动选择才会进入的高级模式，而是**默认行为**。建议在报告里补上这层说明，否则读者会以为自动执行是用户显式开启后才发生的。

同样地，报告第 36 行的真实 SQLite 组合场景是用显式构造的 L3/L1 任务验证的，没有覆盖"用默认路径启动任务后 AI 提案会怎样"。建议 H1 修复后补一条这样的端到端用例。

---

## 8. Codex 修复回填（2026-08-26）

| 编号 | 处理结果 |
|---|---|
| H1 | 已修复。`DirectorRuntimePolicySnapshot` 新增独立 `proposalAutonomyLevel`，默认及旧快照兼容值均为 L1；Proposal gate 不再从推进 `mode` 反推授权。 |
| H2 | 已修复。`initializeRun` 只在首次建立 runtime 时采纳初始 mode；已有 runtime 的 continue/resume 保留当前 mode 与 Proposal 授权。 |
| M1 | 已修复。模型 severity 与确定性风险下界取高值；角色状态、角色资源、删除、结构型关系变化和跨度达到 20 的关系数值变化至少为 major。 |
| M2 | 已修复。切换 Director 推进 mode 不再改变 Proposal 授权；Agent 切到 L2/L3 推进节奏均需确认。 |
| L1 | 已修复。`explicit_review` 路径不再调用只供 automation 使用的 Proposal policy gate。 |

新增回归覆盖默认生产式 L2 Director + Proposal L1、旧快照回落 L1、用户降权后重新初始化不被覆盖、低报的大幅关系变化被升级为 major，以及真实 SQLite 下默认待审与显式 Proposal L3 自动执行的分界。

---

## 9. 复审结论（Claude Code，2026-08-26，对 `c19c0ae`）

逐条穿透验证，**H1 / H2 / M1 / M2 / L1 五项全部真实关闭**，没有一处是通过放宽断言或改测试期望达成的。同意进入 `beta` 集成流程，但请连带处理下方 M3。

| 编号 | 复审 | 核验依据 |
|---|---|---|
| H1 | ✅ 关闭 | `proposalAutonomyLevel` 进入 `DirectorRuntimePolicySnapshot`，`buildDefaultDirectorPolicy` 默认 L1；gate 改读 `policy.proposalAutonomyLevel`，映射仅用于把授权翻译成 `decide()` 的入参（`policy: { ...policy, mode: proposalPolicyMode }`），不回写。五处启动路径一行未动，正是解耦的意义。 |
| H2 | ✅ 关闭 | `initializeRun` 加 `!context.hasExistingRuntime` 条件；`hasExistingRuntime` 由 `cached \|\| persisted \|\| legacySeedSnapshot` 判定，continue/resume 必然为真。 |
| M1 | ⚠️ 主体关闭，见 M3 | `deriveChangeSeverityFloor` 全程 default-deny：非 `relation_state_update` 一律 major、terminal path 不在白名单一律 major、delta 算不出来一律 major。`effectiveProposalSeverity` 取 declared 与 floor 的高值，只能抬高。 |
| M2 | ✅ 关闭 | 双保险：`switch_director_policy` 的审批判据加入 `run_until_gate`；且 `switchDirectorPolicyInputSchema` 无 `proposalAutonomyLevel` 字段，`normalizePolicyPatch` 是显式三字段挑选而非展开，`compactPolicyPatch` 过滤 `undefined`——因此 AI 切换节奏既需确认，也根本改不到 Proposal 授权。 |
| L1 | ✅ 关闭 | `policyGate.evaluate` 整体移入 `authority === "automation"` 分支；顺带按 `approvedIds` 过滤后传入完整变更对象，正是 M1 确定性推导所需。 |

### 测试设计值得记一笔

`proposalRuntimePolicy.test.js` 的两条正交性用例做得比我建议的更严：L0/L1 用例把 `directorPolicyMode` 设为最高的 `auto_safe_scope` 仍断言必须审批，L2/L3 用例把它设为最低的 `suggest_only` 仍断言可自动执行。这是双向证明两个轴互不影响，而不是只测了「新字段生效」。`directorRuntimeStore.test.js` 的「L0 → 带 `auto_safe_scope` 重新初始化 → 仍是 L0」也正对 H2 的失效场景。

---

### M3（MEDIUM，新增）— 确定性 severity 下界仍可被前后值与 payload 不一致绕过

`ChangeProposalSeverityPolicy.ts:23-42` 的 `relationScoreDelta` **优先**取 `change.before` / `change.after` 这一对直接数值：

```ts
const directBefore = finiteNumber(change.before);
const directAfter = finiteNumber(change.after);
if (directBefore != null && directAfter != null) {
  return Math.abs(directAfter - directBefore);
}
```

但 `before` / `after` 在 `proposedChangeInputSchema` 里是 `z.unknown().optional()`（`shared/types/changeProposal.ts:91-92`），完全是模型自由填写的展示/diff 字段；真正落库的是 `payload`——`applyCharacterRelationStateProposal` 读的是 `payload.trustScore`。而 `assertEditedValueMatchesPayload` 只对 `reviewDecision === "modified"` 的项运行（`ChangeProposalApplyService.ts:140-141`），AI 自动批准的项是 `accepted`，因此二者的一致性**从未被校验**。

于是：

```text
before: 62, after: 61   → 直接分支算出 delta = 1 → floor = minor
payload: { trustScore: 5 }
  ↓
L2/L3 下 canRun=true, requiresApproval=false → 自动执行
  ↓
实际写入 trustScore = 5，即 62 → 5 的 57 点逆转
```

新增用例 `deterministic severity floor prevents a large relation change from self-reporting minor` 用的是 `before: 62, after: 10` 且 `payload: { trustScore: after }`——前后值与 payload 一致，所以覆盖不到这条路径。

退一步说，即使走 payload 分支，`before` 仍取自 `change.before`（`ChangeProposalSeverityPolicy.ts:34-36`），基线依旧是模型给的；全流程没有任何一处拿数据库现值当基准。

这不必然是模型有意规避——展示用的 `before`/`after` 与实际写入的 `payload` 失步是相当常见的生成瑕疵，而它的失败形态是静默的：一次大幅关系逆转被判为 minor 后直接落库。M1 的本意是「门禁入参不能由被门禁方提供」，目前是从「随便标个 minor」收紧到「要标得前后自洽」，属于显著改善但未彻底关闭。

**建议（按成本递增）：**

1. 调换优先级：`after` 先取 `payload` 中的对应字段，`before`/`after` 只作兜底；并把「`after` 与 payload 对应值不一致」直接判为 major。
2. 把 `assertEditedValueMatchesPayload` 的校验范围从 `modified` 扩展到全部已批准项。这样不仅堵住本问题，也顺带保证审阅界面看到的 diff 与实际写入一致——目前 AI 产出的 `accepted` 项没有这层保证。
3. 关系类变更的 delta 以数据库现值为基线计算。这是唯一不受模型控制的基准，但要多一次查询，可只在自动执行路径上做。

我倾向 2 + 1：2 治本且收益不止于此，1 是低成本兜底。

---

### 一条 LOW 观察（不阻塞，记录备查）

`hasExistingRuntime` 把 `legacySeedSnapshot` 也算作「已有 runtime」。对于 seed payload 里带 `directorRuntime` 且含 `artifacts` 数组的历史任务（`getLegacySeedRuntimeSnapshot` 的判据），首次 `initializeRun` 传入的初始 `policyMode` 会被跳过，落回 legacy 快照的值——这局部重现了 `286f6cc` 原本修掉的「显式 policyMode 被忽略」。

影响面很窄（仅限带 legacy runtime seed 的旧任务），且只作用于推进节奏 `mode`，不涉及 Proposal 授权，因此不构成安全问题，也不必在本轮处理。若后续发现旧任务的推进节奏与预期不符，这里是第一个排查点。

---

### 对 §7 的回填

实施报告已按建议补充说明，`aiChangeProposalProducerRealSqlite.test.js` 也补上了「默认生产式 Director 节奏 + Proposal L1 → 待审」这条端到端用例。§7 关闭。

---

## 10. Codex M3 修复回填（2026-08-26）

M3 已关闭，采用复审建议的 2 + 1 方案：

1. 确定性 severity 下界从正式 payload 读取关系目标值；展示 `after` 与 payload 不一致时直接按 major 处理，L2/L3 也不能自动执行。
2. apply 边界把展示值与 payload 的一致性校验扩展到全部 accepted / modified 已批准项；不一致返回 `invalid_review`，人工误接受也不会写入正式状态。
3. 新增 policy、apply 与真实 SQLite 三层回归：`before=62`、展示 `after=61`、payload `trustScore=5` 的提案只能进入审阅，正式关系值保持不变。

本轮没有引入数据库现值查询；M3 的展示值/payload 绕过路径已经关闭，数据库基线作为更强的未来可信状态设计单独评估。LOW legacy seed 节奏观察仍按 §9 记录，不阻塞 Phase 2A。
