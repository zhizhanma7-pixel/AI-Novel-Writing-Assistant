# State Apply Observability Implementation Plan

> 分支：`fix/state-apply-observability`（从 `beta@c18c83f` 拉出）
> 作者：Claude Code（Architect）
> 来源：`docs/dev/CODE_REVIEW_PROPOSAL_CORE_GATE.md` §3 的 O1、O2 —— 关口复审时判定为不阻塞合并、留待单独处理的两项

## Goal

`283ffc7` 把 legacy 状态提交的失败从"整批炸掉"改成"逐条隔离"，代价是两处遗留：失败分类靠错误消息前缀字符串，以及被隔离掉的失败没有任何告警面。这个分支只收这两项，不扩张到 Proposal 功能本身。

## Non-goals

- 任何 Proposal 功能行为改变（审阅、执行、UI 一律不动）。
- ledger-only 类型补正式 applier —— 属于 Phase 2。
- `CODE_REVIEW_PROPOSAL_UI.md` 里仍开放的 L6 / L7。
- Windows 桌面 managed server 的 `spawn` 问题 —— 见文末，建议单独分支。

---

## O1 — 用 typed error 取代消息前缀分类

### 现状

`server/src/services/novel/state/StateCommitService.ts:104-122`

```ts
const LEGACY_APPLY_DOMAIN_ERROR_PREFIXES = [
  "Character state proposal ",
  "Relation state proposal ",
] as const;

function isLegacyStateProposalDomainError(error: unknown): boolean {
  return error instanceof ZodError
    || (error instanceof Error
      && LEGACY_APPLY_DOMAIN_ERROR_PREFIXES.some((prefix) => error.message.startsWith(prefix)));
}
```

被它分类的四个抛出点：

- `StateProposalApplierRegistry.ts:44` `"Character state proposal is missing characterId."`
- `StateProposalApplierRegistry.ts:59` `"Character state proposal references a missing character."`
- `characterRelationStateMutation.ts:91` `"Relation state proposal requires two different characters."`
- `characterRelationStateMutation.ts:100` `"Relation state proposal references characters outside this novel."`

两个问题：

1. **改文案就会改行为。** 把消息从 `"Character state proposal references..."` 改成 `"角色状态提案引用了..."`，分类立刻失效，该行不再被隔离为 `rejected`，而是整批上抛——一次纯文案改动会把 legacy 隔离能力静默关掉。反过来，任何第三方错误只要碰巧以这两个前缀开头也会被误判成"这行数据坏了"。
2. **`ZodError` 的覆盖面过宽。** `applyCommittedProposal` 底下任何一层（包括 `characterResourceLedgerService.applyCommittedUpdate` 内部）抛出的 ZodError 都会被当成"这条提案的 payload 坏了"，即便它其实是别处的校验失败。

### 需求

- 定义显式的领域错误类型，例如 `StateProposalDomainError`（放在 `StateProposalApplierRegistry.ts` 同级或 `state/` 下的独立模块），四个抛出点全部改抛它，并携带 `proposalType` 与一个稳定的 `reason` 码（`missing_character_id` / `character_not_found` / `same_character_relation` / `character_outside_novel`）。
- 各 applier 内部的 payload 解析失败（`.parse` 的 ZodError）在 applier 边界处捕获并包成 `StateProposalDomainError(reason: "invalid_payload")`，不要让裸 ZodError 逃逸到分类函数。
- `isLegacyStateProposalDomainError` 改为 `error instanceof StateProposalDomainError` 单一判据，删掉前缀数组。
- `buildLegacyApplyRejection` 写进 `validationNotes` 的串改用 `legacy_apply_failed:<proposalType>:<reason>`，稳定可检索；原始消息可继续附在后面。

### 必须写下来的不变量

当前实现之所以成立，依赖一条没有写进代码的前提：

> **被判定为领域错误的抛出点，前面不能有失败的 SQL 语句。**

因为 `persistValidated` 与 legacy 逐条提交都是在 `prisma.$transaction` **内部**捕获错误后继续用同一个 `tx` 执行 `update`。PostgreSQL 上一旦有语句真的报错，事务会进入 aborted 状态，后续语句全部以 `25P02` 失败。目前四个抛出点全部满足这条前提（要么在任何 SQL 之前抛，要么在 `count` / `updateMany` **成功返回之后**根据结果抛），所以没有暴露问题。

要求：在 `StateProposalDomainError` 的定义处和两处 catch 旁写明这条约束，措辞明确到"新增领域错误时，不得在一条失败的 SQL 语句之后抛出"。这条约束一旦被后来者破坏，故障形态是 Postgres 上整批事务失败而 SQLite 上正常——极难排查。

### 验收

1. 四个抛出点改为 typed error 后，legacy 隔离行为不变：坏项标 `rejected` 并写 `legacy_apply_failed:` note，其余合法项照常提交。
2. 信封路径仍然严格：`changeProposalId != null` 的项失败时整批回滚并上抛。
3. 基础设施错误（非 `StateProposalDomainError`）仍然上抛，不被吞成 rejected。
4. 新增一条测试：抛出一个消息以 `"Character state proposal "` 开头的**普通** `Error`，断言它被当作基础设施错误上抛而不是隔离为 rejected —— 钉住"不再按文案分类"。
5. `stateCommitService.test.js` 现有的四条隔离 / 严格用例全部继续通过。

---

## O2 — 被隔离掉的 legacy 失败要有告警面

### 现状

`commitExistingProposals` 现在会返回 `rejected[]`，`PendingReviewAutoPromotionService.apply()` 也把 `commitResult` 放进了返回值（`:352`）。但是：

- `recordLedgerEvent()`（`:502`）的入参只有 `preview` / `promotedIds` / `supersededIds`，**没有 commitResult**，账本事件的 summary 与 metadata 里看不到任何被拒绝的项；
- `warnApply()`（`:539`）同样只报 promoted / superseded / conflictSkipped / deferred 四个计数；
- 两个调用方 `NovelDirectorService.ts:242` 与 `DirectorCoreStepModuleRuntime.ts:83` 都是 `await ...apply(...)`，**直接丢弃返回值**。

结果：一条每轮都因脏数据被拒的 legacy 提案，只会在 `StateChangeProposal.validationNotesJson` 里留下 `legacy_apply_failed:` 字样，除非有人手动查库，否则永远没人知道。这正是我们用"隔离"换来的静默。

### 需求

- `recordLedgerEvent` 接收 `commitResult`，把 `rejectedCount` 与 `rejectedItemIds`（截断到合理条数）写进 metadata，summary 补一段"其中 N 条因数据问题被拒绝"。
- 有拒绝项时把事件 `severity` 提到 `medium`（当前仅按 promoted / superseded 判定）。
- `warnApply` 增加 `rejectedCount`。
- 事件类型沿用现有的 `pending_review_auto_promotion`，**不要新增事件类型**；`idempotencyKey` 目前由 `promotedIds` / `supersededIds` 组成，需把 rejected 一并纳入，否则"这一轮全被拒、没有任何 promoted"时会与上一轮的空结果撞键而被覆盖。
- `proposeAndCommit` 侧（章节增量链路）同样会产生 `rejectedRows`，检查它的返回值是否已被上层消费；若同样被丢弃，至少加一条 `warn`。

### 验收

1. 自动晋级批次里出现被拒 legacy 项时，`DirectorEvent` 的 metadata 能看到条数与 item id，summary 有中文说明，severity 至少 `medium`。
2. 全部成功的批次事件形态不变（避免污染既有投影与前端展示）。
3. 同一轮"零 promoted、零 superseded、有 rejected"能生成独立事件，不与前一轮撞 `idempotencyKey`。
4. 新增针对 `recordLedgerEvent` 入参的单测，断言拒绝计数进入 metadata。

---

## 风险

| 编号 | 风险 | 对策 |
|---|---|---|
| R1 | 改 applier 抛出类型波及 `proposeAndCommit`（章节增量链路）与自动晋级两条既有链路 | 两条链路的现有测试必须全绿；隔离 / 严格两类语义各留一条断言 |
| R2 | 账本事件形态变化影响既有投影或前端展示 | 只做加法：新增 metadata 字段与 summary 尾缀，不改既有字段名与事件类型 |
| R3 | `idempotencyKey` 组成变化导致历史事件重复 | 新键只在有 rejected 时才追加分量，无 rejected 时保持与既有键完全一致 |

## 交付物

- 上述服务端改动 + 针对性测试。
- `docs/wiki/workflows/change-proposal-review.md` 的"执行与旧链路隔离"小节补一句：领域错误按类型判定，且不得在失败 SQL 之后抛出。
- `docs/dev/IMPLEMENTATION_REPORT_STATE_APPLY_OBSERVABILITY.md`。

完成后合回 `beta`，与 Phase 2 的工作并行不冲突（本分支不碰 Proposal 模块与客户端）。

---

## 附：本分支不处理、但需要单独认领的两项

1. **`directorRunCommandService.test.js::director command stale recovery applies the task policy instead of only recording it`** —— 已确认是 `main@308ca1b` 上的既有失败，见 `docs/dev/TEST_BASELINE_PROPOSAL_CORE.md` 的 main 完整失败清单第 55 行。与 Proposal 无关，属于 stale recovery 策略本身的问题，建议单独排查。
2. **Windows 桌面开发态 managed server `EINVAL`** —— 根因在 `desktop/src/runtime/server.ts`：`buildManagedServerCommand()` 在没有 `AI_NOVEL_SERVER_ENTRY` 时返回 `command = "pnpm.cmd"`（`toPnpmCommand()`，:131-133），而 `:204` 的 `spawn()` 没有 `shell: true`。Node 从 20.12 / 18.20 起（CVE-2024-27980 修复）在 Windows 上拒绝直接 spawn `.cmd` / `.bat`，抛 `EINVAL`；smoke 环境是 Node 24.19.0，正好命中。
   - 推荐修法：让默认分支也走 `process.execPath` + 解析出的服务端入口（与 `AI_NOVEL_SERVER_ENTRY` 分支同构），彻底绕开 shell。
   - 次选：给该分支加 `shell: true`。但要注意 `stopChildProcess()` 用的是 `child.kill()`，经 shell 包一层后在 Windows 上杀掉的是 `cmd.exe`，真正的 node 进程可能变成孤儿并继续占用端口。
   - 打包版走的是 `utilityProcess`（另一条路径，`stopUtilityChildProcess`），不受此问题影响，但仍需单独验证。
   - 建议分支：`fix/desktop-managed-server-spawn`。
