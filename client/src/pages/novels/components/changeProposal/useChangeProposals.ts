import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ChangeProposal,
  ChangeProposalStatus,
  ChangeProposalType,
  EditProposedChangeInput,
  ProposedChangeItemDecision,
  RegenerateChangeProposalInput,
} from "@ai-novel/shared/types/changeProposal";
import {
  approveChangeProposal,
  correctChapterDivergence,
  editChangeProposalItem,
  executeChangeProposal,
  getChangeProposal,
  listChangeProposals,
  partiallyApproveChangeProposal,
  regenerateChangeProposal,
  rejectChangeProposal,
  submitChangeProposal,
  suggestDivergencePlanChanges,
  type ChangeProposalActionResult,
} from "@/api/novel/changeProposals";
import { getDirectorCommandResult } from "@/api/novelDirector";
import { queryKeys } from "@/api/queryKeys";
import { toast } from "@/components/ui/toast";
import { resolveChangeProposalError } from "./changeProposalCopy";
import {
  QUEUED_PROPOSAL_ACTION_TIMEOUT_MS,
  queuedProposalFailureMessage,
  resolveQueuedProposalCommandOutcome,
} from "./queuedProposalAction";

type ProposalActionInput =
  | { type: "submit" }
  | { type: "approve" }
  | {
    type: "partial";
    itemDecisions: ProposedChangeItemDecision[];
    unlistedDecision: "accepted" | "rejected";
  }
  | { type: "reject"; reason?: string }
  | { type: "regenerate"; input?: RegenerateChangeProposalInput }
  | { type: "execute" };

interface QueuedProposalAction {
  commandId: string;
  proposalId: string;
  version: number;
  updatedAt: string;
  status: ChangeProposalStatus;
  startedAtMs: number;
}

interface QueuedProposalActionFailure {
  proposalId: string;
  message: string;
}

function filtersKey(input: {
  status?: ChangeProposalStatus;
  type?: ChangeProposalType;
  chapterId?: string;
}): string {
  return `${input.status ?? "all"}:${input.type ?? "all"}:${input.chapterId ?? "all"}`;
}

function toProposalResult(proposal: ChangeProposal): ChangeProposalActionResult {
  return { kind: "proposal", proposal, status: 200 };
}

export function useChangeProposals(input: {
  novelId: string;
  open: boolean;
  taskId?: string;
}) {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<ChangeProposalStatus | undefined>();
  const [typeFilter, setTypeFilter] = useState<ChangeProposalType | undefined>();
  const [selectedProposalId, setSelectedProposalId] = useState("");
  const [queuedAction, setQueuedAction] = useState<QueuedProposalAction | null>(null);
  const [queuedActionFailure, setQueuedActionFailure] = useState<QueuedProposalActionFailure | null>(null);
  const filters = useMemo(() => ({ status: statusFilter, type: typeFilter }), [statusFilter, typeFilter]);
  const listKey = queryKeys.novels.changeProposals(input.novelId, filtersKey(filters));

  useEffect(() => {
    setSelectedProposalId("");
    setQueuedAction(null);
    setQueuedActionFailure(null);
  }, [input.novelId]);

  const proposalsQuery = useQuery({
    queryKey: listKey,
    queryFn: () => listChangeProposals(input.novelId, filters),
    enabled: Boolean(input.novelId && input.open),
    retry: false,
    refetchInterval: queuedAction ? 2000 : false,
  });

  const orderedProposals = useMemo(() => {
    const proposals = proposalsQuery.data ?? [];
    if (!input.taskId) {
      return proposals;
    }
    return [...proposals].sort((left, right) => {
      const leftMatches = left.taskId === input.taskId ? 1 : 0;
      const rightMatches = right.taskId === input.taskId ? 1 : 0;
      return rightMatches - leftMatches;
    });
  }, [input.taskId, proposalsQuery.data]);

  useEffect(() => {
    if (!input.open) {
      return;
    }
    if (
      selectedProposalId
      && (
        orderedProposals.some((proposal) => proposal.id === selectedProposalId)
        || queuedAction?.proposalId === selectedProposalId
      )
    ) {
      return;
    }
    const preferred = orderedProposals.find((proposal) => (
      proposal.taskId === input.taskId && proposal.status === "pending_review"
    )) ?? orderedProposals.find((proposal) => proposal.status === "pending_review") ?? orderedProposals[0];
    setSelectedProposalId(preferred?.id ?? "");
  }, [input.open, input.taskId, orderedProposals, queuedAction?.proposalId, selectedProposalId]);

  const proposalQuery = useQuery({
    queryKey: queryKeys.novels.changeProposalDetail(input.novelId, selectedProposalId || "none"),
    queryFn: () => getChangeProposal(input.novelId, selectedProposalId),
    enabled: Boolean(input.novelId && input.open && selectedProposalId),
    retry: false,
    refetchInterval: queuedAction?.proposalId === selectedProposalId ? 2000 : false,
  });

  const queuedProposalQuery = useQuery({
    queryKey: queryKeys.novels.changeProposalDetail(
      input.novelId,
      queuedAction?.proposalId ?? "none",
    ),
    queryFn: () => getChangeProposal(input.novelId, queuedAction?.proposalId ?? ""),
    enabled: Boolean(
      input.novelId
      && input.open
      && queuedAction?.proposalId
      && queuedAction.proposalId !== selectedProposalId
    ),
    retry: false,
    refetchInterval: queuedAction ? 2000 : false,
  });

  const queuedCommandQuery = useQuery({
    queryKey: queryKeys.tasks.directorCommandResult(queuedAction?.commandId ?? "none"),
    queryFn: async () => {
      const response = await getDirectorCommandResult(queuedAction?.commandId ?? "");
      if (!response.data) {
        throw new Error("导演命令状态响应缺少数据。");
      }
      return response.data;
    },
    enabled: Boolean(input.open && queuedAction?.commandId),
    retry: false,
    refetchInterval: queuedAction ? 2000 : false,
  });

  const refreshList = async () => {
    await queryClient.invalidateQueries({
      queryKey: ["novels", "change-proposals", input.novelId],
    });
  };

  const cacheProposal = async (proposal: ChangeProposal) => {
    queryClient.setQueryData(
      queryKeys.novels.changeProposalDetail(input.novelId, proposal.id),
      proposal,
    );
    setSelectedProposalId(proposal.id);
    await refreshList();
  };

  useEffect(() => {
    if (!proposalQuery.error) {
      return;
    }
    if (resolveChangeProposalError(proposalQuery.error).code === "not_found") {
      setSelectedProposalId("");
      void refreshList();
    }
  }, [proposalQuery.error]);

  useEffect(() => {
    if (!queuedAction) {
      return;
    }
    const selected = proposalQuery.data?.id === queuedAction.proposalId
      ? proposalQuery.data
      : queuedProposalQuery.data;
    const successor = orderedProposals.find((proposal) => proposal.supersedesId === queuedAction.proposalId);
    const changed = selected?.id === queuedAction.proposalId && (
      selected.version !== queuedAction.version
      || selected.updatedAt !== queuedAction.updatedAt
      || selected.status !== queuedAction.status
    );
    if (!changed && !successor) {
      return;
    }
    if (successor) {
      setSelectedProposalId(successor.id);
    }
    setQueuedAction(null);
    setQueuedActionFailure(null);
    toast.success("导演已处理这次提案操作，请检查最新结果。");
  }, [orderedProposals, proposalQuery.data, queuedAction, queuedProposalQuery.data]);

  useEffect(() => {
    if (!queuedAction) {
      return;
    }
    const outcome = resolveQueuedProposalCommandOutcome({
      status: queuedCommandQuery.data?.status,
      elapsedMs: Date.now() - queuedAction.startedAtMs,
    });
    if (outcome !== "failed") {
      return;
    }
    const message = queuedProposalFailureMessage(outcome);
    setQueuedActionFailure({ proposalId: queuedAction.proposalId, message });
    setQueuedAction(null);
    toast.error("导演未能处理提案操作", { description: message });
  }, [queuedAction, queuedCommandQuery.data?.status]);

  useEffect(() => {
    if (!queuedAction) {
      return;
    }
    const remainingMs = Math.max(
      0,
      QUEUED_PROPOSAL_ACTION_TIMEOUT_MS - (Date.now() - queuedAction.startedAtMs),
    );
    const timeoutId = window.setTimeout(() => {
      const message = queuedProposalFailureMessage("timed_out");
      setQueuedActionFailure({ proposalId: queuedAction.proposalId, message });
      setQueuedAction(null);
      toast.error("等待导演处理超时", { description: message });
    }, remainingMs);
    return () => window.clearTimeout(timeoutId);
  }, [queuedAction]);

  const handleActionError = async (error: unknown) => {
    const resolved = resolveChangeProposalError(error);
    toast.error(resolved.title, { description: resolved.description });
    if (resolved.code === "not_found") {
      setSelectedProposalId("");
      await refreshList();
      return;
    }
    if (resolved.code === "version_conflict" || resolved.code === "invalid_transition" || resolved.code === "stale_proposal") {
      await Promise.all([
        proposalQuery.refetch(),
        refreshList(),
      ]);
    }
  };

  const actionMutation = useMutation({
    retry: false,
    onMutate: () => {
      setQueuedActionFailure(null);
    },
    mutationFn: async (action: ProposalActionInput): Promise<ChangeProposalActionResult> => {
      const proposal = proposalQuery.data;
      if (!proposal) {
        throw new Error("请先选择一份提案。");
      }
      if (action.type === "submit") {
        return toProposalResult(await submitChangeProposal(input.novelId, proposal.id, proposal.version));
      }
      if (action.type === "approve") {
        return approveChangeProposal(input.novelId, proposal.id, { expectedVersion: proposal.version });
      }
      if (action.type === "partial") {
        return partiallyApproveChangeProposal(input.novelId, proposal.id, {
          expectedVersion: proposal.version,
          itemDecisions: action.itemDecisions,
          unlistedDecision: action.unlistedDecision,
        });
      }
      if (action.type === "reject") {
        return rejectChangeProposal(input.novelId, proposal.id, {
          expectedVersion: proposal.version,
          reason: action.reason?.trim() || undefined,
        });
      }
      if (action.type === "regenerate") {
        return regenerateChangeProposal(input.novelId, proposal.id, {
          submitForReview: true,
          ...(action.input ?? {}),
        });
      }
      return executeChangeProposal(input.novelId, proposal.id);
    },
    onSuccess: async (result) => {
      if (result.kind === "queued") {
        const proposal = proposalQuery.data;
        if (proposal) {
          setQueuedAction({
            commandId: result.command.commandId,
            proposalId: proposal.id,
            version: proposal.version,
            updatedAt: proposal.updatedAt,
            status: proposal.status,
            startedAtMs: Date.now(),
          });
        }
        toast.success("操作已提交，等待导演处理。", {
          description: "面板会刷新提案状态，你可以继续查看其他内容。",
        });
        return;
      }
      await cacheProposal(result.proposal);
      toast.success(result.message ?? "提案操作已完成。");
    },
    onError: handleActionError,
  });

  const editMutation = useMutation({
    retry: false,
    mutationFn: async (edit: { itemId: string; input: EditProposedChangeInput }) => {
      const proposal = proposalQuery.data;
      if (!proposal) {
        throw new Error("请先选择一份提案。");
      }
      return editChangeProposalItem(input.novelId, proposal.id, edit.itemId, {
        ...edit.input,
        expectedVersion: proposal.version,
      });
    },
    onSuccess: async (proposal) => {
      await cacheProposal(proposal);
      toast.success("修改值已保存，请按修改后的内容作出决定。");
    },
    onError: handleActionError,
  });

  const suggestPlanChanges = async (itemId: string) => {
    const proposal = proposalQuery.data;
    if (!proposal) {
      throw new Error("请先选择一份提案。");
    }
    return suggestDivergencePlanChanges(input.novelId, proposal.id, itemId);
  };

  const correctDivergence = async (itemId: string) => {
    const proposal = proposalQuery.data;
    if (!proposal) {
      throw new Error("请先选择一份提案。");
    }
    const result = await correctChapterDivergence(input.novelId, proposal.id, itemId);
    // 改写会动正文和逐项状态，卡片必须看到最新的一份，否则作者会对着旧内容继续操作。
    await Promise.all([proposalQuery.refetch(), refreshList()]);
    return result;
  };

  return {
    proposals: orderedProposals,
    proposal: proposalQuery.data ?? null,
    selectedProposalId,
    setSelectedProposalId,
    statusFilter,
    setStatusFilter,
    typeFilter,
    setTypeFilter,
    isLoadingList: proposalsQuery.isLoading,
    isLoadingProposal: proposalQuery.isLoading,
    listError: proposalsQuery.error,
    proposalError: proposalQuery.error,
    queuedAction: Boolean(queuedAction),
    queuedActionFailure: queuedActionFailure?.proposalId === selectedProposalId
      ? queuedActionFailure.message
      : null,
    actionMutation,
    editMutation,
    suggestPlanChanges,
    correctDivergence,
    refresh: async () => {
      await Promise.all([
        selectedProposalId ? proposalQuery.refetch() : Promise.resolve(),
        refreshList(),
      ]);
    },
  };
}
