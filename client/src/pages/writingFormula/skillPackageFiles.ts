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
