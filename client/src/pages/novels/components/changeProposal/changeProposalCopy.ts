import type {
  ChangeProposalStatus,
  ChangeProposalType,
  ProposedChange,
  ProposedChangeCategory,
} from "@ai-novel/shared/types/changeProposal";
import {
  getStateProposalApplicationMode,
  resolveProposedChangePayloadKey,
} from "@ai-novel/shared/types/stateProposalApplication";
import type { ApiHttpError } from "@/api/client";

export const CHANGE_PROPOSAL_ERROR_CODES = [
  "not_found",
  "version_conflict",
  "stale_proposal",
  "invalid_transition",
  "unsupported_change",
  "invalid_review",
] as const;

export type ChangeProposalUiErrorCode = typeof CHANGE_PROPOSAL_ERROR_CODES[number];

export interface ChangeProposalUiError {
  code: ChangeProposalUiErrorCode | "unknown";
  title: string;
  description: string;
}

const ERROR_COPY: Record<ChangeProposalUiErrorCode, Omit<ChangeProposalUiError, "code">> = {
  not_found: {
    title: "这份提案已不存在",
    description: "返回列表并刷新，选择仍可审阅的提案。",
  },
  version_conflict: {
    title: "提案内容有更新",
    description: "详情会刷新为最新版本，请重新检查并选择处理方式。",
  },
  stale_proposal: {
    title: "提案依据发生了变化",
    description: "请查看变化原因并重新生成提案，避免按过期信息写入状态。",
  },
  invalid_transition: {
    title: "当前状态不支持这项操作",
    description: "详情会刷新，你可以按最新状态继续处理。",
  },
  unsupported_change: {
    title: "部分变更暂不能写入正式状态",
    description: "这些内容可以保留在记录中，但需要等待对应的状态写入能力。",
  },
  invalid_review: {
    title: "审阅决定还不完整",
    description: "请检查逐项决定、其余项处理方式或修改后的完整内容。",
  },
};

export function resolveChangeProposalError(error: unknown): ChangeProposalUiError {
  const details = (error as ApiHttpError | null)?.details as {
    error?: unknown;
    message?: unknown;
  } | undefined;
  const rawCode = typeof details?.error === "string" ? details.error : "";
  if ((CHANGE_PROPOSAL_ERROR_CODES as readonly string[]).includes(rawCode)) {
    const code = rawCode as ChangeProposalUiErrorCode;
    return { code, ...ERROR_COPY[code] };
  }
  return {
    code: "unknown",
    title: "提案操作未完成",
    description: "请检查连接后重试；系统不会自动重复提交审阅决定。",
  };
}

export const PROPOSAL_STATUS_COPY: Record<ChangeProposalStatus, string> = {
  draft: "草稿",
  pending_review: "待审阅",
  approved: "已批准",
  partially_approved: "部分批准",
  rejected: "已拒绝",
  executed: "已执行",
  superseded: "已被新版本替代",
};

export const PROPOSAL_TYPE_COPY: Record<ChangeProposalType, string> = {
  chapter_execution: "章节执行",
  outline_edit: "大纲调整",
  character_state: "角色状态",
  relationship_change: "人物关系",
  world_edit: "世界设定",
  plot_replan: "剧情重规划",
  asset_import: "资产导入",
  post_write_state: "写后状态",
};

export const CHANGE_CATEGORY_COPY: Record<ProposedChangeCategory, string> = {
  outline: "大纲",
  character: "角色",
  relationship: "关系",
  knowledge: "信息边界",
  world: "世界设定",
  plot: "剧情",
  foreshadowing: "伏笔",
  timeline: "时间线",
};

export function isLedgerOnlyProposedChange(change: ProposedChange): boolean {
  return getStateProposalApplicationMode(change.proposalType) === "ledger_only";
}

export function formatProposalValue(value: unknown): string {
  if (value === undefined) {
    return "未提供";
  }
  if (value === null) {
    return "空";
  }
  if (typeof value === "string") {
    return value || "空文本";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "无法显示的结构化内容";
  }
}

export type ProposedChangeInlineValue = string | number | boolean;

export function parseProposedChangeInlineValue(
  source: string,
  reference: ProposedChangeInlineValue,
): ProposedChangeInlineValue {
  if (typeof reference === "number") {
    const parsed = Number(source);
    if (!Number.isFinite(parsed)) {
      throw new Error("请输入有效数字。");
    }
    return parsed;
  }
  if (typeof reference === "boolean") {
    if (source === "true") return true;
    if (source === "false") return false;
    throw new Error("布尔值只能填写 true 或 false。");
  }
  return source;
}

export function resolveProposedChangeInlineValue(change: ProposedChange): {
  payloadKey: string;
  value: ProposedChangeInlineValue;
} | null {
  const payload = change.userEditedPayload ?? change.payload;
  const payloadKey = resolveProposedChangePayloadKey({
    proposalType: change.proposalType,
    path: change.path,
    payload,
  });
  if (!payloadKey) {
    return null;
  }
  const value = payload[payloadKey];
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return null;
  }
  return { payloadKey, value };
}

export function canEditProposedChangeInline(change: ProposedChange): boolean {
  return resolveProposedChangeInlineValue(change) !== null;
}
