import type { ParsedSillyTavernCard } from "@ai-novel/shared/types/sillytavernCard";
import {
  SILLYTAVERN_UNKNOWN_SEGMENT_FIELD,
  type SillyTavernCardSegment,
  type SillyTavernSegmentDestination,
  type SillyTavernSuggestionOrigin,
} from "@ai-novel/shared/types/sillytavernCardSplit";

/**
 * 把角色卡切成可分流的段落，并给出建议去向。
 *
 * **全部确定性，不经过模型。** 建议的依据只有「这段来自哪个字段」——
 * 字段本身能定的就定，定不了的标成需要人判断，不猜。
 */

interface FieldRule {
  field: string;
  label: string;
  destination: SillyTavernSegmentDestination;
  origin: SillyTavernSuggestionOrigin;
  reason: string;
  /** 长文本按空行切段，让用户能逐段分流而不是整块二选一。 */
  splitParagraphs: boolean;
}

/**
 * 字段规则表。
 *
 * `system_prompt` / `post_history_instructions` 本来就是给模型的写作指令，
 * `first_mes` / `mes_example` 是语气样本——这四个的归属没有歧义。
 *
 * `description` 与 `scenario` 才是真正混合的地方：作者常把世界设定写在这里。
 * 它们一律标成需要人判断，**不替用户猜**，因为猜错的两个方向代价都不小：
 * 世界设定进了角色，会让世界观只在这个角色身上生效；角色事实进了世界，
 * 会让它对所有角色生效。
 */
const FIELD_RULES: FieldRule[] = [
  {
    field: "system_prompt",
    label: "写作指令",
    destination: "style",
    origin: "deterministic",
    reason: "这是原卡给模型的写作指令，属于文风约束。",
    splitParagraphs: false,
  },
  {
    field: "post_history_instructions",
    label: "补充写作指令",
    destination: "style",
    origin: "deterministic",
    reason: "这是原卡的补充写作指令，属于文风约束。",
    splitParagraphs: false,
  },
  {
    field: "mes_example",
    label: "对话示例",
    destination: "style",
    origin: "deterministic",
    reason: "对话示例反映的是说话方式和语气，作为文风参考。",
    splitParagraphs: false,
  },
  {
    field: "first_mes",
    label: "开场白",
    destination: "style",
    origin: "deterministic",
    reason: "开场白反映语气与叙述口吻，作为文风参考。",
    splitParagraphs: false,
  },
  {
    // 备选开场白与 first_mes 同类，都是语气样本。漏掉它会让一部分文风素材
    // 被静默丢弃——卡片作者往往在这里放不同情境下的口吻。
    field: "alternate_greetings",
    label: "备选开场白",
    destination: "style",
    origin: "deterministic",
    reason: "备选开场白同样反映语气，作为文风参考。",
    splitParagraphs: false,
  },
  {
    field: "personality",
    label: "性格",
    destination: "character",
    origin: "deterministic",
    reason: "性格描述是这个角色本身的事实。",
    splitParagraphs: false,
  },
  {
    field: "description",
    label: "角色描述",
    destination: "character",
    origin: "needs_review",
    reason: "这一段常常混着世界设定，请确认它讲的是这个角色，还是这个世界。",
    splitParagraphs: true,
  },
  {
    field: "scenario",
    label: "场景设定",
    destination: "world",
    origin: "needs_review",
    reason: "场景设定多半属于世界，但也可能只讲这个角色的处境，请确认。",
    splitParagraphs: true,
  },
];

function splitIntoParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function planSillyTavernCardSplit(parsed: ParsedSillyTavernCard): SillyTavernCardSegment[] {
  const segments: SillyTavernCardSegment[] = [];
  const data = parsed.data as unknown as Record<string, unknown>;

  for (const rule of FIELD_RULES) {
    const raw = data[rule.field];
    // 多数字段是字符串，`alternate_greetings` 是字符串数组——每条各成一段。
    const values = Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : (typeof raw === "string" && raw.trim() ? [raw] : []);
    if (values.length === 0) {
      continue;
    }

    const parts = values.flatMap((value) => (
      rule.splitParagraphs ? splitIntoParagraphs(value) : [value.trim()]
    ));
    for (const [index, text] of parts.entries()) {
      segments.push({
        id: `${rule.field}:${index}`,
        sourceField: rule.field,
        sourceLabel: parts.length > 1 ? `${rule.label} 第 ${index + 1} 段` : rule.label,
        text,
        suggestedDestination: rule.destination,
        reason: rule.reason,
        origin: rule.origin,
      });
    }
  }

  const unknown = buildUnknownSegment(parsed);
  if (unknown) {
    segments.push(unknown);
  }

  return segments;
}

/**
 * 解析器认不出的字段，单独成一段交给作者取舍。
 *
 * **默认「不导入」，保持原有行为**——不擅自把一段 JSON 塞进检索。但它必须摆在
 * 台面上：一张卡的内容若全部分到世界设定，就不会产生角色提案或写法资产，原文
 * 没有任何载体，这些值会不可逆地消失。作者只有在这里才能让它们跟着走。
 *
 * `origin` 是 `deterministic` 而不是 `needs_review`：多数 V2/V3 卡片都带
 * `extensions` 之类的未知字段，强制逐张确认只会变成每次都要点一下的噪音。
 */
function buildUnknownSegment(parsed: ParsedSillyTavernCard): SillyTavernCardSegment | null {
  const entries = Object.entries(parsed.rawImportedMetadata);
  if (entries.length === 0) {
    return null;
  }
  return {
    id: `${SILLYTAVERN_UNKNOWN_SEGMENT_FIELD}:0`,
    sourceField: SILLYTAVERN_UNKNOWN_SEGMENT_FIELD,
    // 这个标签同时是世界文档里那一段的小标题，所以直接写成能独立读懂的话。
    sourceLabel: "原始文件中未被识别的内容",
    text: entries
      .map(([key, value]) => `- ${key}：${JSON.stringify(value)}`)
      .join("\n"),
    suggestedDestination: "skip",
    reason: "本项目还不解读这些字段。默认不导入；选「世界设定」会把原值原样附在"
      + "世界文档末尾，日后仍能回溯——若这张卡的内容全部去了世界设定，这是原文"
      + "唯一的留存机会。",
    origin: "deterministic",
  };
}

/**
 * 有内容但**不参与分流**的字段。
 *
 * 它们是关于这张卡本身的元信息，不是可导入的素材。显式列出来是为了让界面能
 * 告诉用户「这些没被导入」——静默丢弃会让人以为内容进去了。
 */
const NON_ROUTED_FIELDS: { field: string; label: string; reason: string }[] = [
  { field: "creator_notes", label: "作者备注", reason: "是给使用者看的说明，不是作品内容。" },
  { field: "creator", label: "卡片作者", reason: "卡片元信息。" },
  { field: "character_version", label: "卡片版本", reason: "卡片元信息。" },
  { field: "tags", label: "标签", reason: "卡片元信息，与作品的题材标签不通用。" },
];

export function listIgnoredCardFields(parsed: ParsedSillyTavernCard): {
  field: string;
  label: string;
  reason: string;
}[] {
  const data = parsed.data as unknown as Record<string, unknown>;
  return NON_ROUTED_FIELDS.filter((entry) => {
    const value = data[entry.field];
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return typeof value === "string" && Boolean(value.trim());
  });
}
