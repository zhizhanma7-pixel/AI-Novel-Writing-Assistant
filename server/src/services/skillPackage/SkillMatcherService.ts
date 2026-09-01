import type { ModelRouteTaskType } from "@ai-novel/shared/types/novel";
import { SKILL_EFFECTIVE_TASK_TYPES } from "@ai-novel/shared/types/skillPackage";
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

// 这三个值就是 SKILL_EFFECTIVE_TASK_TYPES 的全部内容——导入预览按那份口径
// 告诉作者「哪些声明不会生效」。两处如果各写各的，警告就会变成谎话。
const _assertEffectiveTasksStayInSync: Record<
  (typeof SKILL_EFFECTIVE_TASK_TYPES)[number],
  true
> = { writer: true, planner: true, review: true };
void _assertEffectiveTasksStayInSync;

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

/**
 * 自由正文当作写作说明带入时的长度上限。
 *
 * 四维规则是作者自己压缩过的摘要，长度可控；自由正文可能是整篇 SKILL.md，
 * 直接塞进去会把上下文预算吃掉。截断优于丢弃：丢了就等于这个包不生效。
 */
const MAX_GUIDANCE_CHARS = 600;

function truncateGuidance(markdown: string | null): string {
  const text = (markdown ?? "").trim();
  if (!text) {
    return "";
  }
  return text.length > MAX_GUIDANCE_CHARS ? `${text.slice(0, MAX_GUIDANCE_CHARS)}…` : text;
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
        analysisMarkdown: true,
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
      // 解析层明确允许没有四个中文小节的自由正文，只留一条 empty_rules 告警，
      // 全文进 analysisMarkdown。要是这里只认四维 summary，那种包就成了
      // 「导入成功、显示正常、永远不生效」——比读不进来更糟。
      const guidance = ruleSummary || truncateGuidance(row.analysisMarkdown);
      if (!guidance) {
        // 四维空、正文也空，那是真没东西可带。
        continue;
      }
      matched.push({
        styleProfileId: row.id,
        name: row.name,
        description: row.description ?? "",
        matchedTask: task,
        ruleSummary: guidance,
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
