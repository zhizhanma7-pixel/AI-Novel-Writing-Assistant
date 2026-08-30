import { useMemo, useState } from "react";
import type {
  EditProposedChangeInput,
  ProposedChange,
  ProposedChangeReviewDecision,
} from "@ai-novel/shared/types/changeProposal";
import type { ChapterDivergenceCorrectionResult } from "@ai-novel/shared/types/chapterDivergence";
import type {
  ChapterDivergencePlanSuggestion,
  ChapterDivergencePlanSuggestionResult,
} from "@ai-novel/shared/types/chapterDivergencePlanSuggestion";
import type { ChapterExecutionPlanPatch } from "@ai-novel/shared/types/chapterExecutionPlan";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { resolveChangeProposalError } from "../changeProposalCopy";
import DownstreamPlanPatchForm from "./DownstreamPlanPatchForm";
import {
  CORRECTION_RESULT_COPY,
  isCorrectedBackToPlan,
  PLAN_PATCH_FIELDS,
  readDivergencePayload,
  withDownstreamPatches,
} from "./divergenceCopy";

function describePatch(patch: ChapterExecutionPlanPatch): string {
  const parts = PLAN_PATCH_FIELDS
    .map((field) => {
      const value = (patch as Record<string, unknown>)[field.key];
      return typeof value === "string" && value.trim() ? `${field.label}：${value}` : null;
    })
    .filter((part): part is string => part !== null);
  return parts.join("；");
}

export default function DivergenceChangeCard(props: {
  change: ProposedChange;
  decision?: ProposedChangeReviewDecision;
  reviewEnabled: boolean;
  isSaving: boolean;
  onDecision: (decision: ProposedChangeReviewDecision) => void;
  onEdit: (input: EditProposedChangeInput) => Promise<unknown>;
  onSuggest: () => Promise<ChapterDivergencePlanSuggestionResult>;
  onCorrect: () => Promise<ChapterDivergenceCorrectionResult>;
}) {
  const view = useMemo(() => readDivergencePayload(props.change), [props.change]);
  const [editing, setEditing] = useState(false);
  const [patches, setPatches] = useState<ChapterExecutionPlanPatch[]>(view.downstreamPlanPatches);
  const [suggestions, setSuggestions] = useState<ChapterDivergencePlanSuggestion[]>([]);
  const [discarded, setDiscarded] = useState<ChapterDivergencePlanSuggestionResult["discarded"]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionAsked, setSuggestionAsked] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [correction, setCorrection] = useState<ChapterDivergenceCorrectionResult | null>(null);
  const [message, setMessage] = useState("");

  const chapterTitles = useMemo(() => {
    const titles: Record<number, string | null> = {};
    for (const suggestion of suggestions) {
      titles[suggestion.patch.chapterOrder] = suggestion.chapterTitle;
    }
    return titles;
  }, [suggestions]);

  const effectiveDecision = props.decision ?? props.change.reviewDecision ?? undefined;
  const correctedBackToPlan = isCorrectedBackToPlan(props.change);
  const savedPatchCount = view.downstreamPlanPatches.length;
  const minChapterOrder = view.chapterOrder ?? 0;

  const usablePatches = patches.filter((patch) => (
    patch.chapterOrder > minChapterOrder
    && PLAN_PATCH_FIELDS.some((field) => {
      const value = (patch as Record<string, unknown>)[field.key];
      return typeof value === "string" && value.trim().length > 0;
    })
  ));
  const canSave = usablePatches.length > 0 && usablePatches.length === patches.length;

  const askForSuggestions = async () => {
    setSuggesting(true);
    setMessage("");
    try {
      const result = await props.onSuggest();
      setSuggestions(result.suggestions);
      setDiscarded(result.discarded);
      setSuggestionAsked(true);
    } catch (error) {
      setMessage(resolveChangeProposalError(error).description);
    } finally {
      setSuggesting(false);
    }
  };

  const adoptSuggestion = (suggestion: ChapterDivergencePlanSuggestion) => {
    setPatches((current) => {
      const rest = current.filter((patch) => patch.chapterOrder !== suggestion.patch.chapterOrder);
      return [...rest, suggestion.patch].sort((left, right) => left.chapterOrder - right.chapterOrder);
    });
  };

  const saveWithPatches = async (next: ChapterExecutionPlanPatch[]) => {
    setMessage("");
    try {
      await props.onEdit({ payload: withDownstreamPatches(props.change, next) });
      return true;
    } catch (error) {
      setMessage(resolveChangeProposalError(error).description);
      return false;
    }
  };

  const acceptWithPlanChanges = async () => {
    if (await saveWithPatches(usablePatches)) {
      props.onDecision("modified");
      setEditing(false);
    }
  };

  const recordOnly = async () => {
    // 之前可能存过一版调整，改成「仅记录」时必须把它清掉，
    // 否则作者以为不改计划，执行时却把旧调整写了进去。
    if (savedPatchCount > 0 && !(await saveWithPatches([]))) {
      return;
    }
    setPatches([]);
    setEditing(false);
    props.onDecision(savedPatchCount > 0 ? "modified" : "accepted");
  };

  const putBackOnPlan = async () => {
    setCorrecting(true);
    setMessage("");
    try {
      setCorrection(await props.onCorrect());
    } catch (error) {
      setMessage(resolveChangeProposalError(error).description);
    } finally {
      setCorrecting(false);
    }
  };

  const busy = props.isSaving || suggesting || correcting;

  return (
    <article className="space-y-3 rounded-2xl border border-border/70 bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">
            {view.chapterOrder ? `第 ${view.chapterOrder} 章与原计划不一致` : "正文与原计划不一致"}
          </div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">{props.change.reason}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant={props.change.severity === "major" ? "destructive" : "secondary"}>
            {props.change.severity === "major" ? "重要变化" : "轻微变化"}
          </Badge>
          {savedPatchCount > 0 ? <Badge variant="default">已调整 {savedPatchCount} 章</Badge> : null}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border bg-muted/15 p-3">
          <div className="text-xs font-medium text-muted-foreground">原计划要求</div>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">{view.expected}</p>
        </div>
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-3">
          <div className="text-xs font-medium text-muted-foreground">正文实际写成</div>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">{view.actual}</p>
        </div>
      </div>

      {props.change.evidence.length > 0 ? (
        <div className="text-xs leading-5 text-muted-foreground">
          依据：{props.change.evidence.join("；")}
        </div>
      ) : null}

      {savedPatchCount > 0 && !editing ? (
        <div className="space-y-1 rounded-xl border border-primary/20 bg-primary/5 p-3">
          <div className="text-xs font-medium text-muted-foreground">后续章节会跟着调整</div>
          {view.downstreamPlanPatches.map((patch) => (
            <div key={patch.chapterOrder} className="text-sm leading-6 text-foreground">
              第 {patch.chapterOrder} 章 — {describePatch(patch)}
            </div>
          ))}
        </div>
      ) : null}

      {correction ? (
        <div className="space-y-1 rounded-xl border border-border/70 bg-muted/10 p-3">
          <div className="text-sm font-medium text-foreground">
            {CORRECTION_RESULT_COPY[correction.status].title}
          </div>
          <div className="text-xs leading-5 text-muted-foreground">
            {CORRECTION_RESULT_COPY[correction.status].description}
          </div>
        </div>
      ) : null}

      {message ? (
        <div className="text-xs leading-5 text-destructive">{message}</div>
      ) : null}

      {editing && !correctedBackToPlan ? (
        <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-3">
          <div>
            <div className="text-sm font-medium text-foreground">后续章节要怎么改</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">
              保留这一章的正文，把后面章节的安排改到能接上。只有填写的项会生效。
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={askForSuggestions}
            >
              {suggesting ? "正在想…" : "让 AI 给点建议"}
            </Button>
            {suggestionAsked && suggestions.length === 0 ? (
              <span className="text-xs text-muted-foreground">
                后面的安排看起来还成立，可以不改。
              </span>
            ) : null}
          </div>

          {suggestions.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                AI 的建议（逐条采纳，采纳后仍可修改）
              </div>
              {suggestions.map((suggestion) => (
                <div
                  key={suggestion.patch.chapterOrder}
                  className="space-y-1 rounded-xl border border-border/70 bg-background p-3"
                >
                  <div className="text-sm font-medium text-foreground">
                    第 {suggestion.patch.chapterOrder} 章
                    {suggestion.chapterTitle ? ` · ${suggestion.chapterTitle}` : ""}
                  </div>
                  <div className="text-sm leading-6 text-foreground">{describePatch(suggestion.patch)}</div>
                  <div className="text-xs leading-5 text-muted-foreground">理由：{suggestion.reason}</div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => adoptSuggestion(suggestion)}
                  >
                    采纳这一条
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          {discarded.length > 0 ? (
            <div className="space-y-1 text-xs leading-5 text-muted-foreground">
              <div>有几条建议没有采用：</div>
              {discarded.map((item, index) => (
                <div key={`${item.chapterOrder}-${index}`}>· {item.reason}</div>
              ))}
            </div>
          ) : null}

          <DownstreamPlanPatchForm
            patches={patches}
            chapterTitles={chapterTitles}
            minChapterOrder={minChapterOrder}
            disabled={busy}
            onChange={setPatches}
          />

          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy || !canSave} onClick={acceptWithPlanChanges}>
              {props.isSaving ? "保存中…" : "接受并更新后续计划"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setPatches(view.downstreamPlanPatches);
                setEditing(false);
                setMessage("");
              }}
            >
              取消
            </Button>
          </div>
          {!canSave ? (
            <div className="text-xs leading-5 text-muted-foreground">
              每一条都要指向这一章之后的章节，并且至少填写一项。
            </div>
          ) : null}
        </div>
      ) : null}

      {correctedBackToPlan ? (
        <div className="rounded-xl border border-border/70 bg-muted/10 px-3 py-2 text-sm leading-6 text-muted-foreground">
          正文已改回原计划，这一条不需要再处理。后面章节的安排保持不变。
        </div>
      ) : null}

      {props.reviewEnabled && !editing && !correctedBackToPlan ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => setEditing(true)}>
              接受并更新后续计划
            </Button>
            <Button
              type="button"
              size="sm"
              variant={effectiveDecision === "accepted" ? "default" : "outline"}
              disabled={busy}
              onClick={recordOnly}
            >
              仅记录这次变化
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={putBackOnPlan}>
              {correcting ? "正在改写…" : "把正文改回原计划"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={effectiveDecision === "rejected" ? "destructive" : "outline"}
              disabled={busy}
              onClick={() => props.onDecision("rejected")}
            >
              先放着
            </Button>
          </div>
          <div className="text-xs leading-5 text-muted-foreground">
            「仅记录这次变化」不会改动后面章节的安排——如果这次改动会影响后续，请用左边那一项。
          </div>
        </div>
      ) : null}
    </article>
  );
}
