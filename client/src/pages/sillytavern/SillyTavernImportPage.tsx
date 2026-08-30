import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { SillyTavernInspectResult } from "@ai-novel/shared/types/sillytavernInspect";
import type { SillyTavernSegmentDestination } from "@ai-novel/shared/types/sillytavernCardSplit";
import { getNovelList } from "@/api/novel/core";
import type { NovelListItem } from "@/api/novel/shared";
import {
  applySillyTavernCard,
  importSillyTavernPreset,
  importSillyTavernWorldBook,
  inspectSillyTavernFile,
} from "@/api/sillytavern";
import { queryKeys } from "@/api/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import CardSplitPanel from "./CardSplitPanel";
import { ASSET_KIND_COPY, isPngFileName, resolveImportError } from "./importCopy";

/**
 * SillyTavern 资产导入。
 *
 * 用户手上通常只有「一个从 SillyTavern 导出的文件」，所以这里先识别再分流，
 * 不要求他先分清角色卡、世界书和预设。识别与预览全程只读，导入前不写任何东西。
 */

interface LoadedFile {
  fileName: string;
  /** JSON 文件解析后的内容；PNG 时为 null。 */
  content: unknown;
  pngBase64: string | null;
}

function readFile(file: File): Promise<LoadedFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取文件失败。"));

    if (isPngFileName(file.name)) {
      reader.onload = () => {
        const result = String(reader.result ?? "");
        // data:image/png;base64,xxxx → 只要后面那段
        const base64 = result.slice(result.indexOf(",") + 1);
        resolve({ fileName: file.name, content: null, pngBase64: base64 });
      };
      reader.readAsDataURL(file);
      return;
    }

    reader.onload = () => {
      try {
        resolve({
          fileName: file.name,
          content: JSON.parse(String(reader.result ?? "")) as unknown,
          pngBase64: null,
        });
      } catch {
        reject(new Error("这个文件不是有效的 JSON。"));
      }
    };
    reader.readAsText(file);
  });
}

export default function SillyTavernImportPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loaded, setLoaded] = useState<LoadedFile | null>(null);
  const [inspected, setInspected] = useState<SillyTavernInspectResult | null>(null);
  const [errorCopy, setErrorCopy] = useState<{ title: string; description: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const novelsQuery = useQuery({
    queryKey: queryKeys.novels.list(1, 100),
    queryFn: () => getNovelList({ page: 1, limit: 100 }),
  });
  const novels = (novelsQuery.data?.data?.items ?? []).map((novel: NovelListItem) => ({
    id: novel.id,
    title: novel.title,
  }));

  const reset = () => {
    setInspected(null);
    setErrorCopy(null);
    setDone(null);
  };

  const inspectMutation = useMutation({
    retry: false,
    mutationFn: async (file: LoadedFile) => inspectSillyTavernFile(
      file.pngBase64 ? { pngBase64: file.pngBase64 } : { content: file.content },
    ),
    onSuccess: (result) => setInspected(result),
    onError: (error) => setErrorCopy(resolveImportError(error)),
  });

  const importMutation = useMutation({
    retry: false,
    mutationFn: async (input: {
      decisions?: { segmentId: string; destination: SillyTavernSegmentDestination }[];
      novelId?: string;
      characterName?: string;
    }) => {
      if (!loaded || !inspected) {
        throw new Error("请先选择一个文件。");
      }
      if (inspected.kind === "character_card") {
        const result = await applySillyTavernCard({
          // PNG 交给服务端提取，JSON 直接送原文。
          ...(loaded.pngBase64 ? { pngBase64: loaded.pngBase64 } : { card: loaded.content }),
          decisions: input.decisions ?? [],
          novelId: input.novelId,
          characterName: input.characterName,
        });
        const parts: string[] = [];
        if (result.knowledgeDocumentId) {
          parts.push(result.knowledgeUnchanged ? "世界设定已是最新" : "世界设定已入知识库");
        }
        if (result.styleProfileId) {
          parts.push("文风已存为写法资产");
        }
        if (result.characterProposalId) {
          // 角色走提案：这里没有"已加入"，只有"已提交待审"。
          parts.push("角色已提交审阅，请到变更提案里确认后生效");
        }
        return parts.join("；") || "没有内容被导入。";
      }
      if (inspected.kind === "world_book") {
        const result = await importSillyTavernWorldBook({ book: loaded.content });
        return result.unchanged
          ? "这本世界书的内容与现有版本一致，未重复导入。"
          : `已导入知识库：${result.title}`;
      }
      if (inspected.kind === "preset") {
        const result = await importSillyTavernPreset({ preset: loaded.content });
        return result.longInstructions
          ? `已存为写法资产：${result.profile.name}。这份预设的指令较长，建议精简后再绑定使用。`
          : `已存为写法资产：${result.profile.name}`;
      }
      throw new Error("这个文件没有被识别，无法导入。");
    },
    onSuccess: (message) => {
      setDone(message);
      setErrorCopy(null);
      toast.success("导入完成。");
    },
    onError: (error) => setErrorCopy(resolveImportError(error)),
  });

  const onPick = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    reset();
    try {
      const next = await readFile(file);
      setLoaded(next);
      inspectMutation.mutate(next);
    } catch (error) {
      setLoaded(null);
      setErrorCopy(resolveImportError(error));
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-6">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold text-foreground">导入 SillyTavern 资产</h1>
        <p className="text-sm leading-6 text-muted-foreground">
          选择一个从 SillyTavern 导出的文件即可，不用先分清它是角色卡、世界书还是预设。
          角色卡里的世界设定与文风会分开存放，而不是整块塞进一个角色。
        </p>
      </header>

      <section className="space-y-3 rounded-2xl border border-border/70 bg-background p-4">
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.png,application/json,image/png"
          className="hidden"
          onChange={(event) => void onPick(event.target.files?.[0])}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => fileInputRef.current?.click()}>
            选择文件
          </Button>
          {loaded ? <span className="text-sm text-muted-foreground">{loaded.fileName}</span> : null}
          {inspectMutation.isPending ? (
            <span className="text-sm text-muted-foreground">正在识别…</span>
          ) : null}
        </div>
        <div className="text-xs leading-5 text-muted-foreground">
          支持角色卡 JSON、内嵌角色卡的 PNG、世界书 JSON 和预设 JSON。
        </div>
      </section>

      {errorCopy ? (
        <section className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4">
          <div className="text-sm font-medium text-destructive">{errorCopy.title}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">{errorCopy.description}</div>
        </section>
      ) : null}

      {done ? (
        <section className="rounded-2xl border border-border/70 bg-muted/10 p-4">
          <div className="text-sm font-medium text-foreground">已完成</div>
          <div className="mt-1 text-sm leading-6 text-muted-foreground">{done}</div>
          <div className="mt-2 text-xs leading-5 text-muted-foreground">
            世界设定要在知识库里绑定给作品，文风要在写法绑定里启用，之后才会生效。
            角色需要在作品的「变更提案」里审阅通过后才会真正加入。
          </div>
        </section>
      ) : null}

      {inspected && !done ? (
        <section className="space-y-4 rounded-2xl border border-border/70 bg-background p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{ASSET_KIND_COPY[inspected.kind]}</Badge>
            <span className="text-xs text-muted-foreground">识别依据：{inspected.detectedBy}</span>
          </div>

          {inspected.kind === "unknown" ? (
            <div className="text-sm leading-6 text-muted-foreground">
              没能认出这个文件的类型。请确认它是从 SillyTavern 导出的角色卡、世界书或预设。
            </div>
          ) : null}

          {inspected.kind === "character_card" && inspected.cardPlan ? (
            <CardSplitPanel
              plan={inspected.cardPlan}
              novels={novels}
              isImporting={importMutation.isPending}
              onImport={(input) => importMutation.mutate(input)}
            />
          ) : null}

          {inspected.kind === "world_book" && inspected.worldBookPreview ? (
            <div className="space-y-3">
              <div className="text-sm text-foreground">
                {inspected.worldBookPreview.bookName ?? "未命名世界书"} ·
                将导入 {inspected.worldBookPreview.includedCount} 条设定
                {inspected.worldBookPreview.excludedCount > 0
                  ? `，另有 ${inspected.worldBookPreview.excludedCount} 条在原文件里已关闭，不会导入`
                  : ""}
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border bg-muted/15 p-3 font-sans text-xs leading-5 text-foreground">
                {inspected.worldBookPreview.content}
              </pre>
              <Button
                type="button"
                disabled={importMutation.isPending}
                onClick={() => importMutation.mutate({})}
              >
                {importMutation.isPending ? "导入中…" : "导入到知识库"}
              </Button>
            </div>
          ) : null}

          {inspected.kind === "preset" && inspected.presetPreview ? (
            <div className="space-y-3">
              <div className="text-sm text-foreground">
                {inspected.presetPreview.parsed.name ?? "未命名预设"} ·
                {inspected.presetPreview.enabledCount} 段生效指令
                {inspected.presetPreview.disabledCount > 0
                  ? `，另有 ${inspected.presetPreview.disabledCount} 段在原文件里已关闭`
                  : ""}
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border bg-muted/15 p-3 font-sans text-xs leading-5 text-foreground">
                {inspected.presetPreview.effectiveInstructions || "（这份预设没有生效的写作指令）"}
              </pre>
              <div className="text-xs leading-5 text-muted-foreground">
                原预设里的采样参数会一并留存供查看，但不会改变本项目实际的模型调用参数。
              </div>
              <Button
                type="button"
                disabled={importMutation.isPending}
                onClick={() => importMutation.mutate({})}
              >
                {importMutation.isPending ? "导入中…" : "存为写法资产"}
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
