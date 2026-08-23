import { useMemo, useState } from "react";
import type { EditProposedChangeInput, ProposedChange } from "@ai-novel/shared/types/changeProposal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  canEditProposedChangeInline,
  formatProposalValue,
  resolveChangeProposalError,
} from "./changeProposalCopy";

function parseInlineValue(source: string, reference: unknown): unknown {
  if (typeof reference === "number") {
    const parsed = Number(source);
    if (!Number.isFinite(parsed)) {
      throw new Error("请输入有效数字。");
    }
    return parsed;
  }
  if (typeof reference === "boolean") {
    if (source === "true") return true;
    if (source === "false") return false;
    throw new Error("布尔值只能填写 true 或 false。");
  }
  return source;
}

export default function ProposedChangeEditor(props: {
  change: ProposedChange;
  isSaving: boolean;
  onSave: (input: EditProposedChangeInput) => Promise<unknown>;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const inlineAvailable = useMemo(() => canEditProposedChangeInline(props.change), [props.change]);
  const [mode, setMode] = useState<"inline" | "payload">(inlineAvailable ? "inline" : "payload");
  const [inlineValue, setInlineValue] = useState(() => formatProposalValue(props.change.after));
  const [payloadText, setPayloadText] = useState(() => JSON.stringify(
    props.change.userEditedPayload ?? props.change.payload,
    null,
    2,
  ));
  const [validationMessage, setValidationMessage] = useState("");

  const save = async () => {
    setValidationMessage("");
    try {
      if (mode === "inline") {
        await props.onSave({ after: parseInlineValue(inlineValue, props.change.after) });
      } else {
        let payload: unknown;
        try {
          payload = JSON.parse(payloadText);
        } catch {
          setValidationMessage("完整内容必须是有效 JSON。");
          return;
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          setValidationMessage("完整内容必须是 JSON 对象。");
          return;
        }
        await props.onSave({ payload: payload as Record<string, unknown> });
      }
      props.onSaved();
    } catch (error) {
      const resolved = resolveChangeProposalError(error);
      if (mode === "inline" && resolved.code === "invalid_review") {
        setMode("payload");
        setValidationMessage("这个字段需要编辑完整内容，请检查 JSON 后保存。");
        return;
      }
      setValidationMessage(resolved.description);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-3">
      <div>
        <div className="text-sm font-medium text-foreground">
          {mode === "inline" ? "修改建议值" : "编辑完整内容"}
        </div>
        <div className="mt-1 text-xs leading-5 text-muted-foreground">
          {mode === "inline"
            ? "保存后，批准会使用你填写的值。"
            : "请保留执行所需字段，仅修改需要调整的值。"}
        </div>
      </div>
      {mode === "inline" ? (
        <Input
          value={inlineValue}
          onChange={(event) => setInlineValue(event.target.value)}
          aria-label="修改后的建议值"
        />
      ) : (
        <textarea
          className="min-h-44 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={payloadText}
          onChange={(event) => setPayloadText(event.target.value)}
          aria-label="修改后的完整内容"
          spellCheck={false}
        />
      )}
      {validationMessage ? (
        <div className="text-xs leading-5 text-destructive">{validationMessage}</div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={save} disabled={props.isSaving}>
          {props.isSaving ? "保存中..." : "保存修改"}
        </Button>
        {inlineAvailable ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setValidationMessage("");
              setMode((current) => current === "inline" ? "payload" : "inline");
            }}
            disabled={props.isSaving}
          >
            {mode === "inline" ? "编辑完整内容" : "返回修改建议值"}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" onClick={props.onCancel} disabled={props.isSaving}>
          取消
        </Button>
      </div>
    </div>
  );
}
