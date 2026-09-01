import type { ModelRouteTaskType } from "@ai-novel/shared/types/novel";
import type {
  MatchedSkill,
  StyleBinding,
  StyleBindingAgent,
} from "@ai-novel/shared/types/styleEngine";
import { prisma } from "../../db/prisma";

/**
 * 按任务自动命中写法（Phase 4 / S3）。
 *
 * **匹配维度沿用已经流过来的 `agent`。** 写法解析入口 `StyleRuntimeResolver.resolve`
 * 本来就收 `agent`（writer / planner / reviewer），那就是眼下唯一现成的任务维度；
 * 为此另铺一条 taskType 管线穿过整个运行时，收益不抵改动面。
 *
 * 规范 §5 明确第一版只做 tags / task type / 手动指定 / 项目默认，**不引入模型
 * 参与选择**。这里只做 task type 一档，其余留给后续。
 */

/** 一次最多带入几条，防止自动命中把上下文顶满。 */
export const MAX_MATCHED_SKILLS = 3;

/**
 * 环节 → 任务类型。
 *
 * `StyleBindingAgent` 是 writer / planner / reviewer，而任务类型取值域是
 * `ModelRouteTaskType`；两者只有 reviewer / review 一处对不上，显式映射掉。
 */
const AGENT_TO_TASK: Record<StyleBindingAgent, ModelRouteTaskType> = {
  writer: "writer",
  planner: "planner",
  reviewer: "review",
};

function parseList(json: string | null): string[] {
  if (!json) {
    return [];
  }
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function readRuleSummary(json: string | null): string {
  if (!json) {
    return "";
  }
  try {
    const parsed = JSON.parse(json) as { summary?: unknown };
    return typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  } catch {
    return "";
  }
}

export class SkillMatcherService {
  /**
   * 找出该环节应当自动命中的写法。
   *
   * 已经人工绑定的会被排除：同一条写法既绑了又命中，注入两遍只会挤占预算，
   * 而且预览里会出现两条一样的东西。人工绑定优先。
   */
  async matchForAgent(input: {
    agent: StyleBindingAgent;
    boundProfileIds?: string[];
  }): Promise<MatchedSkill[]> {
    const task = AGENT_TO_TASK[input.agent];
    if (!task) {
      return [];
    }

    // SQLite 存的是 JSON 字符串，没法在库里按数组成员过滤；先按状态取回再在内存里筛。
    // 写法资产数量是"作者手上有多少套写法"的量级，不是章节量级。
    const rows = await prisma.styleProfile.findMany({
      where: { status: "active" },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        name: true,
        description: true,
        applicableTasksJson: true,
        narrativeRulesJson: true,
        characterRulesJson: true,
        languageRulesJson: true,
        rhythmRulesJson: true,
      },
    });

    const bound = new Set(input.boundProfileIds ?? []);
    const matched: MatchedSkill[] = [];
    for (const row of rows) {
      if (bound.has(row.id)) {
        continue;
      }
      if (!parseList(row.applicableTasksJson).includes(task)) {
        continue;
      }
      const ruleSummary = [
        readRuleSummary(row.narrativeRulesJson),
        readRuleSummary(row.characterRulesJson),
        readRuleSummary(row.languageRulesJson),
        readRuleSummary(row.rhythmRulesJson),
      ].filter(Boolean).join("\n");
      if (!ruleSummary) {
        // 命中了却没有可用规则，带进去只是噪声。
        continue;
      }
      matched.push({
        styleProfileId: row.id,
        name: row.name,
        description: row.description ?? "",
        matchedTask: task,
        ruleSummary,
      });
      if (matched.length >= MAX_MATCHED_SKILLS) {
        break;
      }
    }
    return matched;
  }

  /** 从已解析的绑定里取出资产 id，用于排除重复命中。 */
  static collectBoundProfileIds(bindings: StyleBinding[]): string[] {
    return [...new Set(bindings.map((binding) => binding.styleProfileId).filter(Boolean))];
  }
}

export const skillMatcherService = new SkillMatcherService();
