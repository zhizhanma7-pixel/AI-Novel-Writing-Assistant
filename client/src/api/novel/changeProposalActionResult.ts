import type { ApiResponse } from "@ai-novel/shared/types/api";
import type { ChangeProposal } from "@ai-novel/shared/types/changeProposal";
import type { DirectorCommandAcceptedResponse } from "@ai-novel/shared/types/directorRuntime";

export type ChangeProposalActionResult =
  | {
    kind: "proposal";
    proposal: ChangeProposal;
    status: 200 | 201;
    message?: string;
  }
  | {
    kind: "queued";
    command: DirectorCommandAcceptedResponse;
    status: 202;
    message?: string;
  };

function requireData<T>(response: ApiResponse<T>, fallbackMessage: string): T {
  if (response.data === undefined) {
    throw new Error(fallbackMessage);
  }
  return response.data;
}

export function toChangeProposalActionResult(
  status: number,
  response: ApiResponse<ChangeProposal | DirectorCommandAcceptedResponse>,
): ChangeProposalActionResult {
  if (status === 202) {
    return {
      kind: "queued",
      command: requireData(response, "导演命令已提交，但响应缺少任务信息。") as DirectorCommandAcceptedResponse,
      status: 202,
      message: response.message,
    };
  }
  if (status === 200 || status === 201) {
    return {
      kind: "proposal",
      proposal: requireData(response, "提案操作完成，但响应缺少提案详情。") as ChangeProposal,
      status,
      message: response.message,
    };
  }
  throw new Error(`不支持的提案响应状态：${status}`);
}
