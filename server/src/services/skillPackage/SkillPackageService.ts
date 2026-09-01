import type { StyleProfile } from "@ai-novel/shared/types/styleEngine";
import {
  SKILL_PACKAGE_SOURCE_TYPE,
  type SkillPackage,
  type SkillPackagePreview,
} from "@ai-novel/shared/types/skillPackage";
import { prisma } from "../../db/prisma";
import { StyleProfileService } from "../styleEngine/StyleProfileService";
import { extractStyleSourceEntities } from "../styleEngine/styleGenerationSanitizer";
import {
  parseSkillPackage,
  serializeSkillPackage,
  SkillPackageParseError,
  type SkillPackageFile,
} from "./skillPackageParser";

/**
 * Skill 包的导入与导出（Phase 4 / S2）。
 *
 * Skill 不是新资产：导入产出的就是一条写法资产（`StyleProfile`），
 * `sourceType = "imported_skill"`。因此**不走 ChangeProposal**——那是小说范围的
 * 信封，而写法是全局资产；这与 Phase 3 世界书 / 预设的口径一致。
 *
 * 整包原文存进 `sourceContent`，用它既有的「原文无损留存」语义：
 * 1. 导出时能逐字还原，包括 references / templates / examples；
 * 2. `styleGenerationSanitizer` 会把 `sourceContent` 喂给禁用实体提取，于是
 *    别人示例里带的人名自动进入脱敏候选——正是「学别人但不抄别人」要的。
 *
 * 附件**不进提示词**：只有 frontmatter 与四维规则参与生成。
 */

/** 单个包的原文上限。超过就拒绝，而不是悄悄塞进一行里拖垮查询与实体提取。 */
export const SKILL_PACKAGE_MAX_BYTES = 256 * 1024;

// 预览结构是接口返回体，定义在 shared，界面按同一份契约展示。
export type { SkillPackagePreview };

interface StoredSkillPackage {
  version: 1;
  files: SkillPackageFile[];
}

function measureBytes(files: SkillPackageFile[]): number {
  return files.reduce(
    (sum, file) => sum + Buffer.byteLength(file.path, "utf8") + Buffer.byteLength(file.content, "utf8"),
    0,
  );
}

function buildPreview(skill: SkillPackage, sizeBytes: number): SkillPackagePreview {
  const sourceEntities = extractStyleSourceEntities([
    skill.frontmatter.name,
    skill.frontmatter.description,
    skill.instructions,
    ...skill.attachments.map((attachment) => attachment.content),
  ].join("\n"));
  const warnings = [
    ...skill.warnings,
    {
      code: "story_state_scope_warning" as const,
      message: "写法包会跨作品复用，请确认其中只包含写作方法，不包含某本书的具体角色、事件或结局。",
      field: null,
    },
    ...(sourceEntities.length > 0 ? [{
      code: "source_entities_detected" as const,
      message: `检测到可能来自原作的名称：${sourceEntities.join("、")}。生成时会按写法消毒规则遮蔽这些名称。`,
      field: null,
    }] : []),
  ];
  return {
    name: skill.frontmatter.name,
    description: skill.frontmatter.description,
    category: skill.frontmatter.category,
    tags: skill.frontmatter.tags,
    applicableGenres: skill.frontmatter.applicableGenres,
    applicableTasks: skill.frontmatter.applicableTasks,
    ruleLengths: {
      narrative: skill.rules.narrative.length,
      character: skill.rules.character.length,
      language: skill.rules.language.length,
      rhythm: skill.rules.rhythm.length,
    },
    attachmentCount: skill.attachments.length,
    sizeBytes,
    unknownFields: Object.keys(skill.unknownFrontmatter),
    warnings,
  };
}

export class SkillPackageService {
  constructor(private readonly styleProfileService = new StyleProfileService()) {}

  /** 纯解析与体检，不写任何库。 */
  preview(files: SkillPackageFile[]): SkillPackagePreview {
    const sizeBytes = measureBytes(files);
    // 先卡体积再解析。放在解析后就等于没卡：请求体上限是 20MB，
    // 超标的包会被完整解析一遍才被拒。
    this.assertWithinSizeLimit(sizeBytes);
    const skill = parseSkillPackage(files);
    return buildPreview(skill, sizeBytes);
  }

  async importPackage(input: {
    files: SkillPackageFile[];
    /** 覆盖包里的名称；同名重复导入时用得上。 */
    name?: string;
  }): Promise<{ profile: StyleProfile; preview: SkillPackagePreview }> {
    const sizeBytes = measureBytes(input.files);
    this.assertWithinSizeLimit(sizeBytes);
    const skill = parseSkillPackage(input.files);

    const name = input.name?.trim() || skill.frontmatter.name.trim();
    if (!name) {
      // 解析层对缺名只降级告警（不因此读不进来），但真要落库必须有名字。
      throw new SkillPackageParseError(
        "missing_name",
        "这个写法包没有名称，导入前请先补一个。",
      );
    }

    const stored: StoredSkillPackage = { version: 1, files: input.files };
    const profile = await this.styleProfileService.createManualProfile({
      name,
      description: skill.frontmatter.description,
      category: skill.frontmatter.category ?? undefined,
      tags: skill.frontmatter.tags,
      applicableGenres: skill.frontmatter.applicableGenres,
      applicableTasks: skill.frontmatter.applicableTasks,
      sourceType: SKILL_PACKAGE_SOURCE_TYPE,
      sourceContent: JSON.stringify(stored),
      analysisMarkdown: skill.instructions,
      // 与 SillyTavern 卡片分流一致：四维规则各存一段 summary。
      narrativeRules: skill.rules.narrative ? { summary: skill.rules.narrative } : {},
      characterRules: skill.rules.character ? { summary: skill.rules.character } : {},
      languageRules: skill.rules.language ? { summary: skill.rules.language } : {},
      rhythmRules: skill.rules.rhythm ? { summary: skill.rules.rhythm } : {},
      // 导入进来不立刻参与自动命中。别人的一套写法，作者还没看过一眼，
      // 不该在下一次生成时就开始左右自己的文字——那正是酒馆式黑箱，
      // 写作这边要把东西先摆出来让作者取舍。作者在写法列表里点「恢复
      // 自动命中」才开始生效；手动绑定不受此限制，随时可用。
      status: "archived",
    });

    return { profile, preview: buildPreview(skill, sizeBytes) };
  }

  /**
   * 导出一条写法资产为包文件。
   *
   * 任何来源的资产都能导出——「把自己炼的写法拷给别人」正是这个能力，
   * 不限于导入过的那些。
   *
   * **导出的永远是当前的资产，不是当初导入的那个包。** 作者改了名称或四维规则，
   * 导出就得跟着变；否则拷给别人的是他自己都已经不用的旧版本。
   * 导入来的包里那些本项目不解读的东西——附件、认不出的 frontmatter 字段——
   * 原样保留（Phase 3 的教训：认不出不等于可以丢），已知字段一律以库里的为准。
   */
  async exportPackage(styleProfileId: string): Promise<SkillPackageFile[]> {
    const row = await prisma.styleProfile.findUnique({ where: { id: styleProfileId } });
    if (!row) {
      throw new SkillPackageParseError("profile_not_found", "找不到这条写法资产。");
    }

    // 导入来的包：取出附件与未知 frontmatter 带走，其余以库里的当前值为准。
    let attachments: SkillPackage["attachments"] = [];
    let unknownFrontmatter: SkillPackage["unknownFrontmatter"] = {};
    if (row.sourceType === SKILL_PACKAGE_SOURCE_TYPE && row.sourceContent) {
      const original = this.tryRestoreOriginalPackage(row.sourceContent);
      if (original) {
        attachments = original.attachments;
        unknownFrontmatter = original.unknownFrontmatter;
      } else {
        // 读不回来时不静默略过：附件和未知字段会就此消失，作者有权知道。
        console.warn(
          `[skill-package] event=stored_package_unreadable styleProfileId=${styleProfileId} — 附件与未识别字段无法带出，仅导出当前字段。`,
        );
      }
    }

    const readRules = (json: string | null): string => {
      if (!json) {
        return "";
      }
      try {
        const parsed = JSON.parse(json) as { summary?: unknown };
        return typeof parsed.summary === "string" ? parsed.summary : "";
      } catch {
        return "";
      }
    };
    const readList = (json: string | null): string[] => {
      if (!json) {
        return [];
      }
      try {
        const parsed = JSON.parse(json);
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
      } catch {
        return [];
      }
    };

    return serializeSkillPackage({
      frontmatter: {
        name: row.name,
        description: row.description ?? "",
        category: row.category,
        tags: readList(row.tagsJson),
        applicableGenres: readList(row.applicableGenresJson),
        applicableTasks: readList(row.applicableTasksJson) as never,
      },
      rules: {
        narrative: readRules(row.narrativeRulesJson),
        character: readRules(row.characterRulesJson),
        language: readRules(row.languageRulesJson),
        rhythm: readRules(row.rhythmRulesJson),
      },
      instructions: row.analysisMarkdown ?? "",
      attachments,
      unknownFrontmatter,
      warnings: [],
    });
  }

  /** 取回当初导入的那个包，只为拿它的附件与未识别字段。 */
  private tryRestoreOriginalPackage(sourceContent: string): SkillPackage | null {
    const files = this.tryRestoreStoredPackage(sourceContent);
    if (!files) {
      return null;
    }
    try {
      return parseSkillPackage(files);
    } catch {
      return null;
    }
  }

  private tryRestoreStoredPackage(sourceContent: string): SkillPackageFile[] | null {
    try {
      const parsed = JSON.parse(sourceContent) as StoredSkillPackage;
      if (parsed?.version !== 1 || !Array.isArray(parsed.files)) {
        return null;
      }
      const files = parsed.files.filter(
        (file): file is SkillPackageFile => typeof file?.path === "string" && typeof file?.content === "string",
      );
      return files.length > 0 ? files : null;
    } catch {
      return null;
    }
  }

  private assertWithinSizeLimit(sizeBytes: number): void {
    if (sizeBytes > SKILL_PACKAGE_MAX_BYTES) {
      throw new SkillPackageParseError(
        "package_too_large",
        `这个写法包有 ${Math.round(sizeBytes / 1024)}KB，超过了 ${SKILL_PACKAGE_MAX_BYTES / 1024}KB 上限。请精简 references / examples 后再导入。`,
      );
    }
  }
}
