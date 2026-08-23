const test = require("node:test");
const assert = require("node:assert/strict");

const {
  forwardProposalError,
} = require("../dist/modules/novel/proposal/http/novelChangeProposalRoutes.js");
const {
  ChangeProposalError,
} = require("../dist/services/novel/proposal/domain/ChangeProposalError.js");
const { errorHandler } = require("../dist/middleware/errorHandler.js");

test("proposal HTTP errors expose a stable code and keep the domain message as detail", () => {
  let forwarded;
  forwardProposalError(
    new ChangeProposalError("version_conflict", "Change proposal changed during review."),
    (error) => {
      forwarded = error;
    },
  );

  assert.equal(forwarded.statusCode, 409);
  assert.equal(forwarded.message, "version_conflict");
  assert.equal(forwarded.details, "Change proposal changed during review.");

  const response = {
    locals: {},
    statusCode: 0,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  errorHandler(
    forwarded,
    { method: "POST", originalUrl: "/api/novels/novel-1/change-proposals/proposal-1/approve" },
    response,
    () => {},
  );

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body, {
    success: false,
    error: "version_conflict",
    message: "Change proposal changed during review.",
  });
});
