import type { ApiResponse } from "@ai-novel/shared/types/api";
import type {
  SillyTavernCardApplyResult,
  SillyTavernSegmentDecision,
} from "@ai-novel/shared/types/sillytavernCardSplit";
import type { SillyTavernInspectResult } from "@ai-novel/shared/types/sillytavernInspect";
import type { SillyTavernWorldBookImportResult } from "@ai-novel/shared/types/sillytavernWorldBookImport";
import type { StyleProfile } from "@ai-novel/shared/types/styleEngine";
import { apiClient } from "./client";

/** 这些状态由界面翻译成中文指引，不弹默认错误提示。 */
const IMPORT_ERROR_STATUSES = [400, 404, 409];

function requireData<T>(response: ApiResponse<T>, fallbackMessage: string): T {
  if (response.data === undefined) {
    throw new Error(fallbackMessage);
  }
  return response.data;
}

/** 识别一个 SillyTavern 导出文件是什么。只读，不导入任何内容。 */
export async function inspectSillyTavernFile(
  input: { content?: unknown; pngBase64?: string },
): Promise<SillyTavernInspectResult> {
  const { data } = await apiClient.post<ApiResponse<SillyTavernInspectResult>>(
    "/sillytavern/inspect",
    input,
    { silentErrorStatuses: IMPORT_ERROR_STATUSES },
  );
  return requireData(data, "无法读取这个文件。");
}

export async function applySillyTavernCard(input: {
  /** 卡片内容：JSON 用 card，PNG 用 pngBase64，二选一。 */
  card?: unknown;
  pngBase64?: string;
  decisions: SillyTavernSegmentDecision[];
  novelId?: string;
  knowledgeTitle?: string;
  styleProfileName?: string;
  characterName?: string;
  characterRole?: string;
}): Promise<SillyTavernCardApplyResult> {
  const { data } = await apiClient.post<ApiResponse<SillyTavernCardApplyResult>>(
    "/sillytavern/cards/apply",
    input,
    { silentErrorStatuses: IMPORT_ERROR_STATUSES },
  );
  return requireData(data, "无法按所选去向导入。");
}

export interface SillyTavernPresetImportResponse {
  profile: StyleProfile;
  longInstructions: boolean;
}

export async function importSillyTavernPreset(input: {
  preset: unknown;
  name?: string;
}): Promise<SillyTavernPresetImportResponse> {
  const { data } = await apiClient.post<ApiResponse<SillyTavernPresetImportResponse>>(
    "/style-profiles/from-sillytavern",
    input,
    { silentErrorStatuses: IMPORT_ERROR_STATUSES },
  );
  return requireData(data, "无法导入这份预设。");
}

export async function importSillyTavernWorldBook(input: {
  book: unknown;
  title?: string;
}): Promise<SillyTavernWorldBookImportResult> {
  const { data } = await apiClient.post<ApiResponse<SillyTavernWorldBookImportResult>>(
    "/knowledge/sillytavern/world-book",
    input,
    { silentErrorStatuses: IMPORT_ERROR_STATUSES },
  );
  return requireData(data, "无法导入这本世界书。");
}
