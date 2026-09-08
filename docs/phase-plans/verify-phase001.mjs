import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { phase001SourcePaths, requireHashCoverage, requireReviewIdentity } from '../../scripts/phase-evidence.mjs';

const originalRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const root = path.resolve(option('--root', originalRoot));
const local = (relative) => path.join(root, relative);
const bytes = (relative) => fs.readFileSync(local(relative));
const text = (relative) => bytes(relative).toString('utf8').replace(/^\uFEFF/, '');
const json = (relative) => JSON.parse(text(relative));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const hash = (relative) => sha256(bytes(relative));
const planPath = 'docs/phase-plans/Phase001.json';
const inputsPath = 'docs/phase-plans/Phase001-inputs.json';
const documentPaths = ['docs/git-workflow.md', 'docs/code-style.md', 'docs/ui-design-system.md', 'docs/database.md'];
const componentNames = ['按钮', '输入框', '卡片', 'Tabs', '表格', '弹窗', 'Toast', '加载态', '空状态', '错误态'];
const forbiddenModels = ['Order', 'Payment', 'SocialFollow', 'OAuthAccount', 'PromptConfig', 'AiModelConfig', 'Asset'];
const requiredModels = {
  User: 6, SystemConfig: 7, TravelRecord: 8, ChatMessage: 8, AuditLog: 9, ApiKeyConfig: 10,
  AuthSession: 11, AuthLoginAttempt: 11, AdminCommandReceipt: 12, KeyRotationRun: 12,
  PromptDefinition: 15, PromptVersion: 15, PromptActivation: 15, ModelDeployment: 15,
  PromptModelActivation: 15, ProviderConfigVersion: 15, PlanningPolicyVersion: 15, PlanningPolicyActivation: 15,
  AiOutputRecord: 15, AiUsageReservation: 15, ChatCommand: 16, ChatCommandEvent: 16,
  CommandIdempotency: 16, DurableTask: 16, Outbox: 16, TaskPayload: 16, AiDebugRun: 18,
  TravelPlanVersion: 25, PlannerRun: 25, PlanTrace: 25, PlanWorkspaceSnapshot: 25, FactSnapshot: 30,
  PlanMutation: 53, MutationClarification: 53, ReplanCommand: 58, RestoreCommand: 59,
  PlanFinalization: 60, RequirementPatchReceipt: 62,
  AnonymousMergeReceipt: 82, DataRequest: 84, PrivacyRevocationLedger: 84,
  ShareGrant: 88, Announcement: 94, AnnouncementVersion: 94, TravelQualityFeedback: 95,
  FileAsset: 96, TraceEvent: 97, PlanPublication: 106,
  CacheEnvelope: 30, PlanDiff: 53, TravelReadinessReport: 60, UserTravelProfile: 84,
  RevalidationCommand: 85, ArchiveReceipt: 85, FavoritePlan: 86, ClonePlanCommand: 87,
  PromptEvaluationRun: 90, PromptGatePolicyVersion: 90, ModelEvaluationRun: 91,
  ProviderActivation: 92, ProviderResolutionPolicyVersion: 92, RegressionCaseCandidate: 95,
  FileDerivative: 96, PlaceMedia: 96, AssetUsage: 96,
  PromptModelRollout: 90,
};

function run(executable, commandArgs, cwd = root, timeout = 180000) {
  const env = { ...process.env };
  delete env.PSModulePath;
  const result = spawnSync(executable, commandArgs, { cwd, env, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { command: [executable, ...commandArgs].map((item) => /\s/.test(item) ? `'${item.replaceAll("'", "''")}'` : item).join(' '), exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}
function successful(observation) {
  assert.equal(observation.exitCode, 0, `${observation.command}\n${observation.stderr}\n${observation.stdout}`);
  return observation;
}
function git(commandArgs, cwd = root) { return successful(run('git', ['-c', 'core.quotepath=false', ...commandArgs], cwd)).stdout.trim(); }
function writeJson(relative, value) {
  fs.mkdirSync(path.dirname(local(relative)), { recursive: true });
  fs.writeFileSync(local(relative), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}
function contains(content, values, label) {
  for (const value of values) assert(content.includes(value), `${label}: missing ${value}`);
}

// ATX headings outside fenced blocks define the authored document contract.
function sections(content) {
  const lines = content.split('\n');
  const headings = [];
  let offset = 0;
  let fence = null;
  for (const line of lines) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) fence = fence ? null : marker[1][0];
    const heading = !fence && line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) headings.push({ level: heading[1].length, title: heading[2].replaceAll('`', ''), start: offset, bodyStart: offset + line.length + 1 });
    offset += line.length + 1;
  }
  return headings.map((heading, index) => {
    const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    return { ...heading, end: next?.start ?? content.length, body: content.slice(heading.bodyStart, next?.start ?? content.length) };
  });
}
function section(content, name) {
  const matches = sections(content).filter((item) => item.title === name);
  assert.equal(matches.length, 1, `Required unique section: ${name}`);
  assert(matches[0].body.trim().length > 0, `Empty section: ${name}`);
  return matches[0];
}
function modelSection(content, model) {
  const matches = sections(content).filter((item) => item.level === 3 && new RegExp(`(?:^|\\s)${model}$`).test(item.title));
  assert.equal(matches.length, 1, `Required unique model definition: ${model}`);
  return matches[0];
}
function tableRows(content) {
  return content.split('\n').filter((line) => line.trim().startsWith('|')).map((line) => {
    const columns = []; let cell = ''; let code = false; let escaped = false;
    for (const character of line.trim().slice(1)) {
      if (escaped) { cell += character; escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === '`') { code = !code; continue; }
      if (character === '|' && !code) { columns.push(cell.trim()); cell = ''; }
      else cell += character;
    }
    return columns;
  }).filter((row) => row.length > 0 && !row.every((value) => /^:?-+:?$/.test(value)));
}
function withoutSection(content, name, isModel = false) {
  const target = isModel ? modelSection(content, name) : section(content, name);
  return content.slice(0, target.start) + content.slice(target.end);
}
function registry(content) {
  const start = '<!-- model-registry:start -->';
  const end = '<!-- model-registry:end -->';
  assert.equal(content.split(start).length, 2, 'Unique registry start marker');
  assert.equal(content.split(end).length, 2, 'Unique registry end marker');
  const rows = tableRows(content.split(start)[1].split(end)[0]);
  const header = ['model', 'producerPhase', 'identity', 'relations+nullable', 'status', 'immutability', 'deletion', 'publicProjection', 'schemaPath', 'source'];
  assert.deepEqual(rows.shift(), header);
  return rows.map((row) => {
    assert.equal(row.length, header.length, `Registry column count: ${row[0]}`);
    return Object.fromEntries(header.map((key, index) => [key, row[index]]));
  });
}
function fields(content, model) {
  const rows = tableRows(modelSection(content, model).body);
  assert.deepEqual(rows.shift(), ['字段', '类型', 'nullable', '约束']);
  assert(rows.length >= 2, `Missing fields: ${model}`);
  for (const row of rows) {
    assert.equal(row.length, 4, `${model}.${row[0]} field columns`);
    assert(row.every((value) => value.length > 0), `${model}.${row[0]} empty field contract`);
  }
  assert.equal(new Set(rows.map((row) => row[0])).size, rows.length, `Duplicate field definition: ${model}`);
  return Object.fromEntries(rows.map(([name, type, nullable, rule]) => [name, { type, nullable, rule }]));
}

function checkGitWorkflow() {
  const content = text(documentPaths[0]);
  for (const name of ['提交信息格式', '分支命名规则', '变更保护规则', '提交前检查清单', '双提交 checkpoint', '脏工作区处理规则']) section(content, name);
  const rows = tableRows(section(content, '提交前检查清单').body);
  for (const command of ['npm run lint', 'npm run typecheck', 'npm run test', 'npm run build']) {
    const row = rows.find(([name]) => name === command);
    assert(row && row.at(-1).includes('退出码0'), `Missing command / zero-exit requirement: ${command}`);
  }
  contains(content, ['phase(NNN): artifact', 'phase(NNN): metadata', 'phase(NNN): recovery', 'baselineCommit', 'executionBaselineCommit', 'recoveryCommits', 'main', 'currentPhase', 'completedThrough', 'evidenceHash', 'contractHashes', 'testedTree', '唯一父', 'allowedExactPaths', 'allowedPathPrefixes', 'docs/roadmap-run.json', 'docs/phase-completion-log.md', 'docs/evidence/', 'PowerShell 7', 'PowerShell 5.1', 'git push origin main', 'git ls-remote --heads origin main', 'NOT_CREATED', 'nextPhaseExecutionAuthorized=false'], 'Git workflow');
  return { sectionCount: 6, requiredCommands: 4, productCommandsExecuted: false };
}
function checkCodeStyle() {
  const content = text(documentPaths[1]);
  for (const name of ['TypeScript 类型规则', '函数命名规则', '组件命名规则', '文件命名规则', '错误处理方式', '注释规则', '不做无关重构']) section(content, name);
  const counts = {};
  for (const layer of ['API', 'service', 'lib']) {
    const body = section(content, `${layer} 层职责`).body;
    counts[layer] = body.replace(/\s/g, '').length;
    assert(counts[layer] >= 50, `Layer is underspecified: ${layer}`);
    assert(/不负责|不依赖/.test(body), `Layer exclusion missing: ${layer}`);
  }
  contains(content, ['禁止使用', '`any`', '`unknown`', '`interface`', '`type`', '显式声明返回类型', 'PascalCase', 'kebab-case.tsx', 'kebab-case.ts', 'kebab-case-service.ts', 'src/app/api/', 'src/server/services/', 'src/lib/env.ts', "import 'server-only'", 'src/server/ai', 'src/lib/ai/provider.ts', 'src/lib/ai/schemas.ts', '不得直接或间接导入', 'requestId', '堆栈', '密钥', '系统 Prompt'], 'Code style');
  const errorFixture = JSON.parse(content.match(/```json\n([\s\S]+?)\n```/)[1]);
  assert.deepEqual(Object.keys(errorFixture).sort(), ['error', 'requestId', 'success']);
  assert.equal(errorFixture.success, false);
  assert.deepEqual(Object.keys(errorFixture.error).sort(), ['code', 'message']);
  return { layerCharacterCounts: counts, errorFixture };
}
function contrast(foreground, background) {
  const luminance = (color) => {
    const channels = color.slice(1).match(/../g).map((channel) => parseInt(channel, 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
function checkUi() {
  const content = text(documentPaths[2]);
  const states = {};
  for (const name of componentNames) {
    const rows = tableRows(section(content, name).body);
    const stateHeader = rows.findIndex((row) => row[0] === '状态');
    assert(stateHeader >= 0, `Component state table: ${name}`);
    const variants = rows.slice(stateHeader + 1);
    assert(variants.length >= 2, `At least two states: ${name}`);
    assert(new Set(variants.map((row) => row[0])).size === variants.length, `Duplicate state: ${name}`);
    assert(variants.every((row) => row[1]?.length >= 8), `Unspecified state behavior: ${name}`);
    states[name] = variants.map((row) => row[0]);
  }
  contains(content, ['12px', '14px', '16px', '18px', '20px', '24px', '30px', '36px', '0.5rem', '1rem', '1.5rem', '2rem', '3rem', '4rem', '2px', '4px', '6px', '8px', '12px', '16px', '9999px', '640px', '768px', '1024px', '1280px', 'letter-spacing: 0', 'sm', 'base', 'md', 'lg', 'xl', '950', 'Leaflet', 'OpenStreetMap', 'map.provider', 'PlanViewModel', 'knownSubtotal', 'NEEDS_REVALIDATION', 'attribution', 'lucide-react', '至少44', 'aria-', 'NOT_EVALUATED'], 'UI tokens and behavior');
  section(content, '后台页面信息密度');
  const modules = tableRows(section(content, '旅行结果页模块展示规则').body);
  assert(modules.length >= 8, 'Travel modules incomplete');
  const colors = Object.fromEntries(tableRows(section(content, '颜色').body).filter((row) => /^#[0-9a-f]{6}$/.test(row[1] ?? '')).map((row) => [row[0], row[1]]));
  const measured = {};
  for (const token of ['primary', 'secondary', 'success', 'warning', 'error', 'info', 'text', 'text-muted', 'text-subtle', 'focus']) {
    assert(colors[token], `Missing color: ${token}`);
    measured[token] = Number(contrast(colors[token], '#ffffff').toFixed(3));
    assert(measured[token] >= 4.5, `Color contrast below 4.5: ${token}`);
  }
  for (const [token, background] of [['success', '#f0fdf4'], ['warning', '#fefce8'], ['error', '#fef2f2'], ['info', '#f0f9ff']]) assert(contrast(colors[token], background) >= 4.5, `Semantic panel contrast: ${token}`);
  return { components: states, normalTextContrastAgainstWhite: measured, browserEvaluated: false };
}

function checkDatabase() {
  const content = text(documentPaths[3]);
  const rows = registry(content);
  const models = new Map(rows.map((row) => [row.model, row]));
  assert.equal(models.size, rows.length, 'Duplicate model registration');
  assert.deepEqual([...models.keys()].sort(), Object.keys(requiredModels).sort(), 'Complete persistent model registry must match the frozen model inventory');
  for (const name of forbiddenModels) assert(!models.has(name), `Forbidden model: ${name}`);
  for (const [name, producer] of Object.entries(requiredModels)) {
    assert(models.has(name), `Unregistered core model: ${name}`);
    assert.equal(Number(models.get(name).producerPhase), producer, `Wrong producer: ${name}`);
  }
  assert(models.has('FavoritePlan'), 'Missing FavoritePlan');
  for (const row of rows) {
    assert(/^[A-Z][A-Za-z0-9]+$/.test(row.model), `Invalid model: ${row.model}`);
    assert(/^\d+$/.test(row.producerPhase) && Number(row.producerPhase) >= 6 && Number(row.producerPhase) <= 137, `Invalid producer: ${row.model}`);
    for (const key of ['identity', 'relations+nullable', 'status', 'immutability', 'deletion', 'publicProjection', 'schemaPath', 'source']) assert(row[key].length >= 2, `${row.model}: missing ${key}`);
    assert(row.schemaPath.startsWith('prisma/') && /schema\.prisma/.test(row.schemaPath), `Missing Prisma mapping: ${row.model}`);
    assert(!/任选|或等价|待定|二选一/.test(Object.values(row).join(' ')), `Ambiguous model decision: ${row.model}`);
    assert(/Phase\d{3}/.test(row.source), `Missing model source: ${row.model}`);
  }
  for (const model of ['User', 'TravelRecord', 'ChatMessage', 'SystemConfig', 'ApiKeyConfig', 'AuditLog', 'AuthSession', 'AuthLoginAttempt', 'AiOutputRecord', 'TravelPlanVersion', 'PlannerRun', 'PlanTrace', 'FactSnapshot', 'FavoritePlan', 'ShareGrant', 'TravelQualityFeedback', 'Announcement', 'AnnouncementVersion', 'FileAsset', 'PlanPublication']) fields(content, model);
  const travel = fields(content, 'TravelRecord');
  assert(!Object.keys(travel).some((field) => /planJson/.test(field)), 'TravelRecord cannot store planJson');
  for (const field of ['userId', 'anonTokenHash', 'status', 'version', 'currentPlanVersionId', 'finalPlanVersionId']) assert(travel[field], `Missing TravelRecord.${field}`);
  const travelBody = modelSection(content, 'TravelRecord').body;
  contains(travelBody, ['DRAFT', 'NEEDS_INFO', 'PLANNED', 'MODIFIED', 'FINALIZED', 'NEEDS_REVALIDATION', 'ARCHIVED', '恰好一个', 'NEEDS_REVALIDATION'], 'TravelRecord');
  assert(/clone新记录目标固定NEEDS_REVALIDATION/.test(travelBody), 'Clone target must be NEEDS_REVALIDATION independently of enum definitions');
  assert(models.get('TravelRecord').immutability.includes('CLONE 目标固定 NEEDS_REVALIDATION'), 'Registered clone target');
  assert(content.includes('VersionDetailReceipt') && !models.has('VersionDetailReceipt'), 'VersionDetailReceipt is a response DTO, not a database table');
  contains(modelSection(content, 'TravelPlanVersion').body, ['planJson', 'planContentHash', 'qualityReportHash', 'planHash', 'GENERATE', 'MUTATION', 'REPLAN', 'RESTORE', 'CLONE', 'REVALIDATE'], 'TravelPlanVersion');
  contains(modelSection(content, 'User').body, ['normalizeEmailV1', 'ASCII', 'UTS #46', 'non-transitional', 'revision', 'sessionVersion', 'USER', 'ADMIN', 'ACTIVE', 'DISABLED'], 'User');
  contains(modelSection(content, 'AiOutputRecord').body, ['traceId', 'attemptNo', 'rawOutput', 'parsedOk', 'promptVersionId', 'deploymentConfigVersion', 'providerConfigVersion'], 'AiOutputRecord');
  contains(modelSection(content, 'AuditLog').body, ['UPDATE', 'DELETE', 'requestId', 'traceId'], 'AuditLog');
  const apiKey = fields(content, 'ApiKeyConfig');
  assert.equal(apiKey.encryptedKey.type, 'String @db.Text', 'ApiKeyConfig.encryptedKey must preserve canonical JSON text');
  assert.equal(apiKey.encryptedKey.nullable, '否', 'ApiKeyConfig.encryptedKey cannot be nullable');
  contains(apiKey.encryptedKey.rule, ['Phase010首产', 'RFC8785 JCS', 'Schema'], 'ApiKeyConfig.encryptedKey');
  assert.equal(apiKey.revision.type, 'Int', 'ApiKeyConfig.revision must be Int');
  assert.equal(apiKey.revision.nullable, '否', 'ApiKeyConfig.revision cannot be nullable or deferred');
  contains(apiKey.revision.rule, ['Phase010首产', 'default 0', '非负CHECK'], 'ApiKeyConfig.revision');
  for (const heading of ['字段命名规则', '时间字段规则', '状态字段规则', 'JSON 字段规则', '索引规则', '数据库迁移规则', 'seed 执行规则', '敏感字段存储规则']) section(content, heading);
  contains(section(content, '索引规则').body, ['PostgreSQL', '不会自动', '外键', '索引'], 'Foreign-key indexes');
  contains(section(content, '索引规则').body, ['DurableTask', '(status,availableAt,leaseUntil,id)'], 'DurableTask claim index');
  contains(section(content, '数据库迁移规则').body, ['npx prisma migrate dev --name <description>', 'npm run db:generate', 'Client', '迁移'], 'Migration commands');
  contains(section(content, '敏感字段存储规则').body, ['AES-256-GCM', 'ENCRYPTION_KEY', 'bcryptjs', '12', '72', 'anonTokenHash', 'sessionVersion'], 'Sensitive storage');
  assert(/禁止模型|禁止.*同义/.test(content), 'Missing prohibited-model list');
  const stateRow = models.get('TravelRecord').status.split('/').map((value) => value.trim()).sort();
  assert.deepEqual(stateRow, ['DRAFT', 'NEEDS_INFO', 'PLANNED', 'MODIFIED', 'FINALIZED', 'NEEDS_REVALIDATION', 'ARCHIVED'].sort(), 'Exact TravelRecord enum');
  return { modelCount: models.size, models: Object.fromEntries(rows.map((row) => [row.model, Number(row.producerPhase)])), requiredCoreCount: Object.keys(requiredModels).length, prohibitedModelDefinitions: 0 };
}

function checkCoverage() {
  const receipt = json(inputsPath);
  const manifest = json(receipt.pinnedInputs.find((input) => input.id === 'manifest').path);
  const contracts = [...manifest.localContracts.map((contract) => ({ ...contract, path: `${receipt.roadmapRoot}/${contract.path}` })), ...manifest.projectContracts.filter((contract) => contract.required && contract.producerPhase <= 1)];
  assert.equal(contracts.length, 20, 'Frozen M0 contract denominator');
  const readable = contracts.map((contract) => { assert(bytes(contract.path).length > 0, `Missing contract: ${contract.id}`); return { id: contract.id, path: contract.path, sha256: hash(contract.path) }; });
  return { numerator: readable.length, denominator: 20, contracts: readable };
}
function checkInputs() {
  const receipt = json(inputsPath);
  assert.equal(receipt.executionBaselineCommit, receipt.baselineCommit);
  assert.equal(receipt.preflight.head, receipt.baselineCommit);
  assert.equal(receipt.preflight.originMain, receipt.baselineCommit);
  assert.equal(receipt.preflight.porcelain, '');
  assert.equal(receipt.preflight.branch, 'main');
  assert.equal(receipt.requestedThrough, 1);
  const ids = new Set();
  for (const input of receipt.pinnedInputs) {
    assert(!ids.has(input.id), `Duplicate pinned input: ${input.id}`); ids.add(input.id);
    assert.equal(hash(input.path), input.sha256, `Pinned input hash drift: ${input.id}`);
  }
  const manifest = json(receipt.pinnedInputs.find((input) => input.id === 'manifest').path);
  assert.equal(hash(receipt.pinnedInputs.find((input) => input.id === 'manifest').path), receipt.manifestHash);
  assert.equal(manifest.runStatePinnedInputs.length, 8);
  for (const input of manifest.runStatePinnedInputs) assert(ids.has(input.id), `Missing run-state input: ${input.id}`);
  assert.equal(git(['ls-files', '--', `${receipt.roadmapRoot}/`]), '');
  successful(run('git', ['check-ignore', '--no-index', `${receipt.roadmapRoot}/Phase001.md`]));
  git(['merge-base', '--is-ancestor', receipt.baselineCommit, 'HEAD']);
  for (const future of ['package.json', 'package-lock.json', 'src', 'prisma', 'node_modules', '.next', 'project']) assert(!fs.existsSync(local(future)), `Future product entry: ${future}`);
  for (const relative of documentPaths) assert(!bytes(relative).includes(Buffer.from('\r')), `Normalize LF before hashing: ${relative}`);
  for (const relative of ['docs/tech-stack.md', 'docs/agent-execution-contract.md', 'docs/directory-structure.md']) contains(text(relative), ['src/server/ai', 'src/lib/ai/provider.ts'], 'Upstream boundary regression');
  const decisionLines = text('docs/tech-stack.md').split('\n').filter((line) => /^- (?:前端框架|后端框架|数据库|ORM|UI 组件库|AI Provider|测试框架|鉴权方案|包管理器|Node 版本|部署方案|地图方案|PDF 导出|npm 版本)/.test(line));
  assert(decisionLines.length >= 10);
  assert(!/任选|或等价|待定|二选一/.test(decisionLines.join('\n')), 'Ambiguous technical choice');
  successful(run('git', ['diff', '--check']));
  const layout = successful(run(process.execPath, ['scripts/check-project-layout.mjs']));
  return { pinnedInputCount: ids.size, manifestHash: receipt.manifestHash, baselineCommit: receipt.baselineCommit, decisionFieldCount: decisionLines.length, layout: JSON.parse(layout.stdout), commands: [{ command: 'git diff --check', exitCode: 0 }, { command: layout.command, exitCode: 0 }] };
}

function checkHistory() {
  const receipt = json(inputsPath);
  const checkpoint = receipt.historicalCheckpoint;
  const audit = successful(run(process.execPath, ['scripts/check-project-layout.mjs']));
  assert.equal(hash(checkpoint.evidencePath), checkpoint.evidenceHash);
  assert.equal(git(['rev-parse', `${checkpoint.metadataCommit}^`]), checkpoint.artifactCommit);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'serendipity-phase001-history-'));
  const repository = path.join(temporary, 'repository');
  successful(run('git', ['-c', 'core.autocrlf=false', 'clone', '--quiet', '--no-hardlinks', '--no-checkout', root, repository], temporary));
  git(['config', 'core.autocrlf', 'false'], repository);
  git(['remote', 'set-url', 'origin', receipt.preflight.remote], repository);
  git(['checkout', '--quiet', '-B', 'main', checkpoint.metadataCommit], repository);
  const roadmap = path.join(repository, receipt.roadmapRoot);
  const observations = [];
  const originalState = json(checkpoint.runStatePath);
  const wrapper = path.join(originalRoot, 'docs/phase-plans/replay-historical-phase.ps1');
  const wrapperArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper,
    '-Validator', path.join(roadmap, 'docs/validate-roadmap-v2.ps1'),
    '-Manifest', path.join(roadmap, 'docs/roadmap-execution-manifest.json'),
    '-OriginalRepositoryRoot', originalState.repositoryRoot,
    '-RelocatedRepositoryRoot', repository, '-RoadmapDirectory', receipt.roadmapRoot,
    '-OriginalBaselineCommit', checkpoint.baselineCommit, '-OriginalArtifactCommit', checkpoint.artifactCommit];
  for (const shell of ['powershell', 'pwsh']) {
    const result = successful(run(shell, wrapperArgs, roadmap));
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'PASS', 'Historical seal must PASS');
    const wrongMappingArgs = [...wrapperArgs];
    wrongMappingArgs[wrongMappingArgs.indexOf('-OriginalRepositoryRoot') + 1] += '-wrong';
    const rejectedMapping = run(shell, wrongMappingArgs, roadmap);
    assert.equal(rejectedMapping.exitCode, 1, 'Wrong historical root mapping must fail');
    assert(rejectedMapping.stdout.includes('Run state repositoryRoot differs from manifest resolution.'), 'Historical root assertion must remain active');
    observations.push({ shell, ...result, report, rejectedMapping });
  }
  assert.equal(git(['status', '--porcelain=v1'], repository), '');
  return { historicalMetadata: checkpoint.metadataCommit, historicalArtifact: checkpoint.artifactCommit, archiveAudit: JSON.parse(audit.stdout), originalValidatorUnmodified: true, relocationAdapter: { path: 'docs/phase-plans/replay-historical-phase.ps1', sha256: hash('docs/phase-plans/replay-historical-phase.ps1'), scope: 'Exact verified historical absolute roots are relocated during deserialization only; source/file/Git bytes and all assertions are unchanged; wrong mapping rejected in both shells' }, isolatedRepository: repository, observations, productionTraffic: false };
}

function checkDocumentMutations(changes, expectedCount) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'serendipity-phase001-mutations-'));
  fs.mkdirSync(path.join(temporary, 'docs'));
  for (const relative of documentPaths) fs.copyFileSync(local(relative), path.join(temporary, relative));
  const observations = [];
  for (const [id, name, relative, mutate] of changes) {
    const source = text(relative);
    const mutated = mutate(source);
    assert.notEqual(mutated, source, `Mutation did not change input: ${id}`);
    const target = path.join(temporary, relative);
    fs.writeFileSync(target, mutated);
    const rejected = run(process.execPath, [path.join(originalRoot, 'docs/phase-plans/verify-phase001.mjs'), '--root', temporary, '--check', name]);
    assert.equal(rejected.exitCode, 1, `Mutation must be rejected: ${id}\n${rejected.stdout}\n${rejected.stderr}`);
    fs.writeFileSync(target, source);
    const restored = successful(run(process.execPath, [path.join(originalRoot, 'docs/phase-plans/verify-phase001.mjs'), '--root', temporary, '--check', name]));
    observations.push({ id, inputPath: relative, mutatedHash: sha256(mutated), restoredHash: sha256(source), rejected, restored });
  }
  assert.equal(observations.length, expectedCount);
  return { temporary, observations, originalFilesUnmodified: documentPaths.every((relative) => hash(relative) === sha256(fs.readFileSync(path.join(temporary, relative)))) };
}

function checkNegativeDocuments() {
  return checkDocumentMutations([
    ['missing-test-command', 'git-workflow', documentPaths[0], (value) => value.replaceAll('npm run test', 'npm run missing')],
    ['missing-api-layer', 'code-style', documentPaths[1], (value) => withoutSection(value, 'API 层职责')],
    ['missing-error-component', 'ui-design-system', documentPaths[2], (value) => withoutSection(value, '错误态')],
    ['missing-version-definition', 'database', documentPaths[3], (value) => withoutSection(value, 'TravelPlanVersion', true)],
    ['missing-audit-definition', 'database', documentPaths[3], (value) => withoutSection(value, 'AuditLog', true)],
    ['wrong-clone-state', 'database', documentPaths[3], (value) => value.replace('clone新记录目标固定NEEDS_REVALIDATION', 'clone新记录目标固定MODIFIED')],
    ['duplicate-plan-body', 'database', documentPaths[3], (value) => { const target = modelSection(value, 'TravelRecord'); return value.slice(0, target.end) + '| planJson | Json | 否 | injected duplicate body |\n\n' + value.slice(target.end); }],
    ['premature-ai-output', 'database', documentPaths[3], (value) => value.replace(/(\| `AiOutputRecord` \| )15( \|)/, (_, prefix, suffix) => `${prefix}8${suffix}`)],
    ['missing-fk-index-rule', 'database', documentPaths[3], (value) => withoutSection(value, '索引规则')],
    ['missing-migration-command', 'database', documentPaths[3], (value) => value.replaceAll('npx prisma migrate dev --name <description>', 'npx prisma generate')],
    ['missing-encryption-rule', 'database', documentPaths[3], (value) => value.replaceAll('AES-256-GCM', 'PLAINTEXT')],
    ['forbidden-model', 'database', documentPaths[3], (value) => value.replace('<!-- model-registry:end -->', '| `Order` | 6 | id PK | none nullable | ACTIVE | immutable | restrict | none | prisma/schema.prisma#Order | Phase006 |\n<!-- model-registry:end -->')],
  ], 12);
}

function checkContractRegression() {
  return checkDocumentMutations([
    ['api-key-json-column', 'database', documentPaths[3], (value) => value.replace('| encryptedKey | String @db.Text |', '| encryptedKey | Json |')],
    ['api-key-revision-deferred', 'database', documentPaths[3], (value) => value.replace('| revision | Int | 否 | Phase010首产', '| revision | Int | 否 | Phase012首产')],
    ['api-key-revision-nullable', 'database', documentPaths[3], (value) => value.replace('| revision | Int | 否 | Phase010首产', '| revision | Int | 是 | Phase010首产')],
    ['api-key-noncanonical-text', 'database', documentPaths[3], (value) => value.replaceAll('RFC8785 JCS', 'UNSPECIFIED')],
    ['durable-task-wrong-index', 'database', documentPaths[3], (value) => value.replace('(status,availableAt,leaseUntil,id)', '(status,nextAttemptAt,leaseUntil,id)')],
  ], 5);
}

function checkEvidenceRegression() {
  const sources = sourceHashes();
  const fixtureReports = [planPath, inputsPath];
  const reportHashes = Object.fromEntries(fixtureReports.map((file) => [file, hash(file)]));
  const implementationContextId = 'synthetic-implementation-context';
  const identity = { runnerIdentity: { kind: 'INDEPENDENT_CODEX_AGENT', implementationAuthored: false }, implementationContextId,
    contextId: 'synthetic-review-context', reviewerRunId: 'synthetic-review-run', generatedBy: 'in-memory-negative-fixture' };
  requireHashCoverage(sources, phase001SourcePaths, hash, 'REPORT_SOURCE_HASH');
  requireHashCoverage(reportHashes, fixtureReports, hash, 'REVIEW_FILE_HASH');
  requireReviewIdentity(identity, implementationContextId);
  const missingSource = { ...sources }; delete missingSource[phase001SourcePaths[0]];
  const missingReport = { ...reportHashes }; delete missingReport[fixtureReports[0]];
  const mutations = [
    ['empty-report-source-map', 'REPORT_SOURCE_HASH', () => requireHashCoverage({}, phase001SourcePaths, hash, 'REPORT_SOURCE_HASH')],
    ['missing-report-source-entry', 'REPORT_SOURCE_HASH', () => requireHashCoverage(missingSource, phase001SourcePaths, hash, 'REPORT_SOURCE_HASH')],
    ['changed-source-bytes', 'REPORT_SOURCE_HASH', () => requireHashCoverage(sources, phase001SourcePaths, (file) => file === phase001SourcePaths[0] ? '0'.repeat(64) : hash(file), 'REPORT_SOURCE_HASH')],
    ['empty-review-report-map', 'REVIEW_FILE_HASH', () => requireHashCoverage({}, fixtureReports, hash, 'REVIEW_FILE_HASH')],
    ['missing-review-report-entry', 'REVIEW_FILE_HASH', () => requireHashCoverage(missingReport, fixtureReports, hash, 'REVIEW_FILE_HASH')],
    ['synthetic-review-kind', 'REVIEW_IDENTITY', () => requireReviewIdentity({ ...identity, runnerIdentity: { ...identity.runnerIdentity, kind: 'SYNTHETIC_PROTOCOL_FIXTURE_NOT_AGENT_REVIEW' } }, implementationContextId)],
    ['same-review-context', 'REVIEW_IDENTITY', () => requireReviewIdentity({ ...identity, contextId: implementationContextId }, implementationContextId)],
    ['missing-implementation-context', 'REVIEW_IDENTITY', () => requireReviewIdentity(identity, undefined)],
  ];
  const observations = mutations.map(([id, diagnostic, mutate]) => {
    let error;
    try { mutate(); } catch (failure) { error = failure.message; }
    assert(error?.includes(diagnostic), `Evidence mutation must be rejected: ${id}`);
    return { id, diagnostic, rejected: true, error };
  });
  return { scope: 'IN_MEMORY_EVIDENCE_REJECTION_REGRESSION', observations, sourceFilesMutated: false, independentReviewPerformed: false };
}

function checkCheckpoint() {
  const command = successful(run(process.execPath, ['scripts/test-validate-phase.mjs', '--shell', 'both', '--keep'], root, 900000));
  const report = JSON.parse(command.stdout);
  assert.equal(report.status, 'PASS');
  return { command, report };
}
const checks = { 'git-workflow': checkGitWorkflow, 'code-style': checkCodeStyle, 'ui-design-system': checkUi, database: checkDatabase, 'contract-coverage': checkCoverage, 'pinned-inputs': checkInputs, history: checkHistory, 'negative-documents': checkNegativeDocuments, 'checkpoint-regression': checkCheckpoint, 'contract-regression': checkContractRegression, 'evidence-regression': checkEvidenceRegression };

function sourceHashes() {
  return Object.fromEntries(phase001SourcePaths.map((relative) => [relative, hash(relative)]));
}
function executeCase(name, plan) {
  assert(checks[name], `Unknown case: ${name}`);
  const test = plan.cases.find((item) => item.testCaseId === `Phase001:${name}`);
  assert(test, `Unplanned case: ${name}`);
  assert(!fs.existsSync(local(test.outputPath)), `Report exists; create a new attempt instead: ${test.outputPath}`);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const measuredInputs = sourceHashes();
  const details = checks[name]();
  const report = { testCaseId: test.testCaseId, command: test.command, status: 'PASS', exitCode: 0, numerator: test.denominator, denominator: test.denominator, inputPath: test.inputPath, inputHash: hash(test.inputPath), planHash: hash(planPath), sourceHashes: measuredInputs, startedAt, completedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started), details };
  writeJson(test.outputPath, report);
  console.log(JSON.stringify({ testCaseId: test.testCaseId, status: 'PASS', numerator: test.denominator, denominator: test.denominator, outputPath: test.outputPath }));
}

try {
  if (args.includes('--check')) {
    const name = option('--check');
    assert(checks[name], `Unknown check: ${name}`);
    console.log(JSON.stringify({ status: 'PASS', details: checks[name]() }));
  } else {
    const plan = json(planPath);
    assert.equal(plan.phase, 1);
    assert.deepEqual(plan.cases.map((test) => test.testCaseId), plan.requiredCaseIds);
    if (args.includes('--all')) for (const test of plan.cases) executeCase(test.testCaseId.split(':')[1], plan);
    else executeCase(option('--case'), plan);
  }
} catch (error) {
  const failure = { status: 'FAIL', message: error.message, stack: error.stack };
  if (!args.includes('--check')) {
    const plan = json(planPath);
    const target = `docs/evidence/attempts/Phase001/${plan.attemptId}/attempt.json`;
    if (!fs.existsSync(local(target))) writeJson(target, { ...failure, phase: 1, attemptId: plan.attemptId, artifactCommit: null, command: `node docs/phase-plans/verify-phase001.mjs ${args.join(' ')}`, exitCode: 1, generatedAt: new Date().toISOString(), planHash: hash(planPath), sourceHashes: sourceHashes() });
  }
  console.error(JSON.stringify(failure));
  process.exitCode = 1;
}
