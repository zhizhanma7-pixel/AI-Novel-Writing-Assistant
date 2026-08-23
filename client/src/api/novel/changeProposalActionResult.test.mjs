import assert from "node:assert/strict";
import test from "node:test";
import { toChangeProposalActionResult } from "./changeProposalActionResult.ts";

test("proposal action result keeps synchronous proposal responses distinct", () => {
  const proposal = { id: "proposal-1", status: "approved" };
  const result = toChangeProposalActionResult(200, {
    success: true,
    data: proposal,
    message: "提案获得批准。",
  });

  assert.equal(result.kind, "proposal");
  assert.equal(result.status, 200);
  assert.equal(result.proposal, proposal);
  assert.equal("command" in result, false);
});

test("proposal action result keeps queued director commands distinct", () => {
  const command = {
    commandId: "command-1",
    taskId: "task-1",
    commandType: "review_proposal",
    status: "queued",
  };
  const result = toChangeProposalActionResult(202, {
    success: true,
    data: command,
    message: "导演提案审批命令已入队。",
  });

  assert.equal(result.kind, "queued");
  assert.equal(result.status, 202);
  assert.equal(result.command, command);
  assert.equal("proposal" in result, false);
});

test("proposal action result rejects unexpected success statuses", () => {
  assert.throws(
    () => toChangeProposalActionResult(204, { success: true }),
    /不支持的提案响应状态/,
  );
});
