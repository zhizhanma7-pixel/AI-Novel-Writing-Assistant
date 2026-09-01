import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { FileWarning, FolderOpen, PackageOpen } from "lucide-react";
import type { SkillPackageFile, SkillPackagePreview } from "@ai-novel/shared/types/skillPackage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { importSkillPackage, previewSkillPackage } from "@/api/styleEngine";
import {
  SKILL_PACKAGE_MAX_FILE_BYTES,
  parseSkillPackageBundle,
  toSkillPackageFiles,
} from "../skillPackageFiles";

interface SkillPackageImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (styleProfileId: string) => void;
}

const RULE_LABELS: Array<{ key: keyof SkillPackagePreview["ruleLengths"]; label: string }> = [
  { key: "narrative", label: "叙事" },
  { key: "character", label: "人物" },
  { key: "language", label: "语言" },
  { key: "rhythm", label: "节奏" },
];

async function readSelectedFiles(fileList: FileList): Promise<SkillPackageFile[]> {
  const picked = Array.from(fileList);

  // 单选一个 .json：可能是本项目导出的写法包，先按包认，认不出再当普通文件走目录逻辑。
  if (picked.length === 1 && picked[0].name.toLowerCase().endsWith(".json")) {
    const bundle = parseSkillPackageBundle(await picked[0].text());
    if (bundle) {
      return bundle;
    }
  }

  const entries: Array<{ path: string; content: string }> = [];
  for (const file of picked) {
    // webkitRelativePath 只有选目录时才有值；单选文件时退回文件名。
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    if (file.size > SKILL_PACKAGE_MAX_FILE_BYTES) {
      // 超限的不读内容，但路径照样上报，服务端会说明它被忽略了。
      entries.push({ path, content: "" });
      continue;
    }
    entries.push({ path, content: await file.text() });
  }
  return toSkillPackageFiles(entries);
}

export default function SkillPackageImportDialog(props: SkillPackageImportDialogProps) {
  const { open, onOpenChange, onImported } = props;
  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<SkillPackageFile[]>([]);
  const [preview, setPreview] = useState<SkillPackagePreview | null>(null);
  const [nameOverride, setNameOverride] = useState("");

  function reset() {
    setFiles([]);
    setPreview(null);
    setNameOverride("");
  }

  const previewMutation = useMutation({
    mutationFn: previewSkillPackage,
    onSuccess: (response) => {
      setPreview(response.data ?? null);
      setNameOverride(response.data?.name ?? "");
      if (response.message) {
        toast.success(response.message);
      }
    },
    onError: (error: Error) => {
      setPreview(null);
      toast.error(error.message || "这个写法包读不出来。");
    },
  });

  const importMutation = useMutation({
    mutationFn: importSkillPackage,
    onSuccess: (response) => {
      toast.success(response.message || "写法包已导入。");
      const profileId = response.data?.profile.id;
      onOpenChange(false);
      reset();
      if (profileId) {
        onImported(profileId);
      }
    },
    onError: (error: Error) => {
      toast.error(error.message || "导入失败。");
    },
  });

  async function handleSelection(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) {
      return;
    }
    const collected = await readSelectedFiles(fileList);
    setFiles(collected);
    setPreview(null);
    if (collected.length === 0) {
      toast.error("没有读到任何文件，确认选的是写法包所在目录。");
      return;
    }
    previewMutation.mutate(collected);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          reset();
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>导入写法包</DialogTitle>
          <DialogDescription>
            写法包是别人炼化好的一套写法（一个含 SKILL.md 的目录，或本项目导出的
            .skill.json）。导入后它就是你库里一条普通的写法资产，可以照常改、照常绑。
            包里的脚本一律忽略，不会执行。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => folderInputRef.current?.click()}
              disabled={previewMutation.isPending || importMutation.isPending}
            >
              <FolderOpen className="mr-2 h-4 w-4" />
              选择写法包目录
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={previewMutation.isPending || importMutation.isPending}
            >
              <PackageOpen className="mr-2 h-4 w-4" />
              选择单个文件
            </Button>
            <input
              ref={folderInputRef}
              type="file"
              multiple
              className="hidden"
              // webkitdirectory 不在 React 的类型表里，但浏览器认它；目录选择只能靠它。
              {...{ webkitdirectory: "", directory: "" }}
              onChange={(event) => {
                void handleSelection(event.target.files);
                event.target.value = "";
              }}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.json"
              className="hidden"
              onChange={(event) => {
                void handleSelection(event.target.files);
                event.target.value = "";
              }}
            />
          </div>

          {files.length > 0 && (
            <p className="text-sm text-muted-foreground">
              已读到 {files.length} 个文件
              {previewMutation.isPending ? "，正在解析…" : ""}
            </p>
          )}

          {preview && (
            <div className="space-y-3 rounded-xl border bg-muted/30 p-4">
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="skill-package-name">
                  写法名称
                </label>
                <Input
                  id="skill-package-name"
                  value={nameOverride}
                  onChange={(event) => setNameOverride(event.target.value)}
                  placeholder={preview.name}
                />
                <p className="text-xs text-muted-foreground">
                  库里已有同名写法时，改个名字免得自己分不清。
                </p>
              </div>

              {preview.description && (
                <p className="text-sm leading-6 text-muted-foreground">{preview.description}</p>
              )}

              <div className="flex flex-wrap gap-1.5">
                {preview.category && <Badge variant="secondary">{preview.category}</Badge>}
                {preview.tags.map((tag) => (
                  <Badge key={tag} variant="outline">{tag}</Badge>
                ))}
                {preview.applicableTasks.map((task) => (
                  <Badge key={task} variant="outline">环节：{task}</Badge>
                ))}
              </div>

              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {RULE_LABELS.map((item) => (
                  <span key={item.key}>
                    {item.label}规则 {preview.ruleLengths[item.key]} 字
                    {preview.ruleLengths[item.key] === 0 ? "（空）" : ""}
                  </span>
                ))}
                <span>附件 {preview.attachmentCount} 个</span>
                <span>{Math.round(preview.sizeBytes / 1024)} KB</span>
              </div>

              {preview.unknownFields.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  认不出的字段：{preview.unknownFields.join("、")}（原值随包保留，不会丢）
                </p>
              )}

              {preview.warnings.length > 0 && (
                <ul className="space-y-1 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
                  {preview.warnings.map((warning, index) => (
                    <li key={`${warning.code}-${index}`} className="flex gap-2">
                      <FileWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{warning.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            type="button"
            disabled={!preview || importMutation.isPending}
            onClick={() => importMutation.mutate({
              files,
              name: nameOverride.trim() || undefined,
            })}
          >
            {importMutation.isPending ? "导入中…" : "导入为写法资产"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
