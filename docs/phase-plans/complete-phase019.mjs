import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as runtime from './phase018-runtime.mjs';
import {audit,planPath,receiptPath,startCommit} from './phase019-evidence.mjs';
const {json,read,hash,sha,write,git,root,scan}=runtime;
const plan=json(planPath),directory=`docs/evidence/attempts/Phase019/${plan.attemptId}`;
assert(!fs.existsSync(path.join(root,directory,'attempt.json')),'FAILED_ATTEMPT');
const {receipt,quality,reports,review}=audit(plan,{...runtime,directory},!process.argv.includes('--without-review'));
if(process.argv.includes('--check')) console.log(JSON.stringify({status:'PASS',reports:reports.length,review:!!review}));
else if(process.argv.includes('--metadata')){
 assert(review);assert.equal(git(['status','--porcelain=v1','--untracked-files=all']).trim(),'','ARTIFACT_DIRTY');
 const artifactCommit=git(['rev-parse','HEAD']).trim();assert.equal(git(['log','-1','--format=%s']).trim(),'phase(019): artifact','ARTIFACT_SUBJECT');
 const recoveryCommits=git(['rev-list','--reverse',startCommit+'..'+artifactCommit+'^']).trim().split(/\r?\n/).filter(Boolean);
 assert(recoveryCommits.includes(receipt.recovery.preexistingCommit));
 for(const commit of recoveryCommits){const parents=git(['rev-list','--parents','-n','1',commit]).trim().split(' ');assert.equal(parents.length,2,'RECOVERY_MERGE');assert.match(git(['log','-1','--format=%s',commit]).trim(),/^phase\(019\): (recovery|artifact|metadata)$/);}
 const evidenceFiles=git(['ls-files','--',directory,'docs/evidence/attempts/Phase019/setup']).trim().split(/\r?\n/).filter(Boolean);
 const inputs=[...new Set([planPath,...plan.sourcePaths,...evidenceFiles])].sort().map(file=>{assert.equal(sha(git(['show',artifactCommit+':'+file],null)),hash(file),'ARTIFACT_BLOB:'+file);return {path:file,sha256:hash(file)};});
 const results=plan.cases.map((item,index)=>({testCaseId:item.testCaseId,command:item.command,exitCode:0,numerator:item.denominator,denominator:item.denominator,inputHash:'sha256:'+reports[index].inputHash,outputHash:'sha256:'+hash(item.outputPath),status:'PASS',details:{inputPath:item.inputPath,outputPath:item.outputPath}}));
 const gatePath='docs/evidence/Phase019-gate.json';
 const gate={schemaVersion:'agent-gate-v1',phase:19,attemptId:plan.attemptId,status:'PASS',simulation:true,operatorMode:'AGENT_ONLY_AUTOMATED_NEW_BUILD',environment:{isolated:true,syntheticUsers:true,providerMode:'mock',productionTraffic:false},artifactCommit,requiredCaseIds:plan.requiredCaseIds,results,commands:results.map(({command,exitCode})=>({command,exitCode})),inputs,failures:[],generatedAt:new Date().toISOString(),details:{planPath,planHash:hash(planPath),testedTree:git(['rev-parse',artifactCommit+'^{tree}']).trim(),reviewerRunId:review.reviewerRunId,reviewReportPath:directory+'/review.json',reviewReportHash:hash(directory+'/review.json'),recoveryCommits,originalThreshold:8,automatedThreshold:8,waived:false,requestedThrough:19,nextPhaseExecutionAuthorized:false,qualityReportPath:directory+'/quality.json',qualityReportHash:hash(directory+'/quality.json'),testMode:'full',crossAttemptReuse:'disabled',validationPolicy:receipt.validationPolicy,checkpointMaintenance:receipt.checkpointMaintenance,executionPolicy:receipt.executionPolicy,executionMaintenance:receipt.executionMaintenance,notEvaluated:plan.notApplicable}};
 scan(JSON.stringify(gate));write(gatePath,gate);
 const state=json('docs/roadmap-run.json');assert.equal(state.completedThrough,18);assert.equal(state.currentPhase,19);
 const checkpoint={phase:19,artifactCommit,evidencePath:gatePath,evidenceHash:hash(gatePath)};state.completedThrough=19;state.currentPhase=20;state.nextPhaseExecutionAuthorized=false;state.lastArtifactCommit=artifactCommit;state.currentLayoutPhaseSeal=checkpoint;state.checkpoints.push(checkpoint);write('docs/roadmap-run.json',state,false);
 const log=read('docs/phase-completion-log.md').toString();assert(!log.includes('| Phase019 |'));
 write('docs/phase-completion-log.md',log.trimEnd()+`\n| Phase019 | 意图识别与核心实体提取 | nlu.extract 注册绑定、受控核心实体服务、确定性日期解析、复用需求字段 Schema、实体与边界测试；完整路径/hash见Gate | 固定8/8；Vitest ${quality.testCount}/${quality.testCount}；专用${quality.dedicatedCount}断言；3项隔离变异及恢复后全卡；PostgreSQL17；schema/typecheck/lint/format/build/layout及证据自检通过；独立Agent复核；artifactCommit=${artifactCommit}；attemptId=${plan.attemptId} | 无API/UI、追问、合并、地图或生产Provider；未执行Phase020 | metadata后双shell seal、clean与GitHub同步；授权止于019 |\n\nPhase019计划：${planPath}；唯一Gate：${gatePath}；原始报告与独立复核：${directory}/。\n`,false);
 console.log(JSON.stringify({status:'METADATA_CANDIDATE_CREATED',artifactCommit,evidenceHash:checkpoint.evidenceHash}));
}else throw new Error('Use --check or --metadata');
