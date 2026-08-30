import {
  parsedSillyTavernBookSchema,
  parsedSillyTavernCardSchema,
  sillyTavernBookEntrySchema,
  sillyTavernCardDataSchema,
  SILLYTAVERN_KNOWN_CARD_FIELDS,
  type ParsedSillyTavernBook,
  type ParsedSillyTavernCard,
  type SillyTavernBook,
  type SillyTavernCardSpec,
  type SillyTavernParseWarning,
} from "@ai-novel/shared/types/sillytavernCard";

/**
 * SillyTavern 角色卡 / 世界书的解析层。
 *
 * **三条原则：**
 * 1. 解析永不猜测去向——只把文件读成结构，内容该进世界观还是角色由后续分流决定。
 * 2. 认不出的字段一律留进 `rawImportedMetadata`；外部格式会演进，丢字段不可逆。
 * 3. 缺字段、版本不认识都降级 + 告警，**不假装解析成功**，也不整份失败。
 */

export class SillyTavernParseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SillyTavernParseError";
    this.code = code;
  }
}

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

function detectSpec(root: Record<string, unknown>): { spec: SillyTavernCardSpec; version: string | null } {
  const spec = typeof root.spec === "string" ? root.spec : null;
  const version = typeof root.spec_version === "string" ? root.spec_version : null;
  if (spec === "chara_card_v3") {
    return { spec: "v3", version };
  }
  if (spec === "chara_card_v2") {
    return { spec: "v2", version };
  }
  if (spec) {
    // 认得出是张卡，但版本号不认识：按已知字段尽力读，并明确告警。
    return { spec: "unknown", version };
  }
  // 没有 spec 字段的是 V1 扁平布局。
  return { spec: "v1", version: null };
}

function collectUnknownFields(source: Record<string, unknown>): Record<string, unknown> {
  const known = new Set<string>(SILLYTAVERN_KNOWN_CARD_FIELDS);
  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!known.has(key)) {
      unknown[key] = value;
    }
  }
  return unknown;
}

/**
 * 世界书条目容器的两种形态。
 *
 * 独立导出的 lorebook 里 `entries` 是**以下标为键的对象**，而角色卡内嵌的那本是
 * 数组。两种都要吃，否则最常见的一类文件会整份读不进来。
 */
function normalizeEntries(value: unknown, warnings: SillyTavernParseWarning[]): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (isRecord(value)) {
    return Object.entries(value)
      .sort(([left], [right]) => {
        const leftNum = Number(left);
        const rightNum = Number(right);
        if (Number.isFinite(leftNum) && Number.isFinite(rightNum)) {
          return leftNum - rightNum;
        }
        return left.localeCompare(right);
      })
      .map(([, entry]) => entry);
  }
  if (value !== undefined && value !== null) {
    warn(warnings, "unreadable_character_book", "世界书条目的结构无法识别，已跳过。", "entries");
  }
  return [];
}

function parseBook(value: unknown, warnings: SillyTavernParseWarning[]): SillyTavernBook | null {
  if (!isRecord(value)) {
    return null;
  }
  const rawEntries = normalizeEntries(value.entries, warnings);
  const entries = [];
  for (const [index, raw] of rawEntries.entries()) {
    const parsed = sillyTavernBookEntrySchema.safeParse(raw);
    if (parsed.success) {
      entries.push(parsed.data);
      continue;
    }
    // 单条坏掉不该让整本世界书读不进来。
    warn(
      warnings,
      "dropped_unparsable_entry",
      `世界书第 ${index + 1} 条无法解析，已跳过其余条目仍会导入。`,
      `entries[${index}]`,
    );
  }
  return {
    name: typeof value.name === "string" ? value.name : null,
    description: typeof value.description === "string" ? value.description : null,
    entries,
  };
}

export function parseSillyTavernCard(input: unknown): ParsedSillyTavernCard {
  if (!isRecord(input)) {
    throw new SillyTavernParseError("invalid_card", "这个文件不是有效的角色卡 JSON 对象。");
  }

  const warnings: SillyTavernParseWarning[] = [];
  const { spec, version } = detectSpec(input);

  if (spec === "unknown") {
    warn(
      warnings,
      "unknown_spec_version",
      `不认识的角色卡版本${version ? `（${version}）` : ""}，已按已知字段尽力读取，可能有内容未被识别。`,
      "spec",
    );
  }
  if (spec === "v1") {
    warn(warnings, "legacy_v1_layout", "这是旧版角色卡，没有版本标记，已按旧格式读取。", null);
  }

  // V2/V3 的正文在 data 里；V1 与不认识的版本回退到顶层。
  const body = isRecord(input.data) ? input.data : input;
  const parsedData = sillyTavernCardDataSchema.safeParse(body);
  if (!parsedData.success) {
    throw new SillyTavernParseError(
      "invalid_card",
      "角色卡的字段结构无法解析，请确认文件来自 SillyTavern。",
    );
  }

  const data = parsedData.data;
  if (!data.name.trim()) {
    warn(warnings, "missing_required_field", "这张卡没有名称，导入后需要你补一个。", "name");
  }
  if (!data.description.trim() && !data.personality.trim() && !data.scenario.trim()) {
    warn(warnings, "empty_content", "这张卡几乎没有正文内容，导入后可能没有可用素材。", null);
  }

  const book = parseBook(body.character_book, warnings);

  const rawImportedMetadata = collectUnknownFields(body);
  // V2/V3 的顶层壳（spec 之外的字段）同样不能丢。
  if (isRecord(input.data)) {
    for (const [key, value] of Object.entries(input)) {
      if (key !== "data" && key !== "spec" && key !== "spec_version") {
        rawImportedMetadata[`__root__.${key}`] = value;
      }
    }
  }

  return parsedSillyTavernCardSchema.parse({
    spec,
    specVersion: version,
    data: { ...data, character_book: book },
    rawImportedMetadata,
    warnings,
  });
}

/** 独立的 lorebook 文件（不带角色卡外壳）。 */
export function parseSillyTavernBook(input: unknown): ParsedSillyTavernBook {
  if (!isRecord(input)) {
    throw new SillyTavernParseError("invalid_book", "这个文件不是有效的世界书 JSON 对象。");
  }

  const warnings: SillyTavernParseWarning[] = [];
  const book = parseBook(input, warnings);
  if (!book) {
    throw new SillyTavernParseError("invalid_book", "无法从这个文件里读出世界书条目。");
  }
  if (book.entries.length === 0) {
    warn(warnings, "empty_content", "这本世界书没有可导入的条目。", "entries");
  }

  const rawImportedMetadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key !== "entries" && key !== "name" && key !== "description") {
      rawImportedMetadata[key] = value;
    }
  }

  return parsedSillyTavernBookSchema.parse({ book, rawImportedMetadata, warnings });
}
