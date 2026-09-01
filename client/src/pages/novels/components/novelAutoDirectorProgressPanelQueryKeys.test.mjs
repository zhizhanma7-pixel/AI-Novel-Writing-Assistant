import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./NovelAutoDirectorProgressPanel.tsx", import.meta.url), "utf8");

test("auto director progress panel uses the snapshot query key for full task snapshots", () => {
  assert.match(source, /queryKey:\s*queryKeys\.tasks\.directorTaskSnapshot\(runtimeTaskId \|\| "none"\)/);
  assert.doesNotMatch(source, /queryKey:\s*queryKeys\.tasks\.directorRuntime\(runtimeTaskId \|\| "none"\)/);
});

test("auto director progress panel keeps previous snapshot data during polling", () => {
  assert.match(source, /placeholderData:\s*\(previousData\)\s*=>\s*previousData/);
});

test("auto director progress panel uses dashboard view for main container state", () => {
  assert.match(source, /const dashboardView = snapshot\?\.dashboardView \?\? null/);
  // 容器状态取的是 dashboardViewForDisplay 而不是 dashboardView：
  // 任务已经终态失败时它会置空，好让面板显示失败而不是停在最后一次运行态。
  assert.match(source, /const dashboardViewForDisplay = taskHasTerminalFailure \? null : dashboardView/);
  assert.match(source, /mapDashboardModeToContainerMode\(dashboardViewForDisplay\?\.mode \?\? null\)/);
  assert.match(source, /dashboardViewForDisplay\?\.mode === "running"[\s\S]*rawChapterTitleWarning/);
  assert.doesNotMatch(source, /runtimeProjectionForDisplay\?\.status === "waiting_approval"/);
  assert.doesNotMatch(source, /runtimeProjectionForDisplay\?\.requiresUserAction/);
  assert.doesNotMatch(source, /const runtimeRequiresUserAction/);
});

test("proposal review checkpoints open the proposal panel instead of continuing", () => {
  assert.match(source, /buildProposalReviewHref/);
  assert.match(source, /routeNovelId/);
  // 结构后来变了：不再把提案动作塞进 dashboardActions，而是在有待审提案时
  // **只**给这一个动作。这比原来更强——「继续」不会和「去审阅」并排出现，
  // 作者点不到那个会绕过审阅的按钮。钉住这个语义，不是钉旧的写法。
  assert.match(source, /label: "审阅变更提案"/);
  assert.match(
    source,
    /const actions = proposalReviewAction\s*\?\s*\[proposalReviewAction\]/,
    "有待审提案时只能给审阅动作",
  );
});
