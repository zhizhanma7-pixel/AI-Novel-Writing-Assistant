# Phase 6 — Stability：架构分析

状态：**分析中**，未动代码。
基线：`beta@2121308`（Phase 4 已合入）。

规范来源：`ainovel_workflow_guide/05_ROADMAP_AND_ACCEPTANCE.md` 的 Phase 6 一节。

---

## §0 范围

规范把 Phase 6 列成四组共 23 个场景。**Android 那 6 条随 Phase 5 取消一并去掉**
（决定见 Phase 4 交接：Phase 5 不做，之后只剩 Phase 6）。剩下 **17 个场景**，
分属 Proposal / Story consistency / Import 三组。

Phase 6 的性质与前面几个阶段不同：**它不新增能力，只回答"这些能力在坏情况下
表现如何"**。所以产出主要是测试与由测试逼出来的修复，不是新功能。

除规范列的 17 条外，另有一批**已知红灯**必须在本阶段收口——它们眼下被当作
"既有失败"跳过，再拖下去就会变成永久噪声，让真正的回归淹没在里面。见 §4。

---

## §1 Proposal（5 条）

提案核心在 `server/src/services/changeProposal/`，测试主要在
`changeProposalCore.test.js`、`changeProposalRealSqlite.test.js`、
`changeProposalHttpContract.test.js`。

| 场景 | 现状判断 | 依据 |
| --- | --- | --- |
| proposal version conflict | **部分覆盖** | `expectedVersion` 乐观锁有测试；但见下方缺口 |
| partial approval | **有覆盖，需补边界** | `changeProposalCore.test.js` 有逐项批准 |
| reject then regenerate | **未见覆盖** | 关键词检索无命中，需人工确认 |
| proposal source changed before approval | **已知缺口** | 见下 |
| stale proposal | **部分覆盖** | 命中散在多个文件，未成体系 |

### 已知缺口：逐项编辑不 bump 信封 version

`docs/dev/CODE_REVIEW_PROPOSAL_CORE.md:189` 已记录：逐项编辑不会 bump 信封
version，因此 `expectedVersion` **只能发现"信封状态变了"，发现不了"我读取之后
别人改了某一项"**。此前的加固修的是反方向（迟到的编辑），正方向仍有缝隙。

这一条同时是 `proposal source changed before approval` 与
`proposal version conflict` 两个场景的根因，应作为本组的第一优先级。

另有一条同源问题：`after` / `payload` 双写不同源（同文档 H2）。两者一起看，
可能是同一次改动。

### 建议顺序

1. 先写 `proposal source changed before approval` 的失败用例，把缝隙暴露出来
2. 再决定是 bump version 还是改 `expectedVersion` 的语义
3. `reject then regenerate` 与 `stale proposal` 补成体系的用例

---

## §2 Story consistency（6 条）

这一组最难，因为它测的不是某个函数，而是**跨章的语义一致性**——需要真实的
多章数据和一次真实的生成/审校往返。

| 场景 | 相关实现 | 现状判断 |
| --- | --- | --- |
| approved vs actual diff | Chapter Execution Divergence（2C） | 有实现，需专门用例 |
| hidden knowledge | `timelineConstraintLayer` | 有相关代码，覆盖度未核实 |
| relationship drift | 角色动态 / `characterDynamics` | 有实现，未见针对性用例 |
| timeline conflict | 时间线约束层 | **关键词无命中**，需人工确认 |
| world rule conflict | 世界设定 | 关键词命中的是 setup 状态，非冲突检测 |
| foreshadowing early resolution | 伏笔账本 `payoffLedger` | 有实现，未见针对性用例 |

**结论：这一组的覆盖状况我还没有可靠结论。** 关键词检索只能证明"有文件提到
这个词"，证明不了"这个场景被测过"。进入实现前必须逐个读实现与现有用例，
不能按上表直接排期。

**规模判断**：这六条如果都要真实数据往返，成本可能超过前五条之和。建议先做
一次可行性切分——哪些能用构造的固定数据（fixture）测，哪些必须跑真实生成链。

---

## §3 Import（6 条）

这一组是三组里最清楚的，因为 Phase 3（SillyTavern）与 Phase 4（Skills）刚做完，
解析层都是纯函数，好测。

| 场景 | 现状 | 依据 |
| --- | --- | --- |
| invalid JSON | **部分覆盖** | `sillyTavernCardParser.test.js:156` 覆盖了"非对象载荷"，但不是"JSON 语法错误" |
| unknown ST version | **已覆盖** | 同文件 `P3 — an unknown spec version degrades and says so` |
| broken PNG metadata | **需确认** | `sillyTavernCardImportRealSqlite.test.js` 提到 PNG，未确认是否测了"坏的" |
| duplicated character | **未见覆盖** | 命中的是 `characterDynamicsUtils`，与导入无关 |
| duplicated worldbook entry | **未见覆盖** | 关键词无命中 |
| Skill missing SKILL.md | **已覆盖** | `skillPackageParser.test.js:170`，`missing_manifest` |

**这一组建议先做**：范围清楚、成本可估、刚做完的代码记忆还热。

---

## §4 已知红灯收口（规范外，但必须做）

眼下每次跑测试都要在报告里写"这几条是既有失败"。这种长期噪声会让真正的回归
被忽略——这本身就是 Phase 6 要解决的稳定性问题。

| 红灯 | 性质 | 已知信息 |
| --- | --- | --- |
| `director root stays limited to compatibility facades` | 结构约束 | `NovelDirectorIdeaInspirationService.ts` 留在 director 根目录。**曾尝试移走并失败**：移动后 `autoDirectorFollowUpRoutes` 在全量下偶发失败（单独跑通过），是文档 §3b 记录的 eager-singleton 加载顺序问题。移动之前要先解掉那个耦合 |
| `startPipelineJob persists maxRetries as a single repair pass` | 测试夹具 | 报 `AppError: 小说不存在。`——是夹具没建小说，不是产品逻辑错。应为易修 |
| `AI proposal producer enforces L1/L3`（integration） | 契约漂移 | schema 要求 `autoRetryBudget`，但没有任何地方产出它 |
| client：progress panel、proposal review checkpoints、mobile ×3 | 5 条 | 未逐条分析 |

**顺带记一条方法论**：客户端测试必须用 `pnpm --filter @ai-novel/client test`，
不要自己拼 glob——bash 默认不开 globstar，`src/**/*.test.mjs` 不会递归展开，
会漏掉约 147 条测试。Phase 4 期间我因此报过一轮偏低的数字。

---

## §5 顺带解决的产品缺口

Phase 4 留下、已同意推迟到本阶段的一条：

- **作者不能为自己创建的写法选择自动适用环节**。`applicableTasks` 只有创建
  路径会写，`updateProfile` 与路由 schema 都没有它，结果自动命中实际只对导入的
  包可用。详见 `docs/design/skill-packages-v1.md` 的「已知缺口」。
  补齐需要：路由 schema + 更新路径 + 一个环节多选的编辑界面。

这条不属于"稳定性"，但它是 Phase 4 唯一挂账的功能项，放在本阶段一起清掉，
免得跨阶段遗忘。

---

## §6 建议的批次

| 批次 | 内容 | 理由 |
| --- | --- | --- |
| **T1** | Import 6 条 + Skills 缺口（§3、§5） | 范围最清楚，刚做完记忆热，能快速拿到第一批绿 |
| **T2** | 已知红灯收口（§4） | 先把噪声清掉，后面的回归才读得懂 |
| **T3** | Proposal 5 条（§1） | 有明确根因（version bump），但改动触及核心状态机，要在噪声清掉后做 |
| **T4** | Story consistency 6 条（§2） | 成本最高、最不确定，且需要前三批的稳定基座 |

T4 开始前应单独出一次可行性评估，不要在本文里就把它排成确定任务。

---

## §7 尚未回答的问题

1. §2 六条的真实覆盖度——必须逐个读实现，不能按关键词下结论
2. `reject then regenerate` 是真没测，还是测了但没用这个措辞
3. client 那 5 条红灯的具体原因
4. Story consistency 是否需要一份"标准测试小说"作为共用 fixture；如果需要，
   它应该放在哪、由谁维护、多大规模
