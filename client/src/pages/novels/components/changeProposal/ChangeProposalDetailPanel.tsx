import { useEffect, useMemo, useState } from "react";
import type {
  ChangeProposal,
  EditProposedChangeInput,
  ProposedChangeItemDecision,
  ProposedChangeReviewDecision,
} from "@ai-novel/shared/types/changeProposal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  isLedgerOnlyProposedChange,
  PROPOSAL_STATUS_COPY,
  PROPOSAL_TYPE_COPY,
} from "./changeProposalCopy";
import ProposedChangeRow from "./ProposedChangeRow";

function sourceReferenceLabel(source: ChangeProposal["sourceRefs"][number]): string {
  if (source.label) {
    return source.label;
  }
  if (source.kind === "chapter") {
    return source.chapterOrder ? `第 ${source.chapterOrder} 章` : `章节 ${source.chapterId}`;
  }
  if (source.kind === "director_artifact") {
    return `导演产物 v${source.version}`;
  }
  return `${source.table} / ${source.id}`;
}

export default function ChangeProposalDetailPanel(props: {
  proposal: ChangeProposal | null;
  isLoading: boolean;
  queuedAction: boolean;
  queuedActionFailure?: string | null;
  actionPending: boolean;
  savingItemId?: string;
  onEdit: (itemId: string, input: EditProposedChangeInput) => Promise<unknown>;
  onSubmit: () => void;
  onApprove: () => void;
  onPartialApprove: (
    decisions: ProposedChangeItemDecision[],
    unlistedDecision: "accepted" | "rejected",
  ) => void;
  onReject: (reason?: string) => void;
  onRegenerate: () => void;
  onExecute: () => void;
}) {
  const [decisions, setDecisions] = useState<Record<string, ProposedChangeReviewDecision>>({});
  const [unlistedDecision, setUnlistedDecision] = useState<"accepted" | "rejected" | "">("");
  const [rejectReason, setRejectReason] = useState("");

  useEffect(() => {
    setDecisions({});
    setUnlistedDecision("");
    setRejectReason("");
  }, [props.proposal?.id]);

  const itemDecisions = useMemo<ProposedChangeItemDecision[]>(() => (
    Object.entries(decisions).map(([id, decision]) => ({ id, decision }))
  ), [decisions]);

  if (props.isLoading && !props.proposal) {
    return <div className="p-8 text-center text-sm text-muted-foreground">正在读取提案详情…</div>;
  }
  if (!props.proposal) {
    return <div className="p-8 text-center text-sm text-muted-foreground">从左侧选择一份提案开始审阅。</div>;
  }

  const proposal = props.proposal;
  const reviewEnabled = proposal.status === "pending_review" && !proposal.isStale && !props.queuedAction;
  const canExecute = (
    proposal.status === "approved" || proposal.status === "partially_approved"
  ) && !proposal.isStale && !props.queuedAction;
  const canRegenerate = proposal.status !== "executed" && proposal.status !== "superseded";
  const hasLedgerOnlyChanges = proposal.changes.some(isLedgerOnlyProposedChange);
  const hasApprovedLedgerOnlyChanges = proposal.changes.some((change) => (
    isLedgerOnlyProposedChange(change)
    && change.reviewDecision !== "rejected"
  ));
  const unlistedCount = Math.max(0, proposal.changes.length - itemDecisions.length);
  const hasApprovedPartialItem = itemDecisions.some((item) => item.decision !== "rejected")
    || (unlistedDecision === "accepted" && unlistedCount > 0);
  const partialReady = itemDecisions.length > 0 && Boolean(unlistedDecision) && hasApprovedPartialItem;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-5 p-5 md:p-6">
        <header className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{PROPOSAL_STATUS_COPY[proposal.status]}</Badge>
            <Badge variant="outline">{PROPOSAL_TYPE_COPY[proposal.proposalType]}</Badge>
            <Badge variant="outline">版本 {proposal.version}</Badge>
            {proposal.taskId ? <Badge variant="outline">导演任务提案</Badge> : null}
          </div>
          <h3 className="text-xl font-semibold text-foreground">{proposal.summary}</h3>
          {proposal.reasoningSummary ? (
            <p className="text-sm leading-6 text-muted-foreground">判断依据：{proposal.reasoningSummary}</p>
          ) : null}
        </header>

        {props.queuedAction ? (
          <div className="rounded-xl border border-blue-300/70 bg-blue-50/70 px-4 py-3 text-sm leading-6 text-blue-900 dark:border-blue-700/60 dark:bg-blue-950/20 dark:text-blue-200">
            操作已提交，等待导演处理。面板会自动刷新结果。
          </div>
        ) : null}

        {props.queuedActionFailure ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm leading-6 text-destructive">
            {props.queuedActionFailure}
          </div>
        ) : null}

        {proposal.isStale ? (
          <div className="space-y-2 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <div className="font-medium">提案依据发生了变化，请重新生成后再批准或执行。</div>
            {proposal.staleReasons.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5 text-xs leading-5">
                {proposal.staleReasons.map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
            ) : null}
          </div>
        ) : null}

        {proposal.warnings.length > 0 ? (
          <section className="space-y-2">
            <div className="text-sm font-medium text-foreground">需要留意</div>
            {proposal.warnings.map((warning, index) => (
              <div key={`${warning.code}-${index}`} className="rounded-xl border border-amber-300/70 bg-amber-50/60 px-3 py-2 text-sm leading-6 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/20 dark:text-amber-200">
                {warning.summary}
              </div>
            ))}
          </section>
        ) : null}

        {proposal.sourceRefs.length > 0 ? (
          <section className="space-y-2">
            <div className="text-sm font-medium text-foreground">参考来源</div>
            <div className="flex flex-wrap gap-2">
              {proposal.sourceRefs.map((source, index) => (
                <Badge key={`${source.kind}-${index}`} variant="outline">{sourceReferenceLabel(source)}</Badge>
              ))}
            </div>
          </section>
        ) : null}

        {hasLedgerOnlyChanges ? (
          <div className="rounded-xl border border-amber-300/70 bg-amber-50/60 px-4 py-3 text-sm leading-6 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/20 dark:text-amber-200">
            这份提案包含仅记录类型。你可以完成审阅，但执行前需要对应的正式状态写入能力。
          </div>
        ) : null}

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium text-foreground">逐项变化</div>
            <Badge variant="outline">{proposal.changes.length} 项</Badge>
          </div>
          {proposal.changes.map((change) => (
            <ProposedChangeRow
              key={change.id}
              change={change}
              decision={decisions[change.id]}
              reviewEnabled={reviewEnabled}
              isSaving={props.savingItemId === change.id}
              onDecision={(decision) => setDecisions((current) => ({ ...current, [change.id]: decision }))}
              onEdit={(input) => props.onEdit(change.id, input)}
            />
          ))}
        </section>

        {reviewEnabled ? (
          <section className="space-y-3 rounded-2xl border border-border/70 bg-muted/10 p-4">
            <div>
              <div className="text-sm font-medium text-foreground">提交部分批准</div>
              <div className="mt-1 text-xs leading-5 text-muted-foreground">
                对未逐项选择的变化指定统一处理方式，避免系统替你猜测。
              </div>
            </div>
            <Select
              value={unlistedDecision || "choose"}
              onValueChange={(value) => setUnlistedDecision(value === "choose" ? "" : value as "accepted" | "rejected")}
            >
              <SelectTrigger aria-label="其余项处理方式">
                <SelectValue placeholder="选择其余项处理方式" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="choose">请选择其余项处理方式</SelectItem>
                <SelectItem value="accepted">其余项全部接受</SelectItem>
                <SelectItem value="rejected">其余项全部拒绝</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => props.onPartialApprove(
                  itemDecisions,
                  unlistedDecision as "accepted" | "rejected",
                )}
                disabled={!partialReady || props.actionPending}
              >
                部分批准
              </Button>
              <Button type="button" variant="outline" onClick={props.onApprove} disabled={props.actionPending}>
                全部批准
              </Button>
            </div>
            {!partialReady ? (
              <div className="text-xs text-muted-foreground">
                请至少逐项选择一条、保留一项接受或修改的变化，并指定其余项的处理方式。
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="space-y-3 border-t border-border/70 pt-4">
          <div className="flex flex-wrap gap-2">
            {proposal.status === "draft" ? (
              <Button type="button" onClick={props.onSubmit} disabled={props.actionPending}>提交审阅</Button>
            ) : null}
            {canExecute ? (
              <Button type="button" onClick={props.onExecute} disabled={props.actionPending || hasApprovedLedgerOnlyChanges}>
                执行批准项
              </Button>
            ) : null}
            {canRegenerate ? (
              <Button
                type="button"
                variant={proposal.isStale ? "default" : "outline"}
                onClick={props.onRegenerate}
                disabled={props.actionPending || props.queuedAction}
              >
                重新生成提案
              </Button>
            ) : null}
          </div>
          {canExecute && hasApprovedLedgerOnlyChanges ? (
            <div className="text-xs leading-5 text-muted-foreground">
              执行入口已停用，因为提案包含暂不能写入正式状态的变化。
            </div>
          ) : null}
          {proposal.status === "pending_review" ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                placeholder="可填写拒绝原因，帮助后续重新规划"
              />
              <Button
                type="button"
                variant="destructive"
                onClick={() => props.onReject(rejectReason)}
                disabled={props.actionPending || props.queuedAction}
              >
                拒绝整份提案
              </Button>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
