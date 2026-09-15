import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { root, planPath, receiptPath, read, json, hash, sha, git, command, write, inventory, testEnvironment, fullDatabasePath } from "./phase016-runtime.mjs";
import { caseTags, requirePlan, requireSealRecovery } from "./phase016-evidence.mjs";
import { phase016RecoveryPath, phase016RecoveredCommits } from "../../scripts/phase016-recovery.mjs";

const plan=json(planPath),directory=`docs/evidence/attempts/Phase016/${plan.attemptId}`;
assert(!fs.existsSync(path.join(root,directory,"quality.json"))&&!fs.existsSync(path.join(root,directory,"attempt.json")),"ATTEMPT_ALREADY_EXECUTED");
const sealRecovery = requireSealRecovery(plan, { hashFile: hash, readJson: json, git });
assert.equal(git(["rev-parse","HEAD"]).trim(),sealRecovery?.metadataCommit ?? phase016RecoveredCommits.at(-1),"PREPARE_RECOVERY_HEAD");
if(process.argv.includes("--refresh-sources")){
  const previous=json(`${directory}/source-basis.json`);
  for(const file of [...inventory("tests"),...inventory("src").filter(file=>file.includes(".test.")),
    "package.json","package-lock.json","vitest.config.ts","vitest.setup.ts"])
    assert.equal(hash(file),previous.sourceHashes[file],`DISCOVERY_SOURCE_CHANGED:${file}`);
  requirePlan(plan,{readJson:json,readBytes:read,hashFile:hash,git});
  write(`${directory}/source-basis.json`,{planHash:hash(planPath),sourceHashes:Object.fromEntries(plan.sourcePaths.map(file=>[file,hash(file)])),
    deletedSources:plan.deletedSources},false);
  console.log(JSON.stringify({status:"SOURCE_BASIS_REFRESHED",planHash:hash(planPath)}));
  process.exit(0);
}
const receipt=json(receiptPath);
receipt.recoveryReceipt={path:phase016RecoveryPath,sha256:hash(phase016RecoveryPath)};
write(receiptPath,receipt,false);plan.recoveryReceipt=receipt.recoveryReceipt;
const additions=[receiptPath,"scripts/phase016-recovery.mjs","docs/phase-plans/prepare-phase016.mjs",
  "docs/database.md","docs/api.md","docs/privacy-and-user-data.md","package.json","package-lock.json",
  ...inventory("src"),...inventory("tests"),...inventory("prisma"),...inventory("scripts")];
plan.deletedSources=["src/app/api/session/anonymous/route.ts","src/app/api/travel-records/[id]/commands/route.ts"].map(file=>({
  path:file,commit:phase016RecoveredCommits.at(-1),sha256:sha(git(["show",`${phase016RecoveredCommits.at(-1)}:${file}`],null)),
}));
plan.sourcePaths=[...new Set([...plan.sourcePaths,...additions])].filter(file=>!plan.deletedSources.some(row=>row.path===file)).sort();
plan.testModeReason="Full regression is mandatory because this card changes ownership/authentication, PostgreSQL schema and privileges, shared task/event protocols, Provider streaming, dependencies and verification infrastructure.";
plan.modificationScope=[...new Set([...plan.modificationScope,"package-lock.json","src/server/ai/usage-reservations.ts",
  "tests/admin/","tests/phase008/data-types.ts"])];
plan.supportingChecks=[...new Set([...plan.supportingChecks,"legacy-route-http","recovery-guards","schema-drift"])];
plan.cases.find(row=>row.testCaseId==="Phase016:mutation").command="node docs/phase-plans/verify-phase016.mjs --negative-controls";
plan.commandCorrection={testCaseId:"Phase016:mutation",from:"node docs/phase-plans/verify-phase016.mjs --all",
  to:"node docs/phase-plans/verify-phase016.mjs --negative-controls",
  priorPlanPath:plan.previousAttempts[0].planPath,priorPlanHash:plan.previousAttempts[0].planHash,
  reason:"The failed runner treated its own --all orchestration command as a Vitest filter. Execute the three actual isolated mutations and the complete restored card in a separately recorded child process, without changing any business denominator or threshold."};
plan.expectationCorrection={testCaseId:"Phase016:owner-resume",priorPlanPath:plan.previousAttempts[0].planPath,
  priorPlanHash:plan.previousAttempts[0].planHash,
  originalExpected:json(plan.previousAttempts[0].planPath).cases.find(row=>row.testCaseId==="Phase016:owner-resume").expected,
  currentExpected:plan.cases.find(row=>row.testCaseId==="Phase016:owner-resume").expected,
  reason:"The original failed plan contradicted the frozen Phase016 card by transitioning FINALIZED to MODIFIED. The card explicitly requires command admission only, with record/final-version state unchanged; complete version-transition regression belongs to Phase060. Authorization and zero-write rejection coverage are retained and expanded."};
plan.modificationScope=[...new Set([...plan.modificationScope,"scripts/phase-evidence.mjs"])];
const discoveryPath=`${directory}/frozen-discovery.json`;
const scratch=`.scaffold/phase016/freeze-${plan.attemptId}-${Date.now()}.json`;
const discoveryCommand=command(process.execPath,["node_modules/vitest/vitest.mjs","list",`--json=${scratch}`],{
  env:testEnvironment(path.join(root,fullDatabasePath)),timeoutMs:120000,
});
assert.equal(discoveryCommand.exitCode,0,"DISCOVERY_FAILED");
const discovery=json(scratch);assert(discovery.length>0);
plan.assertionBindings=Object.fromEntries(Object.entries(caseTags).map(([id,tag])=>[id,discovery
  .map(row=>({file:path.relative(root,row.file).replaceAll("\\","/"),fullName:row.name.replaceAll(" > "," ")}))
  .filter(row=>row.file.startsWith("tests/phase016/")&&row.fullName.includes(tag))
  .sort((a,b)=>`${a.file}:${a.fullName}`.localeCompare(`${b.file}:${b.fullName}`,"en"))]));
write(discoveryPath,discovery,false);
plan.discoverySnapshot={path:discoveryPath,sha256:hash(discoveryPath),discovered:discovery.length};
plan.migrationPolicy.migrations=[{path:"prisma/migrations/20260914165140_chat_command_events/migration.sql",
  sha256:hash("prisma/migrations/20260914165140_chat_command_events/migration.sql")}];
plan.executionFreeze={frozenAt:new Date().toISOString(),requirementsPath:`${directory}/requirements-freeze.json`,
  requirementsHash:hash(`${directory}/requirements-freeze.json`),crossAttemptReuse:"disabled"};
requirePlan(plan,{readJson:json,readBytes:read,hashFile:hash,git});
write(planPath,plan,false);write(`${directory}/frozen-plan.json`,read(planPath),false);
write(`${directory}/freeze-command.json`,discoveryCommand,false);write(`${directory}/input-receipt.json`,read(receiptPath),false);
write(`${directory}/source-basis.json`,{planHash:hash(planPath),sourceHashes:Object.fromEntries(plan.sourcePaths.map(file=>[file,hash(file)])),deletedSources:plan.deletedSources},false);
console.log(JSON.stringify({phase:16,attemptId:plan.attemptId,status:"FROZEN",sources:plan.sourcePaths.length,
  discovered:discovery.length,bindings:Object.fromEntries(Object.entries(plan.assertionBindings).map(([key,rows])=>[key,rows.length]))}));
