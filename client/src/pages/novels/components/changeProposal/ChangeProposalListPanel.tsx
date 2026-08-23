import type {
  ChangeProposal,
  ChangeProposalStatus,
  ChangeProposalType,
} from "@ai-novel/shared/types/changeProposal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROPOSAL_STATUS_COPY, PROPOSAL_TYPE_COPY } from "./changeProposalCopy";

const STATUS_ORDER: ChangeProposalStatus[] = [
  "pending_review",
  "approved",
  "partially_approved",
  "draft",
  "rejected",
  "executed",
  "superseded",
];

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString();
}

export default function ChangeProposalListPanel(props: {
  proposals: ChangeProposal[];
  selectedProposalId: string;
  statusFilter?: ChangeProposalStatus;
  typeFilter?: ChangeProposalType;
  isLoading: boolean;
  onStatusFilterChange: (value?: ChangeProposalStatus) => void;
  onTypeFilterChange: (value?: ChangeProposalType) => void;
  onSelect: (proposalId: string) => void;
  onRefresh: () => void;
}) {
  const grouped = STATUS_ORDER
    .map((status) => ({
      status,
      proposals: props.proposals.filter((proposal) => proposal.status === status),
    }))
    .filter((group) => group.proposals.length > 0);

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-border/70 bg-muted/10">
      <div className="space-y-3 border-b border-border/70 p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-foreground">变更提案</div>
            <div className="mt-1 text-xs text-muted-foreground">选择一份提案查看逐项变化。</div>
          </div>
          <Button type="button" size="sm" variant="ghost" onClick={props.onRefresh}>
            刷新
          </Button>
        </div>
        <Select
          value={props.statusFilter ?? "all"}
          onValueChange={(value) => props.onStatusFilterChange(value === "all" ? undefined : value as ChangeProposalStatus)}
        >
          <SelectTrigger aria-label="按提案状态筛选">
            <SelectValue placeholder="全部状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            {STATUS_ORDER.map((status) => (
              <SelectItem key={status} value={status}>{PROPOSAL_STATUS_COPY[status]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={props.typeFilter ?? "all"}
          onValueChange={(value) => props.onTypeFilterChange(value === "all" ? undefined : value as ChangeProposalType)}
        >
          <SelectTrigger aria-label="按提案类型筛选">
            <SelectValue placeholder="全部类型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类型</SelectItem>
            {Object.entries(PROPOSAL_TYPE_COPY).map(([type, label]) => (
              <SelectItem key={type} value={type}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {props.isLoading ? (
          <div className="rounded-xl border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
            正在读取提案…
          </div>
        ) : grouped.length === 0 ? (
          <div className="rounded-xl border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
            没有符合当前筛选条件的提案。
          </div>
        ) : grouped.map((group) => (
          <section key={group.status} className="space-y-2">
            <div className="flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
              <span>{PROPOSAL_STATUS_COPY[group.status]}</span>
              <span>{group.proposals.length}</span>
            </div>
            {group.proposals.map((proposal) => (
              <button
                key={proposal.id}
                type="button"
                className={`w-full rounded-xl border p-3 text-left transition ${
                  props.selectedProposalId === proposal.id
                    ? "border-primary bg-primary/5"
                    : "border-border/70 bg-background hover:border-primary/40"
                }`}
                onClick={() => props.onSelect(proposal.id)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="line-clamp-2 text-sm font-medium text-foreground">{proposal.summary}</div>
                  {proposal.isStale ? <Badge variant="destructive">来源有变化</Badge> : null}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge variant="outline">{PROPOSAL_TYPE_COPY[proposal.proposalType]}</Badge>
                  <Badge variant="secondary">v{proposal.version}</Badge>
                  {proposal.taskId ? <Badge variant="outline">导演任务</Badge> : null}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">{formatDate(proposal.updatedAt)}</div>
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
