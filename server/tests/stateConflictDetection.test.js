const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectStateDiffConflicts,
} = require("../dist/services/state/stateConflictDetection.js");

/**
 * 跨章状态一致性（Phase 6 / T4）。
 *
 * `detectStateDiffConflicts` 是纯函数，却一条测试都没有——而 Phase 6 规范里
 * 「hidden knowledge」「relationship drift」「foreshadowing early resolution」
 * 三条场景的判定全在它手上。这里按前后两个快照构造，逐条对上。
 *
 * 每条都成对写：**该报的要报，不该报的不能报**。只测「能检出」会让阈值退化成
 * 「什么都报」也照样绿，那种检测器没人愿意用。
 */

const CHARACTERS = [
  { id: "hero", name: "沈砚" },
  { id: "rival", name: "陆昭" },
];

function snapshot(overrides = {}) {
  return {
    characterStates: [],
    relationStates: [],
    informationStates: [],
    foreshadowStates: [],
    ...overrides,
  };
}

function detect(previous, current) {
  return detectStateDiffConflicts({
    characters: CHARACTERS,
    previousSnapshot: previous,
    currentSnapshot: current,
  });
}

function conflictTypes(result) {
  return result.conflicts.map((item) => item.conflictType).sort();
}

// ---------------------------------------------------------------- 关系漂移

function relation(overrides = {}) {
  return {
    sourceCharacterId: "hero",
    targetCharacterId: "rival",
    trustScore: 20,
    intimacyScore: 10,
    conflictScore: 70,
    dependencyScore: 5,
    ...overrides,
  };
}

test("关系分数骤变会被报出来，并说明是哪一项跳了", () => {
  // 上一章还在敌对，这一章突然高度信任，中间没有交代——这正是读者会出戏的地方。
  const result = detect(
    snapshot({ relationStates: [relation()] }),
    snapshot({ relationStates: [relation({ trustScore: 85 })] }),
  );

  assert.deepEqual(conflictTypes(result), ["relation_jump"]);
  const conflict = result.conflicts[0];
  assert.match(conflict.summary, /trust 20->85/);
  // 落差 65，属于高。severity 分档决定它会不会拦住流程，不能糊。
  assert.equal(conflict.severity, "high");
  assert.deepEqual(conflict.affectedCharacterIds.sort(), ["hero", "rival"]);
  // 用角色名不是 id：这条要给作者看。
  assert.match(conflict.title, /沈砚/);
  assert.match(conflict.title, /陆昭/);
});

test("关系的正常推进不报冲突", () => {
  // 阈值是 35。写作里关系本来就会动，动一点就报等于噪声。
  const result = detect(
    snapshot({ relationStates: [relation()] }),
    snapshot({ relationStates: [relation({ trustScore: 50, conflictScore: 45 })] }),
  );

  assert.deepEqual(result.conflicts, []);
  // 但这条关系仍在追踪范围内——已跟踪的键要报出来，调用方才知道
  // 「这次没冲突」和「这次根本没查」的区别。
  assert.ok(result.trackedConflictKeys.includes("relation_jump:hero:rival"));
});

test("新出现的关系不算漂移", () => {
  // 没有上一章的对照，谈不上「跳变」。
  const result = detect(snapshot(), snapshot({ relationStates: [relation({ trustScore: 90 })] }));
  assert.deepEqual(result.conflicts, []);
});

// ---------------------------------------------------------------- 隐藏知识

function info(overrides = {}) {
  return {
    holderType: "character",
    holderRefId: "hero",
    fact: "陆昭是影卫",
    status: "known",
    ...overrides,
  };
}

test("已经知道的事又变回不知道，会被报出来", () => {
  // 「hidden knowledge」：角色知道的事不能无声退回未知，否则后面的反应全对不上。
  const result = detect(
    snapshot({ informationStates: [info()] }),
    snapshot({ informationStates: [info({ status: "unknown" })] }),
  );

  assert.deepEqual(conflictTypes(result), ["information_regression"]);
  assert.equal(result.conflicts[0].severity, "high", "从已知退到未知是跨两档，属高");
  assert.deepEqual(result.conflicts[0].affectedCharacterIds, ["hero"]);
});

test("知识状态前进不报冲突", () => {
  const result = detect(
    snapshot({ informationStates: [info({ status: "suspected" })] }),
    snapshot({ informationStates: [info({ status: "known" })] }),
  );
  assert.deepEqual(result.conflicts, []);
});

test("同一个事实按持有者分别追踪", () => {
  // 沈砚知道、陆昭不知道，是完全正常的信息差，不能因为「同一句话」就混成一条。
  const result = detect(
    snapshot({
      informationStates: [
        info({ holderRefId: "hero", status: "known" }),
        info({ holderRefId: "rival", status: "unknown" }),
      ],
    }),
    snapshot({
      informationStates: [
        info({ holderRefId: "hero", status: "known" }),
        info({ holderRefId: "rival", status: "unknown" }),
      ],
    }),
  );

  assert.deepEqual(result.conflicts, []);
  assert.equal(result.trackedConflictKeys.filter((key) => key.startsWith("information_regression:")).length, 2);
});

// ---------------------------------------------------------------- 伏笔

function foreshadow(overrides = {}) {
  return {
    title: "断剑的来历",
    status: "setup",
    setupChapterId: "chapter-3",
    ...overrides,
  };
}

test("没有铺垫就直接兑现的伏笔会被报出来", () => {
  // 「foreshadowing early resolution」：这一章把某条线收了，但前面从没埋过。
  const result = detect(
    snapshot(),
    snapshot({ foreshadowStates: [foreshadow({ status: "resolved", setupChapterId: null })] }),
  );

  assert.deepEqual(conflictTypes(result), ["foreshadow_missing_setup"]);
  assert.equal(result.conflicts[0].severity, "high");
  assert.match(result.conflicts[0].summary, /断剑的来历/);
});

test("有铺垫章节的兑现不报冲突", () => {
  const result = detect(
    snapshot(),
    snapshot({ foreshadowStates: [foreshadow({ status: "resolved" })] }),
  );
  assert.deepEqual(result.conflicts, []);
});

test("已收的伏笔又被拆回去，会被报出来", () => {
  const result = detect(
    snapshot({ foreshadowStates: [foreshadow({ status: "resolved" })] }),
    snapshot({ foreshadowStates: [foreshadow({ status: "setup" })] }),
  );

  assert.ok(conflictTypes(result).includes("foreshadow_regression"));
  assert.equal(
    result.conflicts.find((item) => item.conflictType === "foreshadow_regression").severity,
    "high",
  );
});

test("伏笔往前推进一档不算倒退", () => {
  // 判定是 currentRank + 1 < previousRank，容一档的抖动——
  // 状态是模型抽出来的，差一档很常见，一抖就报会淹没真问题。
  const result = detect(
    snapshot({ foreshadowStates: [foreshadow({ status: "active" })] }),
    snapshot({ foreshadowStates: [foreshadow({ status: "setup" })] }),
  );
  assert.deepEqual(result.conflicts, []);
});

// ---------------------------------------------------------------- 角色目标

test("角色目标改变会被报出来，但缺少任一侧时不报", () => {
  const withGoal = (currentGoal) => snapshot({
    characterStates: [{ characterId: "hero", currentGoal, summary: null }],
  });

  const changed = detect(withGoal("护送书信"), withGoal("刺杀陆昭"));
  assert.deepEqual(conflictTypes(changed), ["character_goal_shift"]);
  assert.match(changed.conflicts[0].summary, /护送书信/);

  // 上一章没有目标，谈不上「改变」——空值不能当成一次转折。
  const appeared = detect(withGoal(""), withGoal("刺杀陆昭"));
  assert.deepEqual(appeared.conflicts, []);
});

// ---------------------------------------------------------------- 整体

test("没有上一章快照时不凭空造冲突", () => {
  // 第一章没有对照，一切都是「新出现」，不是「变化」。
  const result = detect(null, snapshot({
    relationStates: [relation({ trustScore: 95 })],
    informationStates: [info({ status: "unknown" })],
    characterStates: [{ characterId: "hero", currentGoal: "复仇", summary: null }],
  }));

  assert.deepEqual(result.conflicts, []);
});

test("多类冲突同时出现时各报各的，不互相吞掉", () => {
  const result = detect(
    snapshot({
      relationStates: [relation()],
      informationStates: [info({ status: "known" })],
    }),
    snapshot({
      relationStates: [relation({ trustScore: 85 })],
      informationStates: [info({ status: "unknown" })],
      foreshadowStates: [foreshadow({ status: "resolved", setupChapterId: null })],
    }),
  );

  assert.deepEqual(conflictTypes(result), [
    "foreshadow_missing_setup",
    "information_regression",
    "relation_jump",
  ]);
  // conflictKey 唯一，调用方靠它做幂等与「已处理」标记。
  assert.equal(new Set(result.conflicts.map((item) => item.conflictKey)).size, 3);
});

test("未兑现的伏笔不能被当成已兑现", () => {
  // 子串匹配的老陷阱：`unresolved` 里含有 `resolved`、`incomplete` 里含有
  // `complete`、`未兑现` 里含有 `兑现`。判成最高档会有两个后果：
  // 一是没铺垫却报「提前兑现」（假警报），二是真的从已兑现退回时反而不报。
  for (const status of ["unresolved", "incomplete", "未兑现", "未回收"]) {
    const result = detect(
      snapshot(),
      snapshot({ foreshadowStates: [foreshadow({ status, setupChapterId: null })] }),
    );
    assert.deepEqual(
      result.conflicts,
      [],
      `「${status}」被当成了已兑现，于是没铺垫也报了提前兑现`,
    );
  }
});

test("从已兑现退回未兑现会被报出来", () => {
  const result = detect(
    snapshot({ foreshadowStates: [foreshadow({ status: "resolved" })] }),
    snapshot({ foreshadowStates: [foreshadow({ status: "unresolved" })] }),
  );
  assert.ok(
    conflictTypes(result).includes("foreshadow_regression"),
    "「已收的线又散开」是真问题，不能因为字面含 resolved 就漏掉",
  );
});
