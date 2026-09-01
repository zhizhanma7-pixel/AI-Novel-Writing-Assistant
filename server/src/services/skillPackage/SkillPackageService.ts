import type { StyleProfile } from "@ai-novel/shared/types/styleEngine";
import {
  SKILL_PACKAGE_SOURCE_TYPE,
  type SkillPackage,
  type SkillPackagePreview,
} from "@ai-novel/shared/types/skillPackage";
import { prisma } from "../../db/prisma";
import { StyleProfileService } from "../styleEngine/StyleProfileService";
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
    warnings: skill.warnings,
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
   * 由 Skill 包导入来的资产直接还原原文，保证往返逐字一致；其它来源的资产
   * （手工、从文本炼化、SillyTavern 预设等）按当前字段现场组装成包——
   * 这正是「把自己炼的写法拷给别人」要的能力，不限于导入过的那些。
   */
  async exportPackage(styleProfileId: string): Promise<SkillPackageFile[]> {
    const row = await prisma.styleProfile.findUnique({ where: { id: styleProfileId } });
    if (!row) {
      throw new SkillPackageParseError("profile_not_found", "找不到这条写法资产。");
    }

    if (row.sourceType === SKILL_PACKAGE_SOURCE_TYPE && row.sourceContent) {
      const restored = this.tryRestoreStoredPackage(row.sourceContent);
      if (restored) {
        return restored;
      }
      // 存的东西读不回来时不要静默改走重建：那会让「导出的和导入的不一样」
      // 无声发生。落到重建路径，但下面的日志要能对上。
      console.warn(
        `[skill-package] event=stored_package_unreadable styleProfileId=${styleProfileId} — 已改用字段重建导出。`,
      );
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
      attachments: [],
      unknownFrontmatter: {},
      warnings: [],
    });
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
