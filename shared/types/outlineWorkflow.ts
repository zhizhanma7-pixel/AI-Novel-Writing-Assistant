import { z } from "zod";

export const outlineFidelitySchema = z.enum(["strict", "balanced", "director"]);

export const normalizedOutlineEventSchema = z.object({
  id: z.string().trim().min(1).max(80),
  sourceText: z.string().trim().min(1).max(1000),
  sourceOrder: z.number().int().nonnegative(),
  inferredChapterOrder: z.number().int().positive().nullable().default(null),
  title: z.string().trim().min(1).max(160),
  characters: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  causes: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
  outcomes: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
  confidence: z.number().min(0).max(1),
});

export const normalizedOutlineDraftSchema = z.object({
  title: z.string().trim().min(1).max(200),
  sourceSummary: z.string().trim().min(1).max(2000),
  coreEvents: z.array(normalizedOutlineEventSchema).min(1).max(200),
});

export const outlinePreservationObligationSchema = z.object({
  id: z.string().trim().min(1).max(100),
  eventId: z.string().trim().min(1).max(80),
  kind: z.enum(["event", "order", "ending", "relationship", "reveal"]),
  description: z.string().trim().min(1).max(1000),
  requiredOrder: z.number().int().nonnegative(),
});

export const proposedOutlineChapterSchema = z.object({
  order: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(2000),
  purpose: z.string().trim().min(1).max(1000),
  sourceEventIds: z.array(z.string().trim().min(1).max(80)).min(1).max(30),
  beats: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
});

export const outlineDependencyImpactSchema = z.object({
  chapterOrder: z.number().int().positive().nullable(),
  summary: z.string().trim().min(1).max(1000),
  severity: z.enum(["minor", "major"]),
  hasExistingContent: z.boolean().default(false),
});

export const faithfulOutlineResultSchema = z.object({
  polishedSummary: z.string().trim().min(1).max(3000),
  preservationObligations: z.array(outlinePreservationObligationSchema).min(1).max(300),
  preservedEventIds: z.array(z.string().trim().min(1).max(80)).min(1).max(200),
  chapters: z.array(proposedOutlineChapterSchema).min(1).max(200),
  dependencyImpacts: z.array(outlineDependencyImpactSchema).max(200).default([]),
  warnings: z.array(z.string().trim().min(1).max(1000)).max(50).default([]),
});

export const outlineImportRequestSchema = z.object({
  sourceText: z.string().trim().min(10).max(100_000),
  fidelity: outlineFidelitySchema.default("strict"),
  taskId: z.string().trim().min(1).nullable().optional(),
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

export const outlinePlanUpdatePayloadSchema = z.object({
  fidelity: outlineFidelitySchema,
  sourceText: z.string().trim().min(1),
  polishedSummary: z.string().trim().min(1),
  preservationObligations: z.array(outlinePreservationObligationSchema).min(1),
  chapters: z.array(proposedOutlineChapterSchema).min(1),
  dependencyImpacts: z.array(outlineDependencyImpactSchema).default([]),
});

export type OutlineFidelity = z.infer<typeof outlineFidelitySchema>;
export type NormalizedOutlineEvent = z.infer<typeof normalizedOutlineEventSchema>;
export type NormalizedOutlineDraft = z.infer<typeof normalizedOutlineDraftSchema>;
export type FaithfulOutlineResult = z.infer<typeof faithfulOutlineResultSchema>;
export type OutlineImportRequest = z.infer<typeof outlineImportRequestSchema>;
export type OutlinePlanUpdatePayload = z.infer<typeof outlinePlanUpdatePayloadSchema>;
