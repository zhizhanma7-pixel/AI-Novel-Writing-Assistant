import type { ParsedSillyTavernCard } from "@ai-novel/shared/types/sillytavernCard";
import type {
  SillyTavernCardSegment,
  SillyTavernSegmentDestination,
  SillyTavernSuggestionOrigin,
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
    if (typeof raw !== "string" || !raw.trim()) {
      continue;
    }

    const parts = rule.splitParagraphs ? splitIntoParagraphs(raw) : [raw.trim()];
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

  return segments;
}
