import type { SillyTavernBook, SillyTavernBookEntry } from "@ai-novel/shared/types/sillytavernCard";
import type {
  SillyTavernWorldBookImportResult,
  SillyTavernWorldBookPreview,
} from "@ai-novel/shared/types/sillytavernWorldBookImport";
import { prisma } from "../../db/prisma";
import { KnowledgeService } from "../knowledge/KnowledgeService";
import {
  collectUnknownBookEntryFields,
  parseSillyTavernBook,
  SillyTavernParseError,
} from "./sillyTavernCardParser";

/**
 * 把 SillyTavern 世界书导入既有知识库。
 *
 * **Semantic Mode**：条目变成知识文档正文，交给既有 RAG 检索。
 * 不实现 ST 的关键词注入引擎——两套检索机制并存会让「为什么这条没被检索到」
 * 永远说不清。原文的 `keys` 作为检索提示写进正文，让语义检索能命中它们。
 *
 * **不自动绑定。** 知识库的绑定接口是替换语义（先清空该目标的全部绑定再写入），
 * 拿它来「追加一条」会把用户已有的绑定清掉。绑定交给既有界面。
 */

function entryTitle(entry: SillyTavernBookEntry, index: number): string {
  const name = entry.name?.trim();
  if (name) {
    return name;
  }
  const firstKey = entry.keys.find((key) => key.trim());
  return firstKey?.trim() || `条目 ${index + 1}`;
}

function renderEntry(entry: SillyTavernBookEntry, index: number): string {
  const lines: string[] = [`## ${entryTitle(entry, index)}`, ""];

  const keys = [...entry.keys, ...entry.secondary_keys]
    .map((key) => key.trim())
    .filter(Boolean);
  if (keys.length > 0) {
    // 关键词进正文而不是另建索引：既有的语义检索就能命中它们。
    lines.push(`关键词：${keys.join("、")}`);
  }
  if (entry.constant) {
    lines.push("（原文标记为常驻条目）");
  }
  if (entry.comment?.trim()) {
    lines.push(`备注：${entry.comment.trim()}`);
  }
  if (keys.length > 0 || entry.constant || entry.comment?.trim()) {
    lines.push("");
  }

  lines.push(entry.content.trim());
  return lines.join("\n");
}

function buildPreview(
  book: SillyTavernBook,
  warnings: SillyTavernWorldBookPreview["warnings"],
  unknownFields: string[] = [],
): SillyTavernWorldBookPreview {
  const included = book.entries.filter((entry) => entry.enabled && entry.content.trim());
  const excluded = book.entries.filter((entry) => !entry.enabled);

  const sections: string[] = [];
  if (book.name?.trim()) {
    sections.push(`# ${book.name.trim()}`);
  }
  if (book.description?.trim()) {
    sections.push(book.description.trim());
  }
  // 顺序照 insertion_order，这是作者在原工具里排出来的。
  const ordered = [...included].sort((left, right) => left.insertion_order - right.insertion_order);
  for (const [index, entry] of ordered.entries()) {
    sections.push(renderEntry(entry, index));
  }

  if (unknownFields.length > 0) {
    // 未识别的内容也要能被找回来。知识文档没有存放原始文件的位置，
    // 但把这些字段原样附在末尾、明确标注，比让它们永久消失强——
    // 只在确实存在时才附加，绝大多数文件不会多出这一段。
    const unknownPayload = book.entries
      .map((entry, index) => {
        const extras = Object.fromEntries(
          Object.entries(entry).filter(([key]) => unknownFields.includes(key)),
        );
        return Object.keys(extras).length > 0
          ? `- 第 ${index + 1} 条：${JSON.stringify(extras)}`
          : null;
      })
      .filter((line): line is string => line !== null);
    sections.push([
      "## 原始文件中未被识别的内容",
      "",
      "以下内容本项目当前不解读，原样保留以便日后回溯：",
      "",
      ...(unknownPayload.length > 0 ? unknownPayload : [`- 字段：${unknownFields.join("、")}`]),
    ].join("\n"));
  }

  const content = sections.join("\n\n").trim();
  return {
    bookName: book.name?.trim() || null,
    entryCount: book.entries.length,
    includedCount: included.length,
    excludedCount: excluded.length,
    constantCount: included.filter((entry) => entry.constant).length,
    content,
    charCount: content.length,
    unknownFields,
    warnings,
  };
}

export class SillyTavernWorldBookImportService {
  constructor(private readonly knowledgeService = new KnowledgeService()) {}

  /** 纯解析与渲染，不写任何库。 */
  preview(rawJson: unknown): SillyTavernWorldBookPreview {
    const parsed = parseSillyTavernBook(rawJson);
    return buildPreview(
      parsed.book,
      parsed.warnings,
      // 顶层未知字段与条目内部的未知字段都要算上。
      [...new Set([
        ...Object.keys(parsed.rawImportedMetadata),
        ...collectUnknownBookEntryFields(parsed.book),
      ])].sort(),
    );
  }

  /** 从一张角色卡里取出内嵌世界书的预览；卡片没带世界书时返回 null。 */
  previewFromCardBook(book: SillyTavernBook | null): SillyTavernWorldBookPreview | null {
    return book ? buildPreview(book, [], collectUnknownBookEntryFields(book)) : null;
  }

  async importBook(input: {
    rawJson: unknown;
    title?: string;
  }): Promise<SillyTavernWorldBookImportResult> {
    const preview = this.preview(input.rawJson);
    // 用「有多少条会进检索」判断，而不是正文是否为空：书名和描述本身就能
    // 撑起正文，那样全部条目被禁用时会建出一份只有标题的空文档。
    if (preview.includedCount === 0) {
      throw new SillyTavernParseError(
        "empty_world_book",
        "这本世界书没有可导入的内容（条目为空或全部被禁用）。",
      );
    }

    const title = input.title?.trim() || preview.bookName || "SillyTavern 世界书";
    const stored = await this.importRenderedContent({ title, content: preview.content });
    return { ...stored, preview };
  }

  /**
   * 把已经渲染好的世界设定正文入库。
   *
   * 抽出来是给角色卡分流复用的：那条路径的世界设定来自卡片段落而不是世界书文件，
   * 但「重复导入不该产生新版本」这条规则两边必须一致，不能各写一份。
   */
  async importRenderedContent(input: { title: string; content: string }): Promise<{
    documentId: string;
    title: string;
    versionNumber: number;
    unchanged: boolean;
  }> {
    const title = input.title.trim();
    // 内容没变就不该产生新版本，也不该重新排队索引。
    const existing = await prisma.knowledgeDocument.findFirst({
      where: { title, kind: "user_upload", status: { not: "archived" } },
      orderBy: { updatedAt: "desc" },
      include: { activeVersion: true },
    });
    if (existing?.activeVersion && existing.activeVersion.content === input.content) {
      return {
        documentId: existing.id,
        title: existing.title,
        versionNumber: existing.activeVersionNumber,
        unchanged: true,
      };
    }

    const document = await this.knowledgeService.createDocument({
      title,
      fileName: `${title}.sillytavern.md`,
      content: input.content,
      kind: "user_upload",
    });

    return {
      documentId: document.id,
      title: document.title,
      versionNumber: document.activeVersionNumber,
      unchanged: false,
    };
  }
}
