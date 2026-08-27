import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { OutlineFidelity } from "@ai-novel/shared/types/outlineWorkflow";
import { proposeOutlineImport } from "@/api/novel/changeProposals";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/toast";
import ChangeProposalReviewDrawer from "../changeProposal/ChangeProposalReviewDrawer";

const fidelityCopy: Record<OutlineFidelity, { label: string; description: string }> = {
  strict: { label: "严格保留（推荐）", description: "核心事件、顺序、结局、关系走向和关键揭露点都必须保留。" },
  balanced: { label: "平衡优化", description: "保留故事主干，允许 AI 调整局部结构并标明影响。" },
  director: { label: "导演重构", description: "允许 AI 主动重排结构，重大变化仍需你确认。" },
};

export default function OutlineImportPanel({ novelId }: { novelId: string }) {
  const [sourceText, setSourceText] = useState("");
  const [fidelity, setFidelity] = useState<OutlineFidelity>("strict");
  const [reviewOpen, setReviewOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: () => proposeOutlineImport(novelId, { sourceText, fidelity }),
    onSuccess: (result) => {
      toast.success("大纲建议已整理", {
        description: `AI 识别了 ${result.draft.coreEvents.length} 个核心事件，并整理为 ${result.polished.chapters.length} 章建议。`,
      });
      setReviewOpen(true);
    },
    onError: (error) => {
      toast.error("大纲整理失败", {
        description: error instanceof Error ? error.message : "请稍后重试。",
      });
    },
  });
  const result = mutation.data;

  return (
    <>
      <Card className="border-primary/20 bg-primary/[0.025]">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">从文字大纲开始</CardTitle>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                粘贴你的大纲，AI 会先找出不能丢失的核心事件，再补足因果、情绪、转场和拆章建议。
              </p>
            </div>
            <Badge variant="outline">默认严格保留</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <textarea
            value={sourceText}
            onChange={(event) => setSourceText(event.target.value)}
            placeholder={"例如：\n22 吃饭，主角发现账本少了一页\n23 A 离开，并留下警告\n24 B 开始调查账本去向"}
            className="min-h-40 w-full resize-y rounded-xl border bg-background p-3 text-sm leading-6 outline-none focus:ring-2 focus:ring-primary/30"
          />
          <div className="grid gap-2 md:grid-cols-3">
            {(Object.keys(fidelityCopy) as OutlineFidelity[]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFidelity(value)}
                className={`rounded-xl border p-3 text-left transition ${fidelity === value ? "border-primary bg-primary/5" : "border-border bg-background hover:bg-muted/30"}`}
              >
                <div className="text-sm font-medium">{fidelityCopy[value].label}</div>
                <div className="mt-1 text-xs leading-5 text-muted-foreground">{fidelityCopy[value].description}</div>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">AI 只会生成可审阅建议；应用前可以逐项接受、修改或拒绝。</div>
            <Button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending || sourceText.trim().length < 10}
            >
              {mutation.isPending ? "正在识别核心事件…" : "整理并查看建议"}
            </Button>
          </div>

          {result ? (
            <div className="grid gap-3 border-t pt-4 lg:grid-cols-2">
              <div className="rounded-xl bg-background p-3">
                <div className="text-sm font-medium">AI 会保留什么</div>
                <div className="mt-2 space-y-2 text-xs text-muted-foreground">
                  {result.draft.coreEvents.slice(0, 8).map((event) => (
                    <div key={event.id} className="rounded-lg bg-muted/30 px-3 py-2">
                      {event.sourceText}
                    </div>
                  ))}
                  {result.draft.coreEvents.length > 8 ? <div>另有 {result.draft.coreEvents.length - 8} 个核心事件</div> : null}
                </div>
              </div>
              <div className="rounded-xl bg-background p-3">
                <div className="text-sm font-medium">AI 会补什么</div>
                <div className="mt-2 text-xs leading-6 text-muted-foreground">{result.polished.polishedSummary}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge variant="secondary">{result.polished.chapters.length} 章建议</Badge>
                  <Badge variant="outline">{result.polished.dependencyImpacts.length} 项影响</Badge>
                </div>
                <Button className="mt-3" size="sm" variant="outline" onClick={() => setReviewOpen(true)}>
                  打开提案审阅
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <ChangeProposalReviewDrawer novelId={novelId} open={reviewOpen} onOpenChange={setReviewOpen} />
    </>
  );
}
