const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const {
  BookAnalysisBudgetGuard,
} = require("../dist/services/bookAnalysis/caching/bookAnalysis.budget.js");

/**
 * Token accounting for a book analysis run.
 *
 * Sections are processed by a concurrent worker pool, so every caller of
 * onSectionFinished can be in flight at the same time. Accumulating with a
 * read-then-write loses updates under that concurrency, and undercounted
 * tokens let a run continue past the cap it was given.
 */

/** Minimal in-memory stand-in for the one row this guard touches. */
function withAnalysisRow(row, run) {
  const original = {
    findUnique: prisma.bookAnalysis.findUnique,
    update: prisma.bookAnalysis.update,
    updateMany: prisma.bookAnalysis.updateMany,
  };
  const state = { ...row };
  const select = () => ({ budgetTokens: state.budgetTokens, usedTokens: state.usedTokens });

  prisma.bookAnalysis.findUnique = async () => select();
  prisma.bookAnalysis.updateMany = async ({ where, data }) => {
    // Mirrors the NULL-normalising guard: only applies while the row is still NULL.
    if (where.usedTokens === null && state.usedTokens === null) {
      state.usedTokens = data.usedTokens;
      return { count: 1 };
    }
    return { count: 0 };
  };
  prisma.bookAnalysis.update = async ({ data }) => {
    if (data.usedTokens && typeof data.usedTokens.increment === "number") {
      // The database applies increments atomically; a read-then-write in the
      // service would not, which is exactly what this stands in to detect.
      state.usedTokens = (state.usedTokens ?? 0) + data.usedTokens.increment;
    } else if (typeof data.usedTokens === "number") {
      state.usedTokens = data.usedTokens;
    }
    return select();
  };

  return run(state).finally(() => {
    prisma.bookAnalysis.findUnique = original.findUnique;
    prisma.bookAnalysis.update = original.update;
    prisma.bookAnalysis.updateMany = original.updateMany;
  });
}

const usage = (totalTokens) => ({ totalTokens });

test("concurrent sections do not lose token counts", async () => {
  // Ten sections finishing at once, 100 tokens each. A read-then-write
  // accumulation interleaves the reads and settles far below 1000.
  await withAnalysisRow({ budgetTokens: null, usedTokens: 0 }, async (state) => {
    const guard = new BookAnalysisBudgetGuard("analysis-1");
    await Promise.all(
      Array.from({ length: 10 }, () => guard.onSectionFinished(usage(100))),
    );

    assert.equal(state.usedTokens, 1000, "token counts were lost to interleaved updates");
  });
});

test("a legacy NULL usedTokens row still accumulates", async () => {
  // Prisma's increment on NULL yields NULL, so rows predating the column
  // default have to be normalised before the first increment.
  await withAnalysisRow({ budgetTokens: null, usedTokens: null }, async (state) => {
    const guard = new BookAnalysisBudgetGuard("analysis-1");
    await guard.onSectionFinished(usage(120));

    assert.equal(state.usedTokens, 120);
  });
});

test("exceeding the budget is reported", async () => {
  await withAnalysisRow({ budgetTokens: 150, usedTokens: 0 }, async () => {
    const guard = new BookAnalysisBudgetGuard("analysis-1");
    await guard.onSectionFinished(usage(100));

    await assert.rejects(() => guard.onSectionFinished(usage(100)));
  });
});

test("a zero-token section does not write", async () => {
  // Sections can finish without usage data; that must not touch the row.
  await withAnalysisRow({ budgetTokens: 150, usedTokens: 40 }, async (state) => {
    const guard = new BookAnalysisBudgetGuard("analysis-1");
    await guard.onSectionFinished(usage(0));
    await guard.onSectionFinished(null);

    assert.equal(state.usedTokens, 40);
  });
});
