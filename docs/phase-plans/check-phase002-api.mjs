import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGeneratedRegistry, forbiddenRoutes, loadRegistry, registryMarkers, validateRegistry } from '../../scripts/generate-api-contract.mjs';

const sha256HexPattern = /^[0-9a-f]{64}$/;
const prefixedSha256Pattern = /^sha256:[0-9a-f]{64}$/;
const primitives = new Set(['NoBody', 'Bytes', 'text', 'Content', 'id', 'integer', 'positiveInteger', 'decimalString', 'Instant', 'ISODate', 'zone', 'UUID', 'RequirementHash', 'Sha256Hex', 'PrefixedSha256', 'Secret', 'Password', 'Cursor', 'Locale', 'Reason', 'Name', 'PageLimit', 'DiversitySeed', 'BasisPoints', 'FingerprintDisplay', 'boolean', 'null']);
const hashFieldTypes = {
  AiDebugSummary: { promptHash: 'Sha256Hex' },
  ReplanRequest: { confirmedRequirementDiffHash: 'nullable:Sha256Hex' },
  VersionDetailReceipt: { requirementHash: 'RequirementHash', workspaceSnapshotHash: 'Sha256Hex' },
  RestoreRequest: { targetRequirementHash: 'RequirementHash', targetWorkspaceHash: 'Sha256Hex' },
  PromptCandidateCreate: { contentHash: 'Sha256Hex' },
  PromptVersion: { contentHash: 'Sha256Hex' },
  ModelDeploymentVersion: { contentHash: 'Sha256Hex' },
  ProviderConfigVersion: { contentHash: 'Sha256Hex' },
  PlanningPolicyVersion: { contentHash: 'Sha256Hex' },
  AnnouncementVersion: { contentHash: 'Sha256Hex' },
  RegressionCandidateCreate: { contentHash: 'Sha256Hex' },
  RegressionCandidate: { contentHash: 'Sha256Hex' },
  FileAsset: { contentHash: 'Sha256Hex' }
};
const publicErrors = { VALIDATION_ERROR: 400, AUTH_REQUIRED: 401, FORBIDDEN: 403, NOT_FOUND: 404, IDEMPOTENCY_KEY_REUSED: 409, VERSION_CONFLICT: 409, PLANNING_IN_PROGRESS: 409, USE_PLAN_MUTATION: 409, REQUIREMENT_CONFIRMATION_REQUIRED: 409, RESYNC_REQUIRED: 410, FEATURE_DISABLED: 503, CONFIG_ERROR: 503, RATE_LIMITED: 429, COST_LIMIT: 429, PROVIDER_UNAVAILABLE: 503, PROVIDER_TIMEOUT: 503, CANCELLED: 409, INTERNAL_ERROR: 500, OPERATION_NOT_AVAILABLE: 409, CONFIRMATION_EXPIRED: 410, REVALIDATION_REQUIRED: 409 };
const serverIdentityFields = new Set(['userId', 'ownerUserId', 'ownerKeyHash', 'anonToken', 'anonTokenHash', 'sessionToken', 'requestId', 'traceId', 'idempotencyKey', 'idempotencyKeyHash', 'receipt', 'receiptHash', 'shareToken']);

export function readApiContract(root) {
  const document = readFileSync(path.join(root, 'docs/api.md'), 'utf8');
  assert.ok(!document.includes('\r'), 'API_DOCUMENT_REQUIRES_LF');
  for (const marker of ['<!-- api-contract:start -->', '<!-- api-contract:end -->']) assert.equal(document.split(marker).length, 2, 'API_DTO_BLOCK_COUNT');
  const pattern = /<!-- api-contract:start -->\s*```json\s*([\s\S]*?)```\s*<!-- api-contract:end -->/g;
  const blocks = [...document.matchAll(pattern)];
  assert.equal(blocks.length, 1, 'API_DTO_BLOCK_COUNT');
  return { document, contract: JSON.parse(blocks[0][1]) };
}

function branches(shape) { return shape.oneOf || [shape]; }

function literal(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^[0-9]+$/.test(value)) return Number(value);
  return value;
}

function typeExists(contract, type) {
  assert.equal(typeof type, 'string', 'API_TYPE_MUST_BE_NAMED');
  if (type.startsWith('nullable:') || type.startsWith('page:') || type.startsWith('widget:') || type.startsWith('sse:')) return typeExists(contract, type.slice(type.indexOf(':') + 1));
  if (type.endsWith('[]')) return typeExists(contract, type.slice(0, -2));
  if (type.startsWith('enum:')) {
    const values = type.slice(5).split('|');
    assert.ok(values.every(value => value.length > 0) && new Set(values).size === values.length, `API_INVALID_ENUM: ${type}`);
    return;
  }
  assert.ok(primitives.has(type) || Object.hasOwn(contract.types, type) || Object.hasOwn(contract.references, type), `API_UNKNOWN_TYPE: ${type}`);
}

function scalarValid(type, value) {
  if (type === 'null') return value === null;
  if (type === 'NoBody') return value === undefined;
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'Bytes') return value instanceof Uint8Array;
  if (type === 'integer' || type === 'positiveInteger') return Number.isSafeInteger(value) && value >= (type === 'positiveInteger' ? 1 : 0);
  if (type === 'PageLimit') return Number.isSafeInteger(value) && value >= 1 && value <= 100;
  if (type === 'DiversitySeed') return Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
  if (type === 'BasisPoints') return Number.isSafeInteger(value) && value >= 0 && value <= 10000;
  if (typeof value !== 'string' || !value.length) return false;
  if (type === 'text') return [...value].length <= 4000;
  if (type === 'Content') return value.trim().length > 0 && [...value.trim()].length <= 4000;
  if (type === 'Name') return [...value].length <= 200 && value.trim().length > 0;
  if (type === 'Reason') return value.trim().length > 0 && [...value.trim()].length <= 500;
  if (type === 'Cursor') return value.length <= 2048 && !/[\r\n\u0000]/.test(value);
  if (type === 'Password') return Buffer.byteLength(value, 'utf8') >= 12 && Buffer.byteLength(value, 'utf8') <= 72;
  if (type === 'FingerprintDisplay') return /^[a-f0-9]{12}…$/.test(value);
  if (type === 'Locale') { try { return Intl.getCanonicalLocales(value).length === 1; } catch { return false; } }
  if (type === 'id') return value.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(value);
  if (type === 'Secret') return Buffer.byteLength(value, 'utf8') <= 16384;
  if (type === 'RequirementHash' || type === 'Sha256Hex') return value.length === 64 && sha256HexPattern.test(value);
  if (type === 'PrefixedSha256') return value.length === 71 && prefixedSha256Pattern.test(value);
  if (type === 'UUID') return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
  if (type === 'decimalString') return /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value);
  if (type === 'ISODate') return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (type === 'Instant') {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
    return !!match && scalarValid('ISODate', match[1]) && Number(match[2]) < 24 && Number(match[3]) < 60 && Number(match[4]) < 60 && Number.isFinite(Date.parse(value));
  }
  if (type === 'zone') { try { new Intl.DateTimeFormat('en', { timeZone: value }); return value.includes('/') || value === 'UTC'; } catch { return false; } }
  return false;
}

export function validateDto(contract, type, value) {
  if (type.startsWith('nullable:')) return value === null || validateDto(contract, type.slice(9), value);
  if (type.startsWith('page:')) return validateShape(contract, { fields: { items: `${type.slice(5)}[]`, nextCursor: 'nullable:Cursor' } }, value);
  if (type.startsWith('widget:')) return validateShape(contract, { oneOf: [{ fields: { status: 'enum:ok', data: type.slice(7) } }, contract.types.WidgetError] }, value);
  if (type.startsWith('sse:')) return validateDto(contract, type.slice(4), value);
  if (type.endsWith('[]')) return Array.isArray(value) && value.length <= 100 && value.every(item => validateDto(contract, type.slice(0, -2), item));
  if (type.startsWith('enum:')) return type.slice(5).split('|').some(item => Object.is(literal(item), value));
  if (primitives.has(type)) return scalarValid(type, value);
  assert.ok(!Object.hasOwn(contract.references, type), `API_REFERENCED_SCHEMA_REQUIRES_ITS_OWNER_VALIDATOR: ${type}`);
  assert.ok(contract.types[type], `API_UNDEFINED_DTO: ${type}`);
  if (!validateShape(contract, contract.types[type], value)) return false;
  return validateRefinements(type, value);
}

function validateRefinements(type, value) {
  if (type === 'SafeCommandError') return Object.hasOwn(publicErrors, value.code) && (value.code !== 'FEATURE_DISABLED' || value.retryable === false);
  if (type === 'SafeWidgetError') return Object.hasOwn(publicErrors, value.code);
  if (type === 'RegisterRequest') return value.password === value.passwordConfirmation;
  if (type === 'ApiKeyPatch') return Object.hasOwn(value, 'name') || Object.hasOwn(value, 'status');
  if (type === 'PlanDraftRequest' || type === 'ChatCommandCreate') return value.content.trim().length > 0 && [...value.content.trim()].length <= 4000;
  if (type === 'RequirementPatchCommand') return value.intent !== 'apply' || value.operations.length > 0;
  if (type === 'ReplanRequest') {
    const changed = value.changedRequirements.map(change => change.path);
    return new Set(changed).size === changed.length && new Set(value.preservedRequirementPaths).size === value.preservedRequirementPaths.length && !changed.some(field => value.preservedRequirementPaths.includes(field)) && (changed.length ? value.confirmedRequirementDiffHash !== null : value.confirmedRequirementDiffHash === null);
  }
  if (type === 'RestoreRequest' || type === 'FinalizeRequest') return new Set(value.acknowledgedWarningCodes).size === value.acknowledgedWarningCodes.length;
  if (type === 'DataRequestStatus' && value.downloadAvailable) return value.type === 'EXPORT' && value.status === 'COMPLETED' && value.expiresAt !== null;
  if (['TraceQuery', 'TravelRecordQuery', 'AuditQuery'].includes(type) && value.from && value.to && value.from > value.to) return false;
  if (type === 'TraceQuery' && value.minimumQuality !== undefined && value.maximumQuality !== undefined) return value.minimumQuality <= value.maximumQuality;
  return true;
}

// Only deterministic document fixtures: no HTTP handler, authentication or event ledger is implemented here.
export function validateEventEnvelope(contract, event, { stream = 'chat', purpose = 'PLAN' } = {}) {
  if (!validateDto(contract, 'EventEnvelope', event)) return false;
  const payload = event.payload;
  if (stream === 'planner') {
    if (event.type !== 'planner.progress' || !['PENDING', 'RUNNING', 'SUCCEEDED', 'BLOCKED', 'FAILED', 'CANCELLED'].includes(event.status) || payload.plannerRunId !== event.aggregateId) return false;
    if (event.status === 'SUCCEEDED' && purpose === 'PLAN') return typeof payload.travelRecordId === 'string' && typeof payload.planVersionId === 'string' && Number.isSafeInteger(payload.planVersion) && payload.planVersion > 0;
    return !Object.hasOwn(payload, 'planVersionId') && !Object.hasOwn(payload, 'planVersion');
  }
  if (stream !== 'chat' || payload.commandId !== event.aggregateId) return false;
  const exact = fields => Object.keys(payload).length === fields.length && fields.every(field => Object.hasOwn(payload, field));
  if (event.type === 'message.accepted') return ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(event.status) && exact(['commandId', 'travelRecordId', 'message', 'conversationCursor']) && payload.message.role === 'USER' && payload.message.travelRecordId === payload.travelRecordId;
  if (event.type === 'assistant.delta') return event.status === 'RUNNING' && exact(['commandId', 'deltaIndex', 'text']);
  if (event.type === 'assistant.completed') return event.status === 'COMPLETED' && exact(['commandId', 'message', 'conversationCursor']) && payload.message.role === 'ASSISTANT';
  if (event.type === 'command.failed') return event.status === 'FAILED' && exact(['commandId', 'error', 'conversationCursor']);
  if (event.type === 'command.cancelled') return event.status === 'CANCELLED' && exact(['commandId', 'error', 'conversationCursor']);
  return false;
}

export function validateReplayEvents(contract, events, options = {}) {
  if (!Array.isArray(events) || events.length > 100) return false;
  let sequence = options.afterSequence ?? 0;
  if (!scalarValid('integer', sequence)) return false;
  let aggregateId;
  let terminalSeen = false;
  const plannerTerminalStatuses = ['SUCCEEDED', 'BLOCKED', 'FAILED', 'CANCELLED'];
  const chatTerminalTypes = ['assistant.completed', 'command.failed', 'command.cancelled'];
  const ids = new Set();
  return events.every(event => {
    if (terminalSeen || !validateEventEnvelope(contract, event, options) || event.type === 'assistant.delta' || event.sequence <= sequence || ids.has(event.eventId)) return false;
    aggregateId ??= event.aggregateId;
    if (event.aggregateId !== aggregateId) return false;
    sequence = event.sequence;
    ids.add(event.eventId);
    terminalSeen = options.stream === 'planner' ? plannerTerminalStatuses.includes(event.status) : chatTerminalTypes.includes(event.type);
    return true;
  });
}

function validateShape(contract, shape, value) {
  if (shape.oneOf) return shape.oneOf.filter(branch => validateShape(contract, branch, value)).length === 1;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const normalized = Object.entries(shape.fields).map(([name, type]) => ({ name: name.replace(/\?$/, ''), type, optional: name.endsWith('?') }));
  if (Object.keys(value).some(name => !normalized.some(field => field.name === name))) return false;
  return normalized.every(field => !Object.hasOwn(value, field.name) ? field.optional : validateDto(contract, field.type, value[field.name]));
}

function validateFieldStructure(contract) {
  assert.deepEqual(Object.keys(contract).sort(), ['version', 'errors', 'forbiddenRoutes', 'references', 'types', 'operations'].sort(), 'API_CONTRACT_KEYS');
  assert.equal(contract.version, 'Phase002-api-v1', 'API_CONTRACT_VERSION');
  assert.ok(!Object.keys(contract.references).some(name => Object.hasOwn(contract.types, name)), 'API_TYPE_OWNER_DUPLICATED');
  for (const [name, definition] of Object.entries(contract.types)) {
    assert.deepEqual(Object.keys(definition), [definition.oneOf ? 'oneOf' : 'fields'], `API_DTO_METADATA: ${name}`);
    assert.ok(Object.hasOwn(definition, 'fields') !== Object.hasOwn(definition, 'oneOf'), `API_DTO_SHAPE: ${name}`);
    if (definition.oneOf) assert.ok(Array.isArray(definition.oneOf) && definition.oneOf.length >= 2, `API_EMPTY_UNION: ${name}`);
    for (const branch of branches(definition)) {
      assert.deepEqual(Object.keys(branch), ['fields'], `API_CLOSED_DEFINITION: ${name}`);
      const normalized = new Set();
      for (const [field, type] of Object.entries(branch.fields)) {
        const fieldName = field.replace(/\?$/, '');
        assert.match(field, name === 'RecordStatusCounts' ? /^(DRAFT|NEEDS_INFO|PLANNED|MODIFIED|FINALIZED|NEEDS_REVALIDATION|ARCHIVED)$/ : /^[A-Za-z][A-Za-z0-9]*\??$/, `API_FIELD_NAME: ${name}.${field}`);
        assert.ok(!normalized.has(fieldName), `API_DUPLICATE_FIELD: ${name}.${fieldName}`);
        normalized.add(fieldName);
        typeExists(contract, type);
      }
    }
  }
}

function validateHashFieldTypes(contract) {
  for (const [owner, fields] of Object.entries(hashFieldTypes)) {
    assert.ok(contract.types[owner], `API_HASH_DTO_MISSING: ${owner}`);
    for (const branch of branches(contract.types[owner])) for (const [field, type] of Object.entries(fields)) {
      assert.equal(branch.fields[field], type, `API_HASH_TYPE: ${owner}.${field}`);
    }
  }
  let fieldCount = 0;
  for (const [owner, shape] of Object.entries(contract.types)) for (const branch of branches(shape)) for (const [field, type] of Object.entries(branch.fields)) {
    if (!/Hash\??$/.test(field) && !/(?:RequirementHash|Sha256Hex|PrefixedSha256)/.test(type)) continue;
    assert.equal(hashFieldTypes[owner]?.[field], type, `API_HASH_FIELD_NOT_AUDITED: ${owner}.${field}`);
    fieldCount += 1;
  }
  return fieldCount;
}

function validateRequirementHashOwner(summarySchema) {
  assert.ok(summarySchema.required.includes('requirementHash'), 'API_REQUIREMENT_HASH_OWNER_REQUIRED');
  assert.equal(summarySchema.properties.requirementHash.type, 'string', 'API_REQUIREMENT_HASH_OWNER_TYPE');
  assert.equal(summarySchema.properties.requirementHash.pattern, sha256HexPattern.source, 'API_REQUIREMENT_HASH_OWNER_PATTERN');
}

function verifyHashContracts(root, contract, inputs) {
  const schemaDocument = readFileSync(path.join(root, 'docs/travel-plan-schema.md'), 'utf8');
  const summaryBlocks = [...schemaDocument.matchAll(/<!-- contract:travel-summary-v1 -->\s*```json\s*([\s\S]*?)```/g)];
  assert.equal(summaryBlocks.length, 1, 'API_REQUIREMENT_HASH_OWNER_SCHEMA');
  const summarySchema = JSON.parse(summaryBlocks[0][1]);
  validateRequirementHashOwner(summarySchema);
  const pinnedSource = id => {
    const pins = inputs.pinnedInputs.filter(input => input.id === id);
    assert.equal(pins.length, 1, `API_HASH_SOURCE_PIN: ${id}`);
    const bytes = readFileSync(path.join(root, pins[0].path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), pins[0].sha256, `API_HASH_SOURCE_DRIFT: ${id}`);
    return bytes.toString('utf8');
  };
  assert.ok(pinnedSource('Phase015').includes('hash 为 canonical bytes 的 64 位 SHA-256'), 'API_GOVERNANCE_HASH_ENCODING');
  assert.ok(pinnedSource('Phase025').includes('三个 hash 均为 `sha256:<64 lowercase hex>`'), 'API_PLAN_HASH_ENCODING');
  assert.ok(pinnedSource('Phase043').includes('格式 `sha256:<64 lowercase hex>`'), 'API_EXECUTION_HASH_ENCODING');
  const database = readFileSync(path.join(root, 'docs/database.md'), 'utf8');
  for (const owner of ['AnnouncementVersion', 'FileAsset']) {
    const section = database.split(/^### /m).find(part => part.split('\n')[0].endsWith(` ${owner}`));
    assert.ok(section, `API_HASH_DATABASE_OWNER: ${owner}`);
    assert.match(section, /^\| contentHash \| Char\(64\) \|/m, `API_HASH_DATABASE_ENCODING: ${owner}.contentHash`);
  }
  return { fieldCount: validateHashFieldTypes(contract), requirementPattern: summarySchema.properties.requirementHash.pattern, sha256HexPattern: sha256HexPattern.source, prefixedSha256Pattern: prefixedSha256Pattern.source, summarySchema };
}

function identityAliases(route) {
  const names = [...route.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
  if (route.includes('/travel-records/')) names.push('recordId', 'travelRecordId');
  if (route.includes('/travel-plan-versions/')) names.push('sourcePlanVersionId', 'travelRecordId');
  if (route.includes('/planner-runs/')) names.push('plannerRunId', 'runId');
  if (route.includes('/chat-commands/')) names.push('commandId');
  if (route.includes('/users/')) names.push('userId');
  if (route.includes('/api-keys/')) names.push('keyId', 'replacesId');
  return new Set(names);
}

export function verifyApi(root) {
  const generated = checkGeneratedRegistry(root);
  const { manifest } = loadRegistry(root);
  const { document, contract } = readApiContract(root);
  assert.equal(generated.registryCount, 100, 'API_FROZEN_OPERATION_DENOMINATOR');
  assert.deepEqual(Object.keys(contract.operations).sort(), manifest.apiRegistry.map(item => item.operationId).sort(), 'API_OPERATION_COVERAGE');
  validateFieldStructure(contract);
  const layout = JSON.parse(readFileSync(path.join(root, 'docs/project-layout.json'), 'utf8'));
  const inputs = JSON.parse(readFileSync(path.join(root, 'docs/phase-plans/Phase002-inputs.json'), 'utf8'));
  const hashContracts = verifyHashContracts(root, contract, inputs);
  const inputPins = new Map(inputs.pinnedInputs.map(input => [input.path.replaceAll('\\', '/'), input.sha256]));
  for (const [name, source] of Object.entries(contract.references)) {
    const sourcePath = source.split(': ')[0].replace('roadmapRoot/', `${layout.roadmapRoot}/`);
    assert.ok(existsSync(path.join(root, sourcePath)), `API_REFERENCE_SOURCE_MISSING: ${name}`);
    assert.ok(source.includes(': '), `API_REFERENCE_MUST_NAME_CONTRACT: ${name}`);
    if (source.startsWith('roadmapRoot/')) {
      assert.ok(inputPins.has(sourcePath), `API_REFERENCE_NOT_PINNED: ${name}`);
      assert.equal(createHash('sha256').update(readFileSync(path.join(root, sourcePath))).digest('hex'), inputPins.get(sourcePath), `API_REFERENCE_HASH_DRIFT: ${name}`);
    } else assert.ok(['docs/travel-plan-schema.md', 'docs/prompt-design.md', 'docs/travel-data-provider-strategy.md'].includes(sourcePath), `API_FUTURE_PROJECT_DEPENDENCY: ${name}`);
  }
  const outsideRegistry = document.slice(0, document.indexOf(registryMarkers[0])) + document.slice(document.indexOf(registryMarkers[1]) + registryMarkers[1].length);
  assert.ok(!/^\|[^\n]*\b(?:GET|POST|PATCH|PUT|DELETE)\b[^\n]*\/api\/[^\n]*\|\s*$/m.test(outsideRegistry), 'API_SECOND_ENDPOINT_TABLE');
  const implementedRoutes = verifyRegisteredRoutes(root, manifest);
  for (const operation of manifest.apiRegistry) {
    const mapping = contract.operations[operation.operationId];
    assert.ok(Object.keys(mapping).every(key => ['request', 'query', 'response', 'http'].includes(key)), `API_SECOND_REGISTRY: ${operation.operationId}`);
    assert.ok(['request', 'response', 'http'].every(key => Object.hasOwn(mapping, key)), `API_INCOMPLETE_OPERATION_DTO: ${operation.operationId}`);
    assert.ok(Number.isInteger(mapping.http) && mapping.http >= 200 && mapping.http < 300, 'API_SUCCESS_HTTP_REQUIRED');
    for (const type of [mapping.request, mapping.response, mapping.query].filter(Boolean)) typeExists(contract, type);
    const identity = identityAliases(operation.path);
    for (const branch of branches(contract.types[mapping.request] || { fields: {} })) {
      for (const field of Object.keys(branch.fields)) {
        const name = field.replace(/\?$/, '');
        assert.ok(!identity.has(name), `API_PATH_ID_REPEATED: ${operation.operationId}.${field}`);
        assert.ok(!serverIdentityFields.has(name), `API_SERVER_IDENTITY_IN_BODY: ${operation.operationId}.${field}`);
      }
      if (operation.cas === 'command CAS') assert.equal(branch.fields.expectedCommandState, 'enum:PENDING|RUNNING', 'API_COMMAND_CAS');
      else if (operation.cas === 'run CAS') assert.equal(branch.fields.expectedRunState, 'enum:PENDING|RUNNING', 'API_RUN_CAS');
      else if (operation.cas === 'profile revision') assert.equal(branch.fields.expectedProfileVersion, 'integer', 'API_PROFILE_CAS');
      else if (!['NONE', '新记录无需 baseRevision', 'fixed source authorization; target new record', 'version fixed', 'policy fixed', 'fixed version'].includes(operation.cas)) {
        const fields = new Set(Object.keys(branch.fields).map(name => name.replace(/\?$/, '')));
        const expected = operation.cas.startsWith('expectedCurrentVersion') ? ['expectedCurrentVersion', 'expectedRequirementRevision'] : operation.cas.startsWith('expectedRequirementRevision') ? ['expectedRequirementRevision'] : ['expectedVersion'];
        for (const name of expected) assert.ok(fields.has(name), `API_CAS_FIELD_MISSING: ${operation.operationId}.${name}`);
      }
    }
    if (mapping.query) for (const branch of branches(contract.types[mapping.query])) for (const field of Object.keys(branch.fields)) assert.ok(!identity.has(field.replace(/\?$/, '')), `API_PATH_ID_IN_QUERY: ${operation.operationId}.${field}`);
    for (const error of operation.errors) assert.ok(Object.hasOwn(contract.errors, error), `API_UNMAPPED_ERROR: ${operation.operationId}.${error}`);
    if (operation.method === 'GET') assert.equal(mapping.request, 'NoBody', 'API_GET_BODY');
    if (operation.method !== 'GET' && operation.idempotency !== 'COOKIE_REUSE') assert.notEqual(operation.idempotency, 'NONE', 'API_WRITE_IDEMPOTENCY');
  }
  assert.deepEqual(contract.errors, publicErrors, 'API_ERROR_MAPPING');
  assert.deepEqual(Object.keys(contract.types.RecordStatusCounts.fields), ['DRAFT', 'NEEDS_INFO', 'PLANNED', 'MODIFIED', 'FINALIZED', 'NEEDS_REVALIDATION', 'ARCHIVED'], 'API_RECORD_STATUS_COUNTS');
  assert.deepEqual(Object.keys(contract.types.EventEnvelope.fields), ['eventId', 'sequence', 'aggregateId', 'traceId', 'type', 'status', 'occurredAt', 'payloadVersion', 'payload']);
  for (const branch of branches(contract.types.MinimalDataRequestStatus)) assert.deepEqual(Object.keys(branch.fields), ['id', 'type', 'status', 'completedAt', 'errorCategory']);
  assert.deepEqual(Object.keys(contract.types.FeedbackConsentsPatch.fields), ['expectedVersion', 'contactConsent', 'evaluationConsent']);
  assert.equal(contract.operations['post.auth.register'].http, 202);
  assert.deepEqual(Object.keys(contract.types.UserReceipt.fields), ['accepted', 'nextAction']);
  assert.equal(contract.types.TravelProfilePatch.fields.expectedProfileVersion, 'integer');
  for (const branch of branches(contract.types.ProviderConfigCreate)) assert.equal(branch.fields.secretRef, branch.fields.credentialRequirement === 'enum:NONE' ? 'null' : 'id', 'API_PROVIDER_CREDENTIAL_BRANCH');
  for (const required of ['INVALID_JSON', 'SCHEMA_MISMATCH', 'SECRET_DECRYPT_FAILED', 'retryable=false', 'Last-Event-ID', 'assistant.delta', 'deltaIndex', 'PrivacyRevocationLedger', 'tokenAvailable=false', 'X-Data-Request-Receipt', 'X-Feedback-Receipt', 'X-Share-Token', 'CONSENT_WITHDRAWAL', 'authorizeExportSend', 'expectedRequirementRevision', 'RESTORE_TARGET', 'BOOTSTRAP_ANONYMOUS_SESSION', 'SourceSummary', 'sourceLocator/contentHash', 'sequence_only', '至少24小时']) assert.ok(document.includes(required), `API_REQUIRED_RULE: ${required}`);
  for (const file of ['auth.md', 'admin.md', 'crypto.md']) assert.ok(existsSync(path.join(root, 'docs', file)), `API_SUPPORT_MISSING: ${file}`);

  const fixtureResults = [];
  const test = (name, type, value, expected) => {
    const actual = validateDto(contract, type, value);
    assert.equal(actual, expected, `API_FIXTURE: ${name}`);
    fixtureResults.push({ name, expected, actual });
  };
  const bareHash = 'a'.repeat(64);
  for (const [owner, fields] of Object.entries(hashFieldTypes)) for (const field of Object.keys(fields)) {
    const type = branches(contract.types[owner])[0].fields[field];
    test(`hash-${owner}.${field}-bare-hex`, type, bareHash, true);
    test(`hash-${owner}.${field}-rejects-prefix`, type, `sha256:${bareHash}`, false);
  }
  for (const type of ['RequirementHash', 'Sha256Hex']) {
    test(`${type}-rejects-uppercase`, type, 'A'.repeat(64), false);
    test(`${type}-rejects-short`, type, 'a'.repeat(63), false);
    test(`${type}-rejects-long`, type, 'a'.repeat(65), false);
    test(`${type}-rejects-non-hex`, type, 'g'.repeat(64), false);
    test(`${type}-rejects-newline`, type, `${bareHash}\n`, false);
  }
  test('plan-hash-requires-prefix', 'PrefixedSha256', `sha256:${bareHash}`, true);
  test('plan-hash-rejects-requirement-format', 'PrefixedSha256', bareHash, false);
  test('plan-hash-rejects-uppercase', 'PrefixedSha256', `sha256:${'A'.repeat(64)}`, false);
  test('plan-hash-rejects-short', 'PrefixedSha256', `sha256:${'a'.repeat(63)}`, false);
  test('plan-hash-rejects-newline', 'PrefixedSha256', `sha256:${bareHash}\n`, false);
  const rejectHashType = (name, owner, field) => {
    const copy = structuredClone(contract);
    copy.types[owner].fields[field] = 'PrefixedSha256';
    assert.throws(() => validateHashFieldTypes(copy), error => error.message.includes(`API_HASH_TYPE: ${owner}.${field}`), `API_HASH_FIXTURE: ${name}`);
    fixtureResults.push({ name, expected: false, actual: false, fixtureMode: 'IN_MEMORY_COPY' });
  };
  rejectHashType('version-requirement-hash-cannot-drift', 'VersionDetailReceipt', 'requirementHash');
  rejectHashType('restore-workspace-hash-cannot-drift', 'RestoreRequest', 'targetWorkspaceHash');
  rejectHashType('file-content-hash-cannot-drift', 'FileAsset', 'contentHash');
  const changedSummaryHash = structuredClone(hashContracts.summarySchema);
  changedSummaryHash.properties.requirementHash.pattern = prefixedSha256Pattern.source;
  assert.throws(() => validateRequirementHashOwner(changedSummaryHash), error => error.message.includes('API_REQUIREMENT_HASH_OWNER_PATTERN'));
  fixtureResults.push({ name: 'requirement-owner-pattern-drift-rejected', expected: false, actual: false, fixtureMode: 'IN_MEMORY_COPY' });
  test('export-create-exact', 'DataRequestCreate', { type: 'EXPORT', expectedVersion: 0 }, true);
  test('export-prohibits-reauthentication', 'DataRequestCreate', { type: 'EXPORT', expectedVersion: 0, reauthentication: { password: 'synthetic-only', confirmErasure: true } }, false);
  test('erase-requires-reauthentication', 'DataRequestCreate', { type: 'ERASE', expectedVersion: 0 }, false);
  test('erase-explicit-confirmation', 'DataRequestCreate', { type: 'ERASE', expectedVersion: 0, reauthentication: { password: 'synthetic-only', confirmErasure: true } }, true);
  test('erase-false-confirmation', 'DataRequestCreate', { type: 'ERASE', expectedVersion: 0, reauthentication: { password: 'synthetic-only', confirmErasure: false } }, false);
  test('data-body-rejects-receipt', 'DataRequestCreate', { type: 'EXPORT', expectedVersion: 0, receipt: 'synthetic-only' }, false);
  test('data-receipt-no-download', 'MinimalDataRequestStatus', { id: 'request_1', type: 'EXPORT', status: 'COMPLETED', completedAt: '2026-09-09T00:00:00Z', errorCategory: null, downloadUrl: '/private' }, false);
  test('feedback-consents-exact', 'FeedbackConsentsPatch', { expectedVersion: 0, contactConsent: false, evaluationConsent: false }, true);
  test('feedback-consents-reject-partial', 'FeedbackConsentsPatch', { expectedVersion: 0, evaluationConsent: false }, false);
  test('feedback-body-rejects-version', 'FeedbackCreateRequest', { category: 'OTHER', severityHint: 'low', description: 'Synthetic issue', expectedOutcome: 'Synthetic correction', planVersionId: 'version_1' }, false);
  const share = { shareId: 'share_1', planVersionId: 'version_1', status: 'ACTIVE', revision: 0, expiresAt: null };
  test('share-first-secret', 'ShareGrantReceipt', { ...share, tokenAvailable: true, token: 'synthetic-secret', replayed: false }, true);
  test('share-replay-no-secret', 'ShareGrantReceipt', { ...share, tokenAvailable: false, replayed: true }, true);
  test('share-replay-reject-secret', 'ShareGrantReceipt', { ...share, tokenAvailable: false, token: 'synthetic-secret', replayed: true }, false);
  test('share-first-reject-missing-secret', 'ShareGrantReceipt', { ...share, tokenAvailable: true, replayed: false }, false);
  test('planner-cancel-exact', 'PlannerCancelRequest', { expectedRunState: 'RUNNING' }, true);
  test('planner-cancel-reject-id', 'PlannerCancelRequest', { expectedRunState: 'RUNNING', plannerRunId: 'run_1' }, false);
  test('confirmation-select-exact', 'ConfirmationDecision', { kind: 'SELECT', choiceId: 'choice_1' }, true);
  test('confirmation-cancel-no-choice', 'ConfirmationDecision', { kind: 'CANCEL', choiceId: 'choice_1' }, false);
  test('favorite-null-is-clear', 'FavoritePutRequest', { note: null }, true);
  test('favorite-absent-is-preserve', 'FavoritePutRequest', {}, true);
  test('public-registration-no-enumeration', 'UserReceipt', { accepted: true, nextAction: 'LOGIN', userId: 'user_1' }, false);
  test('provider-no-fourth-availability', 'ProviderHealth', { hasResult: true, availability: 'unknown', checkedAt: '2026-09-09T00:00:00Z', durationMs: 0, capability: 'geocoding', errorCategory: null }, false);
  test('provider-no-result-explicit', 'ProviderHealth', { hasResult: false }, true);
  test('restore-requires-target-hash', 'RestoreRequest', { restoreVersion: 1, expectedCurrentVersion: 2, expectedRequirementRevision: 3, requirementStrategy: 'RESTORE_TARGET', targetRequirementHash: bareHash, acknowledgedWarningCodes: [] }, false);
  test('erase-cannot-fail', 'MinimalDataRequestStatus', { id: 'request_1', type: 'ERASE', status: 'FAILED', completedAt: null, errorCategory: 'STORAGE_UNAVAILABLE' }, false);
  test('export-can-fail', 'MinimalDataRequestStatus', { id: 'request_1', type: 'EXPORT', status: 'FAILED', completedAt: null, errorCategory: 'STORAGE_UNAVAILABLE' }, true);
  test('erase-continuation-status', 'MinimalDataRequestStatus', { id: 'request_1', type: 'ERASE', status: 'RUNNING', completedAt: null, errorCategory: 'STORAGE_UNAVAILABLE' }, true);
  const dataStatus = { id: 'request_1', type: 'ERASE', status: 'RUNNING', revision: 0, createdAt: '2026-09-09T00:00:00Z', startedAt: '2026-09-09T00:00:00Z', completedAt: null, errorCategory: null, downloadAvailable: false, expiresAt: null };
  test('erase-owner-status-no-download', 'DataRequestStatus', dataStatus, true);
  test('erase-owner-status-rejects-download', 'DataRequestStatus', { ...dataStatus, downloadAvailable: true }, false);
  test('export-not-ready-rejects-download', 'DataRequestStatus', { ...dataStatus, type: 'EXPORT', downloadAvailable: true, expiresAt: '2026-09-10T00:00:00Z' }, false);
  test('page-limit-upper-bound', 'PageQuery', { limit: 100 }, true);
  test('page-limit-rejects-unbounded', 'PageQuery', { limit: 101 }, false);
  test('cursor-rejects-oversize', 'PageQuery', { cursor: 'c'.repeat(2049) }, false);
  test('trace-detail-uses-page-size', 'TracePageQuery', { pageSize: 50 }, true);
  test('trace-detail-rejects-limit-alias', 'TracePageQuery', { limit: 50 }, false);
  test('trace-quality-range-reversed', 'TraceQuery', { minimumQuality: 90, maximumQuality: 40 }, false);
  test('widget-array-data', 'widget:AuditSummary[]', { status: 'ok', data: [] }, true);
  test('widget-error-is-not-zero', 'widget:UserStats', { status: 'error', error: { code: 'INTERNAL_ERROR', requestId: 'request_1' } }, true);
  test('widget-rejects-failure-as-zero', 'widget:UserStats', 0, false);
  test('public-safe-error-known-code', 'SafeCommandError', { code: 'CONFIG_ERROR', message: 'Synthetic unavailable configuration', retryable: false }, true);
  test('public-safe-error-no-decryption-classification', 'SafeCommandError', { code: 'SECRET_DECRYPT_FAILED', message: 'Synthetic classification', retryable: false }, false);
  test('disabled-feature-not-retryable', 'SafeCommandError', { code: 'FEATURE_DISABLED', message: 'Synthetic disabled feature', retryable: true }, false);
  test('api-key-no-empty-patch', 'ApiKeyPatch', { expectedVersion: 1 }, false);
  test('api-key-no-plaintext-patch', 'ApiKeyPatch', { name: 'synthetic', expectedVersion: 1, plainKey: 'synthetic-only' }, false);
  test('api-key-display-bounded', 'FingerprintDisplay', 'abcdef012345…', true);
  test('api-key-display-no-full-hash', 'FingerprintDisplay', 'a'.repeat(64), false);
  test('audit-reason-trimmed', 'Reason', 'synthetic reason', true);
  test('audit-reason-rejects-whitespace', 'Reason', '   ', false);
  test('password-utf8-boundary', 'Password', '合'.repeat(24), true);
  test('password-no-bcrypt-truncation', 'Password', '合'.repeat(25), false);
  test('password-too-short', 'Password', 'short', false);
  test('registration-password-confirmation', 'RegisterRequest', { email: 'synthetic@example.invalid', password: 'synthetic-password', passwordConfirmation: 'different-password' }, false);
  test('instant-rejects-normalized-invalid-date', 'Instant', '2026-02-30T00:00:00Z', false);
  test('instant-rejects-next-day-midnight-alias', 'Instant', '2026-09-09T24:00:00Z', false);
  const draft = { content: 'Synthetic request', planningMode: 'quick', clientRequestId: '00000000-0000-4000-8000-000000000001', locale: 'zh-CN', timezone: 'Asia/Shanghai' };
  test('draft-exact-request', 'PlanDraftRequest', draft, true);
  test('draft-server-owner-only', 'PlanDraftRequest', { ...draft, userId: 'user_1' }, false);
  test('draft-no-header-in-body', 'PlanDraftRequest', { ...draft, idempotencyKey: 'synthetic-key' }, false);
  test('draft-no-whitespace-content', 'PlanDraftRequest', { ...draft, content: ' \n ' }, false);
  test('draft-length-after-trim', 'PlanDraftRequest', { ...draft, content: ` ${'a'.repeat(4000)} ` }, true);
  test('draft-valid-locale-required', 'PlanDraftRequest', { ...draft, locale: 'not_a_locale' }, false);
  const confirmation = { clientMessageId: draft.clientRequestId, content: 'Synthetic confirmation', expectedVersion: 1, expectedRequirementRevision: 2, confirmation: { sourceCommandId: 'command_1', clarificationId: 'clarification_1', confirmationToken: 'synthetic-signature', decision: { kind: 'SELECT', choiceId: 'choice_1' } } };
  test('confirmation-command-exact', 'ChatCommandCreate', confirmation, true);
  test('confirmation-prohibits-mutation', 'ChatCommandCreate', { ...confirmation, mutation: {} }, false);
  test('confirmation-prohibits-client-causation', 'ChatCommandCreate', { ...confirmation, causationId: 'command_2' }, false);
  const missingRevision = structuredClone(confirmation);
  delete missingRevision.expectedRequirementRevision;
  test('confirmation-requires-requirement-cas', 'ChatCommandCreate', missingRevision, false);
  test('question-answer-exact', 'RequirementOperation', { operation: 'answer_question', questionId: 'question_1', choiceId: 'choice_1' }, true);
  test('question-answer-one-value', 'RequirementOperation', { operation: 'answer_question', questionId: 'question_1', choiceId: 'choice_1', value: 'extra' }, false);
  test('requirement-apply-needs-answer', 'RequirementPatchCommand', { clientRequestId: draft.clientRequestId, expectedRequirementRevision: 0, intent: 'apply', operations: [] }, false);
  test('requirement-empty-continue', 'RequirementPatchCommand', { clientRequestId: draft.clientRequestId, expectedRequirementRevision: 0, intent: 'continue', operations: [] }, true);
  const replan = { expectedVersion: 1, expectedRequirementRevision: 2, mode: 'FULL', changedRequirements: [], preservedRequirementPaths: [], diversitySeed: 0, avoidPreviousChoices: [], confirmedRequirementDiffHash: null };
  test('replan-full-exact', 'ReplanRequest', replan, true);
  test('replan-full-no-from-day', 'ReplanRequest', { ...replan, fromDayId: 'day_1' }, false);
  test('replan-from-day-explicit', 'ReplanRequest', { ...replan, mode: 'FROM_DAY', fromDayId: 'day_1' }, true);
  test('replan-alternative-needs-goal', 'ReplanRequest', { ...replan, mode: 'ALTERNATIVE' }, false);
  test('replan-seed-bounded', 'ReplanRequest', { ...replan, diversitySeed: 2147483648 }, false);
  test('replan-no-arbitrary-requirement-path', 'ReplanRequest', { ...replan, preservedRequirementPaths: ['profile.private'] }, false);
  test('replan-preserved-paths-unique', 'ReplanRequest', { ...replan, preservedRequirementPaths: ['budget', 'budget'] }, false);
  test('replan-empty-change-hash-null', 'ReplanRequest', { ...replan, confirmedRequirementDiffHash: bareHash }, false);
  const restore = { restoreVersion: 1, expectedCurrentVersion: 2, expectedRequirementRevision: 3, requirementStrategy: 'RESTORE_TARGET', targetRequirementHash: bareHash, targetWorkspaceHash: 'b'.repeat(64), acknowledgedWarningCodes: [] };
  test('restore-explicit-target-hashes', 'RestoreRequest', restore, true);
  test('restore-rejects-prefixed-requirement-hash', 'RestoreRequest', { ...restore, targetRequirementHash: `sha256:${bareHash}` }, false);
  test('restore-rejects-prefixed-workspace-hash', 'RestoreRequest', { ...restore, targetWorkspaceHash: `sha256:${'b'.repeat(64)}` }, false);
  test('restore-warning-codes-unique', 'RestoreRequest', { ...restore, acknowledgedWarningCodes: ['STALE', 'STALE'] }, false);
  const run = { plannerRunId: 'run_1', status: 'SUCCEEDED', stage: 'SAVED', planVersionId: 'version_1', planVersion: 1, error: null, eventsUrl: '/api/planner-runs/run_1/events', cancelUrl: '/api/planner-runs/run_1/cancel', replayed: false };
  test('planner-success-binds-version', 'PlannerRunReceipt', run, true);
  test('planner-failure-has-no-version', 'PlannerRunReceipt', { ...run, status: 'FAILED' }, false);
  test('planner-success-cannot-omit-version', 'PlannerRunReceipt', { ...run, planVersionId: null, planVersion: null }, false);

  const eventFixture = (name, value, options, expected) => {
    const actual = validateEventEnvelope(contract, value, options);
    assert.equal(actual, expected, `API_EVENT_FIXTURE: ${name}`);
    fixtureResults.push({ name, expected, actual });
  };
  const event = { eventId: 'event_1', sequence: 1, aggregateId: 'run_1', traceId: 'trace_1', type: 'planner.progress', status: 'SUCCEEDED', occurredAt: '2026-09-09T00:00:00Z', payloadVersion: 1, payload: { plannerRunId: 'run_1', stageCode: 'SAVED', travelRecordId: 'record_1', planVersionId: 'version_1', planVersion: 1 } };
  eventFixture('planner-event-success-exact-version', event, { stream: 'planner' }, true);
  eventFixture('planner-event-success-needs-version', { ...event, payload: { plannerRunId: 'run_1', stageCode: 'SAVED' } }, { stream: 'planner' }, false);
  eventFixture('planner-event-failure-cannot-publish-version', { ...event, status: 'FAILED' }, { stream: 'planner' }, false);
  eventFixture('planner-event-no-second-envelope-field', { ...event, planVersionId: 'version_1' }, { stream: 'planner' }, false);
  const delta = { ...event, aggregateId: 'command_1', type: 'assistant.delta', status: 'RUNNING', payload: { commandId: 'command_1', deltaIndex: 0, text: 'Synthetic delta' } };
  eventFixture('assistant-delta-only-payload', delta, { stream: 'chat' }, true);
  eventFixture('assistant-delta-owner-aggregate-matches', { ...delta, aggregateId: 'command_2' }, { stream: 'chat' }, false);
  eventFixture('assistant-delta-not-terminal', { ...delta, status: 'COMPLETED' }, { stream: 'chat' }, false);
  eventFixture('eof-not-domain-event', { ...delta, type: 'stream.completed' }, { stream: 'chat' }, false);
  const replayFixture = (name, events, options, expected) => {
    const actual = validateReplayEvents(contract, events, options);
    assert.equal(actual, expected, `API_REPLAY_FIXTURE: ${name}`);
    fixtureResults.push({ name, expected, actual, fixtureMode: 'DOCUMENT_EVENT_SEQUENCE' });
  };
  const runningProgress = { ...event, eventId: 'event_running', sequence: 8, status: 'RUNNING', payload: { plannerRunId: 'run_1', stageCode: 'VALIDATING' } };
  replayFixture('durable-planner-event-replay', [event], { stream: 'planner' }, true);
  replayFixture('delta-never-in-durable-replay', [delta], { stream: 'chat' }, false);
  replayFixture('durable-event-id-unique', [runningProgress, { ...runningProgress, sequence: 9 }], { stream: 'planner' }, false);
  replayFixture('durable-sequence-unique', [runningProgress, { ...runningProgress, eventId: 'event_2' }], { stream: 'planner' }, false);
  replayFixture('replay-after-checkpoint-only', [event], { stream: 'planner', afterSequence: 1 }, false);
  const plannerFailed = { ...runningProgress, eventId: 'event_failed', sequence: 9, status: 'FAILED' };
  const completedMessage = { messageId: 'message_2', travelRecordId: 'record_1', sequence: 2, role: 'ASSISTANT', kind: 'TEXT', content: 'Synthetic result', createdAt: event.occurredAt, replyToMessageId: 'message_1' };
  const completed = { ...event, eventId: 'completed_1', sequence: 8, aggregateId: 'command_1', type: 'assistant.completed', status: 'COMPLETED', payload: { commandId: 'command_1', message: completedMessage, conversationCursor: 'cursor_2' } };
  const failed = { ...completed, eventId: 'failed_1', sequence: 9, type: 'command.failed', status: 'FAILED', payload: { commandId: 'command_1', error: { code: 'INTERNAL_ERROR', message: 'Synthetic failure', retryable: false }, conversationCursor: 'cursor_2' } };
  const cancelled = { ...failed, eventId: 'cancelled_1', type: 'command.cancelled', status: 'CANCELLED', payload: { ...failed.payload, error: { code: 'CANCELLED', message: 'Synthetic cancellation', retryable: false } } };
  const accepted = { ...completed, eventId: 'accepted_1', sequence: 7, type: 'message.accepted', status: 'PENDING', payload: { commandId: 'command_1', travelRecordId: 'record_1', message: { ...completedMessage, messageId: 'message_1', sequence: 1, role: 'USER', replyToMessageId: null }, conversationCursor: 'cursor_1' } };
  for (const frame of [completed, failed, cancelled, accepted]) eventFixture(`replay-frame-${frame.type}-valid`, frame, { stream: 'chat' }, true);
  replayFixture('chat-replay-valid-mid-window', [accepted, completed], { stream: 'chat', afterSequence: 6 }, true);
  for (const terminal of [completed, failed, cancelled]) {
    replayFixture(`chat-replay-${terminal.status}-single-terminal-window`, [terminal], { stream: 'chat', afterSequence: terminal.sequence - 1 }, true);
    replayFixture(`chat-accepted-current-${terminal.status}-then-terminal`, [{ ...accepted, status: terminal.status }, terminal], { stream: 'chat', afterSequence: 6 }, true);
  }
  replayFixture('chat-replay-mutually-exclusive-terminals', [completed, failed], { stream: 'chat' }, false);
  replayFixture('chat-replay-failed-cannot-complete', [failed, { ...completed, eventId: 'completed_2', sequence: 10 }], { stream: 'chat' }, false);
  replayFixture('chat-replay-cancelled-cannot-fail', [cancelled, { ...failed, eventId: 'failed_2', sequence: 10 }], { stream: 'chat' }, false);
  replayFixture('chat-replay-no-duplicate-terminal-new-event-id', [completed, { ...completed, eventId: 'completed_2', sequence: 9 }], { stream: 'chat' }, false);
  replayFixture('chat-replay-no-message-after-terminal', [completed, { ...accepted, sequence: 9 }], { stream: 'chat' }, false);
  replayFixture('planner-replay-valid-mid-window', [runningProgress, plannerFailed], { stream: 'planner', afterSequence: 7 }, true);
  replayFixture('planner-replay-no-second-terminal', [event, plannerFailed], { stream: 'planner' }, false);
  replayFixture('planner-replay-no-progress-after-terminal', [event, runningProgress], { stream: 'planner' }, false);
  for (const status of ['SUCCEEDED', 'BLOCKED', 'FAILED', 'CANCELLED']) {
    const terminal = status === 'SUCCEEDED' ? { ...event, sequence: 8 } : { ...plannerFailed, sequence: 8, status };
    replayFixture(`planner-replay-${status}-single-frame`, [terminal], { stream: 'planner', afterSequence: 7 }, true);
    replayFixture(`planner-replay-${status}-rejects-progress`, [terminal, { ...runningProgress, sequence: 9 }], { stream: 'planner' }, false);
  }

  const rejectRegistry = (name, mutate, code) => {
    const copy = structuredClone(manifest);
    mutate(copy);
    assert.throws(() => validateRegistry(copy), error => error.message.includes(code), `API_REGISTRY_FIXTURE: ${name}`);
    fixtureResults.push({ name, expected: false, actual: false, rejectedBy: code, fixtureMode: 'IN_MEMORY_COPY' });
  };
  rejectRegistry('registry-duplicate-endpoint', copy => { copy.apiRegistry.push({ ...copy.apiRegistry[0], operationId: 'synthetic.duplicate' }); }, 'API_DUPLICATE_ENDPOINT');
  rejectRegistry('registry-producer-mismatch', copy => { copy.apiRegistry[0].producerPhase += 1; }, 'API_PRODUCER_MISMATCH');
  rejectRegistry('registry-forbidden-route', copy => { copy.apiRegistry[0].path = forbiddenRoutes[0]; }, 'API_FORBIDDEN_ROUTE');
  const { summarySchema, ...hashEncoding } = hashContracts;
  return { ...generated, operationDtoCount: Object.keys(contract.operations).length, closedDtoCount: Object.keys(contract.types).length, namedReferenceCount: Object.keys(contract.references).length, hashEncoding, fixtureCount: fixtureResults.length, fixtureResults, implementedRoutes, verificationMode: 'DOCUMENT_SCHEMA_AND_CONTRACT_CHECKS', runtimeHttpRequests: 0 };
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function routePath(root, file) {
  const parts = path.relative(path.join(root, 'src/app'), path.dirname(file)).split(path.sep).filter(part => !/^\(.+\)$/.test(part) && !part.startsWith('@'));
  const logical = `/${parts.join('/')}`;
  if (logical === '/api/auth/[...nextauth]') return logical;
  return logical.replace(/\[([A-Za-z][A-Za-z0-9]*)\]/g, '{$1}');
}

export function verifyRegisteredRoutes(root, manifest = loadRegistry(root).manifest) {
  const allowed = new Set(manifest.apiRegistry.map(operation => `${operation.method} ${operation.path}`));
  const files = walk(path.join(root, 'src/app')).filter(file => /(?:^|[\\/])route\.[cm]?[jt]sx?$/.test(file));
  let registeredMethodCount = 0;
  let frameworkRouteFileCount = 0;
  for (const file of files) {
    const route = routePath(root, file);
    if (!route.startsWith('/api/')) continue;
    if (route === '/api/auth/[...nextauth]') { frameworkRouteFileCount += 1; continue; }
    assert.ok(manifest.apiRegistry.some(operation => operation.path === route), `API_UNREGISTERED_ROUTE: ${route}`);
    const source = readFileSync(file, 'utf8');
    const exports = [...source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|export\s+(?:const|let|var)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|export\s*\{([^}]+)\}/g)];
    const methods = new Set(exports.flatMap(match => match[1] || match[2] ? [match[1] || match[2]] : match[3].split(',').map(value => value.trim().match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/)?.[1]).filter(Boolean)));
    assert.ok(methods.size > 0, `API_UNRESOLVED_ROUTE_EXPORT: ${route}`);
    for (const method of methods) assert.ok(allowed.has(`${method} ${route}`), `API_UNREGISTERED_METHOD: ${method} ${route}`);
    registeredMethodCount += methods.size;
  }
  return { routeFileCount: files.length, registeredMethodCount, frameworkRouteFileCount, scanMode: 'STATIC_APP_ROUTER_EXPORTS' };
}

export function verifyForbiddenRoutes(root) {
  const { contract } = readApiContract(root);
  const { manifest } = loadRegistry(root);
  const expected = forbiddenRoutes;
  assert.deepEqual(contract.forbiddenRoutes.map(item => item.path).sort(), [...expected].sort(), 'API_FORBIDDEN_LIST_DRIFT');
  const files = walk(path.join(root, 'src'));
  for (const item of contract.forbiddenRoutes) {
    assert.equal(item.expectedHttpStatus, 404, 'API_FORBIDDEN_HTTP_CONTRACT');
    assert.equal(item.producerCount, 0, 'API_FORBIDDEN_PRODUCER_CONTRACT');
    assert.equal(manifest.apiRegistry.filter(operation => operation.path === item.path).length, 0, `API_FORBIDDEN_ROUTE: ${item.path}`);
    const routeDirectory = path.join(root, 'src/app', item.path.slice(1));
    assert.ok(!walk(routeDirectory).some(file => /(?:^|[\\/])route\.[cm]?[jt]sx?$/.test(file)), `API_FORBIDDEN_ROUTE_FILE: ${item.path}`);
    assert.ok(!files.some(file => /(?:^|[\\/])route\.[cm]?[jt]sx?$/.test(file) && routePath(root, file) === item.path), `API_FORBIDDEN_GROUPED_ROUTE_FILE: ${item.path}`);
    for (const file of files) {
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
      if (/\.[cm]?[jt]sx?$/.test(file)) assert.ok(!readFileSync(file, 'utf8').includes(item.path), `API_FORBIDDEN_PRODUCTION_REFERENCE: ${path.relative(root, file)}`);
    }
  }
  return { forbiddenRouteCount: 3, expectedHttpStatus: 404, registryProducerCount: 0, productionSourceFiles: files.length, routeFiles: 0, runtimeHttpRequests: 0, verificationMode: 'STATIC_DECLARATION_AND_SOURCE_SCAN', httpBehavior: 'NOT_CREATED_PHASE002' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const rootIndex = process.argv.indexOf('--root');
    const root = rootIndex < 0 ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..') : path.resolve(process.argv[rootIndex + 1]);
    const checker = process.argv.includes('--forbidden') ? verifyForbiddenRoutes : verifyApi;
    console.log(JSON.stringify(checker(root), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
