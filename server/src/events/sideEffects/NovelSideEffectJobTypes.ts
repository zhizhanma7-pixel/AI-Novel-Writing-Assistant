export const NOVEL_SIDE_EFFECT_PAYLOAD_VERSION = 1;

export const NOVEL_SIDE_EFFECT_JOB_TYPES = [
  "character.volumeRebuild",
  "character.postDraftEnrichment",
  "novel.pipelineSnapshot",
  "payoff.bookContractSync",
] as const;

export type NovelSideEffectJobType = (typeof NOVEL_SIDE_EFFECT_JOB_TYPES)[number];

export type NovelSideEffectJobStatus = "pending" | "running" | "succeeded" | "failed" | "dead";

export interface CharacterVolumeRebuildPayload {
  novelId: string;
  /**
   * 两种来源标注优先级相同，区别只在来源标注上：卷结构变更投影用
   * `volume_projection`；拆章后的重投影（含它失败后的队列兜底）用
   * `rebuild_projection`，兜底不应该把来源改写成另一种。
   */
  sourceType: "volume_projection" | "rebuild_projection";
}

export interface CharacterPostDraftEnrichmentPayload {
  novelId: string;
}

export interface PipelineSnapshotPayload {
  novelId: string;
  jobId: string;
  label: string;
}

export interface BookContractPayoffSyncPayload {
  novelId: string;
}

export type NovelSideEffectPayload =
  | CharacterVolumeRebuildPayload
  | CharacterPostDraftEnrichmentPayload
  | PipelineSnapshotPayload
  | BookContractPayoffSyncPayload;

export interface EnqueueNovelSideEffectJobInput {
  novelId?: string | null;
  jobType: NovelSideEffectJobType;
  idempotencyKey: string;
  payload: NovelSideEffectPayload;
  payloadVersion?: number;
  runAfter?: Date;
  maxAttempts?: number;
}

export interface NovelSideEffectLeaseOptions {
  workerId: string;
  leaseMs: number;
  now?: Date;
}

