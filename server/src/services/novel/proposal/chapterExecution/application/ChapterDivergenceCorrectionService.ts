import type { ChapterDivergence } from "@ai-novel/shared/types/chapterDivergence";
import { DIVERGENCE_CORRECTION_FAILED_DEBT_CODE } from "@ai-novel/shared/types/chapterDivergence";
import type { ChapterExecutionMissingObligation } from "@ai-novel/shared/types/chapterRuntime";
import { prisma } from "../../../../../db/prisma";
import { ChangeProposalError } from "../../domain/ChangeProposalError";
import { changeProposalStalenessService } from "../../infrastructure/ChangeProposalStalenessService";
import { parseProposalSourceRefs } from "../../infrastructure/ChangeProposalMapper";
import { buildDivergenceRepairObligations } from "../domain/ChapterDivergenceRepairMapper";
import { createChapterDivergenceRepairAdapter } from "../infrastructure/ChapterDivergenceRepairAdapter";

/**
 * 「按计划修正」的执行端口。
 *
 * 抽成端口是为了让本命令可以在没有 LLM 的情况下测试；默认实现接既有
 * `chapterRepairRuntime`，**不新建修复链路**，因此既有修复模式与预算规则
 * 一并继承。
 */
export interface ChapterDivergenceRepairPort {
  repairChapter(input: {
    novelId: string;
    chapterId: string;
    novelTitle: string;
    chapterTitle: string;
    content: string;
    obligations: ChapterExecutionMissingObligation[];
  }): Promise<{ content: string } | null>;
}

export interface CorrectChapterDivergenceInput {
  novelId: string;
  proposalId: string;
  /** 要修正的逐项变更 id。 */
  changeId: string;
}

export type ChapterDivergenceCorrectionResult =
  | { status: "corrected"; chapterId: string; divergenceId: string }
  | { status: "repair_failed"; chapterId: string; divergenceId: string; reason: string }
  /**
   * 修复跑完准备落库时，正文 / 逐项决定 / 信封状态之一已被并发改动。
   * 拒绝提交，保持当前状态——旧的修复结果不能覆盖新正文或新决定。
   */
  | { status: "conflict"; chapterId: string; divergenceId: string; reason: string };

interface CorrectionDeps {
  /** 省略时使用接既有 `chapterRepairRuntime` 的生产 adapter。 */
  repairPort?: ChapterDivergenceRepairPort;
  stalenessService?: Pick<typeof changeProposalStalenessService, "inspect">;
  db?: typeof prisma;
}

/** 仅用于在保存事务内触发回滚，不对外暴露。 */
class CorrectionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorrectionConflictError";
  }
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * 按计划修正：拒绝这条偏离（不把它接受进计划），并让正文改回 Expected。
 *
 * 关键顺序——**正文保存成功之后才写 `corrected_to_expected`**。修复失败时逐项
 * 保持可审阅，并写入显式质量债，绝不把失败记成已修正。
 */
export class ChapterDivergenceCorrectionService {
  private readonly repairPort: ChapterDivergenceRepairPort;
  private readonly stalenessService: Pick<typeof changeProposalStalenessService, "inspect">;
  private readonly db: typeof prisma;

  constructor(deps: CorrectionDeps = {}) {
    // 默认接生产 adapter。此前这里是必填参数，导致整条命令只有测试装配得起来
    // ——二次复审 H2 阻塞一。
    this.repairPort = deps.repairPort ?? createChapterDivergenceRepairAdapter();
    this.stalenessService = deps.stalenessService ?? changeProposalStalenessService;
    this.db = deps.db ?? prisma;
  }

  async correct(input: CorrectChapterDivergenceInput): Promise<ChapterDivergenceCorrectionResult> {
    const proposal = await this.db.changeProposal.findFirst({
      where: { id: input.proposalId, novelId: input.novelId },
      include: { changes: true },
    });
    if (!proposal) {
      throw new ChangeProposalError("not_found", "Change proposal not found.");
    }
    if (proposal.status !== "pending_review") {
      // 只有仍待审的信封才能走修正；已批准/已执行的要另行处理。
      throw new ChangeProposalError(
        "invalid_transition",
        `Change proposal must still be pending review to correct a divergence (current: ${proposal.status}).`,
      );
    }

    const change = proposal.changes.find((item) => item.id === input.changeId);
    if (!change) {
      throw new ChangeProposalError("not_found", "Proposed change not found in this proposal.");
    }
    if (change.reviewDecision) {
      throw new ChangeProposalError(
        "invalid_review",
        `Proposed change already has decision ${change.reviewDecision}.`,
      );
    }

    const stale = await this.stalenessService.inspect({
      proposalId: proposal.id,
      novelId: input.novelId,
      sourceRefs: parseProposalSourceRefs(proposal.sourceRefsJson),
    });
    if (stale.isStale) {
      throw new ChangeProposalError(
        "stale_proposal",
        "Change proposal sources changed; regenerate before correcting.",
        { reasons: stale.reasons },
      );
    }

    const payload = parseJsonRecord(change.payloadJson);
    const chapterId = typeof payload.chapterId === "string" ? payload.chapterId : null;
    const divergenceId = typeof payload.divergenceId === "string" ? payload.divergenceId : null;
    if (!chapterId || !divergenceId) {
      throw new ChangeProposalError(
        "invalid_review",
        "Divergence change payload is missing chapterId or divergenceId.",
      );
    }

    const chapter = await this.db.chapter.findFirst({
      where: { id: chapterId, novelId: input.novelId },
      select: { id: true, title: true, content: true, riskFlags: true },
    });
    if (!chapter?.content?.trim()) {
      throw new ChangeProposalError(
        "invalid_review",
        "Chapter has no saved content to correct.",
      );
    }
    const novel = await this.db.novel.findUnique({
      where: { id: input.novelId },
      select: { title: true },
    });

    const divergence: ChapterDivergence = {
      kind: payload.kind as ChapterDivergence["kind"],
      summary: String(payload.expected ?? ""),
      expected: String(payload.expected ?? ""),
      actual: String(payload.actual ?? ""),
      evidence: null,
      references: {
        affectedCharacterContractEntries: [],
        affectedPayoffContractEntries: [],
        touchedProtectedReveals: [],
        contractQuotes: [],
      },
    };

    let repaired: { content: string } | null = null;
    let failureReason = "repair produced no content";
    try {
      repaired = await this.repairPort.repairChapter({
        novelId: input.novelId,
        chapterId,
        novelTitle: novel?.title ?? "",
        chapterTitle: chapter.title,
        content: chapter.content,
        obligations: buildDivergenceRepairObligations([divergence]),
      });
    } catch (error) {
      failureReason = error instanceof Error ? error.message : String(error);
    }

    if (!repaired?.content?.trim()) {
      // 修复失败：逐项保持可审阅（不写 reviewDecision），只落显式质量债。
      await this.recordCorrectionDebt(chapter.id, divergenceId, failureReason);
      return {
        status: "repair_failed",
        chapterId,
        divergenceId,
        reason: failureReason,
      };
    }

    // 修复跑在事务外（LLM 可能耗时数分钟），因此**落库前必须重新校验**：
    // 期间用户可能改了正文、批准了提案，或触发了另一轮修复。
    // 正确做法不是把 LLM 塞进事务，而是在保存事务里做乐观条件更新，
    // 任一条件变化就拒绝提交（二次复审 H2 阻塞二）。
    // 注意：Prisma 事务只有**抛出**才会回滚，`return` 不会。任一条件不满足必须
    // 抛出 CorrectionConflictError，否则先执行的正文写入会被提交——
    // 这个顺序陷阱是本次新增的 TOCTOU 用例抓出来的。
    const conflictReason = await this.db.$transaction(async (tx) => {
      const envelope = await tx.changeProposal.findUnique({
        where: { id: input.proposalId },
        select: { status: true },
      });
      if (envelope?.status !== "pending_review") {
        throw new CorrectionConflictError(
          `envelope status changed to ${envelope?.status ?? "missing"}`,
        );
      }

      // 正文乐观条件更新：只有内容仍是修复输入的那一份才允许覆盖。
      const contentUpdated = await tx.chapter.updateMany({
        where: { id: chapter.id, content: chapter.content },
        data: { content: repaired.content },
      });
      if (contentUpdated.count !== 1) {
        throw new CorrectionConflictError(
          "chapter content changed while the repair was running",
        );
      }

      // 逐项条件更新：期间若已有评审决定则不覆盖。
      const itemUpdated = await tx.stateChangeProposal.updateMany({
        where: {
          id: input.changeId,
          changeProposalId: input.proposalId,
          reviewDecision: null,
        },
        // 修正 = 不把这条偏离接受进计划，因此逐项记为 rejected。
        data: { reviewDecision: "rejected", status: "rejected" },
      });
      if (itemUpdated.count !== 1) {
        throw new CorrectionConflictError("proposed change already has a review decision");
      }

      // riskFlags 基于事务内最新值 merge，不用修复前读到的旧字符串。
      const fresh = await tx.chapter.findUnique({
        where: { id: chapter.id },
        select: { riskFlags: true },
      });
      await tx.chapter.update({
        where: { id: chapter.id },
        data: {
          riskFlags: this.mergeResolution(fresh?.riskFlags, divergenceId, {
            resolution: "corrected_to_expected",
            kind: payload.kind ?? null,
            expected: payload.expected ?? null,
            resolvedAt: new Date().toISOString(),
          }),
        },
      });
      return null;
    }).catch((error: unknown) => {
      if (error instanceof CorrectionConflictError) {
        return error.message;
      }
      throw error;
    });

    if (conflictReason) {
      return { status: "conflict", chapterId, divergenceId, reason: conflictReason };
    }
    return { status: "corrected", chapterId, divergenceId };
  }

  private mergeResolution(
    riskFlags: string | null | undefined,
    divergenceId: string,
    entry: Record<string, unknown>,
  ): string {
    const parsed = parseJsonRecord(riskFlags);
    const existing = parsed.divergenceResolutions
      && typeof parsed.divergenceResolutions === "object"
      && !Array.isArray(parsed.divergenceResolutions)
      ? parsed.divergenceResolutions as Record<string, unknown>
      : {};
    return JSON.stringify({
      ...parsed,
      divergenceResolutions: { ...existing, [divergenceId]: entry },
    });
  }

  /**
   * 质量债同样在事务内重读最新 `riskFlags` 再 merge——用修复前读到的字符串
   * 覆盖会抹掉修复期间的并发写入（二次复审 H2 阻塞二）。
   */
  private async recordCorrectionDebt(
    chapterId: string,
    divergenceId: string,
    reason: string,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const fresh = await tx.chapter.findUnique({
        where: { id: chapterId },
        select: { riskFlags: true },
      });
      const parsed = parseJsonRecord(fresh?.riskFlags);
      const existingDebt = Array.isArray(parsed.divergenceDebt) ? parsed.divergenceDebt : [];
      await tx.chapter.update({
        where: { id: chapterId },
        data: {
          riskFlags: JSON.stringify({
            ...parsed,
            divergenceDebt: [
              ...existingDebt,
              {
                code: DIVERGENCE_CORRECTION_FAILED_DEBT_CODE,
                divergenceId,
                reason,
                recordedAt: new Date().toISOString(),
              },
            ],
          }),
        },
      });
    });
  }
}
