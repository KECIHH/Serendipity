import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as runtime from './phase018-runtime.mjs';
import {startCommit,planPath,receiptPath,ids,dedicatedCommand,requirePlan,requireInputs} from './phase019-evidence.mjs';
const {root,json,read,hash,sha,write,git,sourceFiles,fixtureFiles,environment,command}=runtime;
const attemptId=process.argv[2]??'attempt-3'; assert.match(attemptId,/^attempt-\d+$/);
const directory=`docs/evidence/attempts/Phase019/${attemptId}`;
assert(!fs.existsSync(path.join(root,directory,'frozen-plan.json')),'ATTEMPT_ALREADY_FROZEN');
if(!fs.existsSync(path.join(root,receiptPath))){
 const previous=json('docs/phase-plans/Phase018-inputs.json');const state=json('docs/roadmap-run.json');assert.equal(state.completedThrough,18);
 const replayPath='docs/evidence/attempts/Phase019/setup/prerequisite-replay.json';
 write(replayPath,read('.scaffold/phase019/admission-seals.json'));
 const receipt={...previous,phase:19,phaseStartCommit:startCommit,requestedThrough:19,prerequisites:{...state.checkpoints.at(-1),metadataCommit:startCommit},
  preflight:{mode:'RECOVERY_OF_EXISTING_PHASE019',head:git(['rev-parse','HEAD']).trim(),originMain:git(['ls-remote','origin','refs/heads/main']).trim().split(/\s/)[0],porcelain:git(['status','--porcelain=v1','--untracked-files=all']).trim(),branch:git(['branch','--show-current']).trim()},
  recovery:{preexistingCommit:'e16b7108d94aca10436dba329413732a8706f232',prerequisiteReplayPath:replayPath,prerequisiteReplayHash:hash(replayPath),note:'The existing unfinished Phase019 changes were preserved. A clean isolated checkout replays the synchronized Phase018 checkpoint; this is not a claim that the resumed working tree was clean.'}};
 requireInputs(receipt,{json,hash,git});write(receiptPath,receipt);
}
requireInputs(json(receiptPath),{json,hash,git});
const old=json('docs/evidence/attempts/Phase019/attempt-1/frozen-plan.json');
const priorDrafts=['docs/evidence/attempts/Phase019/attempt-1/frozen-plan.json','docs/evidence/attempts/Phase019/attempt-2/requirements-freeze.json'].map(file=>({path:file,sha256:hash(file)}));
const cases=old.cases.map((row,index)=>({...row,command:index<5?dedicatedCommand:row.command,inputPath:index===5?'docs/phase-plans/verify-phase019.mjs':row.inputPath,outputPath:`${directory}/${ids[index].split(':')[1]}.json`}));
const sources=[...new Set([...sourceFiles(),...fixtureFiles(),receiptPath,'docs/testing-execution-policy.md','docs/development-execution-policy.md','docs/agent-execution-contract.md','docs/project-constitution.md','docs/phase-plans/phase018-runtime.mjs','docs/phase-plans/phase018-evidence.mjs','docs/phase-plans/Phase018.json','docs/phase-plans/Phase018-inputs.json',...['prepare','verify','complete'].map(s=>`docs/phase-plans/${s}-phase019.mjs`),'docs/phase-plans/phase019-evidence.mjs','docs/phase-plans/Phase019.json','.gitattributes','.gitignore','.prettierignore','.prettierrc.json','eslint.config.mjs','next.config.ts','postcss.config.mjs'])].sort();
const scratch=`.scaffold/phase019/${attemptId}-discovery.json`;
const collected=command(process.execPath,['node_modules/vitest/vitest.mjs','list','--json='+scratch],{env:environment(),timeoutMs:180000}); assert.equal(collected.exitCode,0,collected.stderr);
const discovery=json(scratch); const rows=discovery.map(row=>({file:path.relative(root,row.file).replaceAll('\\','/'),fullName:row.name.replaceAll(' > ',' ')}));
const bindings=Object.fromEntries(ids.slice(0,5).map((id,index)=>[id,rows.filter(row=>index<3?row.file===cases[index].inputPath:row.file===cases[index].inputPath&&row.fullName.includes(index===3?'guarded call: 这周末从深圳去武功山':'guarded call: 国庆去日本玩七天'))]));
write(directory+'/frozen-discovery.json',discovery);
const previousAttempts=fs.existsSync(path.join(root,planPath))?(()=>{const p=json(planPath);return [...(p.previousAttempts??[]),{attemptId:p.attemptId,planPath:`docs/evidence/attempts/Phase019/${p.attemptId}/frozen-plan.json`,planHash:hash(planPath),status:'FAIL'}];})():[];
const plan={...old,attemptId,implementationContextId:'codex-native-root-phase019-20260921',phaseStartCommit:startCommit,cases,sourcePaths:sources,fixtureSourcePaths:fixtureFiles(),priorDrafts,previousAttempts,
 draftCorrections:'The inherited drafts lacked complete discovery/source/command bindings and never passed a Gate. Keep their bytes and all six required IDs/8 business items. Bind the invalid directory input to the actual mutation runner; five positive cases share one real dedicated execution with exact assertion mapping.',
 assertionBindings:bindings,discoverySnapshot:{path:directory+'/frozen-discovery.json',sha256:hash(directory+'/frozen-discovery.json'),discovered:discovery.length},
 modificationScope:['src/lib/ai/prompts/nlu-extract.ts','src/lib/schemas/core-entities.ts','src/server/services/nlu/','tests/nlu/','docs/phase-plans/Phase019.json',receiptPath,'docs/phase-plans/prepare-phase019.mjs','docs/phase-plans/verify-phase019.mjs','docs/phase-plans/complete-phase019.mjs','docs/phase-plans/phase019-evidence.mjs','docs/evidence/attempts/Phase019/'],
 supportingChecks:['schema','typecheck','lint','format','layout','whitespace','guards','build','full-regression','dedicated-card','negative-controls','secret-scan'],
 executionFreeze:{frozenAt:new Date().toISOString(),crossAttemptReuse:'disabled'},notApplicable:['No API/UI, multi-turn merge or readiness computation; no production traffic, private credentials, real external provider or map service.']};
requirePlan(plan,{json,hash});write(planPath,plan,false);write(directory+'/frozen-plan.json',read(planPath));write(directory+'/freeze-command.json',collected);
write(directory+'/source-basis.json',{planHash:hash(planPath),sourceHashes:Object.fromEntries(sources.map(file=>[file,hash(file)]))});
console.log(JSON.stringify({status:'FROZEN',attemptId,discovered:discovery.length,sources:sources.length,bindings:Object.fromEntries(Object.entries(bindings).map(([k,v])=>[k,v.length]))}));
