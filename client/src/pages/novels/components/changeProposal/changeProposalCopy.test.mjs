import assert from "node:assert/strict";
import test from "node:test";
import {
  canEditProposedChangeInline,
  CHANGE_PROPOSAL_ERROR_CODES,
  resolveChangeProposalError,
} from "./changeProposalCopy.ts";

test("proposal error copy covers every review recovery code in Chinese", () => {
  for (const code of CHANGE_PROPOSAL_ERROR_CODES) {
    const result = resolveChangeProposalError({ details: { error: code } });
    assert.equal(result.code, code);
    assert.ok(result.title.length > 0);
    assert.ok(result.description.length > 0);
    assert.doesNotMatch(result.title, /change proposal|invalid|unsupported|stale/i);
  }
});

test("inline editing is limited to the approved lightweight field aliases", () => {
  assert.equal(canEditProposedChangeInline({
    proposalType: "relation_state_update",
    path: "Character.A.relationship.B.trust",
    payload: { trustScore: 52 },
  }), true);
  assert.equal(canEditProposedChangeInline({
    proposalType: "event_record",
    path: "Event.summary",
    payload: { summary: "原记录" },
  }), false);
  assert.equal(canEditProposedChangeInline({
    proposalType: "relation_state_update",
    path: "Character.A.relationship.B.stage",
    payload: { stage: "疏远" },
  }), false);
});

test("proposal error copy does not expose unknown backend text", () => {
  const result = resolveChangeProposalError({
    details: { error: "unexpected_internal_message", message: "raw server detail" },
  });
  assert.equal(result.code, "unknown");
  assert.doesNotMatch(`${result.title}${result.description}`, /raw server detail/);
});
