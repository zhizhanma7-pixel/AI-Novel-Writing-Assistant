import assert from "node:assert/strict";
import test from "node:test";
import {
  QUEUED_PROPOSAL_ACTION_TIMEOUT_MS,
  resolveQueuedProposalCommandOutcome,
} from "./queuedProposalAction.ts";

test("queued proposal commands stop immediately for every terminal failure status", () => {
  for (const status of ["failed", "cancelled", "stale"]) {
    assert.equal(resolveQueuedProposalCommandOutcome({ status, elapsedMs: 1_000 }), "failed");
  }
});

test("queued proposal commands stop polling at the timeout boundary", () => {
  assert.equal(resolveQueuedProposalCommandOutcome({
    status: "queued",
    elapsedMs: QUEUED_PROPOSAL_ACTION_TIMEOUT_MS - 1,
  }), "waiting");
  assert.equal(resolveQueuedProposalCommandOutcome({
    status: "running",
    elapsedMs: QUEUED_PROPOSAL_ACTION_TIMEOUT_MS,
  }), "timed_out");
});
