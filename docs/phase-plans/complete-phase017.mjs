import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { auditEvidence, requireArtifactParent } from "./phase017-evidence.mjs";
import { root, plan, planPath, receiptPath, directory, json, read, hash, sha, write, git, npmCli, scan } from "./phase017-runtime.mjs";
const reviewPath=`${directory}/review.json`,qualityPath=`${directory}/quality.json`,gatePath="docs/evidence/Phase017-gate.json";
function audit(withReview=true){assert(!fs.existsSync(path.join(root,directory,"attempt.json")),"FAILED_ATTEMPT_CANNOT_SEAL");return auditEvidence(plan,{root,planPath,receiptPath,directory,readJson:json,readBytes:read,hashFile:hash,git,npmCli},withReview);}
function metadata(){
  const {receipt,reports,quality,review}=audit();
  const artifactCommit=git(["rev-parse","HEAD"]).trim();
  assert.equal(git(["status","--porcelain=v1","--untracked-files=all"]).trim(),"","ARTIFACT_MUST_BE_CLEAN");
  requireArtifactParent({artifactCommit,phaseStartCommit:receipt.phaseStartCommit},git);
  const testedTree=git(["rev-parse",`${artifactCommit}^{tree}`]).trim();
  const inputPaths=[...new Set([planPath,...plan.sourcePaths,...plan.cases.map(item=>item.outputPath),reviewPath,qualityPath,...quality.artifacts.map(row=>row.path)])];
  const inputs=inputPaths.map(file=>{assert.equal(sha(git(["show",`${artifactCommit}:${file}`],null)),hash(file),`ARTIFACT_BLOB:${file}`);return{path:file,sha256:hash(file)};});
  const results=plan.cases.map((item,index)=>({testCaseId:item.testCaseId,command:item.command,exitCode:reports[index].exitCode,numerator:reports[index].numerator,denominator:reports[index].denominator,inputHash:`sha256:${reports[index].inputHash}`,outputHash:`sha256:${hash(item.outputPath)}`,status:"PASS",details:{inputPath:item.inputPath,outputPath:item.outputPath}}));
  const gate={schemaVersion:"agent-gate-v1",phase:17,attemptId:plan.attemptId,status:"PASS",simulation:true,operatorMode:"AGENT_ONLY_AUTOMATED_NEW_BUILD",environment:{isolated:true,syntheticUsers:true,providerMode:"local-adapter",productionTraffic:false},artifactCommit,requiredCaseIds:plan.requiredCaseIds,results,commands:results.map(({command,exitCode})=>({command,exitCode})),inputs,failures:[],generatedAt:new Date().toISOString(),details:{planPath,planHash:hash(planPath),testedTree,reviewerRunId:review.reviewerRunId,reviewReportPath:reviewPath,reviewReportHash:hash(reviewPath),recoveryCommits:[],originalThreshold:6,automatedThreshold:6,waived:false,requestedThrough:17,nextPhaseExecutionAuthorized:false,qualityReportPath:qualityPath,qualityReportHash:hash(qualityPath),manifestHash:receipt.manifestHash,schemaPath:"prisma/schema.prisma",schemaHash:quality.schemaHash,promptVersionHash:quality.promptVersionHash,fixtureHash:quality.fixtureHash,testMode:"full",crossAttemptReuse:"disabled",validationPolicy:receipt.validationPolicy,checkpointMaintenance:receipt.checkpointMaintenance,executionPolicy:receipt.executionPolicy,executionMaintenance:receipt.executionMaintenance,database:quality.database,actualCommandExitCodes:quality.observations.map(({command,exitCode,timedOut})=>({command,exitCode,timedOut})),secretScan:quality.scan,costAccounting:quality.costAccounting,notEvaluated:plan.notApplicable}};
  scan(JSON.stringify(gate));write(gatePath,gate);
  const checkpoint={phase:17,artifactCommit,evidencePath:gatePath,evidenceHash:hash(gatePath)},state=json("docs/roadmap-run.json");
  assert.equal(state.completedThrough,16);assert.equal(state.currentPhase,17);
  state.completedThrough=17;state.currentPhase=18;state.nextPhaseExecutionAuthorized=false;state.lastArtifactCommit=artifactCommit;state.currentLayoutPhaseSeal=checkpoint;state.checkpoints.push(checkpoint);write("docs/roadmap-run.json",state,false);
  const log=read("docs/phase-completion-log.md").toString().trimEnd();assert(!log.includes("| Phase017 |"));
  write("docs/phase-completion-log.md",`${log}\n| Phase017 | AI 输出解析与容错 | 固定需求/概要及8个Prompt Schema、纯parser、实例绑定NluContext、最多两次保守语法修复、上下文限长、owner history；完整路径/hash见Gate | 固定6/6；Vitest ${quality.testCount}/${quality.testCount}；专用${quality.dedicatedCount}断言；5项反向控制及恢复后全卡；真实PostgreSQL17/10份原迁移；lint/typecheck/format/build/layout/证据自检；独立Agent复核；artifactCommit=${artifactCommit}；attemptId=${plan.attemptId} | 未执行正式方案版本、生产流量、真实凭据或Phase018；rawOutput维持数据库强制null，debug只在临时内存 | metadata后双shell seal、clean和GitHub同步；授权止于017 |\n\nPhase017 计划：${planPath}；唯一Gate：${gatePath}；原始报告与独立复核：docs/evidence/attempts/Phase017/。\n`,false);
  console.log(JSON.stringify({status:"METADATA_CANDIDATE_CREATED",artifactCommit,evidenceHash:checkpoint.evidenceHash,nextPhaseExecutionAuthorized:false}));
}
try{if(process.argv.includes("--check")){const value=audit(!process.argv.includes("--without-review"));console.log(JSON.stringify({status:"PASS",reports:value.reports.length,independentReview:!!value.review}));}else if(process.argv.includes("--metadata"))metadata();else throw new Error("Use --check or --metadata");}catch(error){console.error(error.stack);process.exitCode=1;}
