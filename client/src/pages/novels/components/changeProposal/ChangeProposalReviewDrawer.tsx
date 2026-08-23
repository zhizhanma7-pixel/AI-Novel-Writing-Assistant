import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { resolveChangeProposalError } from "./changeProposalCopy";
import ChangeProposalDetailPanel from "./ChangeProposalDetailPanel";
import ChangeProposalListPanel from "./ChangeProposalListPanel";
import { useChangeProposals } from "./useChangeProposals";

export default function ChangeProposalReviewDrawer(props: {
  novelId: string;
  taskId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const controller = useChangeProposals({
    novelId: props.novelId,
    taskId: props.taskId,
    open: props.open,
  });
  const visibleError = controller.proposalError ?? controller.listError;
  const errorCopy = visibleError ? resolveChangeProposalError(visibleError) : null;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex h-[min(92vh,900px)] w-[calc(100vw-1.5rem)] max-w-6xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/70 px-5 py-4">
          <DialogTitle>审阅变更提案</DialogTitle>
          <DialogDescription>
            逐项检查 AI 建议，按你的决定修改、批准或拒绝，再写入正式故事状态。
          </DialogDescription>
        </DialogHeader>

        {errorCopy ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/5 px-5 py-3">
            <div>
              <div className="text-sm font-medium text-destructive">{errorCopy.title}</div>
              <div className="mt-1 text-xs leading-5 text-muted-foreground">{errorCopy.description}</div>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => controller.refresh()}>
              刷新提案
            </Button>
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 grid-rows-[minmax(220px,34vh)_minmax(0,1fr)] md:grid-cols-[320px_minmax(0,1fr)] md:grid-rows-1">
          <ChangeProposalListPanel
            proposals={controller.proposals}
            selectedProposalId={controller.selectedProposalId}
            statusFilter={controller.statusFilter}
            typeFilter={controller.typeFilter}
            isLoading={controller.isLoadingList}
            onStatusFilterChange={controller.setStatusFilter}
            onTypeFilterChange={controller.setTypeFilter}
            onSelect={controller.setSelectedProposalId}
            onRefresh={() => controller.refresh()}
          />
          <ChangeProposalDetailPanel
            proposal={controller.proposal}
            isLoading={controller.isLoadingProposal}
            queuedAction={controller.queuedAction}
            actionPending={controller.actionMutation.isPending || controller.editMutation.isPending}
            savingItemId={controller.editMutation.isPending
              ? controller.editMutation.variables?.itemId
              : undefined}
            onEdit={(itemId, input) => controller.editMutation.mutateAsync({ itemId, input })}
            onSubmit={() => controller.actionMutation.mutate({ type: "submit" })}
            onApprove={() => controller.actionMutation.mutate({ type: "approve" })}
            onPartialApprove={(itemDecisions, unlistedDecision) => controller.actionMutation.mutate({
              type: "partial",
              itemDecisions,
              unlistedDecision,
            })}
            onReject={(reason) => controller.actionMutation.mutate({ type: "reject", reason })}
            onRegenerate={() => controller.actionMutation.mutate({ type: "regenerate" })}
            onExecute={() => controller.actionMutation.mutate({ type: "execute" })}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
