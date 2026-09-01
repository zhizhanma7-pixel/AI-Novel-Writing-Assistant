import { z } from "zod";
import { MODEL_ROUTE_TASK_TYPES } from "./novel.js";

/**
 * Skill 包契约（Phase 4 / S1）。
 *
 * **Skill 不是新的资产类型。** 它是既有写法资产（`StyleProfile`）的可携带封装：
 * 作者炼化出来的写法本来锁死在自己库里，这层格式让它能拷给别人、也能装回来。
 * 口径见 `docs/dev/ARCH_ANALYSIS_SKILLS.md` §0，显式覆盖了原规范把 Skill 与
 * Preset 切成两种资产的写法。
 *
 * 目录形态：
 * ```
 * skill-name/
 * ├─ SKILL.md
 * ├─ references/*.md
 * ├─ templates/*.md
 * └─ examples/*.md
 * ```
 *
 * **只读。** 解析层不 eval、不 require 包内文件、不发网络请求；包里出现脚本
 * 一律忽略并在预览里明说不会执行。
 */

/** SKILL.md 正文里映射到写法四维规则的小节标题。 */
export const SKILL_RULE_SECTIONS = [
  { key: "narrative", heading: "叙事规则" },
  { key: "character", heading: "人物规则" },
  { key: "language", heading: "语言规则" },
  { key: "rhythm", heading: "节奏规则" },
] as const;

export type SkillRuleSectionKey = (typeof SKILL_RULE_SECTIONS)[number]["key"];

/**
 * 包内附件：references / templates / examples。
 *
 * 随包携带以便回溯，但**不进提示词**——只有 frontmatter 与四维规则参与生成。
 * 理由见实施计划 Non-goals 与风险 R3。
 */
export const skillPackageAttachmentSchema = z.object({
  kind: z.enum(["reference", "template", "example"]),
  /** 相对包根的路径，保留原样以便导出时还原目录结构。 */
  path: z.string(),
  content: z.string(),
});
export type SkillPackageAttachment = z.infer<typeof skillPackageAttachmentSchema>;

/**
 * 解析告警。
 *
 * 沿用 Phase 3 的做法：认不出的东西一律留下并如实告知，不静默丢弃，也不
 * 因为一处不认识就整包读不进来。
 */
export const skillPackageWarningSchema = z.object({
  code: z.enum([
    /** frontmatter 里出现了本项目还不解读的键。 */
    "unknown_frontmatter_field",
    /** applicableTasks 里出现了不在既有取值域内的任务名。 */
    "unknown_task_type",
    /** 包里带了脚本或二进制，已忽略。 */
    "ignored_executable",
    /** 缺少必填项，已降级处理。 */
    "missing_required_field",
    /** 正文里没有任何可识别的规则小节。 */
    "empty_rules",
  ]),
  message: z.string(),
  field: z.string().nullable().default(null),
});
export type SkillPackageWarning = z.infer<typeof skillPackageWarningSchema>;

export const skillPackageFrontmatterSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  category: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  applicableGenres: z.array(z.string()).default([]),
  /**
   * 复用 `ModelRouteTaskType` 作为取值域，不自造字符串。
   * `modelRouter.normalizeTaskType` 已经把 `chapter_drafting` 之类别名映射回该域。
   */
  applicableTasks: z.array(z.enum(MODEL_ROUTE_TASK_TYPES)).default([]),
});
export type SkillPackageFrontmatter = z.infer<typeof skillPackageFrontmatterSchema>;

export const skillPackageRulesSchema = z.object({
  narrative: z.string().default(""),
  character: z.string().default(""),
  language: z.string().default(""),
  rhythm: z.string().default(""),
});
export type SkillPackageRules = z.infer<typeof skillPackageRulesSchema>;

export const skillPackageSchema = z.object({
  frontmatter: skillPackageFrontmatterSchema,
  rules: skillPackageRulesSchema,
  /** SKILL.md 的正文全文（不含 frontmatter），落到 `StyleProfile.analysisMarkdown`。 */
  instructions: z.string(),
  attachments: z.array(skillPackageAttachmentSchema).default([]),
  /**
   * frontmatter 里认不出的键，原值保留。
   *
   * 与 `warnings` 分工不同：这里存的是**值**，warnings 存的是**说法**。
   * Phase 3 世界书那次的教训是只留字段名会让值不可逆地消失。
   */
  unknownFrontmatter: z.record(z.string(), z.string()).default({}),
  warnings: z.array(skillPackageWarningSchema).default([]),
});
export type SkillPackage = z.infer<typeof skillPackageSchema>;

/** 导入时写进 `StyleProfile.sourceType` 的值。 */
export const SKILL_PACKAGE_SOURCE_TYPE = "imported_skill";

/** 包内会被忽略、且明确不执行的文件后缀。 */
export const SKILL_PACKAGE_IGNORED_EXTENSIONS = [
  ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd",
  ".py", ".rb", ".pl", ".js", ".mjs", ".cjs", ".ts",
  ".exe", ".dll", ".so", ".dylib", ".bin",
] as const;
