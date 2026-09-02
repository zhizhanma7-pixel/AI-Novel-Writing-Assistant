import type { SillyTavernAssetKind } from "@ai-novel/shared/types/sillytavernInspect";
import type { SillyTavernSegmentDestination } from "@ai-novel/shared/types/sillytavernCardSplit";
import type { ApiHttpError } from "@/api/client";

export const ASSET_KIND_COPY: Record<SillyTavernAssetKind, string> = {
  character_card: "角色卡",
  world_book: "世界书",
  preset: "预设",
  unknown: "未识别",
};

/**
 * 去向选项。
 *
 * 说明文字要讲清**代价**，不是讲清概念：作者要判断的是「这段话归错地方会
 * 怎样」，而不是「世界设定的定义是什么」。
 */
export const DESTINATION_OPTIONS: {
  value: SillyTavernSegmentDestination;
  label: string;
  hint: string;
}[] = [
  {
    value: "world",
    label: "世界设定",
    hint: "对这个世界里的所有角色都成立，可以绑给整本书。",
  },
  {
    value: "character",
    label: "这个角色",
    hint: "只属于这个角色。放错的话，本该全局的设定就只在他身上生效。",
  },
  {
    value: "style",
    label: "文风要求",
    hint: "影响怎么写，不影响写什么。",
  },
  {
    value: "skip",
    label: "不导入",
    hint: "这段不带进来。",
  },
];

export const DESTINATION_LABEL: Record<SillyTavernSegmentDestination, string> = {
  world: "世界设定",
  character: "这个角色",
  style: "文风要求",
  skip: "不导入",
};

interface ImportErrorCopy {
  title: string;
  description: string;
}

/**
 * 稳定错误码 → 中文恢复指引。
 *
 * 界面按 code 展示，不直接把服务端的诊断信息塞给用户。
 */
const ERROR_COPY: Record<string, ImportErrorCopy> = {
  unrecognised_file: {
    title: "认不出这个文件",
    description: "请确认它是从 SillyTavern 导出的角色卡、世界书或预设。",
  },
  invalid_card: {
    title: "角色卡读不出来",
    description: "文件结构不像角色卡，换一个文件试试。",
  },
  invalid_book: {
    title: "世界书读不出来",
    description: "文件结构不像世界书，换一个文件试试。",
  },
  invalid_preset: {
    title: "预设读不出来",
    description: "文件结构不像预设，换一个文件试试。",
  },
  not_png: {
    title: "这不是一张 PNG",
    description: "角色卡图片必须是 PNG 格式，JPG 不带卡片数据。",
  },
  broken_png: {
    title: "图片已损坏",
    description: "文件可能在传输中被截断，请重新导出一次。",
  },
  broken_png_metadata: {
    title: "图片里的卡片数据读不出来",
    description: "图片本身没问题，但内嵌的数据已损坏，请重新导出。",
  },
  no_card_metadata: {
    title: "这张图片里没有角色卡",
    description: "它可能只是一张普通图片，或者卡片数据在保存时丢了。",
  },
  empty_world_book: {
    title: "没有可导入的内容",
    description: "这本世界书的条目为空，或者全部处于关闭状态。",
  },
  decision_required: {
    title: "还有内容没决定去向",
    description: "标着「需要你确认」的段落都要选一个去向才能导入。",
  },
  unknown_segment: {
    title: "内容已经变了",
    description: "请重新读取这个文件后再确认一次。",
  },
  novel_required: {
    title: "还没选这个角色属于哪本书",
    description: "有内容要导入为角色，角色必须归属一本书。",
  },
};

export function resolveImportError(error: unknown): ImportErrorCopy {
  const details = (error as ApiHttpError | null)?.details as { error?: unknown } | undefined;
  const code = typeof details?.error === "string" ? details.error : null;
  if (code && ERROR_COPY[code]) {
    return ERROR_COPY[code];
  }
  return {
    title: "导入没有完成",
    description: error instanceof Error && error.message
      ? error.message
      : "请稍后重试，或换一个文件。",
  };
}

/** 从文件名判断走 JSON 还是 PNG 读取。 */
export function isPngFileName(fileName: string): boolean {
  return /\.png$/i.test(fileName.trim());
}
