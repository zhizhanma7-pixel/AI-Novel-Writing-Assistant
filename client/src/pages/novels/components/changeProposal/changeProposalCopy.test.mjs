import assert from "node:assert/strict";
import test from "node:test";
import {
  canEditProposedChangeInline,
  CHANGE_PROPOSAL_ERROR_CODES,
  parseProposedChangeInlineValue,
  resolveProposedChangeInlineValue,
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

test("inline editing follows the shared payload mapping and terminal-key fallback", () => {
  assert.equal(canEditProposedChangeInline({
    proposalType: "relation_state_update",
    path: "Character.A.relationship.B.trust",
    payload: { trustScore: 52 },
  }), true);
  assert.equal(canEditProposedChangeInline({
    proposalType: "event_record",
    path: "Event.summary",
    payload: { summary: "原记录" },
  }), true);
  assert.equal(canEditProposedChangeInline({
    proposalType: "relation_state_update",
    path: "Character.A.relationship.B.trustScore",
    payload: { trustScore: 55 },
  }), true);
  assert.equal(canEditProposedChangeInline({
    proposalType: "relation_state_update",
    path: "Character.A.relationship.B.metadata",
    payload: { metadata: { source: "chapter" } },
  }), false);
});

test("inline editing reads and parses the mapped payload value even when after is absent", () => {
  const inlineField = resolveProposedChangeInlineValue({
    proposalType: "relation_state_update",
    path: "Character.A.relationship.B.trust",
    after: undefined,
    payload: { trustScore: 55 },
    userEditedPayload: null,
  });
  assert.deepEqual(inlineField, { payloadKey: "trustScore", value: 55 });
  assert.equal(parseProposedChangeInlineValue("57", inlineField.value), 57);
});

test("proposal error copy does not expose unknown backend text", () => {
  const result = resolveChangeProposalError({
    details: { error: "unexpected_internal_message", message: "raw server detail" },
  });
  assert.equal(result.code, "unknown");
  assert.doesNotMatch(`${result.title}${result.description}`, /raw server detail/);
});
