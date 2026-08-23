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
  editChangeProposalItem,
  executeChangeProposal,
  getChangeProposal,
  listChangeProposals,
  partiallyApproveChangeProposal,
  regenerateChangeProposal,
  rejectChangeProposal,
  submitChangeProposal,
  type ChangeProposalActionResult,
} from "@/api/novel/changeProposals";
import { queryKeys } from "@/api/queryKeys";
import { toast } from "@/components/ui/toast";
import { resolveChangeProposalError } from "./changeProposalCopy";

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
  proposalId: string;
  version: number;
  updatedAt: string;
  status: ChangeProposalStatus;
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
  const filters = useMemo(() => ({ status: statusFilter, type: typeFilter }), [statusFilter, typeFilter]);
  const listKey = queryKeys.novels.changeProposals(input.novelId, filtersKey(filters));

  useEffect(() => {
    setSelectedProposalId("");
    setQueuedAction(null);
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
    refetchInterval: 2000,
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
    toast.success("导演已处理这次提案操作，请检查最新结果。");
  }, [orderedProposals, proposalQuery.data, queuedAction, queuedProposalQuery.data]);

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
            proposalId: proposal.id,
            version: proposal.version,
            updatedAt: proposal.updatedAt,
            status: proposal.status,
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
    actionMutation,
    editMutation,
    refresh: async () => {
      await Promise.all([
        selectedProposalId ? proposalQuery.refetch() : Promise.resolve(),
        refreshList(),
      ]);
    },
  };
}
