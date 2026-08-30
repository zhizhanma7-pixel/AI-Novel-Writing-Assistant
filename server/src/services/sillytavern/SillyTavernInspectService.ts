import type { SillyTavernInspectResult } from "@ai-novel/shared/types/sillytavernInspect";
import { SILLYTAVERN_GENERATION_PARAMETER_KEYS } from "@ai-novel/shared/types/sillytavernPreset";
import { SillyTavernCardImportService } from "./SillyTavernCardImportService";
import { SillyTavernParseError } from "./sillyTavernCardParser";
import { SillyTavernPresetImportService } from "./SillyTavernPresetImportService";
import { extractSillyTavernCardFromPng } from "./sillyTavernPngCard";
import { SillyTavernWorldBookImportService } from "./SillyTavernWorldBookImportService";

/**
 * 统一识别一个 SillyTavern 导出文件是什么，并给出对应预览。
 *
 * 用户手上通常只有一个文件，未必分得清角色卡、世界书和预设。识别全部确定性，
 * 依据是文件里有哪些结构特征，**并把依据一起返回**——认错了用户要能看出来。
 *
 * 全程只读。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class SillyTavernInspectService {
  constructor(
    private readonly cardImportService = new SillyTavernCardImportService(),
    private readonly worldBookImportService = new SillyTavernWorldBookImportService(),
    private readonly presetImportService = new SillyTavernPresetImportService(),
  ) {}

  inspectJson(input: unknown): SillyTavernInspectResult {
    return this.inspectParsed(input, null);
  }

  inspectPng(buffer: Buffer): SillyTavernInspectResult {
    const extracted = extractSillyTavernCardFromPng(buffer);
    return this.inspectParsed(extracted.json, extracted.keyword);
  }

  private inspectParsed(input: unknown, extractedFrom: string | null): SillyTavernInspectResult {
    if (!isRecord(input)) {
      throw new SillyTavernParseError(
        "unrecognised_file",
        "这个文件不是有效的 SillyTavern 导出内容。",
      );
    }

    const base = {
      extractedFrom,
      cardPlan: null,
      worldBookPreview: null,
      presetPreview: null,
    };

    // 顺序有意义：先认最明确的标记，再退到结构特征。
    const spec = typeof input.spec === "string" ? input.spec : null;
    if (spec?.startsWith("chara_card") || extractedFrom) {
      return {
        ...base,
        kind: "character_card",
        detectedBy: extractedFrom
          ? `图片内嵌的角色卡数据（${extractedFrom}）`
          : `文件声明的规范标记 ${spec}`,
        cardPlan: this.cardImportService.plan(input),
      };
    }

    // 预设的判据是指令片段或采样参数；角色卡与世界书都不带这些。
    const hasPrompts = Array.isArray(input.prompts);
    const hasSamplingKeys = SILLYTAVERN_GENERATION_PARAMETER_KEYS
      .some((key) => typeof input[key] === "number");
    if (hasPrompts || hasSamplingKeys) {
      return {
        ...base,
        kind: "preset",
        detectedBy: hasPrompts ? "文件里有指令片段列表" : "文件里有采样参数",
        presetPreview: this.presetImportService.preview(input),
      };
    }

    // 世界书的判据是顶层 entries；角色卡的世界书在 data.character_book 里，不会误判。
    if (input.entries !== undefined) {
      return {
        ...base,
        kind: "world_book",
        detectedBy: "文件顶层有世界书条目",
        worldBookPreview: this.worldBookImportService.preview(input),
      };
    }

    // 旧版角色卡是扁平结构，没有任何标记，只能靠字段组合认。
    const looksLikeLegacyCard = typeof input.name === "string"
      && ["description", "personality", "scenario", "first_mes"]
        .some((key) => typeof input[key] === "string" && (input[key] as string).trim());
    if (looksLikeLegacyCard) {
      return {
        ...base,
        kind: "character_card",
        detectedBy: "旧版角色卡的字段组合（没有版本标记）",
        cardPlan: this.cardImportService.plan(input),
      };
    }

    return {
      ...base,
      kind: "unknown",
      detectedBy: "没有识别出角色卡、世界书或预设的结构特征",
    };
  }
}
