import type { ParsedSillyTavernCard } from "@ai-novel/shared/types/sillytavernCard";
import type {
  SillyTavernCardApplyResult,
  SillyTavernCardSegment,
  SillyTavernCardSplitPlan,
  SillyTavernSegmentDecision,
  SillyTavernSegmentDestination,
} from "@ai-novel/shared/types/sillytavernCardSplit";
import { changeProposalService } from "../novel/proposal/application/ChangeProposalService";
import { StyleProfileService } from "../styleEngine/StyleProfileService";
import { parseSillyTavernCard, SillyTavernParseError } from "./sillyTavernCardParser";
import { listIgnoredCardFields, planSillyTavernCardSplit } from "./sillyTavernCardSplitPlanner";
import { SillyTavernWorldBookImportService } from "./SillyTavernWorldBookImportService";

/**
 * 角色卡导入：**分流，不是映射**。
 *
 * 卡片在格式上像"一个角色"，但作者常把世界设定、语气要求和写作约束写在
 * `description` / `scenario` 里。整块映射进角色字段，会让世界观只在这个角色
 * 身上生效。所以这里把卡片切成段，各段分别去世界设定、写法资产或角色。
 *
 * **规划阶段完全只读且确定性**：建议只依据段落来自哪个字段，字段定不了的
 * 标成需要人判断，不猜。最终去向由用户逐段确认。
 */

export interface ApplySillyTavernCardInput {
  rawJson: unknown;
  decisions: SillyTavernSegmentDecision[];
  /** 角色必须归属一本书；只有分了段给角色时才需要。 */
  novelId?: string;
  knowledgeTitle?: string;
  styleProfileName?: string;
  characterName?: string;
  characterRole?: string;
}

export class SillyTavernCardImportService {
  constructor(
    private readonly worldBookImportService = new SillyTavernWorldBookImportService(),
    private readonly styleProfileService = new StyleProfileService(),
    private readonly proposalService: Pick<typeof changeProposalService, "createProposal"> = changeProposalService,
  ) {}

  /** 纯解析与规划，不写任何库。 */
  plan(rawJson: unknown): SillyTavernCardSplitPlan {
    const parsed = parseSillyTavernCard(rawJson);
    return this.planFromParsed(parsed);
  }

  private planFromParsed(parsed: ParsedSillyTavernCard): SillyTavernCardSplitPlan {
    const segments = planSillyTavernCardSplit(parsed);
    return {
      cardName: parsed.data.name || "未命名角色卡",
      segments,
      embeddedBook: this.worldBookImportService.previewFromCardBook(parsed.data.character_book),
      needsReviewCount: segments.filter((item) => item.origin === "needs_review").length,
      ignoredFields: listIgnoredCardFields(parsed),
      warnings: parsed.warnings,
    };
  }

  async apply(input: ApplySillyTavernCardInput): Promise<SillyTavernCardApplyResult> {
    const parsed = parseSillyTavernCard(input.rawJson);
    const plan = this.planFromParsed(parsed);
    const resolved = this.resolveDecisions(plan.segments, input.decisions);

    const worldSegments = resolved.filter((item) => item.destination === "world");
    const styleSegments = resolved.filter((item) => item.destination === "style");
    const characterSegments = resolved.filter((item) => item.destination === "character");
    const skipped = resolved.filter((item) => item.destination === "skip");

    // 校验前置：三路写入跨三个子系统，无法放进一个事务，所以能提前发现的
    // 问题一律不要留到写了一半才发现。
    if (characterSegments.length > 0 && !input.novelId?.trim()) {
      throw new SillyTavernParseError(
        "novel_required",
        "有内容要导入为角色，请先选择它属于哪本书。",
      );
    }

    const cardName = parsed.data.name?.trim() || "SillyTavern 角色卡";

    let knowledgeDocumentId: string | null = null;
    let knowledgeUnchanged = false;
    const worldContent = this.renderWorldContent(cardName, worldSegments, plan);
    if (worldContent) {
      const stored = await this.worldBookImportService.importRenderedContent({
        title: input.knowledgeTitle?.trim() || `${cardName} · 世界设定`,
        content: worldContent,
      });
      knowledgeDocumentId = stored.documentId;
      knowledgeUnchanged = stored.unchanged;
    }

    let styleProfileId: string | null = null;
    if (styleSegments.length > 0) {
      const profile = await this.styleProfileService.createManualProfile({
        name: input.styleProfileName?.trim() || `${cardName} · 文风`,
        description: `从 SillyTavern 角色卡分流出的文风约束，共 ${styleSegments.length} 段。`,
        // 与 preset 导入区分开：来源追踪要能说清这份写法是从卡片分流来的。
        sourceType: "from_sillytavern_card",
        // 原文无损留存，导入后仍能回溯这些指令来自卡片的哪个字段。
        sourceContent: JSON.stringify(input.rawJson),
        analysisMarkdown: this.renderStyleMarkdown(cardName, styleSegments),
        narrativeRules: {
          summary: styleSegments.map((item) => item.segment.text.trim()).join("\n\n"),
        },
      });
      styleProfileId = profile.id;
    }

    // 角色**不直接写角色库**：设计文档要求导入走提案。角色是小说范围的正式
    // 状态，适配既有 `ChangeProposal` 信封；世界设定与写法是全局资产，不适配，
    // 所以只有这一路进提案。
    let characterProposalId: string | null = null;
    if (characterSegments.length > 0 && input.novelId) {
      const name = input.characterName?.trim() || cardName;
      const payload = {
        name,
        // 默认「配角」而不是「主角」：正文与统计链路用 `role === "主角"` 和
        // /主角|反派/ 判定身份，导入一张卡不该让它自动成为这本书的主角。
        role: input.characterRole?.trim() || "配角",
        personality: this.joinByField(characterSegments, "personality") || null,
        background: this.joinByField(characterSegments, "description", "scenario") || null,
        sourceLabel: `SillyTavern 角色卡 · ${cardName}`,
      };
      const proposal = await this.proposalService.createProposal(input.novelId, {
        proposalType: "asset_import",
        summary: `从 SillyTavern 角色卡导入角色「${name}」`,
        reasoningSummary: `由 ${characterSegments.length} 段被判定为角色事实的内容组成。`,
        submitForReview: true,
        sourceRefs: [],
        warnings: [],
        changes: [{
          proposalType: "character_import",
          // 路径的终端段必须对应 payload 里的一个键：apply 前会校验
          // 「展示的 after 等于实际写入值」，这是 2A 定下的规则。
          path: `characters.${name}.name`,
          operation: "add",
          category: "character",
          severity: "major",
          before: null,
          after: name,
          payload,
          reason: "这些内容被判定为属于这个角色本身。",
          evidence: characterSegments.map((item) => item.segment.sourceLabel),
          sourceRefs: [],
        }],
      });
      characterProposalId = proposal.id;
    }

    return {
      knowledgeDocumentId,
      knowledgeUnchanged,
      styleProfileId,
      characterProposalId,
      appliedCounts: {
        world: worldSegments.length,
        style: styleSegments.length,
        character: characterSegments.length,
        skipped: skipped.length,
      },
    };
  }

  /**
   * 把用户的决定套到段落上。
   *
   * 未提及的段落沿用建议值——但 `needs_review` 的段落必须由用户明确表态，
   * 否则那些「可能是世界设定也可能是角色事实」的内容会按默认值悄悄落地，
   * 而这正是这张卡最容易被导错的部分。
   */
  private resolveDecisions(
    segments: SillyTavernCardSegment[],
    decisions: SillyTavernSegmentDecision[],
  ): { segment: SillyTavernCardSegment; destination: SillyTavernSegmentDestination }[] {
    const byId = new Map(segments.map((segment) => [segment.id, segment]));
    const chosen = new Map<string, SillyTavernSegmentDestination>();

    for (const decision of decisions) {
      if (!byId.has(decision.segmentId)) {
        throw new SillyTavernParseError(
          "unknown_segment",
          `提交的内容里有一段不属于这张卡（${decision.segmentId}），请重新读取后再确认。`,
        );
      }
      chosen.set(decision.segmentId, decision.destination);
    }

    const undecidedReview = segments
      .filter((segment) => segment.origin === "needs_review" && !chosen.has(segment.id));
    if (undecidedReview.length > 0) {
      throw new SillyTavernParseError(
        "decision_required",
        `还有 ${undecidedReview.length} 段需要你确认去向：${
          undecidedReview.map((segment) => segment.sourceLabel).join("、")
        }。`,
      );
    }

    return segments.map((segment) => ({
      segment,
      destination: chosen.get(segment.id) ?? segment.suggestedDestination,
    }));
  }

  private renderWorldContent(
    cardName: string,
    worldSegments: { segment: SillyTavernCardSegment }[],
    plan: SillyTavernCardSplitPlan,
  ): string {
    const sections: string[] = [];
    if (worldSegments.length > 0 || plan.embeddedBook) {
      sections.push(`# ${cardName} · 世界设定`);
    }
    for (const { segment } of worldSegments) {
      sections.push(`## ${segment.sourceLabel}\n\n${segment.text.trim()}`);
    }
    // 卡片内嵌的世界书归属确定，随世界设定一起入库。
    if (plan.embeddedBook?.content) {
      sections.push(plan.embeddedBook.content);
    }
    return sections.join("\n\n").trim();
  }

  private renderStyleMarkdown(
    cardName: string,
    styleSegments: { segment: SillyTavernCardSegment }[],
  ): string {
    const lines = [`# ${cardName} 的文风约束`, "", "来自 SillyTavern 角色卡的以下部分：", ""];
    for (const { segment } of styleSegments) {
      lines.push(`## ${segment.sourceLabel}`, "", segment.text.trim(), "");
    }
    return lines.join("\n");
  }

  private joinByField(
    entries: { segment: SillyTavernCardSegment }[],
    ...fields: string[]
  ): string {
    return entries
      .filter((entry) => fields.includes(entry.segment.sourceField))
      .map((entry) => entry.segment.text.trim())
      .join("\n\n");
  }
}
