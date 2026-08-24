# Proposal Core Gate Disposition

本文件处置 `CODE_REVIEW_PROPOSAL_CORE_GATE.md` 的合并条件与非阻塞新问题。

## 处置结果

| 编号 | 结果 | 处置 |
|---|---|---|
| N1 | 已修复 | Change Proposal 信封项继续在同一事务中严格执行；任一正式写入失败都会回滚并向调用方报错。legacy 独立项改为逐条事务：payload / 引用类领域错误把该行标为 `rejected` 并写入 `legacy_apply_failed` note，其余合法项继续；数据库与基础设施错误仍保持严格失败。版本快照只记录实际提交的项。 |
| N2 | 已修复 | 关系阶段沿用逐项记录的真实 `sourceType`，不再把 legacy 来源统一写成 `change_proposal`。 |
| N3 | 已记录风险 | 章节增量与提案执行仍共享同一关系阶段写入 helper；同一角色对的 `isCurrent` 采用最后一次成功正式写入，历史阶段均保留。该跨来源排序规则留给后续关系状态协调阶段补专项验收。 |
| N4 | 已修复 | 先 PATCH 保存编辑值后，审批可只发送 `{ id, decision: "modified" }`；如果服务端没有已保存编辑值，则 `modified` 仍必须携带 edited payload/value。 |
| P2 | 已采纳 | `changeProposalRealSqlite.test.js` 已移入 integration 测试集合。 |

## 合并条件

- N1 已给出代码处置，不作为 Known Risk 接受。
- `main@308ca1b` 与功能分支已按相同 fast 文件边界运行并保存失败清单；`feature - main` 失败差集为空。详见 `TEST_BASELINE_PROPOSAL_CORE.md`。

结论：Proposal Phase 1 后端核心满足进入 `beta` 集成验证的代码关口。Proposal UI 由后续 `feat/change-proposal-ui` 分支承接；AI 侧 Proposal 生产者、自治等级与 policy 门禁属于 Phase 2A（Proposal Runtime Bridge），Expected vs Actual 属于 Phase 2C（Chapter Execution Divergence）。

> 口径更正（2026-08-24）：本文件原写「仍属于 Phase 2」。按 `05_ROADMAP_AND_ACCEPTANCE.md`，Phase 2 是 Outline Workflow；上述遗留接线项对应其子阶段 2A / 2C，不是 Phase 2 本身。
