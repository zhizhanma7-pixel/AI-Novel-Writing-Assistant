const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const {
  SillyTavernCardImportService,
} = require("../dist/services/sillytavern/SillyTavernCardImportService.js");

const CARD = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: { name: "沈砚", personality: "沉默，护短" },
};

test("Phase 6 — an existing character blocks duplicate import before any destination writes", async () => {
  const originals = {
    characterFindMany: prisma.character.findMany,
    proposalFindMany: prisma.stateChangeProposal.findMany,
  };
  let writeCount = 0;
  prisma.character.findMany = async () => [{ name: " 沈砚 " }];
  prisma.stateChangeProposal.findMany = async () => [];
  const service = new SillyTavernCardImportService(
    {
      previewFromCardBook: () => null,
      importRenderedContent: async () => { writeCount += 1; },
    },
    { createManualProfile: async () => { writeCount += 1; } },
    { createProposal: async () => { writeCount += 1; } },
  );
  try {
    await assert.rejects(
      () => service.apply({ rawJson: CARD, decisions: [], novelId: "novel-1" }),
      (error) => error.code === "duplicate_character" && /已有角色/.test(error.message),
    );
    assert.equal(writeCount, 0, "重复检查必须发生在世界、写法和提案写入之前");
  } finally {
    prisma.character.findMany = originals.characterFindMany;
    prisma.stateChangeProposal.findMany = originals.proposalFindMany;
  }
});

test("Phase 6 — a pending character import proposal blocks a second proposal", async () => {
  const originals = {
    characterFindMany: prisma.character.findMany,
    proposalFindMany: prisma.stateChangeProposal.findMany,
  };
  prisma.character.findMany = async () => [];
  prisma.stateChangeProposal.findMany = async () => [{ payloadJson: JSON.stringify({ name: "沈砚" }) }];
  const service = new SillyTavernCardImportService();
  try {
    await assert.rejects(
      () => service.apply({ rawJson: CARD, decisions: [], novelId: "novel-1" }),
      (error) => error.code === "duplicate_character" && /待审导入提案/.test(error.message),
    );
  } finally {
    prisma.character.findMany = originals.characterFindMany;
    prisma.stateChangeProposal.findMany = originals.proposalFindMany;
  }
});
