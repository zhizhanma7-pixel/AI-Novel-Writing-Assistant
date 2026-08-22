# Proposal Core 合并关口测试基线

## 范围

- 日期：2026-08-22
- `main` 基线：`308ca1b`
- 功能分支：`feat/change-proposal-core`，以 `e2231c3` 为基础并包含本轮关口收尾工作区
- 运行时：Node.js `24.19.0`
- 两边分别生成 Prisma Client，并用各自独立、按对应 schema 初始化的 SQLite 数据库运行。
- fast / integration 文件边界按功能分支 `server/scripts/run-tests.cjs` 的 `integrationTests` 集合统一计算；真实 SQLite Proposal 验收测试归入 integration。

Windows 无法一次传入全部测试文件，关口枚举采用逐文件、单并发的 `node --test`。失败键统一为 `<相对测试文件>::<用例名>`，文件级失败规范化为 `FILE_LOAD`，避免绝对路径和耗时造成假差异。

## 结果

| 对象 | fast 文件 | 失败文件 | 失败键 |
|---|---:|---:|---:|
| `main@308ca1b` | 239 | 41 | 51 |
| 功能分支 | 242 | 40 | 50 |

- `feature - main` 失败差集：**0**。
- `main - feature` 失败差集：1 条，即 `settingsImageGeneration.test.js::FILE_LOAD`。
- 功能分支多出的 3 个 Proposal fast 测试文件没有失败。

全量枚举曾将 `taskRecoveryRoutes.test.js` 和 `novelCharacterGenderRoutes.test.js` 记为功能分支文件级失败，但两个文件各自的 2 个业务用例均已通过，失败发生在 Node 24 的 `--test-force-exit` 退出阶段。其中前者明确触发 Windows libuv `UV_HANDLE_CLOSING` 断言；去掉 `--test-force-exit` 单独复跑后，两文件均为 2/2 通过，因此不计入业务失败差集。

`generationContextAssembler.test.js` 的 Proposal 隔离断言最初漏写实现已要求的 `changeProposalId: null`，修正期望后该用例通过；同文件剩余的 `assembler refreshes chapter execution fields after chapter plan regeneration` 也存在于 `main` 基线。

## `main` 完整失败清单

```text
server/tests/autoDirectorApprovalPreferenceRoutes.test.js::FILE_LOAD
server/tests/autoDirectorAutoApprovalAudit.test.js::auto director auto-approval audit loads the latest 10 records per novel
server/tests/autoDirectorChannelCallbacks.test.js::FILE_LOAD
server/tests/autoDirectorChannelSettingsRoutes.test.js::FILE_LOAD
server/tests/bookAnalysis.test.js::NovelExportService exports generated chapters as a knowledge document for diagnosis
server/tests/bookAnalysis.test.js::NovelReferenceService formats structured timeline nodes by phase
server/tests/bookAnalysisCharacterCandidate.test.js::generateAllCandidates skips generated rows and processes failed candidates
server/tests/bookAnalysisCharacterCandidate.test.js::generateCharacterProfile transitions candidate to generated with arcs and scenes
server/tests/bookAnalysisCharacterCandidate.test.js::identifyCharacterCandidates dedupes candidates and keeps generated rows intact
server/tests/bookAnalysisCharacterCandidate.test.js::legacy generateCharacters identifies then generates profiles
server/tests/chapter-runtime-routes.test.js::FILE_LOAD
server/tests/chapterAcceptanceAssessmentService.test.js::normalizeAssessment routes missing obligations to repairable draft obligation gaps
server/tests/chapterArtifactInfluence.test.js::artifact delta expires accepted influence proposals once their window has passed
server/tests/chapterArtifactInfluence.test.js::artifact delta only applies accepted influence proposals that are active in this chapter
server/tests/chapterRuntimePipeline.test.js::runPipelineChapterWithRuntime escalates patch failures to heavy repair and rechecks the chapter
server/tests/chapterRuntimePipeline.test.js::runPipelineChapterWithRuntime escalates short patch targets to heavy repair
server/tests/chapterRuntimePipeline.test.js::runPipelineChapterWithRuntime forces full rewrite when style source entities leak
server/tests/characterLibrarySync.test.js::FILE_LOAD
server/tests/characterVisibleProfile.test.js::chapter character context includes compact visible profile summary
server/tests/directorDirectoryBoundary.test.js::director root stays limited to compatibility facades
server/tests/directorDisplayStateBuilder.test.js::display state keeps running mode when task is running despite stale approval projection
server/tests/directorDisplayStateBuilder.test.js::display state maps chapter draft execution into chapter stage and uses fact progress
server/tests/directorIssueGovernance.test.js::every stable issue code has one valid default policy
server/tests/directorRunCommandService.test.js::director command stale recovery applies the task policy instead of only recording it
server/tests/dramaForge.test.js::FILE_LOAD
server/tests/generationContextAssembler.test.js::assembler refreshes chapter execution fields after chapter plan regeneration
server/tests/imageRoutesNovelCover.test.js::FILE_LOAD
server/tests/novelContinuationReferenceHardening.test.js::FILE_LOAD
server/tests/novelDirectorAutoExecutionRuntime.test.js::circuit-breaker governance continues, pauses, or fails the real workflow state
server/tests/novelDirectorCharacterGate.test.js::director character phase applies an existing draft cast option without regenerating
server/tests/novelDirectorConfirmDedup.test.js::confirm runtime creates the novel through the standard runtime node
server/tests/novelDirectorStageNodeAdapters.test.js::director planning stages expose standard node adapter contracts
server/tests/novelDirectorStructuredOutlinePersistence.test.js::runDirectorStructuredOutlinePhase persists chapter detail after each completed chapter
server/tests/novelDirectorStructuredOutlinePersistence.test.js::runDirectorStructuredOutlinePhase resumes from the next incomplete chapter
server/tests/novelDirectorTakeoverExecution.test.js::continue_existing chapter takeover does not reuse the requested auto execution range
server/tests/novelExportService.test.js::buildExportContent uses novel title plus timestamp as export filename
server/tests/novelGenerationService.test.js::FILE_LOAD
server/tests/novelPlanningService.test.js::FILE_LOAD
server/tests/novelWorkflowContinue.test.js::novel workflow continue route accepts range and full-book continuation modes
server/tests/payoffLedgerShared.test.js::buildPayoffLedgerResponse orders items by risk and computes summary counts
server/tests/ragContextualChunk.test.js::FILE_LOAD
server/tests/ragJobListing.test.js::FILE_LOAD
server/tests/ragRetrievalTrace.test.js::RagRetrievalTracer writes sampled trace summaries without chunk text
server/tests/routes.test.js::novel routes preserve book framing fields through create-get-update cycle
server/tests/routes.test.js::PUT /api/settings/rag saves extended settings and auto-enqueues reindex
server/tests/settingsImageGeneration.test.js::FILE_LOAD
server/tests/style-engine.test.js::StyleRewriteService includes preview anti-ai rules in the repair prompt
server/tests/styleGenerationSanitizer.test.js::sanitizeStyleContextForGeneration redacts source entities before writer context
server/tests/tools.test.js::agent tool definitions keep zod declarations in dedicated schema modules
server/tests/volumeWorkspace.test.js::volume workspace v2 roundtrip keeps strategy, beat sheet and rebalance assets
server/tests/worldContextGateway.test.js::gateway delegates novel theme world generation through novel world service
```

功能分支的 50 条失败均在上述清单中；没有 Proposal Core 引入的新增失败。
