import type { SkillPackageFile } from "@ai-novel/shared/types/skillPackage";

/**
 * 写法包的 ZIP 读写（Phase 4 / M2）。
 *
 * **没有引第三方库。** 写入用 stored 模式（不压缩），ZIP 的 stored 格式就是
 * 头部 + 原字节的拼装，压缩那部分本来就用不上——写法包是文字，体积以 KB 计，
 * 为省这点体积去装一个压缩库不划算。读取时如果碰到别人用压缩模式打的包，
 * 交给浏览器自带的 DecompressionStream 处理。
 *
 * 之所以要是 ZIP 而不是本项目自有的格式：解开就是一个同构的目录，能直接交给
 * Codex / Claude 那类按目录消费 Skill 的工具。自有格式只有本项目认得。
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** 文件名按 UTF-8 解读的标志位（bit 11）。中文路径少了它会乱码。 */
const UTF8_FLAG = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 包根目录名，解开后就是一个同构的写法包目录。 */
export function toZipRootName(profileName: string): string {
  const safe = profileName.replace(/[\\/:*?"<>|]/g, "_").trim();
  return safe || "skill";
}

/**
 * 把包内文件打成 ZIP。
 *
 * 每个条目都放在 `rootName/` 下：解开得到的是一个目录，而不是一堆散落在
 * 下载文件夹里的 `SKILL.md`。
 */
export function buildSkillPackageZip(files: SkillPackageFile[], rootName: string): Uint8Array {
  const encoder = new TextEncoder();
  const root = toZipRootName(rootName);
  const entries = files.map((file) => {
    const name = encoder.encode(`${root}/${file.path}`);
    const data = encoder.encode(file.content);
    return { name, data, crc: crc32(data), offset: 0 };
  });

  const localSize = entries.reduce((sum, entry) => sum + 30 + entry.name.length + entry.data.length, 0);
  const centralSize = entries.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  let cursor = 0;

  for (const entry of entries) {
    entry.offset = cursor;
    view.setUint32(cursor, LOCAL_SIG, true);
    view.setUint16(cursor + 4, 20, true);
    view.setUint16(cursor + 6, UTF8_FLAG, true);
    view.setUint16(cursor + 8, METHOD_STORED, true);
    // 修改时间/日期留 0：包的内容才是身份，时间戳只会让同一个包每次导出都不一样。
    view.setUint16(cursor + 10, 0, true);
    view.setUint16(cursor + 12, 0, true);
    view.setUint32(cursor + 14, entry.crc, true);
    view.setUint32(cursor + 18, entry.data.length, true);
    view.setUint32(cursor + 22, entry.data.length, true);
    view.setUint16(cursor + 26, entry.name.length, true);
    view.setUint16(cursor + 28, 0, true);
    cursor += 30;
    output.set(entry.name, cursor);
    cursor += entry.name.length;
    output.set(entry.data, cursor);
    cursor += entry.data.length;
  }

  const centralStart = cursor;
  for (const entry of entries) {
    view.setUint32(cursor, CENTRAL_SIG, true);
    view.setUint16(cursor + 4, 20, true);
    view.setUint16(cursor + 6, 20, true);
    view.setUint16(cursor + 8, UTF8_FLAG, true);
    view.setUint16(cursor + 10, METHOD_STORED, true);
    view.setUint16(cursor + 12, 0, true);
    view.setUint16(cursor + 14, 0, true);
    view.setUint32(cursor + 16, entry.crc, true);
    view.setUint32(cursor + 20, entry.data.length, true);
    view.setUint32(cursor + 24, entry.data.length, true);
    view.setUint16(cursor + 28, entry.name.length, true);
    view.setUint16(cursor + 30, 0, true);
    view.setUint16(cursor + 32, 0, true);
    view.setUint16(cursor + 34, 0, true);
    view.setUint16(cursor + 36, 0, true);
    view.setUint32(cursor + 38, 0, true);
    view.setUint32(cursor + 42, entry.offset, true);
    cursor += 46;
    output.set(entry.name, cursor);
    cursor += entry.name.length;
  }

  view.setUint32(cursor, EOCD_SIG, true);
  view.setUint16(cursor + 4, 0, true);
  view.setUint16(cursor + 6, 0, true);
  view.setUint16(cursor + 8, entries.length, true);
  view.setUint16(cursor + 10, entries.length, true);
  view.setUint32(cursor + 12, centralSize, true);
  view.setUint32(cursor + 16, centralStart, true);
  view.setUint16(cursor + 20, 0, true);

  return output;
}

function findEndOfCentralDirectory(view: DataView): number | null {
  // EOCD 在文件末尾，长度不定（注释可变），只能从后往前找签名。
  const minOffset = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIG) {
      return offset;
    }
  }
  return null;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  // 浏览器自带；本项目自己打的包是 stored，走不到这里，只有别人用压缩模式
  // 打的包才需要。运行环境不提供时如实抛错，不假装读成功。
  const Decompression = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (!Decompression) {
    throw new Error("这个写法包是压缩过的，当前环境读不了；请解开成目录后再导入。");
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new Decompression("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 读出 ZIP 里的写法包文件，路径已去掉包根目录。
 *
 * 不是 ZIP 就返回 null，交给目录/单文件那条路径处理。
 */
export async function readSkillPackageZip(bytes: Uint8Array): Promise<SkillPackageFile[] | null> {
  if (bytes.length < 22) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd === null) {
    return null;
  }

  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const files: SkillPackageFile[] = [];

  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > view.byteLength || view.getUint32(cursor, true) !== CENTRAL_SIG) {
      return null;
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    // 目录条目没有内容，跳过。
    if (name.endsWith("/")) {
      continue;
    }
    if (view.getUint32(localOffset, true) !== LOCAL_SIG) {
      return null;
    }
    // 本地头里的名字长度和扩展长度可能与中央目录不同，数据起点只能按本地头算。
    const dataStart = localOffset + 30
      + view.getUint16(localOffset + 26, true)
      + view.getUint16(localOffset + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    let content: string;
    if (method === METHOD_STORED) {
      content = decoder.decode(raw);
    } else if (method === METHOD_DEFLATE) {
      content = decoder.decode(await inflate(raw));
    } else {
      throw new Error(`写法包里的「${name}」用了读不了的压缩方式，请解开成目录后再导入。`);
    }
    files.push({ path: name, content });
  }

  return files;
}

export interface SkillPackageDownload {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

/**
 * 决定导出成什么文件。
 *
 * 一律导出 ZIP，解开就是一个同构的写法包目录——这是计划里要的可携带形态，
 * 也能直接交给按目录消费 Skill 的工具。
 *
 * 早先曾按「只有 SKILL.md 就直接导出 SKILL.md」处理，那会让每条写法都下载成
 * 同一个文件名，在下载文件夹里互相覆盖。
 */
export function buildSkillPackageDownload(
  files: SkillPackageFile[],
  profileName: string,
): SkillPackageDownload {
  const rootName = toZipRootName(profileName);
  return {
    fileName: `${rootName}.zip`,
    mimeType: "application/zip",
    bytes: buildSkillPackageZip(files, rootName),
  };
}
