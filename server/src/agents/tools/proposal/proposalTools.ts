import { AgentToolError, type AgentToolName } from "../../types";
import type { AgentToolDefinition } from "../toolTypes";
import { aiChangeProposalProducerService } from "../../../services/novel/proposal/runtime/AiChangeProposalProducerService";
import { NovelWorkflowService } from "../../../services/novel/workflow/NovelWorkflowService";
import {
  proposeNovelChangeInputSchema,
  proposeNovelChangeOutputSchema,
} from "./proposalToolSchemas";

const workflowService = new NovelWorkflowService();

async function resolveTaskId(novelId: string, taskId?: string): Promise<string> {
  if (taskId) {
    const task = await workflowService.getTaskByIdWithoutHealing(taskId);
    if (!task || task.novelId !== novelId || task.lane !== "auto_director") {
      throw new AgentToolError("INVALID_INPUT", "变更提案必须绑定当前小说的自动导演任务。");
    }
    return task.id;
  }
  const active = await workflowService.findActiveTaskByNovelAndLane(novelId, "auto_director");
  const task = active ?? await workflowService.findLatestVisibleTaskByNovelId(novelId, "auto_director");
  if (!task) {
    throw new AgentToolError("NOT_FOUND", "当前小说还没有可绑定的自动导演任务。");
  }
  return task.id;
}

export const proposalToolDefinitions: Partial<
  Record<AgentToolName, AgentToolDefinition<Record<string, unknown>, Record<string, unknown>>>
> = {
  propose_novel_change: {
    name: "propose_novel_change",
    title: "提出小说变更方案",
    description: "把 AI 识别出的小说状态变更整理成可审阅提案，并按当前自动导演策略决定安全执行或等待确认。",
    category: "mutate",
    riskLevel: "high",
    domainAgent: "NovelAgent",
    resourceScopes: ["novel", "task", "creative_decision"],
    inputSchema: proposeNovelChangeInputSchema,
    outputSchema: proposeNovelChangeOutputSchema,
    execute: async (context, rawInput) => {
      const input = proposeNovelChangeInputSchema.parse(rawInput);
      if (context.novelId && input.novelId && context.novelId !== input.novelId) {
        throw new AgentToolError("INVALID_INPUT", "提案小说与当前工作区不一致。");
      }
      const novelId = input.novelId ?? context.novelId;
      if (!novelId) {
        throw new AgentToolError("INVALID_INPUT", "需要先进入小说工作区，才能提出变更方案。");
      }
      const taskId = await resolveTaskId(novelId, input.taskId);
      const { novelId: _novelId, ...proposalInput } = input;
      const result = await aiChangeProposalProducerService.produce(novelId, {
        ...proposalInput,
        taskId,
      });
      return proposeNovelChangeOutputSchema.parse({
        ...result,
        summary: result.disposition === "executed"
          ? "变更方案已通过当前安全策略并完成应用。"
          : "变更方案需要你确认，已放入审阅入口。",
      });
    },
  },
};
