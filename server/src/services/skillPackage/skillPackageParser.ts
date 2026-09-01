import {
  MODEL_ROUTE_TASK_TYPES,
  type ModelRouteTaskType,
} from "@ai-novel/shared/types/novel";
import {
  SKILL_PACKAGE_IGNORED_EXTENSIONS,
  SKILL_RULE_SECTIONS,
  type SkillPackage,
  type SkillPackageAttachment,
  type SkillPackageFile,
  type SkillPackageRules,
  type SkillPackageWarning,
} from "@ai-novel/shared/types/skillPackage";

/**
 * Skill 包的解析与序列化层（Phase 4 / S1）。
 *
 * **三条原则**（沿用 Phase 3 解析层的经验）：
 * 1. 纯函数、只读。不碰文件系统、不 eval、不 require 包内文件、不发网络请求。
 *    调用方负责把文件读成 `SkillPackageFile[]` 再交给这里。
 * 2. 认不出的 frontmatter 键**连值一起留下**。只留字段名会让值不可逆消失——
 *    这是 Phase 3 世界书那次实打实踩过的坑。
 * 3. 单处不认识不让整包读不进来，一律降级 + 告警，不假装解析成功。
 */

export class SkillPackageParseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SkillPackageParseError";
    this.code = code;
  }
}

// 传输单元的定义在 shared，两端共用一份；这里只做转出，调用点不必改导入路径。
export type { SkillPackageFile };

const SKILL_MANIFEST = "SKILL.md";

const ATTACHMENT_DIRS = [
  { dir: "references/", kind: "reference" as const },
  { dir: "templates/", kind: "template" as const },
  { dir: "examples/", kind: "example" as const },
];

const KNOWN_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "category",
  "tags",
  "applicableGenres",
  "applicableTasks",
]);

function warn(
  warnings: SkillPackageWarning[],
  code: SkillPackageWarning["code"],
  message: string,
  field: string | null = null,
): void {
  warnings.push({ code, message, field });
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function isIgnoredFile(path: string): boolean {
  const lower = normalizePath(path).toLowerCase();
  return SKILL_PACKAGE_IGNORED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function splitList(value: string): string[] {
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 极简 frontmatter：`---` 包起来的 `key: value`。
 *
 * 刻意不引入 YAML 依赖——包是作者手写的，支持嵌套结构只会让「写错了为什么没生效」
 * 更难解释。多出来的键不丢，进 `unknownFrontmatter`。
 */
function splitFrontmatter(source: string): { raw: Record<string, string>; body: string } {
  const normalized = source.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return { raw: {}, body: normalized.trim() };
  }
  const raw: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    // 去掉 YAML 风格的方括号与引号，让 `tags: [a, b]` 和 `tags: a, b` 都能写。
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^\[(.*)\]$/, "$1")
      .replace(/^["'](.*)["']$/, "$1")
      .trim();
    raw[key] = value;
  }
  return { raw, body: normalized.slice(match[0].length).trim() };
}

/**
 * 按 `## 小节标题` 切出四维规则。
 *
 * 找不到任何小节不算错：作者可能只写了一段自由说明，那段仍会作为 instructions
 * 参与生成，只是四维规则为空。
 */
function splitRuleSections(body: string): SkillPackageRules {
  const rules: SkillPackageRules = {
    narrative: "",
    character: "",
    language: "",
    rhythm: "",
  };
  const headingPattern = /^##\s+(.+?)\s*$/gm;
  const positions: { key: string; start: number; end: number }[] = [];
  let match: RegExpExecArray | null = headingPattern.exec(body);
  while (match) {
    positions.push({ key: match[1].trim(), start: match.index, end: match.index + match[0].length });
    match = headingPattern.exec(body);
  }
  for (const [index, heading] of positions.entries()) {
    const section = SKILL_RULE_SECTIONS.find((item) => item.heading === heading.key);
    if (!section) {
      continue;
    }
    const nextStart = positions[index + 1]?.start ?? body.length;
    rules[section.key] = body.slice(heading.end, nextStart).trim();
  }
  return rules;
}

function resolveApplicableTasks(
  value: string | undefined,
  warnings: SkillPackageWarning[],
): ModelRouteTaskType[] {
  if (!value?.trim()) {
    return [];
  }
  const known = new Set<string>(MODEL_ROUTE_TASK_TYPES);
  const resolved: ModelRouteTaskType[] = [];
  for (const candidate of splitList(value)) {
    if (known.has(candidate)) {
      resolved.push(candidate as ModelRouteTaskType);
      continue;
    }
    // 取值域是既有的模型路由任务类型，不自造字符串。写错的名字如实报出来，
    // 而不是静默当成"不匹配任何任务"——那样作者会以为包装好了却永远不命中。
    warn(
      warnings,
      "unknown_task_type",
      `任务类型「${candidate}」不在可用范围内，已忽略。可用：${MODEL_ROUTE_TASK_TYPES.join("、")}。`,
      "applicableTasks",
    );
  }
  return resolved;
}

/** 把一组包内文件解析成规范化的 Skill 包。 */
export function parseSkillPackage(files: SkillPackageFile[]): SkillPackage {
  const warnings: SkillPackageWarning[] = [];
  const manifest = files.find((file) => normalizePath(file.path) === SKILL_MANIFEST);
  if (!manifest) {
    throw new SkillPackageParseError(
      "missing_manifest",
      `这个文件夹里没有 ${SKILL_MANIFEST}，无法作为写法包导入。`,
    );
  }

  const { raw, body } = splitFrontmatter(manifest.content);

  const name = raw.name?.trim() || "";
  if (!name) {
    warn(warnings, "missing_required_field", "这个包没有写 name，导入后需要你补一个。", "name");
  }

  const unknownFrontmatter: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_FRONTMATTER_KEYS.has(key)) {
      unknownFrontmatter[key] = value;
    }
  }
  if (Object.keys(unknownFrontmatter).length > 0) {
    warn(
      warnings,
      "unknown_frontmatter_field",
      `本项目还不解读这些字段：${Object.keys(unknownFrontmatter).join("、")}。它们的原值会被保留，不会丢失。`,
    );
  }

  const rules = splitRuleSections(body);
  if (!Object.values(rules).some((value) => value.trim())) {
    warn(
      warnings,
      "empty_rules",
      `正文里没有找到可识别的规则小节（${SKILL_RULE_SECTIONS.map((item) => item.heading).join("、")}），全文仍会作为写作说明保留。`,
    );
  }

  const attachments: SkillPackageAttachment[] = [];
  const ignored: string[] = [];
  for (const file of files) {
    const path = normalizePath(file.path);
    if (path === SKILL_MANIFEST) {
      continue;
    }
    if (isIgnoredFile(path)) {
      ignored.push(path);
      continue;
    }
    const target = ATTACHMENT_DIRS.find((item) => path.startsWith(item.dir));
    if (target) {
      attachments.push({ kind: target.kind, path, content: file.content });
    }
  }
  if (ignored.length > 0) {
    // 第一版明确只读：包里带脚本一律忽略，并且要说出来——用户得知道自己装进来的
    // 东西里有什么没生效，而不是以为它会跑。
    warn(
      warnings,
      "ignored_executable",
      `包里的这些文件不会被读取，也不会被执行：${ignored.join("、")}。`,
    );
  }

  return {
    frontmatter: {
      name,
      description: raw.description?.trim() ?? "",
      category: raw.category?.trim() || null,
      tags: splitList(raw.tags ?? ""),
      applicableGenres: splitList(raw.applicableGenres ?? ""),
      applicableTasks: resolveApplicableTasks(raw.applicableTasks, warnings),
    },
    rules,
    instructions: body,
    attachments,
    unknownFrontmatter,
    warnings,
  };
}

/**
 * 序列化回包文件，用于导出。
 *
 * 与 `parseSkillPackage` 构成往返：导出再导入，frontmatter 与四维规则不应丢字段、
 * 不应改值。认不出的原值也一并写回去，否则「导出 → 导入」会成为一次静默的数据裁剪。
 */
export function serializeSkillPackage(skill: SkillPackage): SkillPackageFile[] {
  const front: string[] = ["---"];
  front.push(`name: ${skill.frontmatter.name}`);
  front.push(`description: ${skill.frontmatter.description}`);
  if (skill.frontmatter.category) {
    front.push(`category: ${skill.frontmatter.category}`);
  }
  if (skill.frontmatter.tags.length > 0) {
    front.push(`tags: ${skill.frontmatter.tags.join(", ")}`);
  }
  if (skill.frontmatter.applicableGenres.length > 0) {
    front.push(`applicableGenres: ${skill.frontmatter.applicableGenres.join(", ")}`);
  }
  if (skill.frontmatter.applicableTasks.length > 0) {
    front.push(`applicableTasks: ${skill.frontmatter.applicableTasks.join(", ")}`);
  }
  for (const [key, value] of Object.entries(skill.unknownFrontmatter)) {
    front.push(`${key}: ${value}`);
  }
  front.push("---");

  const sections = SKILL_RULE_SECTIONS
    .map((section) => {
      const content = skill.rules[section.key].trim();
      return content ? `## ${section.heading}\n\n${content}` : "";
    })
    .filter(Boolean);

  // 有小节就用小节重建正文；否则原样写回 instructions，保住只写了自由说明的包。
  const body = sections.length > 0 ? sections.join("\n\n") : skill.instructions.trim();

  return [
    { path: SKILL_MANIFEST, content: `${front.join("\n")}\n\n${body}\n` },
    ...skill.attachments.map((attachment) => ({
      path: attachment.path,
      content: attachment.content,
    })),
  ];
}
