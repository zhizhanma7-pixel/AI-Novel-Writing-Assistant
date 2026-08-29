import type { ChapterExecutionPlanPatch } from "@ai-novel/shared/types/chapterExecutionPlan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PLAN_PATCH_FIELDS, type PlanPatchFieldKey } from "./divergenceCopy";

/**
 * 后续章节的调整表单。
 *
 * 字段严格照 `chapterExecutionPlanPatchSchema` 生成，**不多给一个**：标题、
 * 摘要、字数这些的权威来源是章节本身，写进这里会在下一次同步时被悄悄还原，
 * 界面上出现它们只会骗人。后端在保存时也会挡住越界字段。
 */
export default function DownstreamPlanPatchForm(props: {
  patches: ChapterExecutionPlanPatch[];
  chapterTitles: Record<number, string | null>;
  minChapterOrder: number;
  disabled: boolean;
  onChange: (patches: ChapterExecutionPlanPatch[]) => void;
}) {
  const updatePatch = (index: number, next: ChapterExecutionPlanPatch) => {
    props.onChange(props.patches.map((patch, current) => (current === index ? next : patch)));
  };

  const removePatch = (index: number) => {
    props.onChange(props.patches.filter((_, current) => current !== index));
  };

  const setField = (index: number, key: PlanPatchFieldKey, value: string) => {
    const patch = { ...props.patches[index] } as Record<string, unknown>;
    if (value.trim()) {
      patch[key] = value;
    } else {
      // 留空表示不动这一项，而不是把它清空——后者需要的是另一个动作，
      // 混在同一个输入框里作者分不清自己做了什么。
      delete patch[key];
    }
    updatePatch(index, patch as ChapterExecutionPlanPatch);
  };

  const addPatch = () => {
    const used = new Set(props.patches.map((patch) => patch.chapterOrder));
    let candidate = props.minChapterOrder + 1;
    while (used.has(candidate)) {
      candidate += 1;
    }
    props.onChange([...props.patches, { chapterOrder: candidate }]);
  };

  return (
    <div className="space-y-3">
      {props.patches.map((patch, index) => {
        const title = props.chapterTitles[patch.chapterOrder];
        const hasField = PLAN_PATCH_FIELDS.some((field) => (
          typeof (patch as Record<string, unknown>)[field.key] === "string"
        ));
        return (
          <div
            key={`${patch.chapterOrder}-${index}`}
            className="space-y-3 rounded-xl border border-border/70 bg-background p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs text-muted-foreground" htmlFor={`patch-order-${index}`}>
                第
              </label>
              <Input
                id={`patch-order-${index}`}
                className="w-20"
                type="number"
                min={props.minChapterOrder + 1}
                value={patch.chapterOrder || ""}
                disabled={props.disabled}
                onChange={(event) => updatePatch(index, {
                  ...patch,
                  chapterOrder: Number(event.target.value) || 0,
                })}
                aria-label="要调整的章节序号"
              />
              <span className="text-xs text-muted-foreground">
                章{title ? ` · ${title}` : ""}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto"
                disabled={props.disabled}
                onClick={() => removePatch(index)}
              >
                移除这一条
              </Button>
            </div>

            <div className="grid gap-2 md:grid-cols-2">
              {PLAN_PATCH_FIELDS.map((field) => (
                <div key={field.key} className="space-y-1">
                  <label
                    className="text-xs text-muted-foreground"
                    htmlFor={`patch-${index}-${field.key}`}
                  >
                    {field.label}
                  </label>
                  <Input
                    id={`patch-${index}-${field.key}`}
                    value={String((patch as Record<string, unknown>)[field.key] ?? "")}
                    placeholder={field.placeholder}
                    disabled={props.disabled}
                    onChange={(event) => setField(index, field.key, event.target.value)}
                  />
                </div>
              ))}
            </div>

            {patch.chapterOrder <= props.minChapterOrder ? (
              <div className="text-xs leading-5 text-destructive">
                只能调整这一章之后的章节。
              </div>
            ) : null}
            {!hasField ? (
              <div className="text-xs leading-5 text-muted-foreground">
                至少填写一项，否则这一条不会生效。
              </div>
            ) : null}
          </div>
        );
      })}

      <Button type="button" size="sm" variant="outline" disabled={props.disabled} onClick={addPatch}>
        添加一章
      </Button>
    </div>
  );
}
