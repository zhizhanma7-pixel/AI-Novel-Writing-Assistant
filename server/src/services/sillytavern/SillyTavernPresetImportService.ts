import type { StyleProfile } from "@ai-novel/shared/types/styleEngine";
import type { ParsedSillyTavernPreset } from "@ai-novel/shared/types/sillytavernPreset";
import { StyleProfileService } from "../styleEngine/StyleProfileService";
import { parseSillyTavernPreset } from "./sillyTavernPresetParser";

/**
 * 把 SillyTavern preset 导入成一份 `StyleProfile`。
 *
 * **不新建 preset 表。** `StyleProfile` 已经有来源追踪（`sourceType` /
 * `sourceContent`）、四类规则、绑定与优先级，再造一套平行资产只会让「这本书
 * 到底用哪份文风」出现两个答案。
 *
 * **指令进 `summary`，不拆成结构化规则。** preset 的指令是自由文本，不携带
 * 「这条属于叙事还是语言」的分类信息。硬拆会让 `StyleContract` 的 maturity
 * 变成 `structured`——那是在假装我们理解了这份 preset。留在 summary 里，
 * 合同如实呈现为 `summary_only`。
 */

/** 超过这个长度就提醒用户裁剪：整份 preset 会进入写作提示词的上下文预算。 */
const LONG_INSTRUCTION_THRESHOLD = 4000;

export interface SillyTavernPresetPreview {
  parsed: ParsedSillyTavernPreset;
  /** 会真正影响写作的合并指令（只含启用片段）。 */
  effectiveInstructions: string;
  effectiveLength: number;
  enabledCount: number;
  disabledCount: number;
  /** 采样参数会被保留展示，但不改变实际生成调用。 */
  generationParametersApplied: false;
}

function mergeEnabledInstructions(parsed: ParsedSillyTavernPreset): string {
  return parsed.instructions
    .filter((item) => item.enabled && item.content.trim())
    .map((item) => item.content.trim())
    .join("\n\n");
}

function buildAnalysisMarkdown(
  parsed: ParsedSillyTavernPreset,
  preview: Pick<SillyTavernPresetPreview, "effectiveLength">,
): string {
  const lines: string[] = ["# 来自 SillyTavern 的预设", ""];

  lines.push(`- 预设类型：${parsed.kind}`);
  lines.push(`- 写作指令合计 ${preview.effectiveLength} 字（仅计启用片段）`);
  lines.push("");

  lines.push("## 指令片段");
  lines.push("");
  if (parsed.instructions.length === 0) {
    lines.push("这份预设没有指令片段。");
  }
  for (const instruction of parsed.instructions) {
    lines.push(`### ${instruction.name}${instruction.enabled ? "" : "（已禁用，不参与写作）"}`);
    lines.push("");
    lines.push(instruction.content.trim() || "（空）");
    lines.push("");
  }

  const parameterKeys = Object.keys(parsed.generationParameters);
  if (parameterKeys.length > 0) {
    lines.push("## 采样参数（仅供参考）");
    lines.push("");
    // 这里必须说清楚，否则用户会以为导入后温度就生效了。
    lines.push("以下参数来自原预设，**不会改变本项目实际的模型调用参数**，模型与参数仍由模型设置决定。");
    lines.push("");
    for (const key of parameterKeys) {
      lines.push(`- ${key}: ${parsed.generationParameters[key]}`);
    }
    lines.push("");
  }

  if (parsed.warnings.length > 0) {
    lines.push("## 导入提示");
    lines.push("");
    for (const warning of parsed.warnings) {
      lines.push(`- ${warning.message}`);
    }
  }

  return lines.join("\n");
}

export class SillyTavernPresetImportService {
  constructor(private readonly styleProfileService = new StyleProfileService()) {}

  /** 纯解析，不写任何库。 */
  preview(rawJson: unknown): SillyTavernPresetPreview {
    const parsed = parseSillyTavernPreset(rawJson);
    const effectiveInstructions = mergeEnabledInstructions(parsed);
    return {
      parsed,
      effectiveInstructions,
      effectiveLength: effectiveInstructions.length,
      enabledCount: parsed.instructions.filter((item) => item.enabled).length,
      disabledCount: parsed.instructions.filter((item) => !item.enabled).length,
      generationParametersApplied: false,
    };
  }

  async importPreset(input: { rawJson: unknown; name?: string }): Promise<{
    profile: StyleProfile;
    preview: SillyTavernPresetPreview;
    longInstructions: boolean;
  }> {
    const preview = this.preview(input.rawJson);
    const parsed = preview.parsed;
    const name = input.name?.trim() || parsed.name || "SillyTavern 预设";

    const profile = await this.styleProfileService.createManualProfile({
      name,
      description: `从 SillyTavern 预设导入，共 ${preview.enabledCount} 段启用指令。`,
      sourceType: "from_sillytavern_preset",
      // 原文无损留存：外部格式会演进，导入后仍要能回溯原始文件。
      sourceContent: JSON.stringify(input.rawJson),
      analysisMarkdown: buildAnalysisMarkdown(parsed, preview),
      narrativeRules: preview.effectiveInstructions
        ? { summary: preview.effectiveInstructions }
        : {},
    });

    return {
      profile,
      preview,
      longInstructions: preview.effectiveLength > LONG_INSTRUCTION_THRESHOLD,
    };
  }
}
