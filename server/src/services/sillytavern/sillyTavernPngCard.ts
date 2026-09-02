import { SillyTavernParseError } from "./sillyTavernCardParser";

/**
 * 从 PNG 角色卡里取出内嵌的 JSON。
 *
 * SillyTavern 把卡片数据 base64 后写进 PNG 的 tEXt chunk：V2 用关键字 `chara`，
 * V3 用 `ccv3`。同时存在时以 V3 为准——它是较新的那份。
 *
 * 这里只做**确定性**提取，不解析卡片语义；读出来的 JSON 交给
 * `parseSillyTavernCard`，两层职责不混。
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const V2_KEYWORD = "chara";
const V3_KEYWORD = "ccv3";

export interface ExtractedPngCard {
  json: unknown;
  /** 数据来自哪个关键字，用于告诉用户读到的是哪一版。 */
  keyword: typeof V2_KEYWORD | typeof V3_KEYWORD;
}

interface TextChunk {
  keyword: string;
  text: string;
}

function readTextChunks(buffer: Buffer): TextChunk[] {
  const chunks: TextChunk[] = [];
  // 跳过 8 字节签名，之后是 [4 长度][4 类型][数据][4 CRC] 的序列。
  let offset = PNG_SIGNATURE.length;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    // 长度字段来自文件本身，不能信：越界即视为文件损坏。
    if (dataEnd + 4 > buffer.length) {
      throw new SillyTavernParseError(
        "broken_png",
        "这个 PNG 文件已损坏，无法读取其中的角色卡数据。",
      );
    }

    if (type === "tEXt") {
      const data = buffer.subarray(dataStart, dataEnd);
      const separator = data.indexOf(0);
      if (separator > 0) {
        chunks.push({
          keyword: data.toString("latin1", 0, separator),
          text: data.toString("latin1", separator + 1),
        });
      }
    }

    if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  return chunks;
}

function decodeChunk(text: string, keyword: string): unknown {
  let decoded: string;
  try {
    decoded = Buffer.from(text, "base64").toString("utf8");
  } catch {
    throw new SillyTavernParseError(
      "broken_png_metadata",
      `PNG 里的角色卡数据（${keyword}）无法解码。`,
    );
  }
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    throw new SillyTavernParseError(
      "broken_png_metadata",
      `PNG 里的角色卡数据（${keyword}）不是有效的 JSON。`,
    );
  }
}

export function extractSillyTavernCardFromPng(buffer: Buffer): ExtractedPngCard {
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new SillyTavernParseError("not_png", "这不是一个 PNG 文件。");
  }

  const chunks = readTextChunks(buffer);
  // V3 优先：两份都在时，较新的那份才是完整的。
  const v3 = chunks.find((chunk) => chunk.keyword === V3_KEYWORD);
  if (v3) {
    return { json: decodeChunk(v3.text, V3_KEYWORD), keyword: V3_KEYWORD };
  }
  const v2 = chunks.find((chunk) => chunk.keyword === V2_KEYWORD);
  if (v2) {
    return { json: decodeChunk(v2.text, V2_KEYWORD), keyword: V2_KEYWORD };
  }

  throw new SillyTavernParseError(
    "no_card_metadata",
    "这个 PNG 里没有角色卡数据，可能只是一张普通图片。",
  );
}
