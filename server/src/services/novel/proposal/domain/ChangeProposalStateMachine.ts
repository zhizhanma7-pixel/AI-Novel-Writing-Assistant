import type { ChangeProposalStatus } from "@ai-novel/shared/types/changeProposal";
import { ChangeProposalError } from "./ChangeProposalError";

const ALLOWED_TRANSITIONS: Readonly<Record<ChangeProposalStatus, readonly ChangeProposalStatus[]>> = {
  draft: ["pending_review", "superseded"],
  pending_review: ["approved", "partially_approved", "rejected", "superseded"],
  approved: ["executed", "superseded"],
  partially_approved: ["executed", "superseded"],
  rejected: ["superseded"],
  executed: [],
  superseded: [],
};

export function assertChangeProposalTransition(
  current: ChangeProposalStatus,
  next: ChangeProposalStatus,
): void {
  if (ALLOWED_TRANSITIONS[current].includes(next)) {
    return;
  }
  throw new ChangeProposalError(
    "invalid_transition",
    `Change proposal cannot transition from ${current} to ${next}.`,
    { current, next },
  );
}

/**
 * 并发守卫：读取之后信封被改过就挡下。
 *
 * `assertExpectedProposalVersion` 挡不住逐项编辑——`version` 是重新生成的
 * 世代号，编辑一项不会动它，但会写 `updatedAt`。信息本来就在，只是没人查。
 *
 * 时间戳按毫秒比较，不比字符串：DTO 里是 ISO 字符串，数据库里是 Date，
 * 两边序列化格式不必一致。
 */
export function assertExpectedProposalUpdatedAt(actual: Date, expected?: string): void {
  if (expected === undefined) {
    return;
  }
  const expectedMs = new Date(expected).getTime();
  if (Number.isNaN(expectedMs)) {
    throw new ChangeProposalError(
      "version_conflict",
      `Expected updatedAt ${expected} is not a valid timestamp.`,
      { expected },
    );
  }
  if (actual.getTime() === expectedMs) {
    return;
  }
  throw new ChangeProposalError(
    "version_conflict",
    "Change proposal was modified after it was read; reload it before reviewing.",
    { actual: actual.toISOString(), expected },
  );
}

export function assertExpectedProposalVersion(actual: number, expected?: number): void {
  if (expected === undefined || actual === expected) {
    return;
  }
  throw new ChangeProposalError(
    "version_conflict",
    `Change proposal version ${actual} does not match expected version ${expected}.`,
    { actual, expected },
  );
}
