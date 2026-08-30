import { z } from "zod";

/**
 * 从外部资产导入一个角色的可执行载荷（Phase 3）。
 *
 * **导入不直接写正式角色库**——设计文档的原话。角色是小说范围的正式状态，
 * 因此走既有的 `ChangeProposal` 信封：创建提案 → 用户审阅 → 执行时才落库。
 * 这样导入可中断续做，也留下了谁把哪一段导成了什么的记录。
 *
 * 世界设定与写法资产不走这条路：它们是全局资产，不属于任何一本书，
 * 塞进绑 `novelId` 的信封语义不对。
 */
export const characterImportPayloadSchema = z.object({
  name: z.string().trim().min(1),
  /**
   * 角色定位。默认「配角」而不是「主角」：正文与统计链路用 `role === "主角"`
   * 和 /主角|反派/ 判定身份，导入一张卡不该让它自动成为这本书的主角。
   */
  role: z.string().trim().min(1),
  personality: z.string().trim().min(1).nullable().optional(),
  background: z.string().trim().min(1).nullable().optional(),
  /** 来源留证，便于事后回溯这个角色是从哪张卡导进来的。 */
  sourceLabel: z.string().trim().min(1).nullable().optional(),
  /**
   * 原始文件内容，原样留存。
   *
   * 写法资产那一路存在 `StyleProfile.sourceContent` 里；角色走提案，
   * 就存在提案载荷里。**不存的话，批准之后这张卡里没被识别的字段就再也
   * 找不回来了**——外部格式会继续演进，那是不可逆的数据损失。
   * applier 只读不写它。
   */
  sourceRaw: z.unknown().optional(),
}).strict();

export type CharacterImportPayload = z.infer<typeof characterImportPayloadSchema>;
