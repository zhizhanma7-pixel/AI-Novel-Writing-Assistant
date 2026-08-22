CREATE TABLE "ChangeProposal" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "novelId" TEXT NOT NULL,
  "chapterId" TEXT,
  "taskId" TEXT,
  "proposalType" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "supersedesId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "outlineFidelity" TEXT,
  "summary" TEXT NOT NULL,
  "reasoningSummary" TEXT,
  "sourceRefsJson" TEXT,
  "warningsJson" TEXT,
  "expectedStateJson" TEXT,
  "approvedAt" DATETIME,
  "executedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ChangeProposal_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ChangeProposal_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ChangeProposal_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "NovelWorkflowTask"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ChangeProposal_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "ChangeProposal"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

ALTER TABLE "StateChangeProposal" ADD COLUMN "changeProposalId" TEXT REFERENCES "ChangeProposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StateChangeProposal" ADD COLUMN "changePath" TEXT;
ALTER TABLE "StateChangeProposal" ADD COLUMN "operation" TEXT;
ALTER TABLE "StateChangeProposal" ADD COLUMN "category" TEXT;
ALTER TABLE "StateChangeProposal" ADD COLUMN "severity" TEXT;
ALTER TABLE "StateChangeProposal" ADD COLUMN "beforeJson" TEXT;
ALTER TABLE "StateChangeProposal" ADD COLUMN "afterJson" TEXT;
ALTER TABLE "StateChangeProposal" ADD COLUMN "userEditedPayloadJson" TEXT;
ALTER TABLE "StateChangeProposal" ADD COLUMN "reviewDecision" TEXT;
ALTER TABLE "StateChangeProposal" ADD COLUMN "sourceRefsJson" TEXT;

CREATE INDEX "ChangeProposal_novelId_status_updatedAt_idx"
  ON "ChangeProposal"("novelId", "status", "updatedAt");
CREATE INDEX "ChangeProposal_taskId_status_idx"
  ON "ChangeProposal"("taskId", "status");
CREATE INDEX "ChangeProposal_chapterId_createdAt_idx"
  ON "ChangeProposal"("chapterId", "createdAt");
CREATE INDEX "ChangeProposal_supersedesId_idx"
  ON "ChangeProposal"("supersedesId");
CREATE INDEX "StateChangeProposal_changeProposalId_status_idx"
  ON "StateChangeProposal"("changeProposalId", "status");
