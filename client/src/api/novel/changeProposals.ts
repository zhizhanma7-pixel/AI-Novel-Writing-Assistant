import type { ApiResponse } from "@ai-novel/shared/types/api";
import type {
  ChangeProposal,
  ChangeProposalStatus,
  ChangeProposalType,
  CreateChangeProposalInput,
  EditProposedChangeInput,
  RegenerateChangeProposalInput,
  RejectChangeProposalInput,
  ReviewChangeProposalInput,
} from "@ai-novel/shared/types/changeProposal";
import type { DirectorCommandAcceptedResponse } from "@ai-novel/shared/types/directorRuntime";
import { apiClient } from "../client";
import {
  toChangeProposalActionResult,
  type ChangeProposalActionResult,
} from "./changeProposalActionResult";

export { toChangeProposalActionResult } from "./changeProposalActionResult";
export type { ChangeProposalActionResult } from "./changeProposalActionResult";

export interface ChangeProposalListFilters {
  status?: ChangeProposalStatus;
  type?: ChangeProposalType;
  chapterId?: string;
}

const REVIEW_ERROR_STATUSES = [400, 404, 409];

function requireData<T>(response: ApiResponse<T>, fallbackMessage: string): T {
  if (response.data === undefined) {
    throw new Error(fallbackMessage);
  }
  return response.data;
}

export async function listChangeProposals(
  novelId: string,
  filters: ChangeProposalListFilters = {},
): Promise<ChangeProposal[]> {
  const { data } = await apiClient.get<ApiResponse<ChangeProposal[]>>(
    `/novels/${novelId}/change-proposals`,
    { params: filters, silentErrorStatuses: REVIEW_ERROR_STATUSES },
  );
  return data.data ?? [];
}

export async function getChangeProposal(novelId: string, proposalId: string): Promise<ChangeProposal> {
  const { data } = await apiClient.get<ApiResponse<ChangeProposal>>(
    `/novels/${novelId}/change-proposals/${proposalId}`,
    { silentErrorStatuses: REVIEW_ERROR_STATUSES },
  );
  return requireData(data, "无法读取提案详情。");
}

export async function createChangeProposal(
  novelId: string,
  input: CreateChangeProposalInput,
): Promise<ChangeProposal> {
  const { data } = await apiClient.post<ApiResponse<ChangeProposal>>(
    `/novels/${novelId}/change-proposals`,
    input,
    { silentErrorStatuses: REVIEW_ERROR_STATUSES },
  );
  return requireData(data, "无法创建变更提案。");
}

export async function submitChangeProposal(
  novelId: string,
  proposalId: string,
  expectedVersion?: number,
): Promise<ChangeProposal> {
  const { data } = await apiClient.post<ApiResponse<ChangeProposal>>(
    `/novels/${novelId}/change-proposals/${proposalId}/submit`,
    { expectedVersion },
    { silentErrorStatuses: REVIEW_ERROR_STATUSES },
  );
  return requireData(data, "无法提交提案审阅。");
}

export async function editChangeProposalItem(
  novelId: string,
  proposalId: string,
  itemId: string,
  input: EditProposedChangeInput,
): Promise<ChangeProposal> {
  const { data } = await apiClient.patch<ApiResponse<ChangeProposal>>(
    `/novels/${novelId}/change-proposals/${proposalId}/items/${itemId}`,
    input,
    { silentErrorStatuses: REVIEW_ERROR_STATUSES },
  );
  return requireData(data, "无法保存修改值。");
}

async function postProposalAction(
  path: string,
  body: unknown,
): Promise<ChangeProposalActionResult> {
  const response = await apiClient.post<ApiResponse<ChangeProposal | DirectorCommandAcceptedResponse>>(
    path,
    body,
    { silentErrorStatuses: REVIEW_ERROR_STATUSES },
  );
  return toChangeProposalActionResult(response.status, response.data);
}

export function approveChangeProposal(
  novelId: string,
  proposalId: string,
  input: ReviewChangeProposalInput,
): Promise<ChangeProposalActionResult> {
  return postProposalAction(`/novels/${novelId}/change-proposals/${proposalId}/approve`, input);
}

export function partiallyApproveChangeProposal(
  novelId: string,
  proposalId: string,
  input: ReviewChangeProposalInput & { itemDecisions: NonNullable<ReviewChangeProposalInput["itemDecisions"]> },
): Promise<ChangeProposalActionResult> {
  return postProposalAction(`/novels/${novelId}/change-proposals/${proposalId}/partial-approve`, input);
}

export function rejectChangeProposal(
  novelId: string,
  proposalId: string,
  input: RejectChangeProposalInput,
): Promise<ChangeProposalActionResult> {
  return postProposalAction(`/novels/${novelId}/change-proposals/${proposalId}/reject`, input);
}

export function regenerateChangeProposal(
  novelId: string,
  proposalId: string,
  input: RegenerateChangeProposalInput,
): Promise<ChangeProposalActionResult> {
  return postProposalAction(`/novels/${novelId}/change-proposals/${proposalId}/regenerate`, input);
}

export function executeChangeProposal(
  novelId: string,
  proposalId: string,
): Promise<ChangeProposalActionResult> {
  return postProposalAction(`/novels/${novelId}/change-proposals/${proposalId}/execute`, {});
}
