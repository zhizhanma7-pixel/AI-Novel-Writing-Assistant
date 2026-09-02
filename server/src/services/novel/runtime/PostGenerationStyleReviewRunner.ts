import type {
  GenerationContextPackage,
  RuntimeStyleDetectionReport,
} from "@ai-novel/shared/types/chapterRuntime";
import { StyleDetectionService } from "../../styleEngine/StyleDetectionService";
import { StyleRewriteService } from "../../styleEngine/StyleRewriteService";
import type { ChapterRuntimeRequestInput } from "./chapterRuntimeSchema";
import { PostGenerationStyleReviewPolicyResolver } from "./PostGenerationStyleReviewPolicyResolver";

export interface StyleReviewResult {
  report: RuntimeStyleDetectionReport | null;
  autoRewritten: boolean;
  originalContent: string | null;
  finalContent: string;
}

export interface PostGenerationStyleReviewInput {
  novelId: string;
  chapterId: string;
  request: ChapterRuntimeRequestInput;
  contextPackage: GenerationContextPackage;
  content: string;
}

interface PostGenerationStyleReviewRunnerDeps {
  styleDetectionService?: Pick<StyleDetectionService, "check">;
  styleRewriteService?: Pick<StyleRewriteService, "rewrite">;
  postGenerationStyleReviewPolicyResolver?: Pick<PostGenerationStyleReviewPolicyResolver, "resolve">;
}

export class PostGenerationStyleReviewRunner {
  private readonly deps: Required<PostGenerationStyleReviewRunnerDeps>;

  constructor(deps: PostGenerationStyleReviewRunnerDeps = {}) {
    this.deps = {
      styleDetectionService: deps.styleDetectionService ?? new StyleDetectionService(),
      styleRewriteService: deps.styleRewriteService ?? new StyleRewriteService(),
      postGenerationStyleReviewPolicyResolver: deps.postGenerationStyleReviewPolicyResolver
        ?? new PostGenerationStyleReviewPolicyResolver(),
    };
  }

  async run(input: PostGenerationStyleReviewInput): Promise<StyleReviewResult> {
    const policy = await this.deps.postGenerationStyleReviewPolicyResolver.resolve(input.novelId).catch(() => ({
      enabled: true,
    }));
    if (!policy.enabled) {
      return {
        report: null,
        autoRewritten: false,
        originalContent: null,
        finalContent: input.content,
      };
    }

    // 这里原本先看正文生成时组装的 styleContext 有没有内容，没有就直接跳过审校。
    // 那个 context 来自 writer 环节：只绑了 reviewer 而没绑 writer 或作品写法时，
    // 它是空的，于是审校根本不跑，reviewer 绑定完全失效。
    //
    // 判断"有没有可执行约束"本来就该由检测自己做——它解析的是 reviewer 环节，
    // 并且在没有任何约束时会直接返回空报告且不调用模型。所以这里不再前置拦截。
    let report: RuntimeStyleDetectionReport | null = null;
    try {
      report = await this.deps.styleDetectionService.check({
        content: input.content,
        novelId: input.novelId,
        chapterId: input.chapterId,
        taskStyleProfileId: input.request.taskStyleProfileId,
        provider: input.request.provider,
        model: input.request.model,
        temperature: 0.2,
      });
    } catch {
      return {
        report: null,
        autoRewritten: false,
        originalContent: null,
        finalContent: input.content,
      };
    }

    const rewritableIssues = report.violations.filter((item) => item.canAutoRewrite && item.suggestion.trim());
    const shouldAutoRewrite = report.canAutoRewrite
      && rewritableIssues.length > 0
      && report.riskScore >= 35;

    if (!shouldAutoRewrite) {
      return {
        report,
        autoRewritten: false,
        originalContent: null,
        finalContent: input.content,
      };
    }

    try {
      const rewritten = await this.deps.styleRewriteService.rewrite({
        content: input.content,
        novelId: input.novelId,
        chapterId: input.chapterId,
        taskStyleProfileId: input.request.taskStyleProfileId,
        issues: rewritableIssues.map((item) => ({
          ruleName: item.ruleName,
          excerpt: item.excerpt,
          suggestion: item.suggestion,
        })),
        provider: input.request.provider,
        model: input.request.model,
        temperature: Math.min(input.request.temperature ?? 0.5, 0.7),
      });
      const finalContent = rewritten.content.trim() || input.content;
      const autoRewritten = finalContent.trim() !== input.content.trim();
      return {
        report,
        autoRewritten,
        originalContent: autoRewritten ? input.content : null,
        finalContent,
      };
    } catch {
      return {
        report,
        autoRewritten: false,
        originalContent: null,
        finalContent: input.content,
      };
    }
  }
}
