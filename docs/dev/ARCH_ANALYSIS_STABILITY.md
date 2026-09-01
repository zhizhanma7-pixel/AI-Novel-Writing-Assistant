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

## §2 Story consistency（6 条）—— T4 已做

盘完之后，这一组比预想的清楚：**五条的判定集中在一个纯函数
`server/src/services/state/stateConflictDetection.ts` 与时间线检查器里**，
不需要跑真实生成链。此前担心的「必须多章真实往返」只对最后一条成立。

| 场景 | 判定在哪 | 结果 |
| --- | --- | --- |
| approved vs actual diff | 章节偏离（2C） | **已覆盖**，`chapterDivergence*.test.js` |
| hidden knowledge | `information_regression` | **本轮补测**，并修出一个真 bug（见下） |
| relationship drift | `relation_jump`（阈值 35 / 60） | **本轮补测** |
| timeline conflict | `timeline-checker` 的 `timeline_regression` | **已覆盖**，六种问题类型都有测试 |
| world rule conflict | —— | **没有实现**，见下 |
| foreshadowing early resolution | `foreshadow_missing_setup` | **本轮补测**，并修出一个真 bug |

### 补测时修掉的两个真 bug

两处都是**子串匹配没有先判否定**：

- `rankInformationStatus`：`"unknown"` 里含有 `"known"`，于是被判成「已知」
  （最高档）。结果是「已知的事又变回未知」——也就是 hidden knowledge 这条场景
  本身——**一条都报不出来**，且毫无征兆。`"未公开"` 含 `"公开"`，同一个坑。
- `rankForeshadowStatus`：`"unresolved"` 含 `"resolved"`、`"incomplete"` 含
  `"complete"`、`"未兑现"` 含 `"兑现"`。判成最高档会同时造成假警报
  （没铺垫却报「提前兑现」）和漏报（真的从已兑现退回时反而不报）。

这两个 bug 说明了 Phase 6 的价值：实现看着都在，跑起来也不报错，
但核心判定一直是反的。

### world rule conflict：不做，交给作者

世界规则目前只作为**提示词上下文**存在（`worldRulesText` 喂给角色生成等），
没有任何检测器判断某一章是否违反了已确立的世界规则。

**这是定下来的产品口径，不是待办缺口。** 世界规则由作者自己把关：系统这边已经
有问询与告知的机制把剧情走向摆到作者面前，判断"这样写违不违反本书设定"是
作者的事。理由也很实际——"世界规则"现在是自由文本，要机器判定就得先逼作者
把它写成可判定的形式，那等于用工具的方便去换作者的表达空间。

因此规范 17 条里，**16 条有测试覆盖，1 条按产品决定不实现**。

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

**服务端两条已清（T2 已完成）。**

| 红灯 | 结果 |
| --- | --- |
| `startPipelineJob persists maxRetries as a single repair pass` | **已清**。纯夹具问题：startPipelineJob 后来加了取问题治理策略快照那一步，要读小说本身，用例没存根 `prisma.novel.findUnique` |
| `director root stays limited to compatibility facades` | **已清**。先把唯一引用点改成按需引入，把这条链从急切单例图里摘出来，再移动文件。此前直接移动之所以引发无关的偶发失败，是因为它在加载期就构造单例、还静态拉起同为急切单例的 `marketRadarService` |
| `AI proposal producer enforces L1/L3`（integration） | 仍红。schema 要求 `autoRetryBudget`，但没有任何地方产出它 |
| client：progress panel、proposal review checkpoints、mobile ×3 | 仍红，5 条，未逐条分析 |

现状：**server fast 1536/1524 通过、12 跳过、0 失败**（连跑两轮稳定）；
integration 175/172 通过、2 跳过、1 条既有失败。

**两条环境坑，踩过一次就别再踩**：

1. 客户端测试必须用 `pnpm --filter @ai-novel/client test`，不要自己拼 glob——
   bash 默认不开 globstar，`src/**/*.test.mjs` 不会递归展开，会漏掉约 147 条测试。
2. 集成套件会 spawn `pnpm.cmd` 跑 `prisma:push`。pnpm 不在 PATH 上时会冒出
   45 条与代码无关的失败。需要把 corepack 的 shims 目录加进 PATH：
   `C:/Users/ADMIN/AppData/Local/nodejs/node_modules/corepack/shims`。

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
| ~~**T1**~~ | Import：坏 JSON / 重复角色 / 重复世界书条目**已做**；剩 PNG 元数据损坏、Skills 缺口 | — |
| ~~**T2**~~ | **已做**，服务端红灯清零；客户端 5 条待办 | — |
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
