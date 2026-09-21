import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as runtime from './phase018-runtime.mjs';
import {planPath,receiptPath,requirePlan,requireInputs,requireVitest,requireDiscovery,negatives,mutate,checkNegative,dedicatedArgs,dedicatedCommand,audit} from './phase019-evidence.mjs';
const {root,json,read,hash,sha,write,git,command,npmRun,npmCli,environment,scan,copyFixture,removeFixture,resetRegression,resetDatabase}=runtime;
const plan=json(planPath),directory=`docs/evidence/attempts/Phase019/${plan.attemptId}`;
const negativeOnly=process.argv.includes('--negative-controls');
const archiveRoot=negativeOnly?directory+'/negative':directory;
const context={...runtime,directory};
const records=[],artifacts=[];const startedAt=new Date().toISOString();
const sourceHashes=Object.fromEntries(plan.sourcePaths.map(file=>[file,hash(file)]));
function archive(name,value){const file=archiveRoot+'/'+name;scan(typeof value==='string'?value:JSON.stringify(value),file);write(file,value);artifacts.push({path:file,sha256:hash(file)});return file;}
function record(label,result,exitCode=0){console.log(JSON.stringify({check:label,exitCode:result.exitCode,durationMs:result.durationMs}));records.push(result);archive(`commands/${String(records.length).padStart(3,'0')}.json`,result);assert.equal(result.exitCode,exitCode,label+':'+result.stderr);assert.equal(result.timedOut,false);return result;}
function stable(){for(const [file,expected]of Object.entries(sourceHashes))assert.equal(hash(file),expected,'SOURCE_CHANGED:'+file);}
function test(name,selectors=dedicatedArgs){
 const scratchPath=path.join(root,`.scaffold/phase019/${plan.attemptId}-${name}.json`);
 const result=record(name,npmRun('test',['--',...selectors,'--reporter=json','--outputFile='+scratchPath],{env:environment(),timeoutMs:900000}));
 const reportPath=archive(name+'.json',fs.readFileSync(scratchPath,'utf8'));
 const raw=json(reportPath),rows=requireVitest(raw,{base:root});
 const selected=json(plan.discoverySnapshot.path).filter(row=>!selectors.length||path.relative(root,row.file).replaceAll('\\','/').startsWith('tests/nlu/'));
 requireDiscovery(selected,rows,root);
 return {logicalCommand:selectors.length?dedicatedCommand:'npm run test',scratchPath,result,reportPath,reportHash:hash(reportPath),count:rows.length};
}
function checkSources(){
 requirePlan(plan,context);requireInputs(json(receiptPath),context);
 assert.equal(hash(directory+'/frozen-plan.json'),hash(planPath));assert.deepEqual(sourceHashes,json(directory+'/source-basis.json').sourceHashes);
 const changes=[...git(['diff','--name-only',plan.phaseStartCommit]).trim().split(/\r?\n/),...git(['ls-files','--others','--exclude-standard']).trim().split(/\r?\n/)].filter(Boolean);
 for(const file of changes)assert(plan.modificationScope.some(scope=>file===scope||(scope.endsWith('/')&&file.startsWith(scope))),'OUT_OF_SCOPE:'+file);
 for(const file of plan.sourcePaths){scan(read(file).toString(),file); if(/\.(ts|tsx|mjs|json|css|md|sql)$/.test(file)) assert(!read(file).includes(13),'LF_REQUIRED:'+file);}
 assert.equal(process.versions.node,'24.19.0'); assert.equal(json('.scaffold/tools/node_modules/npm/package.json').version,'11.7.0');
 for(const def of negatives)mutate(def,read(def.file).toString());
}
try{
 assert(!fs.existsSync(path.join(root,directory,'attempt.json')),'FAILED_ATTEMPT');checkSources();
 if(negativeOnly){
  const rows=[];
  for(const def of negatives){
   const fixture=copyFixture('phase019-'+def.id);try{
    const original=read(def.file).toString(),changed=mutate(def,original);fs.writeFileSync(path.join(fixture,def.file),changed);
    const scratch=path.join(root,`.scaffold/phase019/${plan.attemptId}-${def.id}.json`);
    const result=record(def.id,command(process.execPath,[npmCli,'run','test','--',def.test,'-t',def.pattern,'--reporter=json','--outputFile='+scratch],{cwd:fixture,env:environment(),timeoutMs:180000}),1);
    const reportPath=archive(def.id+'.json',fs.readFileSync(scratch,'utf8'));
    rows.push({id:def.id,originalHash:hash(def.file),mutatedHash:sha(Buffer.from(changed)),testHash:hash(def.test),result,reportPath,reportHash:hash(reportPath),failure:checkNegative(json(reportPath),def,fixture)});
   }finally{removeFixture(fixture);}
  }
  stable();archive('summary.json',{status:'PASS',rows,artifacts});
 }else{
  assert(process.argv.includes('--all'),'Use --all or --negative-controls');
  const supporting=[];
  for(const [id,operation]of [
   ['schema',()=>command(process.execPath,['scripts/generate-ai-schemas.mjs','--check'])],
   ['typecheck',()=>npmRun('typecheck',[],{env:environment()})],['lint',()=>npmRun('lint',[],{env:environment()})],['format',()=>npmRun('format:check',[],{env:environment()})],
   ['layout',()=>command(process.execPath,['scripts/check-project-layout.mjs'])],['whitespace',()=>command('git',['diff','--check'])],
   ['guards',()=>command(process.execPath,['tests/nlu/evidence-guards.mjs'])],
  ])supporting.push({id,result:record(id,operation())});
  for(const r of [...await resetRegression(),await resetDatabase()])record('database reset',r);
  const full=test('full-tests',[]),dedicated=test('dedicated-tests');
  record('negative controls',command(process.execPath,['docs/phase-plans/verify-phase019.mjs','--negative-controls'],{timeoutMs:300000}));
  const negative=json(directory+'/negative/summary.json');
  const restored=test('restored-tests');
  supporting.push({id:'build',result:record('build',npmRun('build',[],{env:environment(),timeoutMs:300000}))});
  stable();
  const rows=requireVitest(json(restored.reportPath),{base:root});
  for(const [index,item]of plan.cases.entries()){
   const assertions=index<5?rows.filter(row=>plan.assertionBindings[item.testCaseId].some(b=>b.file===row.file&&b.fullName===row.fullName)).map(({file,fullName})=>({file,fullName})):null;
   if(index<5)assert.equal(assertions.length,plan.assertionBindings[item.testCaseId].length);
   const report={testCaseId:item.testCaseId,command:item.command,status:'PASS',exitCode:0,numerator:item.denominator,denominator:item.denominator,inputPath:item.inputPath,inputHash:hash(item.inputPath),planHash:hash(planPath),sourceHashes,simulation:true,productionTraffic:false,details:index<5?{assertions,rawReportPath:restored.reportPath,actualExecution:restored.result}:{controls:negative.rows}};
   archive(item.outputPath.slice(directory.length+1),report);
  }
  const quality={status:'PASS',phase:19,attemptId:plan.attemptId,planHash:hash(planPath),sourceHashes,full,dedicated,restored,negative,supporting,testCount:full.count,dedicatedCount:restored.count,observations:records,artifacts:[...artifacts,...negative.artifacts,{path:directory+'/negative/summary.json',sha256:hash(directory+'/negative/summary.json')}],scan:{hits:0,files:plan.sourcePaths.length},costAccounting:{startedAt,finishedAt:new Date().toISOString(),crossAttemptReuse:'disabled'}};
  archive('quality.json',quality);audit(plan,context,false);console.log(JSON.stringify({status:'PASS',tests:full.count,dedicated:restored.count,businessItems:8}));
 }
}catch(error){
 const message=String(error.stack);try{scan(message);}catch{throw new Error('FAILURE_OUTPUT_REJECTED');}
 if(!negativeOnly)write(directory+'/attempt.json',{phase:19,attemptId:plan.attemptId,status:'FAIL',blockedCategory:'VERIFICATION',artifactCommit:null,planHash:hash(planPath),error:message,observations:records},false);
 console.error(message);process.exitCode=1;
}
