import assert from 'node:assert/strict';
import path from 'node:path';
import { requireHashCoverage, requireReportBinding, requireReviewIdentity } from '../../scripts/phase-evidence.mjs';
import { requireVitest, requireDiscovery } from './phase018-evidence.mjs';
export { requireVitest, requireDiscovery };
export const startCommit = 'a3c1cdfe0640222d6d104dcee9530c2c395516af';
export const planPath = 'docs/phase-plans/Phase019.json';
export const receiptPath = 'docs/phase-plans/Phase019-inputs.json';
export const dedicatedArgs = ['nlu/origin','nlu/destinations','nlu/date-range'];
export const dedicatedCommand = 'npm run test -- '+dedicatedArgs.join(' ');
export const ids = ['unit-origin','unit-destinations','unit-date-range','call-weekend','call-national-day','negative-controls'].map(id=>'Phase019:'+id);
export const negatives = [
 {id:'date-parser-removal',file:'src/server/services/nlu/date-parser.ts',test:'tests/nlu/date-range.test.ts',pattern:'将这周末锚定到 serverDate 所在周',witness:'WEEKEND_CONVERSION_REQUIRED',from:'if (/这周末|本周末/.test(value)) {',to:'if (false && /这周末|本周末/.test(value)) {'},
 {id:'confidence-removal',file:'src/server/services/nlu/extract-core-entities.ts',test:'tests/nlu/origin.test.ts',pattern:'识别从深圳出发',witness:'SCHEMA_MISMATCH',from:'confidence: confidence(score),',to:'// confidence intentionally omitted by isolated negative control'},
 {id:'destination-order',file:'src/server/services/nlu/extract-core-entities.ts',test:'tests/nlu/destinations.test.ts',pattern:'保留多目的地顺序',witness:'DESTINATION_ORDER_REQUIRED',from:'.map((item, index) => destination(item.name, index, item.confidence));',to:'.map((item, index) => destination(item.name, index, item.confidence)).reverse();'},
];
export function mutate(definition, original) {
 const at=original.indexOf(definition.from); assert(at>=0,'MISSING_MUTATION_ANCHOR');
 // Confidence occurs in two independent entity constructors; mutate the first, origin.
 if(definition.id!=='confidence-removal') assert.equal(original.indexOf(definition.from,at+definition.from.length),-1,'AMBIGUOUS_MUTATION');
 return original.slice(0,at)+definition.to+original.slice(at+definition.from.length);
}
export function checkNegative(raw, definition, base) {
 const rows=requireVitest(raw,{expectedFailure:true,allowFiltered:true,base});
 const failures=rows.filter(row=>row.status==='failed');
 assert.equal(failures.length,1,'NEGATIVE_FAILURE_COUNT');
 const row=failures[0]; assert.equal(row.file,definition.test); assert.equal(row.title,definition.pattern);
 assert(row.failureMessages.join('\n').includes(definition.witness),'NEGATIVE_WRONG_FAILURE');
 return {file:row.file,fullName:row.fullName,witness:definition.witness};
}
export function requireInputs(receipt,{json,hash,git}) {
 assert.equal(receipt.phase,19); assert.equal(receipt.phaseStartCommit,startCommit); assert.equal(receipt.requestedThrough,19);
 const previous=JSON.parse(git(['show',startCommit+':docs/phase-plans/Phase018-inputs.json']));
 const state=JSON.parse(git(['show',startCommit+':docs/roadmap-run.json']));
 assert.equal(state.completedThrough,18); assert.equal(state.currentPhase,19);
 for(const key of ['baselineCommit','executionBaselineCommit','manifestHash','pinnedInputs','checkpointMigration','checkpointMaintenance','validationPolicy','executionMaintenance','executionPolicy']) assert.deepEqual(receipt[key],previous[key],'INPUT_CHAIN:'+key);
 for(const item of [...receipt.pinnedInputs,receipt.checkpointMigration,receipt.checkpointMaintenance,receipt.validationPolicy,receipt.executionMaintenance,receipt.executionPolicy]) assert.equal(hash(item.path),item.sha256,'INPUT_HASH:'+item.path);
 const checkpoint=state.checkpoints.at(-1); assert.deepEqual(receipt.prerequisites,{...checkpoint,metadataCommit:startCommit});
 assert.equal(git(['rev-parse',startCommit+'^']).trim(),checkpoint.artifactCommit,'PREVIOUS_PARENT');
 assert.equal(hash(checkpoint.evidencePath),checkpoint.evidenceHash); assert.equal(json(checkpoint.evidencePath).status,'PASS');
 assert.equal(receipt.recovery.preexistingCommit,'e16b7108d94aca10436dba329413732a8706f232');
 const replay=json(receipt.recovery.prerequisiteReplayPath); assert.equal(hash(receipt.recovery.prerequisiteReplayPath),receipt.recovery.prerequisiteReplayHash);
 assert.deepEqual(replay.map(row=>row.executable),['powershell','pwsh']);
 for(const row of replay){assert.equal(row.exitCode,0); const seal=JSON.parse(row.stdout||row.stderr); assert.equal(seal.status,'PASS'); assert.equal(seal.metadataCommit,startCommit); assert.equal(seal.completedThrough,18);}
}
export function requirePlan(plan,{json,hash}) {
 assert.equal(plan.phase,19); assert.deepEqual(plan.requiredCaseIds,ids); assert.deepEqual(plan.cases.map(row=>row.testCaseId),ids);
 assert.deepEqual(plan.cases.map(row=>row.denominator),[1,1,1,1,1,3]);
 assert.equal(plan.testMode,'full'); assert.equal(plan.crossAttemptReuse,'disabled');
 assert.equal(plan.phaseStartCommit,startCommit);
 assert.equal(new Set(plan.sourcePaths).size,plan.sourcePaths.length);
 assert.equal(hash(plan.discoverySnapshot.path),plan.discoverySnapshot.sha256);
 assert.equal(json(plan.discoverySnapshot.path).length,plan.discoverySnapshot.discovered);
 for(const id of ids.slice(0,5)) assert(plan.assertionBindings[id]?.length>0,'MISSING_CASE_BINDING');
 for(const row of plan.priorDrafts) assert.equal(hash(row.path),row.sha256,'PRIOR_DRAFT_CHANGED');
}
export function requireExecution(execution,ctx,options={}) {
 const {json,hash,root,npmCli}=ctx;
 assert.equal(hash(execution.reportPath),execution.reportHash,'RAW_REPORT_HASH');
 assert.equal(execution.result.exitCode,0); assert.equal(execution.result.timedOut,false);
 assert.equal(execution.result.cwd,root); assert.equal(path.resolve(execution.result.executable),path.resolve(process.execPath));
 const selectors=execution.logicalCommand==='npm run test'?[]:dedicatedArgs;
 assert.equal(execution.logicalCommand,selectors.length?dedicatedCommand:'npm run test');
 assert.deepEqual(execution.result.arguments,[npmCli,'run','test','--',...selectors,'--reporter=json','--outputFile='+execution.scratchPath],'EXECUTION_COMMAND');
 const rows=requireVitest(json(execution.reportPath),{base:root});
 if(options.discovery) requireDiscovery(options.discovery,rows,root);
 return rows;
}
export function audit(plan,ctx,withReview=true){
 const {json,hash,git,root,npmCli,directory}=ctx;
 requirePlan(plan,ctx); const receipt=json(receiptPath); requireInputs(receipt,ctx);
 const planHash=hash(planPath); assert.equal(hash(directory+'/frozen-plan.json'),planHash);
 requireHashCoverage(json(directory+'/source-basis.json').sourceHashes,plan.sourcePaths,hash,'SOURCE_BASIS');
 const quality=json(directory+'/quality.json'); assert.equal(quality.planHash,planHash); assert.equal(quality.status,'PASS');
 requireHashCoverage(quality.sourceHashes,plan.sourcePaths,hash,'QUALITY_SOURCE');
 for(const file of quality.artifacts) assert.equal(hash(file.path),file.sha256,'ARTIFACT_HASH');
 const discovery=json(plan.discoverySnapshot.path);
 const full=requireExecution(quality.full,ctx,{discovery});
 const selected=discovery.filter(row=>path.relative(root,row.file).replaceAll('\\','/').startsWith('tests/nlu/'));
 const restored=requireExecution(quality.restored,ctx,{discovery:selected});
 requireExecution(quality.dedicated,ctx,{discovery:selected});
 assert.equal(quality.testCount,full.length); assert.equal(quality.dedicatedCount,restored.length);
 assert.deepEqual(quality.negative.rows.map(row=>row.id),negatives.map(row=>row.id));
 for(const [index,row] of quality.negative.rows.entries()){
  const def=negatives[index]; assert.equal(row.result.exitCode,1); assert.equal(row.result.timedOut,false);
  assert.equal(hash(row.reportPath),row.reportHash); assert.deepEqual(checkNegative(json(row.reportPath),def,row.result.cwd),row.failure);
  assert.equal(row.originalHash,hash(def.file)); assert.equal(row.mutatedHash,ctx.sha(Buffer.from(mutate(def,ctx.read(def.file).toString()))));
  assert.equal(row.testHash,hash(def.test));
 }
 assert.deepEqual(quality.supporting.map(row=>row.id),['schema','typecheck','lint','format','layout','whitespace','guards','build']);
 for(const row of quality.supporting){assert.equal(row.result.exitCode,0);assert.equal(row.result.timedOut,false);}
 const reports=plan.cases.map((item,index)=>{
  const report=json(item.outputPath); requireReportBinding(report,item,planHash,plan.sourcePaths,hash);
  if(index<5){const mapped=restored.filter(row=>plan.assertionBindings[item.testCaseId].some(b=>b.file===row.file&&b.fullName===row.fullName));
   assert.equal(mapped.length,plan.assertionBindings[item.testCaseId].length,'MISSING_ASSERTION');
   assert.deepEqual(report.details.assertions,mapped.map(({file,fullName})=>({file,fullName}))); assert.equal(report.details.rawReportPath,quality.restored.reportPath);
  }else assert.deepEqual(report.details.controls,quality.negative.rows);
  return report;
 });
 let review=null;
 if(withReview){review=json(directory+'/review.json'); assert.equal(review.phase,19);assert.equal(review.attemptId,plan.attemptId);assert.equal(review.planPath,planPath);assert.equal(review.planHash,planHash);assert.equal(review.decision,'PASS');
  requireReviewIdentity(review,plan.implementationContextId); requireHashCoverage(review.sourceHashes,plan.sourcePaths,hash,'REVIEW_SOURCE'); requireHashCoverage(review.reportHashes,plan.cases.map(row=>row.outputPath),hash,'REVIEW_REPORT'); requireHashCoverage(review.supplementalReportHashes,[directory+'/quality.json'],hash,'REVIEW_QUALITY');
  assert(review.issues.every(issue=>review.dispositions.some(d=>d.issueId===issue.id&&d.status==='RESOLVED')),'OPEN_REVIEW_ISSUE');
 }
 return {receipt,quality,reports,review};
}
