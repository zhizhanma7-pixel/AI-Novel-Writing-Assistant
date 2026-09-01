import {
  SKILL_PACKAGE_IGNORED_EXTENSIONS,
  type SkillPackageFile,
} from "@ai-novel/shared/types/skillPackage";

/**
 * 写法包在浏览器这一侧的读写（Phase 4 / S4）。
 *
 * 这里全是纯函数：目录选择、下载触发都在组件里，判断逻辑留在这层才测得动。
 */

/** 单个文件的读取上限；写法包是文字资产，超过这个数基本是选错了目录。 */
export const SKILL_PACKAGE_MAX_FILE_BYTES = 512 * 1024;

/**
 * 导出落盘用的单文件格式。
 *
 * **没有引 zip 依赖。** 浏览器里生成 zip 需要额外的库，而写法包的常见形态就是
 * 一个 `SKILL.md`：只有一份文件时直接导出 `SKILL.md`，带附件时才退回这个
 * 打包成一份 JSON 的形态。导入侧同样认这个格式，来回一趟不丢东西。
 */
export const SKILL_PACKAGE_BUNDLE_VERSION = 1;

interface SkillPackageBundle {
  format: "ai-novel-skill-package";
  version: number;
  files: SkillPackageFile[];
}

function isIgnoredPath(path: string): boolean {
  const lower = path.toLowerCase();
  return SKILL_PACKAGE_IGNORED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * 从选中的文件里定位包根。
 *
 * 以层级最浅的 `SKILL.md` 所在目录为准，而不是直接砍掉第一段路径：作者可能选中
 * 的是包的父目录，也可能直接选中包本身，两种都要能认出来。
 */
export function resolveSkillPackageRoot(paths: string[]): string | null {
  let best: string | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  for (const path of paths) {
    const normalized = path.replace(/\\/g, "/");
    const segments = normalized.split("/");
    if (segments[segments.length - 1] !== "SKILL.md") {
      continue;
    }
    const depth = segments.length;
    if (depth < bestDepth) {
      bestDepth = depth;
      best = segments.slice(0, -1).join("/");
    }
  }
  return best;
}

/**
 * 把选中的文件整理成包内相对路径。
 *
 * 包根之外的文件直接丢掉——作者选错父目录时不该把隔壁的东西也塞进来。
 */
export function toSkillPackageFiles(
  entries: Array<{ path: string; content: string }>,
): SkillPackageFile[] {
  const paths = entries.map((entry) => entry.path);
  const root = resolveSkillPackageRoot(paths);
  const prefix = root ? `${root}/` : "";
  const files: SkillPackageFile[] = [];
  for (const entry of entries) {
    const normalized = entry.path.replace(/\\/g, "/");
    if (prefix && !normalized.startsWith(prefix)) {
      continue;
    }
    const relative = prefix ? normalized.slice(prefix.length) : normalized;
    if (!relative) {
      continue;
    }
    // 脚本与二进制照样上报路径，好让服务端如实告知"已忽略、不会执行"；
    // 但内容不读，避免把二进制当文本塞进请求体。
    files.push({ path: relative, content: isIgnoredPath(relative) ? "" : entry.content });
  }
  return files;
}

/** 认出导出时生成的 JSON 包；不是这个格式就返回 null，交给目录路径处理。 */
export function parseSkillPackageBundle(text: string): SkillPackageFile[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const bundle = parsed as Partial<SkillPackageBundle>;
  if (bundle?.format !== "ai-novel-skill-package" || !Array.isArray(bundle.files)) {
    return null;
  }
  return bundle.files
    .filter((file): file is SkillPackageFile => (
      typeof file?.path === "string" && typeof file?.content === "string"
    ))
    .map((file) => ({ path: file.path, content: file.content }));
}

export interface SkillPackageDownload {
  fileName: string;
  mimeType: string;
  content: string;
}

/**
 * 决定导出成什么文件。
 *
 * 只有 `SKILL.md` 时导出 `SKILL.md` 本身，作者拿到的就是能直接读、能直接改的
 * 那份原文；带附件才打成 JSON 包（见 `SKILL_PACKAGE_BUNDLE_VERSION`）。
 */
export function buildSkillPackageDownload(
  files: SkillPackageFile[],
  profileName: string,
): SkillPackageDownload {
  const safeName = profileName.replace(/[\\\/:*?"<>|]/g, "_").trim() || "skill";
  if (files.length === 1 && files[0].path === "SKILL.md") {
    return { fileName: "SKILL.md", mimeType: "text/markdown;charset=utf-8", content: files[0].content };
  }
  const bundle: SkillPackageBundle = {
    format: "ai-novel-skill-package",
    version: SKILL_PACKAGE_BUNDLE_VERSION,
    files,
  };
  return {
    fileName: `${safeName}.skill.json`,
    mimeType: "application/json;charset=utf-8",
    content: JSON.stringify(bundle, null, 2),
  };
}
