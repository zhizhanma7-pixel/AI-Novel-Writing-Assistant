import { useState } from "react";
import type {
  EditProposedChangeInput,
  ProposedChange,
  ProposedChangeReviewDecision,
} from "@ai-novel/shared/types/changeProposal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CHANGE_CATEGORY_COPY,
  formatProposalValue,
  isLedgerOnlyProposedChange,
} from "./changeProposalCopy";
import ProposedChangeEditor from "./ProposedChangeEditor";

const DECISION_COPY: Record<ProposedChangeReviewDecision, string> = {
  accepted: "接受原建议",
  modified: "按修改值接受",
  rejected: "拒绝此项",
};

export default function ProposedChangeRow(props: {
  change: ProposedChange;
  decision?: ProposedChangeReviewDecision;
  reviewEnabled: boolean;
  isSaving: boolean;
  onDecision: (decision: ProposedChangeReviewDecision) => void;
  onEdit: (input: EditProposedChangeInput) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const isLedgerOnly = isLedgerOnlyProposedChange(props.change);
  const hasStoredEdit = props.change.userEditedPayload !== null;
  const displayedAfter = hasStoredEdit && props.change.after == null
    ? props.change.userEditedPayload
    : props.change.after;
  const effectiveDecision = props.decision ?? props.change.reviewDecision ?? undefined;

  return (
    <article className="space-y-3 rounded-2xl border border-border/70 bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="break-all text-sm font-medium text-foreground">{props.change.path}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">{props.change.reason}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant={props.change.severity === "major" ? "destructive" : "secondary"}>
            {props.change.severity === "major" ? "重要变化" : "轻微变化"}
          </Badge>
          <Badge variant="outline">{CHANGE_CATEGORY_COPY[props.change.category]}</Badge>
          {hasStoredEdit ? <Badge variant="default">已修改</Badge> : null}
        </div>
      </div>

      {isLedgerOnly ? (
        <div className="rounded-xl border border-amber-300/70 bg-amber-50/60 px-3 py-2 text-xs leading-5 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/20 dark:text-amber-200">
          这类变化可保留在审阅记录中，暂不能写入正式故事状态。
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border bg-muted/15 p-3">
          <div className="text-xs font-medium text-muted-foreground">原状态</div>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans text-sm text-foreground">
            {formatProposalValue(props.change.before)}
          </pre>
        </div>
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-3">
          <div className="text-xs font-medium text-muted-foreground">建议状态</div>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans text-sm text-foreground">
            {formatProposalValue(displayedAfter)}
          </pre>
        </div>
      </div>

      {props.change.evidence.length > 0 ? (
        <div className="text-xs leading-5 text-muted-foreground">
          依据：{props.change.evidence.join("；")}
        </div>
      ) : null}

      {editing ? (
        <ProposedChangeEditor
          change={props.change}
          isSaving={props.isSaving}
          onSave={props.onEdit}
          onSaved={() => {
            props.onDecision("modified");
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : null}

      {props.reviewEnabled && !editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={effectiveDecision === (hasStoredEdit ? "modified" : "accepted") ? "default" : "outline"}
            onClick={() => props.onDecision(hasStoredEdit ? "modified" : "accepted")}
          >
            ✓ {hasStoredEdit ? "按修改值接受" : "接受"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
            ✎ 修改
          </Button>
          <Button
            type="button"
            size="sm"
            variant={effectiveDecision === "rejected" ? "destructive" : "outline"}
            onClick={() => props.onDecision("rejected")}
          >
            ✗ 拒绝
          </Button>
          {effectiveDecision ? (
            <span className="text-xs text-muted-foreground">已选择：{DECISION_COPY[effectiveDecision]}</span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
