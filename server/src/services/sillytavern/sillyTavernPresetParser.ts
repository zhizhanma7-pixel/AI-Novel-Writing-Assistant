import {
  parsedSillyTavernPresetSchema,
  SILLYTAVERN_GENERATION_PARAMETER_KEYS,
  type ParsedSillyTavernPreset,
  type SillyTavernPresetInstruction,
  type SillyTavernPresetKind,
} from "@ai-novel/shared/types/sillytavernPreset";
import type { SillyTavernParseWarning } from "@ai-novel/shared/types/sillytavernCard";
import { SillyTavernParseError } from "./sillyTavernCardParser";

/**
 * SillyTavern preset 解析。
 *
 * 与角色卡解析同样的三条原则：不猜去向、不丢字段、认不出就降级告警。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function warn(
  warnings: SillyTavernParseWarning[],
  code: SillyTavernParseWarning["code"],
  message: string,
  field: string | null = null,
): void {
  warnings.push({ code, message, field });
}

function detectKind(root: Record<string, unknown>): SillyTavernPresetKind {
  if (Array.isArray(root.prompts)) {
    return "chat_completion";
  }
  // text completion preset 没有 prompts，只有一堆采样参数。
  const hasSamplingKeys = SILLYTAVERN_GENERATION_PARAMETER_KEYS
    .some((key) => typeof root[key] === "number");
  return hasSamplingKeys ? "text_completion" : "unknown";
}

function collectGenerationParameters(root: Record<string, unknown>): Record<string, number> {
  const parameters: Record<string, number> = {};
  for (const key of SILLYTAVERN_GENERATION_PARAMETER_KEYS) {
    const value = root[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      parameters[key] = value;
    }
  }
  return parameters;
}

/**
 * `prompt_order` 决定片段的顺序与启停。
 *
 * 它的结构是 `[{ character_id, order: [{ identifier, enabled }] }]`——多套顺序时
 * 取第一套有内容的。没有 `prompt_order` 就按 `prompts` 的原始顺序。
 */
function resolveOrder(root: Record<string, unknown>): { identifier: string; enabled: boolean }[] | null {
  if (!Array.isArray(root.prompt_order)) {
    return null;
  }
  for (const group of root.prompt_order) {
    if (!isRecord(group) || !Array.isArray(group.order)) {
      continue;
    }
    const order = group.order
      .filter(isRecord)
      .filter((entry) => typeof entry.identifier === "string")
      .map((entry) => ({
        identifier: entry.identifier as string,
        enabled: entry.enabled !== false,
      }));
    if (order.length > 0) {
      return order;
    }
  }
  return null;
}

function readInstructions(
  root: Record<string, unknown>,
  warnings: SillyTavernParseWarning[],
): SillyTavernPresetInstruction[] {
  if (!Array.isArray(root.prompts)) {
    return [];
  }

  const byIdentifier = new Map<string, SillyTavernPresetInstruction>();
  const inFileOrder: SillyTavernPresetInstruction[] = [];

  for (const [index, raw] of root.prompts.entries()) {
    if (!isRecord(raw)) {
      warn(
        warnings,
        "dropped_unparsable_entry",
        `第 ${index + 1} 段指令无法解析，已跳过。`,
        `prompts[${index}]`,
      );
      continue;
    }
    const identifier = typeof raw.identifier === "string" ? raw.identifier : `prompt_${index}`;
    const instruction: SillyTavernPresetInstruction = {
      identifier,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name : identifier,
      content: typeof raw.content === "string" ? raw.content : "",
      // 片段自身可以禁用；`prompt_order` 里的开关随后还会覆盖一次。
      enabled: raw.enabled !== false,
      role: typeof raw.role === "string" ? raw.role : null,
    };
    byIdentifier.set(identifier, instruction);
    inFileOrder.push(instruction);
  }

  const order = resolveOrder(root);
  if (!order) {
    return inFileOrder;
  }

  const ordered: SillyTavernPresetInstruction[] = [];
  const used = new Set<string>();
  for (const entry of order) {
    const instruction = byIdentifier.get(entry.identifier);
    if (!instruction) {
      continue;
    }
    used.add(entry.identifier);
    ordered.push({ ...instruction, enabled: instruction.enabled && entry.enabled });
  }
  // `prompt_order` 没提到的片段仍然保留在后面，不能因为没排序就丢掉。
  for (const instruction of inFileOrder) {
    if (!used.has(instruction.identifier)) {
      ordered.push(instruction);
    }
  }
  return ordered;
}

export function parseSillyTavernPreset(input: unknown): ParsedSillyTavernPreset {
  if (!isRecord(input)) {
    throw new SillyTavernParseError("invalid_preset", "这个文件不是有效的预设 JSON 对象。");
  }

  const warnings: SillyTavernParseWarning[] = [];
  const kind = detectKind(input);
  if (kind === "unknown") {
    warn(
      warnings,
      "unknown_spec_version",
      "认不出这份预设的类型，已按已知字段尽力读取。",
      null,
    );
  }

  const instructions = readInstructions(input, warnings);
  const generationParameters = collectGenerationParameters(input);

  if (instructions.every((item) => !item.content.trim())) {
    warn(
      warnings,
      "empty_content",
      "这份预设里没有可用的写作指令，导入后只会保留采样参数供查看。",
      "prompts",
    );
  }

  const consumed = new Set<string>([
    "prompts",
    "prompt_order",
    "name",
    ...SILLYTAVERN_GENERATION_PARAMETER_KEYS,
  ]);
  const rawImportedMetadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!consumed.has(key)) {
      rawImportedMetadata[key] = value;
    }
  }

  return parsedSillyTavernPresetSchema.parse({
    name: typeof input.name === "string" && input.name.trim() ? input.name : null,
    kind,
    instructions,
    generationParameters,
    rawImportedMetadata,
    warnings,
  });
}
