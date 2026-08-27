# 真实 SQLite Integration 基线与排查

## Background

真实 SQLite 组合测试用于覆盖 Prisma schema、服务门面、迁移兼容、状态写入和跨模块调用。它们比 mock 测试更容易暴露真实链路问题，但也会受到操作系统进程调用、临时数据库 URL、构建产物和在线 LLM 的干扰。

历史上仓库只有 fast 测试基线，没有 integration 基线。某个功能分支合入 `beta` 后出现多项失败时，仅凭“失败文件不在本次 diff”无法排除两个特性合并后才触发的回归。

## Decision

涉及共享合同、真实数据库或跨模块流程的功能合入 `beta` 后，若 integration 不是全绿，必须在未包含该功能的稳定基准提交上运行同一套 integration，并按测试名称比较失败集合。

- `beta failures - baseline failures` 是新增回归候选，必须在晋升前归零。
- 两边同名失败只能证明失败已存在，不能证明它无需修复；`beta` 仍需在进入下一阶段前恢复全绿。
- 不得用“diff 没碰该文件”替代基线对照，也不得通过放宽断言让真实链路迁就实现。

## Current Rule

### Windows 子进程

真实 SQLite 测试需要执行 pnpm 时，统一复用 `server/tests/helpers/processInvocation.js`：Windows 使用 `cmd.exe /d /s /c pnpm.cmd`，其他平台直接调用 `pnpm`。不要在新测试里再次手写平台分支。

SQLite URL 应相对 `server/` 生成，并验证数据库路径没有逃出 server 根目录。临时数据库继续放在 `server/.tmp/` 下，由单个测试在 `finally` 中清理；任何真实用户数据库都不在测试范围内。

### 构建产物

测试从 `server/dist` 或 `shared/dist` 加载代码时，切换分支后先确认构建产物与当前源码一致。若 server build 报出 shared 类型或导出缺失，先重建 shared 再判断是否为源码回归，不要把旧分支的 dist 当成当前结果。

### 外部 AI 隔离

integration 测试如果目标是数据库、上下文装配或恢复链路，应在明确边界替换在线 LLM 调用，使用真实数据库中预置的结构化产物继续后续链路。测试不得依赖 API key、网络或模型当前输出，也不得用关键词 fallback 伪造产品决策。

### 真实缺陷处置

进程包装修好后暴露的失败按产品缺陷处理。例如：

- 动态兼容门面调用 application service 方法时必须保留 receiver；否则依赖 `this` 的方法会在真实链路中失败。
- legacy 卷工作区第一次持久化补齐章节关联后，当前迁移调用仍要保留 `source=legacy`，确保迁移报告和首次账本同步按旧项目路径执行；后续重新读取才自然成为 `volume`。

## Verification Pattern

1. 固定 baseline 与 candidate 的提交号。
2. 在两个提交上运行同一条 integration 命令，保存失败测试名称、总数和跳过数。
3. 求失败名称差集，不用文件范围推理代替对照。
4. 在短期稳定化分支修复基础设施噪音和被它揭开的真实缺陷。
5. 先跑最窄的失败组，再跑完整 integration；只有完整套件 0 失败才视为 `beta` 稳定化完成。

## Failure Modes

- Windows 直接 `spawn/execFile pnpm.cmd` 报 `EINVAL`：先确认是否遗漏共享包装。
- Prisma 找不到临时数据库或路径解释不同：确认 URL 是相对 server schema 的 `file:./...`，不要混用绝对 Windows 路径。
- 测试意外调用在线模型：定位测试目标并在正式 service 边界注入已有结构化 fixture，不要把网络失败算作数据库失败。
- 修复 wrapper 后断言开始失败：继续穿透业务调用链；这通常说明原先基础设施错误遮住了真实产品缺陷。
- 分支切换后 build 出现与源码不符的导出错误：检查 shared/server dist 是否来自另一分支。

## Related Modules

- `server/tests/helpers/processInvocation.js`
- `server/tests/p0bRealPrismaChain.test.js`
- `server/tests/ragCompatibilityBootstrap.test.js`
- `server/src/services/novel/NovelService.ts`
- `server/src/services/novel/volume/NovelVolumeService.ts`

## Source Documents

- `docs/dev/TEST_BASELINE_PROPOSAL_CORE.md`
- `docs/dev/IMPLEMENTATION_REPORT_OUTLINE_WORKFLOW.md`
- `docs/dev/SMOKE_STATE_APPLY_OBSERVABILITY.md`
