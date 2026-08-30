import { Router } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import { sillyTavernSegmentDecisionSchema } from "@ai-novel/shared/types/sillytavernCardSplit";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { validate } from "../middleware/validate";
import { SillyTavernCardImportService } from "../services/sillytavern/SillyTavernCardImportService";
import { SillyTavernParseError } from "../services/sillytavern/sillyTavernCardParser";
import { extractSillyTavernCardFromPng } from "../services/sillytavern/sillyTavernPngCard";

/**
 * 角色卡导入入口。
 *
 * 单独成一个路由是因为它**跨三个子系统**：一张卡分流后可能同时写知识库、
 * 写法资产和角色。预设与世界书各自归属明确，仍留在写法与知识库路由里。
 */

const router = Router();
router.use(authMiddleware);

const cardImportService = new SillyTavernCardImportService();

const planSchema = z.object({
  card: z.unknown(),
});

const pngSchema = z.object({
  /** PNG 文件的 base64 内容。 */
  pngBase64: z.string().min(1),
});

const applySchema = z.object({
  card: z.unknown(),
  decisions: z.array(sillyTavernSegmentDecisionSchema).max(500).default([]),
  novelId: z.string().trim().min(1).optional(),
  knowledgeTitle: z.string().trim().min(1).max(200).optional(),
  styleProfileName: z.string().trim().min(1).max(120).optional(),
  characterName: z.string().trim().min(1).max(120).optional(),
  characterRole: z.string().trim().min(1).max(60).optional(),
});

function forwardSillyTavernError(error: unknown, next: (error?: unknown) => void): void {
  if (error instanceof SillyTavernParseError) {
    next(new AppError(error.code, 400, error.message));
    return;
  }
  next(error);
}

// 规划是纯读：解析卡片、切段、给出建议去向，不写任何库。
router.post("/cards/plan", validate({ body: planSchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof planSchema>;
    const data = cardImportService.plan(body.card);
    res.status(200).json({
      success: true,
      data,
      message: data.needsReviewCount > 0
        ? `有 ${data.needsReviewCount} 段需要你确认是世界设定还是角色本身的内容。`
        : "已读出这张卡的内容，确认去向后即可导入。",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    forwardSillyTavernError(error, next);
  }
});

// 从 PNG 里取出卡片再规划，省得用户自己先转成 JSON。
router.post("/cards/plan-from-png", validate({ body: pngSchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof pngSchema>;
    const extracted = extractSillyTavernCardFromPng(Buffer.from(body.pngBase64, "base64"));
    const data = cardImportService.plan(extracted.json);
    res.status(200).json({
      success: true,
      data,
      message: `已从图片里读出角色卡（${extracted.keyword}）。`,
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    forwardSillyTavernError(error, next);
  }
});

router.post("/cards/apply", validate({ body: applySchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof applySchema>;
    const data = await cardImportService.apply({
      rawJson: body.card,
      decisions: body.decisions,
      novelId: body.novelId,
      knowledgeTitle: body.knowledgeTitle,
      styleProfileName: body.styleProfileName,
      characterName: body.characterName,
      characterRole: body.characterRole,
    });
    res.status(201).json({
      success: true,
      data,
      message: "已按你确认的去向导入。世界设定与文风可在各自的绑定界面启用。",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    forwardSillyTavernError(error, next);
  }
});

export default router;
