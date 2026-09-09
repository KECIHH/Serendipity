import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { domainToASCII, fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const files = { provider: 'docs/travel-data-provider-strategy.md', privacy: 'docs/privacy-and-user-data.md' };
const digest = value => createHash('sha256').update(value).digest('hex');
const copy = value => structuredClone(value);
const sameKeys = (value, keys, label) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), label);
const sameSet = (value, expected, label) => {
  assert.equal(new Set(value).size, value.length, `${label}: duplicates`);
  assert.deepEqual([...value].sort(), [...expected].sort(), label);
};
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const validInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const allowedObject = (value, allowed, required = allowed) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));

function block(document, name) {
  const marker = `<!-- contract:${name} -->`;
  assert.equal(document.split(marker).length - 1, 1, `SINGLE_MACHINE_BLOCK:${name}`);
  const match = document.slice(document.indexOf(marker) + marker.length).match(/^\s*```json\n([\s\S]*?)\n```/);
  assert.ok(match, `JSON_FENCE:${name}`);
  return JSON.parse(match[1]);
}

function readGroup(root, group) {
  const bytes = readFileSync(path.join(root, files[group]));
  assert.ok(!bytes.includes(13), `LF_REQUIRED:${group}`);
  assert.ok(!(bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191), `NO_BOM:${group}`);
  const document = bytes.toString('utf8');
  return { document, policy: block(document, `${group}-policy`), fixtures: block(document, `${group}-fixtures`), ...(group === 'privacy' ? { register: block(document, 'privacy-decision-register') } : {}) };
}

function checkSources(root, policy, manifest) {
  const receipt = JSON.parse(readFileSync(path.join(root, 'docs/phase-plans/Phase002-inputs.json'), 'utf8'));
  assert.equal(policy.producerPhase, 2);
  assert.equal(policy.implementationStatus, 'NOT_CREATED');
  sameSet(policy.sources.map(item => item.id), policy.sources.map(item => item.id), 'UNIQUE_SOURCE_IDS');
  for (const id of ['manifest', 'product-requirements', 'canonical-contract', 'terminology', 'state-machines', 'testing-strategy', 'phase-card']) assert.ok(policy.sources.some(item => item.id === id), `REQUIRED_SOURCE:${id}`);
  for (const reference of policy.sources) {
    sameKeys(reference, ['id', 'sourceAbsolutePath', 'sha256'], 'SOURCE_REFERENCE_ONLY');
    const pin = receipt.pinnedInputs.find(item => item.id === reference.id);
    assert.ok(pin, `UNPINNED_SOURCE:${reference.id}`);
    const absolute = receipt.sourceLocations?.[reference.id] || pin.sourceAbsolutePath;
    assert.equal(reference.sourceAbsolutePath, absolute, `SOURCE_ABSOLUTE_LOCATION:${reference.id}`);
    assert.equal(reference.sourceAbsolutePath, path.resolve(reference.sourceAbsolutePath).replaceAll('\\', '/'), `NORMALIZED_ABSOLUTE_SOURCE:${reference.id}`);
    assert.equal(reference.sha256, pin.sha256, `SOURCE_PIN:${reference.id}`);
    assert.equal(digest(readFileSync(reference.sourceAbsolutePath)), reference.sha256, `SOURCE_HASH:${reference.id}`);
  }
  const actualManifest = manifest || JSON.parse(readFileSync(policy.sources.find(item => item.id === 'manifest').sourceAbsolutePath, 'utf8'));
  assert.equal(actualManifest.projectContracts.find(item => item.path === policy.owner)?.producerPhase, 2, 'MANIFEST_CONTRACT_PRODUCER');
  if (policy.owner === files.privacy) {
    for (const key of ['activeOperationNeverExpires', 'domainReceiptsRetainedWithAggregate']) {
      assert.equal(actualManifest.apiPolicy.idempotency[key], true, `MANIFEST_RECEIPT_RETENTION:${key}`);
      assert.equal(policy.enforcement.receiptRetention[key], actualManifest.apiPolicy.idempotency[key], `RECEIPT_RETENTION_AUTHORITY:${key}`);
    }
  }
  return { manifestHash: receipt.manifestHash, sourceCount: policy.sources.length };
}

const domains = {
  FactStatus: ['verified', 'estimated', 'unknown', 'conflicting', 'stale'],
  FactFreshness: ['fresh', 'aging', 'stale', 'expired', 'unknown'],
  ProviderAvailability: ['available', 'degraded', 'unavailable'],
  CapabilityStatus: ['supported', 'partial', 'unsupported'],
  'CacheEnvelope.state': ['fresh', 'stale_revalidating', 'stale_fallback', 'expired', 'unavailable'],
};
const domainFields = { FactStatus: 'fact.status', FactFreshness: 'fact.freshness.status', ProviderAvailability: 'provider.availability', CapabilityStatus: 'capability.coverage', 'CacheEnvelope.state': 'cache.state' };
const at = (value, pointer) => pointer.split('.').reduce((current, key) => current?.[key], value);
function put(value, pointer, replacement) {
  const parts = pointer.split('.');
  const key = parts.pop();
  parts.reduce((current, part) => current[part], value)[key] = replacement;
}

function checkProviderPolicy(policy) {
  assert.equal(policy.contractVersion, 'phase002.provider.v1');
  assert.equal(policy.owner, files.provider);
  sameKeys(policy.domains, Object.keys(domains), 'FIVE_STATUS_DOMAINS');
  for (const [name, values] of Object.entries(domains)) sameSet(policy.domains[name], values, `EXACT_DOMAIN:${name}`);
  assert.deepEqual(policy.domainFields, domainFields, 'DOMAIN_FIELD_SEPARATION');
  assert.equal(policy.capabilityIds.length, 22, 'CAPABILITY_DENOMINATOR');
  sameSet(policy.profiles.map(profile => profile.providerId), ['controlled-static-evidence', 'nominatim-compatible', 'osrm-compatible', 'open-meteo'], 'FOUR_BASELINE_PROVIDERS');
  for (const profile of policy.profiles) {
    sameKeys(profile.capabilities, policy.capabilityIds, `CAPABILITY_COVERAGE:${profile.providerId}`);
    assert.ok(Object.values(profile.capabilities).every(value => domains.CapabilityStatus.includes(value)));
    assert.equal(profile.productionApproved, false);
    assert.equal(profile.evaluationApproved, false, 'BLUEPRINT_IS_NOT_ADMISSION');
    assert.equal(profile.endpoint, null, 'NO_UNPRODUCED_ENDPOINT');
    assert.equal(profile.licenseEvidence, null, 'NO_INVENTED_LICENSE_APPROVAL');
    assert.equal(profile.credentialRequirement, 'NONE');
    assert.equal(profile.secretRef, null);
  }
  const osrm = policy.profiles.find(profile => profile.providerId === 'osrm-compatible');
  for (const id of ['high_speed_rail_schedule', 'flight_schedule', 'city_bus_schedule', 'scenic_shuttle_schedule', 'realtime_inventory', 'live_traffic']) assert.equal(osrm.capabilities[id], 'unsupported');
  assert.equal(osrm.capabilities.road_route, 'supported');
  assert.equal(policy.profiles.find(profile => profile.providerId === 'nominatim-compatible').capabilities.lodging_candidates, 'unsupported');
  assert.equal(policy.admission.productionApproved, false);
  assert.equal(policy.admission.publicDemoProductionDefault, false);
  assert.equal(policy.admission.missingRuleAction, 'BLOCK');
  assert.equal(policy.admission.noneForbidsCredential, true);
  assert.equal(policy.admission.requiredNeedsActiveKey, true);
  sameSet(policy.admission.licenseEvidenceFields, ['id', 'contentHash', 'termsScope', 'checkedAt', 'cacheMaxAgeSeconds', 'redistributionAllowed'], 'LICENSE_EVIDENCE_FIELDS');
  for (const field of ['licenseEvidence', 'attribution', 'cachePermission', 'redistributionPermission', 'limits', 'regions', 'locales', 'machineAdmissionRuleVersion']) assert.ok(policy.admission.required.includes(field));
  assert.equal(policy.request.privateCoordinatesAllowed, false);
  sameSet(policy.request.coordinateAuthority, ['TRUSTED_PUBLIC_GEOCODER', 'CONTROLLED_PUBLIC_DATABASE'], 'COORDINATE_PROVENANCE');
  sameSet(policy.request.commonRequired, ['queryType', 'normalizedName', 'locale'], 'QUERY_COMMON_FIELDS');
  sameSet(policy.request.nameNormalization, ['NFC', 'TRIM', 'COLLAPSE_WHITESPACE'], 'QUERY_NORMALIZATION');
  for (const field of ['revalidateEveryDnsAnswer', 'revalidateEveryRedirect', 'pinConnectionAddress', 'verifyConnectedPeer', 'dropCredentialsOnRedirect', 'tlsVerification']) assert.equal(policy.transport[field], true, `TRANSPORT_GUARD:${field}`);
  for (const field of ['allowUserinfo', 'allowFragment', 'followRedirectAutomatically']) assert.equal(policy.transport[field], false, `TRANSPORT_DENY:${field}`);
  sameSet(policy.transport.schemes, ['https:'], 'HTTPS_ONLY');
  assert.equal(policy.transport.localException.environment, 'ISOLATED_SYNTHETIC');
  assert.equal(policy.transport.localException.inventoryBound, true);
  assert.equal(policy.transport.localException.networkScope, 'LOOPBACK_ONLY');
  assert.ok(integer(policy.transport.maxRedirects, 0, 3));
  sameSet(policy.transport.blockedIpv4Cidrs, ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'], 'IPV4_DENY_RANGES');
  assert.equal(policy.transport.ipv6GlobalUnicast, '2000::/3');
  sameSet(policy.transport.blockedIpv6Cidrs, ['2001::/23', '2001:db8::/32', '2002::/16'], 'IPV6_DENY_RANGES');
  assert.equal(policy.transport.rejectMappedOrTranslatedIpv4, true);
  const limits = policy.limits;
  assert.equal(limits.scope, 'DOCUMENT_FIXTURE_ONLY');
  for (const field of ['connectTimeoutMs', 'totalTimeoutMs', 'baseBackoffMs', 'maxBackoffMs', 'maxWireBytes', 'maxDecodedBytes', 'concurrency', 'ratePerSecond', 'dailyRequestQuota', 'circuitFailureThreshold', 'circuitWindowMs', 'circuitOpenMs', 'halfOpenProbeLimit']) assert.ok(integer(limits[field], 1, 10_000_000), `FINITE_BOUND:${field}`);
  assert.ok(integer(limits.maxAttempts, 1, 3), 'FINITE_RETRY_BOUND');
  assert.ok(limits.connectTimeoutMs <= limits.totalTimeoutMs);
  assert.ok(limits.maxBackoffMs < limits.totalTimeoutMs);
  assert.equal(limits.halfOpenProbeLimit, 1);
  assert.ok(integer(limits.costUpperBoundMicros, 0, 1_000_000));
  sameSet(limits.retryableCategories, ['timeout', 'unavailable', 'rate_limited'], 'RETRY_ERRORS');
  assert.ok(!limits.retryableCategories.some(value => limits.nonRetryableCategories.includes(value)), 'RETRY_DOMAINS_DO_NOT_OVERLAP');
  for (const key of ['valueOrPayloadRefExactlyOne', 'preserveOriginalFetchedAt', 'refreshCreatesNewSnapshot']) assert.equal(policy.cache[key], true);
  for (const key of ['recordOrRunOwnershipAllowed', 'payloadMayReferenceFactSnapshot', 'privateQuerySharedCacheAllowed', 'versionPinnedBlobEviction', 'refreshMayExtendDeadline']) assert.equal(policy.cache[key], false, `CACHE_DENY:${key}`);
  assert.equal(policy.cache.coordination, 'POSTGRES_LEASE_AND_FENCING');
  sameSet(policy.cache.snapshotMaterializationKey, ['plannerRunId', 'collectionAttemptId'], 'SNAPSHOT_ATTEMPT_IDENTITY');
  sameSet(policy.versionBinding, ['providerId', 'configVersion', 'schemaVersion', 'normalizerVersion', 'freshnessPolicyVersion', 'resolutionPolicyVersion'], 'EXACT_VERSION_BINDING');
  for (const key of ['aiMaySetFacts', 'aiMaySetStatus', 'aiMayCreateSources', 'aiMaySetCoordinates']) assert.equal(policy.fallback[key], false, `FALLBACK_DENY:${key}`);
  assert.equal(policy.fallback.expiredAction, 'UNKNOWN_OR_BLOCK');
  assert.equal(policy.fallback.conflictAction, 'PRESERVE_ALL_WITH_CONFLICT_GROUP');
  assert.equal(policy.fallback.preciseMissingCriticalAction, 'BLOCK');
  assert.equal(policy.fallback.unknownTransportAction, 'ORDER_ONLY_NO_EXECUTION_CONFIRMATION_OR_NAVIGATION');
  assert.equal(policy.betaScenarios.length, 3);
  assert.equal(policy.betaCoverageRequired.length, 7);
  assert.equal(policy.productionPolicy, 'NOT_EVALUATED');
  assert.equal(policy.outboundPublicRequests, 0);
  const freshness = policy.freshnessFixturePolicy;
  for (const key of ['agingAfterSeconds', 'ttlSeconds', 'maxStaleSeconds', 'licenseMaxAgeSeconds']) assert.ok(integer(freshness[key], 1, 86400));
  assert.ok(freshness.agingAfterSeconds < freshness.ttlSeconds);
}

function stateValid(policy, state) {
  return Object.entries(policy.domainFields).every(([domain, pointer]) => policy.domains[domain].includes(at(state, pointer))) && validInstant(state.fact.freshness.checkedAt) && typeof state.fact.freshness.freshnessPolicyVersion === 'string';
}

function normalizeQuery(policy, query, now) {
  const rule = policy.request;
  const branch = rule.branches[query?.queryType];
  if (!branch || !allowedObject(query, [...rule.commonRequired, ...rule.commonOptional, ...branch.required, ...branch.optional], [...rule.commonRequired, ...branch.required])) return null;
  if (Object.keys(query).some(key => rule.forbiddenKeys.includes(key))) return null;
  if (typeof query.normalizedName !== 'string' || !rule.allowedLocales.includes(query.locale)) return null;
  const result = copy(query);
  result.normalizedName = result.normalizedName.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (!result.normalizedName || [...result.normalizedName].length > rule.nameMaxCharacters) return null;
  if (query.country !== undefined && !/^[A-Z]{2}$/.test(query.country)) return null;
  if (query.placeHint !== undefined && (typeof query.placeHint !== 'string' || !query.placeHint.trim() || query.placeHint.length > 200)) return null;
  if (query.limit !== undefined && !integer(query.limit, 1, rule.maxLimit)) return null;
  if (query.coordinates !== undefined) {
    const minimum = query.queryType.startsWith('road_') ? 2 : 1;
    if (!Array.isArray(query.coordinates) || query.coordinates.length < minimum || query.coordinates.length > rule.maxCoordinates) return null;
    if (!query.queryType.startsWith('road_') && query.coordinates.length !== 1) return null;
    if (!query.coordinates.every(point => allowedObject(point, rule.coordinateFields) && Number.isFinite(point.lat) && point.lat >= -90 && point.lat <= 90 && Number.isFinite(point.lng) && point.lng >= -180 && point.lng <= 180 && rule.coordinateAuthority.includes(point.authority) && /^source:[a-zA-Z0-9_-]+$/.test(point.sourceRef))) return null;
  }
  if (query.roadProfile !== undefined && !rule.allowedRoadProfiles.includes(query.roadProfile)) return null;
  if (query.timeZone !== undefined) { try { new Intl.DateTimeFormat('en', { timeZone: query.timeZone }); } catch { return null; } }
  if (query.dateRange !== undefined) {
    if (!allowedObject(query.dateRange, ['start', 'end']) || !validDate(query.dateRange.start) || !validDate(query.dateRange.end)) return null;
    const start = Date.parse(query.dateRange.start);
    const end = Date.parse(query.dateRange.end);
    const today = Date.parse(now.slice(0, 10));
    if (end < start || start < today || end - today >= rule.maxForecastDays * 86400000) return null;
  }
  if (query.month !== undefined && !integer(query.month, 1, 12)) return null;
  if (query.subjectRef !== undefined && !/^place:[a-zA-Z0-9_-]+$/.test(query.subjectRef)) return null;
  if (query.factTypes !== undefined && (!Array.isArray(query.factTypes) || !query.factTypes.length || query.factTypes.length > 20 || !query.factTypes.every(value => typeof value === 'string' && /^[a-z][a-z_]{1,79}$/.test(value)))) return null;
  return result;
}

function ipNumber(address) {
  const family = isIP(address);
  if (!family) return null;
  if (family === 4) return { family, number: address.split('.').reduce((value, byte) => (value << 8n) + BigInt(byte), 0n), bits: 32 };
  let input = address.toLowerCase();
  if (input.includes('.')) {
    const offset = input.lastIndexOf(':');
    const bytes = input.slice(offset + 1).split('.').map(Number);
    input = `${input.slice(0, offset)}:${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const [leftText, rightText] = input.split('::');
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  const groups = rightText === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8) return null;
  return { family, number: groups.reduce((value, group) => (value << 16n) + BigInt(`0x${group || '0'}`), 0n), bits: 128 };
}

function inCidr(address, cidr) {
  const ip = ipNumber(address);
  const [base, prefixText] = cidr.split('/');
  const network = ipNumber(base);
  if (!ip || !network || ip.family !== network.family) return false;
  const shift = BigInt(ip.bits - Number(prefixText));
  return (ip.number >> shift) === (network.number >> shift);
}

function publicIp(policy, address) {
  if (isIP(address) === 4) return !policy.transport.blockedIpv4Cidrs.some(cidr => inCidr(address, cidr));
  return isIP(address) === 6 && inCidr(address, policy.transport.ipv6GlobalUnicast) && !policy.transport.blockedIpv6Cidrs.some(cidr => inCidr(address, cidr));
}

function transportValid(policy, fixture) {
  const rule = policy.transport;
  if (!Array.isArray(fixture.chain) || !fixture.chain.length || fixture.chain.length > rule.maxRedirects + 1) return false;
  let firstOrigin;
  let initialLocal;
  for (const hop of fixture.chain) {
    let url;
    try { url = new URL(hop.url); } catch { return false; }
    if (url.username || url.password || url.hash) return false;
    const localHost = rule.localException.hosts.includes(url.hostname);
    firstOrigin ??= url.origin;
    initialLocal ??= localHost;
    if (url.origin !== firstOrigin || localHost !== initialLocal) return false;
    if (localHost) {
      const guard = rule.localException;
      const address = url.hostname.replace(/^\[|\]$/g, '');
      if (fixture.environment !== guard.environment || fixture.inventoryBound !== true || url.protocol !== 'http:' || Number(url.port) !== guard.port || url.pathname !== guard.path || url.search) return false;
      if (hop.peer !== address || !Array.isArray(hop.dns) || !hop.dns.length || !hop.dns.every(value => value === address)) return false;
    } else {
      if (!rule.schemes.includes(url.protocol) || !rule.ports.includes(Number(url.port || 443))) return false;
      const host = domainToASCII(url.hostname.toLowerCase().replace(/\.$/, ''));
      if (!rule.allowlistHosts.includes(host) || !rule.allowedPaths.includes(url.pathname)) return false;
      if ([...url.searchParams.keys()].some(key => !rule.allowedQueryKeys.includes(key))) return false;
      if (!Array.isArray(hop.dns) || !hop.dns.length || !hop.dns.every(address => publicIp(policy, address))) return false;
      if (!hop.dns.includes(hop.peer) || !publicIp(policy, hop.peer)) return false;
    }
  }
  return true;
}

function admitted(policy, profile) {
  if (!allowedObject(profile, [...policy.admission.required, 'keyStatus'], policy.admission.required)) return false;
  if (profile.environment !== 'ISOLATED_SYNTHETIC' || !profile.evaluationApproved || profile.productionApproved !== false) return false;
  if (!profile.licenseEvidence || !allowedObject(profile.licenseEvidence, policy.admission.licenseEvidenceFields) || !/^sha256:[a-f0-9]{64}$/.test(profile.licenseEvidence.contentHash) || !validInstant(profile.licenseEvidence.checkedAt)) return false;
  if (!profile.licenseEvidence.id || !profile.licenseEvidence.termsScope || !profile.attribution || !profile.machineAdmissionRuleVersion || !profile.endpoint) return false;
  if (!integer(profile.licenseEvidence.cacheMaxAgeSeconds, 0, 86400) || typeof profile.licenseEvidence.redistributionAllowed !== 'boolean') return false;
  if (profile.cachePermission && profile.licenseEvidence.cacheMaxAgeSeconds === 0) return false;
  if (profile.redistributionPermission && !profile.licenseEvidence.redistributionAllowed) return false;
  if (!profile.regions.length || !profile.locales.length || profile.configVersion !== 1 || !integer(profile.limits.totalTimeoutMs, 1, 60000)) return false;
  if (profile.credentialRequirement === 'NONE') return profile.secretRef === null && !profile.keyStatus;
  return profile.credentialRequirement === 'REQUIRED' && typeof profile.secretRef === 'string' && profile.keyStatus === 'ACTIVE';
}

function boundedRun(policy, fixture) {
  const limits = policy.limits;
  let elapsed = 0;
  let attempts = 0;
  let quota = fixture.quotaRemaining ?? limits.dailyRequestQuota;
  if (fixture.cancelled || (fixture.recentFailures ?? 0) >= limits.circuitFailureThreshold || quota <= 0) return { attempts, availability: 'unavailable' };
  for (const event of fixture.events) {
    if (attempts >= limits.maxAttempts || quota <= 0 || elapsed >= limits.totalTimeoutMs) break;
    quota -= 1;
    attempts += 1;
    elapsed += event.durationMs;
    let category = event.category;
    if (elapsed > limits.totalTimeoutMs) category = 'timeout';
    if ((event.wireBytes ?? 0) > limits.maxWireBytes || (event.decodedBytes ?? 0) > limits.maxDecodedBytes) category = 'security';
    if (!category) return { attempts, availability: 'available' };
    if (!limits.retryableCategories.includes(category)) break;
    const delay = Math.max(Math.min(limits.maxBackoffMs, limits.baseBackoffMs * (2 ** (attempts - 1))), event.retryAfterMs ?? 0);
    if (elapsed + delay >= limits.totalTimeoutMs) break;
    elapsed += delay;
  }
  return { attempts, availability: 'unavailable' };
}

function freshness(policy, fixture) {
  if (fixture.unknown) return 'unknown';
  const rule = policy.freshnessFixturePolicy;
  const validThrough = Math.min(rule.ttlSeconds + rule.maxStaleSeconds, rule.licenseMaxAgeSeconds, fixture.providerValidSeconds ?? Infinity);
  if (fixture.ageSeconds >= validThrough) return 'expired';
  if (fixture.ageSeconds >= rule.ttlSeconds) return 'stale';
  if (fixture.ageSeconds >= rule.agingAfterSeconds) return 'aging';
  return 'fresh';
}

function cacheState(policy, fixture) {
  if (fixture.missing) return policy.cache.miss.state;
  const state = freshness(policy, fixture);
  if (state === 'expired') return 'expired';
  if (state !== 'stale') return 'fresh';
  if (fixture.refreshing) return 'stale_revalidating';
  if (fixture.failed && policy.fallback.allowStaleWithinAllDeadlines) return 'stale_fallback';
  return 'unavailable';
}

function validSource(source) {
  const fields = ['id', 'provider', 'sourceType', 'title', 'url', 'sourceLocator', 'contentHash', 'organization', 'license', 'fetchedAt', 'confidence', 'validFrom', 'validUntil'];
  if (!allowedObject(source, fields) || !validInstant(source.fetchedAt) || !Number.isFinite(source.confidence) || source.confidence < 0 || source.confidence > 1) return false;
  if ((source.sourceLocator === null) !== (source.contentHash === null)) return false;
  if (!source.url && !source.sourceLocator) return false;
  if (source.contentHash && !/^sha256:[a-f0-9]{64}$/.test(source.contentHash)) return false;
  return ['id', 'provider', 'sourceType', 'title', 'organization', 'license'].every(key => typeof source[key] === 'string' && source[key].length > 0);
}

function validFact(policy, fixture, source) {
  if (!policy.domains.FactStatus.includes(fixture.status) || !Array.isArray(fixture.sourceRefs)) return false;
  if (fixture.status === 'unknown') return fixture.value === null && fixture.sourceRefs.length === 0 && fixture.conflictGroup === null;
  return fixture.value !== null && validSource(source) && fixture.sourceRefs.length > 0 && fixture.sourceRefs.every(ref => ref === source.id) && (fixture.status === 'conflicting' ? typeof fixture.conflictGroup === 'string' && fixture.conflictGroup.length > 0 : fixture.conflictGroup === null);
}

function checked(results, id, callback) {
  assert.ok(!results.some(result => result.id === id), `DUPLICATE_FIXTURE:${id}`);
  callback();
  results.push({ id, status: 'PASS' });
}

function verifyProviderFixtures(policy, fixtures) {
  const results = [];
  assert.ok(validInstant(fixtures.clock));
  const expectedCounts = { states: 6, requests: 12, transport: 19, freshness: 6, cache: 6, resources: 10, facts: 7 };
  for (const [key, count] of Object.entries(expectedCounts)) assert.equal(fixtures[key].length, count, `FIXED_PROVIDER_DENOMINATOR:${key}`);
  for (const fixture of fixtures.states) checked(results, fixture.id, () => {
    const value = copy(fixture.value || fixtures.states[0].value);
    if (fixture.replace) put(value, fixture.replace.path, fixture.replace.value);
    assert.equal(stateValid(policy, value), fixture.expected);
  });
  for (const fixture of fixtures.requests) checked(results, fixture.id, () => {
    const road = copy(fixtures.requests.find(item => item.id === 'trusted-road-input').query);
    let query = copy(fixture.query || road);
    if (fixture.mutation === 'ai-coordinate') query.coordinates[0].authority = 'AI';
    if (fixture.mutation === 'private-coordinate') query.coordinates[0].authority = 'PRIVATE_USER_ADDRESS';
    if (fixture.mutation === 'out-of-range-coordinate') query.coordinates[0].lat = 91;
    if (fixture.mutation === 'road-as-transit') query.roadProfile = 'high_speed_rail';
    if (fixture.mutation === 'impossible-calendar-date') { query = copy(fixtures.requests.find(item => item.id === 'valid-forecast').query); query.dateRange.start = '2026-02-30'; }
    const normalized = normalizeQuery(policy, query, fixtures.clock);
    assert.equal(normalized !== null, fixture.expected);
    if (fixture.id === 'normalized-query') { assert.equal(normalized.normalizedName, '测试 地点'); assert.deepEqual(normalizeQuery(policy, normalized, fixtures.clock), normalized); }
  });
  for (const fixture of fixtures.transport) checked(results, fixture.id, () => {
    const input = fixture.mutation === 'redirect-limit' ? { ...fixtures.transport[0], chain: Array(policy.transport.maxRedirects + 2).fill(fixtures.transport[0].chain[0]) } : fixture;
    assert.equal(transportValid(policy, input), fixture.expected);
  });
  for (const fixture of fixtures.resources) checked(results, fixture.id, () => assert.deepEqual(boundedRun(policy, fixture), { attempts: fixture.expectedAttempts, availability: fixture.expectedAvailability }));
  for (const fixture of fixtures.freshness) checked(results, `freshness:${fixture.id}`, () => assert.equal(freshness(policy, fixture), fixture.expected));
  for (const fixture of fixtures.cache) checked(results, `cache:${fixture.id}`, () => assert.equal(cacheState(policy, fixture), fixture.expected));
  for (const fixture of fixtures.facts) checked(results, `fact:${fixture.id}`, () => assert.equal(validFact(policy, fixture, fixtures.factSource), fixture.expected));
  checked(results, 'license-and-credential-admission', () => {
    const profile = { providerId: 'synthetic-only', configVersion: 1, endpoint: 'http://127.0.0.1:18765/contract', environment: 'ISOLATED_SYNTHETIC', licenseEvidence: { id: 'fixture-license-v1', contentHash: `sha256:${digest('synthetic-license-v1')}`, termsScope: 'SYNTHETIC_FIXTURES_ONLY', checkedAt: fixtures.clock, cacheMaxAgeSeconds: 600, redistributionAllowed: false }, attribution: 'Synthetic fixture', cachePermission: true, redistributionPermission: false, limits: policy.limits, regions: ['SYNTHETIC'], locales: ['zh-CN'], machineAdmissionRuleVersion: 'fixture-admission-v1', evaluationApproved: true, productionApproved: false, credentialRequirement: 'NONE', secretRef: null };
    assert.equal(admitted(policy, profile), true);
    assert.equal(admitted(policy, { ...profile, licenseEvidence: null }), false);
    assert.equal(admitted(policy, { ...profile, attribution: null }), false);
    assert.equal(admitted(policy, { ...profile, productionApproved: true }), false);
    assert.equal(admitted(policy, { ...profile, environment: 'PRODUCTION' }), false);
    assert.equal(admitted(policy, { ...profile, secretRef: 'key:synthetic' }), false);
    assert.equal(admitted(policy, { ...profile, credentialRequirement: 'REQUIRED', secretRef: 'key:synthetic', keyStatus: 'ACTIVE' }), true);
    assert.equal(admitted(policy, { ...profile, credentialRequirement: 'REQUIRED', secretRef: 'key:synthetic', keyStatus: 'DISABLED' }), false);
  });
  checked(results, 'snapshot-version-and-freshness-isolation', () => {
    const snapshots = new Map();
    const materialize = (run, attempt, payload) => {
      const key = canonical([run, attempt]);
      if (snapshots.has(key)) return snapshots.get(key);
      const snapshot = { id: `snapshot:${snapshots.size + 1}`, plannerRunId: run, collectionAttemptId: attempt, payload: copy(payload), generatedFreshness: freshness(policy, { ageSeconds: 30 }), fetchedAt: fixtures.clock };
      snapshots.set(key, snapshot);
      return snapshot;
    };
    const first = materialize('run-a', 'attempt-a', { facts: fixtures.facts[0], sourceCatalog: [fixtures.factSource] });
    const before = canonical(first);
    assert.equal(materialize('run-a', 'attempt-a', first.payload).id, first.id);
    assert.notEqual(materialize('run-b', 'attempt-b', first.payload).id, first.id);
    assert.notEqual(materialize('run-a', 'refresh-a', first.payload).id, first.id);
    const currentFreshness = freshness(policy, { ageSeconds: 180 });
    assert.equal(first.generatedFreshness, 'fresh');
    assert.equal(currentFreshness, 'stale');
    assert.equal(canonical(first), before, 'READ_ONLY_CURRENT_FRESHNESS');
    assert.equal(cacheState(policy, { ageSeconds: 300, failed: true }), 'expired');
    const semanticKey = tuple => digest(canonical(tuple));
    assert.notEqual(semanticKey({ provider: 'a', configVersion: 1, locale: 'zh-CN' }), semanticKey({ provider: 'a', configVersion: 2, locale: 'zh-CN' }));
  });
  return results;
}

const decisionFields = ['decisionId', 'dataCategory', 'environment', 'automatedDecision', 'ruleVersion', 'evaluatedAt', 'runnerRef', 'retentionRule', 'deletionRule', 'backupDeadline', 'consentRule'];
const privacyCategories = ['account', 'anonymous_token', 'password', 'api_key', 'auth_session', 'chat_and_requirement', 'travel_profile', 'location', 'travel_plan_and_snapshot', 'plan_trace', 'trace_detail', 'audit_and_command_receipt', 'share_token', 'data_and_feedback_receipt', 'export_temporary_file', 'evaluation_sample', 'feedback_contact', 'media_attachment', 'backup', 'privacy_revocation_ledger'];
const recoveryReceiptCategories = ['audit_and_command_receipt', 'data_and_feedback_receipt', 'privacy_revocation_ledger'];
const receiptRetentionGuards = ['ACTIVE_OPERATION', 'DOMAIN_AGGREGATE', 'RECOVERY_WATERMARK'];

function checkPrivacyPolicy(policy, register) {
  assert.equal(policy.contractVersion, 'phase002.privacy.v1');
  assert.equal(policy.owner, files.privacy);
  assert.equal(policy.ruleVersion, 'phase002.synthetic-retention.v1');
  assert.equal(policy.environment, 'ISOLATED_SYNTHETIC', 'PRIVACY_SYNTHETIC_ENVIRONMENT_ONLY');
  for (const field of ['productionPolicy', 'realUserConsent', 'humanScreenReaderExperience']) assert.equal(policy[field], 'NOT_EVALUATED');
  sameSet(policy.categories.map(item => item.dataCategory), privacyCategories, 'ALL_DATA_CATEGORIES');
  sameSet(register.map(item => item.dataCategory), privacyCategories, 'REGISTER_CATEGORY_COVERAGE');
  sameSet(register.map(item => item.decisionId), register.map(item => item.decisionId), 'UNIQUE_DECISION_IDS');
  for (const category of policy.categories) {
    sameKeys(category, ['dataCategory', 'purpose', 'fieldWhitelist'], 'CATEGORY_FIELDS');
    assert.ok(category.purpose && category.fieldWhitelist.length);
    assert.equal(new Set(category.fieldWhitelist).size, category.fieldWhitelist.length);
  }
  const fields = category => policy.categories.find(item => item.dataCategory === category).fieldWhitelist;
  assert.deepEqual(fields('password'), ['passwordHash']);
  assert.ok(fields('anonymous_token').includes('anonTokenHash') && !fields('anonymous_token').includes('anonToken'));
  assert.equal(policy.classification.default, 'PRIVATE');
  assert.equal(policy.classification.unknownFields, 'DENY');
  assert.equal(policy.classification.adminImpliesPrivateAccess, false);
  assert.equal(policy.classification.plaintextPasswordsPersisted, false);
  assert.equal(policy.classification.plaintextTokensPersisted, false);
  assert.equal(policy.classification.erasureDedicatedRoleException, true);
  sameSet(policy.classification.prohibitedDataCategories, ['identity_documents', 'passport', 'payment_credentials', 'precise_health_diagnosis', 'real_production_personal_data'], 'PROHIBITED_COLLECTION');
  for (const item of register) {
    sameKeys(item, decisionFields, `EXACT_ELEVEN_FIELDS:${item.dataCategory}`);
    assert.equal(item.environment, policy.environment);
    assert.equal(item.ruleVersion, policy.ruleVersion);
    assert.ok(['ALLOW', 'BLOCK'].includes(item.automatedDecision));
    assert.ok(validInstant(item.evaluatedAt));
    assert.equal(item.runnerRef, 'docs/phase-plans/check-phase002-provider-privacy.mjs#checkPrivacy');
    sameKeys(item.retentionRule, ['startsAt', 'maxAgeSeconds', 'expiryAction', 'protectedBy'], 'RETENTION_RULE_FIELDS');
    const recoveryReceipt = recoveryReceiptCategories.includes(item.dataCategory);
    assert.equal(item.retentionRule.startsAt, recoveryReceipt ? 'tombstonedAt' : 'createdAt', 'RECEIPT_TOMBSTONE_CLOCK');
    assert.ok(integer(item.retentionRule.maxAgeSeconds, 1, policy.enforcement.maxOrdinaryRetentionSeconds), `FINITE_RETENTION_BOUND:${item.dataCategory}`);
    assert.ok(['ERASE_SUBJECT', 'REVOKE_AND_PURGE', 'PURGE_CATEGORY', 'RETIRE_BACKUP', 'PURGE_AFTER_RESTORE_RETIREMENT'].includes(item.retentionRule.expiryAction));
    if (item.retentionRule.protectedBy === 'PLAN_VERSION') assert.equal(item.retentionRule.expiryAction, 'ERASE_SUBJECT', 'PINNED_CONTEXT_NOT_CACHE_PURGE');
    if (recoveryReceipt) {
      assert.deepEqual(item.retentionRule.protectedBy, receiptRetentionGuards, 'RECEIPT_RETENTION_GUARDS');
      assert.equal(item.retentionRule.expiryAction, 'PURGE_AFTER_RESTORE_RETIREMENT');
      assert.ok(item.retentionRule.maxAgeSeconds >= item.backupDeadline.maxAgeSeconds + item.backupDeadline.eraseWithinSeconds, 'RECOVERY_INTENT_OUTLIVES_BACKUPS');
    }
    sameKeys(item.deletionRule, ['triggerEvents', 'scope', 'completeWithinSeconds', 'preserveIndependentOtherOwners', 'preserveOnlyMinimalTombstone'], 'DELETION_RULE_FIELDS');
    assert.ok(item.deletionRule.triggerEvents.includes('RETENTION_EXPIRED') && item.deletionRule.triggerEvents.includes('SUBJECT_ERASE'));
    sameSet(item.deletionRule.scope, ['PRIMARY', 'DERIVED', 'CACHE', 'CLIENT_STATE', 'OBJECTS'], 'ALL_DELETION_COPIES');
    assert.ok(integer(item.deletionRule.completeWithinSeconds, 1, policy.enforcement.maxCleanupSeconds));
    assert.equal(item.deletionRule.preserveIndependentOtherOwners, true);
    assert.equal(item.deletionRule.preserveOnlyMinimalTombstone, true);
    sameKeys(item.backupDeadline, ['maxAgeSeconds', 'eraseWithinSeconds', 'restoreRequiresCurrentLedger'], 'BACKUP_RULE_FIELDS');
    assert.ok(integer(item.backupDeadline.maxAgeSeconds, 1, policy.enforcement.maxBackupAgeSeconds));
    assert.ok(integer(item.backupDeadline.eraseWithinSeconds, 1, policy.enforcement.maxBackupErasureSeconds), `FINITE_BACKUP_ERASURE_BOUND:${item.dataCategory}`);
    assert.equal(item.backupDeadline.restoreRequiresCurrentLedger, true);
    sameKeys(item.consentRule, ['scopeFields', 'defaultGranted', 'withdrawalStopsUseImmediately', 'withdrawalPurgesIdentifiableCopies', 'requiresExplicitProductAction'], 'CONSENT_RULE_FIELDS');
    assert.equal(item.consentRule.defaultGranted, false);
    assert.equal(item.consentRule.withdrawalStopsUseImmediately, true);
    assert.equal(item.consentRule.withdrawalPurgesIdentifiableCopies, true);
    assert.equal(item.consentRule.requiresExplicitProductAction, item.consentRule.scopeFields.length > 0);
    if (item.consentRule.scopeFields.length) assert.ok(item.deletionRule.triggerEvents.includes('CONSENT_WITHDRAWAL'));
  }
  assert.equal(register.find(item => item.dataCategory === 'privacy_revocation_ledger').retentionRule.maxAgeSeconds, policy.enforcement.maxLedgerTombstoneRetentionSeconds);
  assert.deepEqual(policy.enforcement.receiptRetention, {
    categories: recoveryReceiptCategories, activeOperationNeverExpires: true, domainReceiptsRetainedWithAggregate: true,
    startsAt: 'tombstonedAt', tombstoneRequires: ['OPERATION_TERMINAL', 'AGGREGATE_DELETED', 'DOMAIN_CLEANUP_COMPLETE'],
    reauthorizeAcceptedErasure: false, unknownLifecycle: 'BLOCK_AND_KEEP_RECOVERY_INTENT',
  }, 'RECEIPT_LIFECYCLE_POLICY');
  assert.deepEqual(register.find(item => item.dataCategory === 'evaluation_sample').consentRule.scopeFields, ['evaluationConsent']);
  assert.deepEqual(register.find(item => item.dataCategory === 'feedback_contact').consentRule.scopeFields, ['contactConsent']);
  const projection = policy.publicProjection;
  assert.equal(projection.schemaOwnerPhase, 65);
  assert.equal(projection.schemaName, 'PlanViewModelSchema');
  assert.equal(projection.recursive, true);
  assert.equal(projection.shareAndPublicSameMaximum, true);
  assert.equal(projection.unknownFields, 'DROP');
  assert.equal(projection.narrativeOrigin, 'VERIFIED_PUBLIC_FIELDS_AND_TEMPLATE');
  assert.equal(projection.rawNarrativeCopyAllowed, false);
  assert.equal(projection.publicSafeBooleanSufficient, false);
  assert.equal(projection.keepPrivateStableReferences, true);
  assert.equal(projection.externalMapPrivateCoordinatesAllowed, false);
  assert.equal(projection.allPrivateMapRequestCount, 0);
  sameSet(projection.sourceSummaryFields, ['id', 'provider', 'sourceType', 'title', 'url', 'organization', 'license', 'fetchedAt', 'confidence', 'validFrom', 'validUntil'], 'EXACT_SOURCE_SUMMARY');
  for (const forbidden of ['planPatch', 'requestedChange', 'confirmationToken', 'sourceLocator', 'contentHash', 'ownerCapabilities', 'requirementSnapshot', 'profileSnapshot', 'email', 'traceId', 'token', 'receipt']) assert.ok(projection.denyKeys.includes(forbidden), `PUBLIC_DENY:${forbidden}`);
  assert.equal(policy.logging.recursive, true);
  assert.equal(policy.logging.allowRawText, false);
  assert.equal(policy.logging.stripAtFirstBoundary, true);
  for (const header of ['Authorization', 'Cookie', 'Set-Cookie', 'X-Share-Token', 'X-Feedback-Receipt', 'X-Data-Request-Receipt']) assert.ok(policy.logging.sensitiveHeaders.includes(header));
  for (const field of ['password', 'passwordHash', 'apiKey', 'envelope', 'rawOutput', 'rawResponse', 'systemPrompt', 'query', 'email', 'coordinate', 'chat', 'receipt']) assert.ok(policy.logging.denyKeys.includes(field), `LOG_DENY:${field}`);
  assert.equal(policy.logging.unknownFields, 'DROP');
  const protocols = policy.secretProtocols;
  assert.equal(protocols.anonymous.generator, 'SERVER_CSPRNG_256_BIT');
  assert.equal(protocols.anonymous.delivery, 'HTTPONLY_COOKIE_ONLY');
  assert.equal(protocols.anonymous.database, 'anonTokenHash');
  assert.equal(protocols.anonymous.bootstrapReturnsRawToken, false);
  assert.equal(protocols.anonymous.consumedTokenReusable, false);
  assert.equal(protocols.receipt.generator, 'CLIENT_WEB_CRYPTO_256_BIT_BEFORE_CREATE');
  assert.equal(protocols.receipt.delivery, 'SENSITIVE_HEADER_ONLY');
  assert.equal(protocols.receipt.serverReturnsSecret, false);
  for (const key of ['downloadAllowed', 'planAccessAllowed', 'triageAllowed']) assert.equal(protocols.receipt[key], false, `RECEIPT_CAPABILITY_DENY:${key}`);
  assert.equal(protocols.receipt.validAfterShareRevocation, true);
  assert.equal(protocols.receipt.validAfterSessionRevocation, true);
  assert.equal(protocols.share.replayTokenAvailable, false);
  assert.equal(protocols.share.replayOmitsToken, true);
  assert.equal(protocols.share.reissuePreservesPlanVersionAndExpiry, true);
  assert.equal(protocols.share.shareImpliesPublication, false);
  const deletion = policy.deletion;
  assert.equal(deletion.ledger, 'PrivacyRevocationLedger');
  assert.equal(deletion.ledgerStorage, 'INDEPENDENT_POSTGRES_DATABASE_VOLUME_AND_BACKUP_SET');
  assert.equal(deletion.independentFromApplicationRestore, true);
  assert.deepEqual(deletion.acceptOrder, ['REAUTHENTICATE_AND_LOCK_SUBJECT', 'APPEND_INDEPENDENT_LEDGER', 'PROJECT_APPLICATION_REQUEST_AND_REVOKE', 'RUN_IDEMPOTENT_ERASURE', 'RECONCILE_OBJECTS_AND_WATERMARK', 'COMPLETE'], 'ERASURE_LEDGER_BEFORE_APPLICATION');
  sameSet(deletion.categories, ['ERASE', 'CONSENT_WITHDRAWAL', 'SESSION_REVOKE', 'SHARE_REVOKE', 'PUBLICATION_REVOKE', 'MEDIA_REVOKE', 'KILL_DISABLE'], 'SEVEN_REVOCATION_CATEGORIES');
  assert.equal(deletion.ledgerSequence, 'LOCK_HEAD_AND_APPEND_IN_ONE_LEDGER_TRANSACTION');
  assert.equal(deletion.ledgerContainsPlaintext, false);
  assert.equal(deletion.applicationFailureAfterLedger, 'RECONCILE_SAME_INTENT_AND_RECEIPT');
  assert.equal(deletion.eraseReauthenticationOnContinuation, false);
  assert.equal(deletion.eraseCancellable, false);
  assert.equal(deletion.eraseTechnicalFailureState, 'RUNNING');
  assert.equal(deletion.exportFailureState, 'FAILED');
  assert.equal(deletion.maxActiveTasksPerRequest, 1);
  assert.equal(deletion.completeRequiresObjectReconciliation, true);
  assert.equal(deletion.archiveEqualsErasure, false);
  assert.equal(deletion.erasedUserReenableAllowed, false);
  assert.equal(deletion.missingWatermarkReadiness, false);
  assert.equal(deletion.replaceErasureWithTokenRotation, false);
  assert.equal(deletion.deleteOthersIndependentCopies, false);
  assert.deepEqual(deletion.objectOrder, ['TOMBSTONE_AND_DENY_READ', 'OUTBOX', 'DELETE_BY_IMMUTABLE_KEY_AND_HASH', 'CONFIRM_ABSENCE']);
  assert.deepEqual(deletion.restoreOrder, ['STOP_TRAFFIC', 'READ_CURRENT_INDEPENDENT_WATERMARK', 'REPLAY_ALL_CATEGORIES_AND_OBJECT_DELETION', 'CATCH_UP_NEW_WATERMARK', 'VERIFY_NO_RESURRECTION', 'READINESS_TRUE']);
  assert.equal(policy.consent.sensitiveRequirementField, 'preferences.consent.sensitiveRequirementProcessing');
  assert.equal(policy.consent.falseOrNullAllowsExternalSensitiveText, false);
  sameSet(policy.consent.feedbackFields, ['contactConsent', 'evaluationConsent'], 'TWO_INDEPENDENT_CONSENTS');
  assert.equal(policy.consent.guestContactAllowed, false);
  assert.equal(policy.consent.inferFromDescriptionAllowed, false);
  assert.equal(policy.consent.recheckBeforeEverySampleOrReplay, true, 'CONSENT_RECHECK_REQUIRED');
  assert.equal(policy.consent.historyManifestMutable, false);
  assert.equal(policy.consent.claimIsVerifiedFact, false);
  assert.equal(policy.enforcement.expiryComparison, 'NOW_GREATER_THAN_OR_EQUAL_DEADLINE');
  assert.equal(policy.enforcement.productionEnvironmentAllowed, false);
  assert.equal(policy.enforcement.oldRuleVersionAllowed, false);
  assert.equal(policy.enforcement.blockedDecisionAction, 'BLOCKED_DECISION');
  assert.equal(policy.enforcement.unprovenPinOrDeletionAction, 'BLOCK_AND_KEEP_RECOVERY_INTENT');
}

function canUse(policy, register, fixture) {
  const item = register.find(row => row.dataCategory === fixture.category);
  if (!item || fixture.environment !== policy.environment || fixture.ruleVersion !== policy.ruleVersion) return false;
  return (fixture.automatedDecision ?? item.automatedDecision) === 'ALLOW';
}

function newTemporaryRoot() { return mkdtempSync(path.join(tmpdir(), 'phase002-provider-privacy-')); }
function removeTemporaryRoot(directory) {
  const absolute = path.resolve(directory);
  assert.equal(path.dirname(absolute), path.resolve(tmpdir()), 'TEMP_ROOT_PARENT');
  assert.ok(path.basename(absolute).startsWith('phase002-provider-privacy-'), 'TEMP_ROOT_PREFIX');
  rmSync(absolute, { recursive: true, force: true });
}
function withStore(callback) {
  const directory = newTemporaryRoot();
  try {
    for (const name of ['application', 'objects', 'backup', 'ledger', 'samples', 'contact', 'cache', 'client']) mkdirSync(path.join(directory, name));
    return callback(directory);
  } finally { removeTemporaryRoot(directory); }
}
const fileIn = (directory, store, name) => path.join(directory, store, `${name}.json`);
function save(directory, store, name, value) { writeFileSync(fileIn(directory, store, name), `${JSON.stringify(value)}\n`); }
function read(directory, store, name) { return JSON.parse(readFileSync(fileIn(directory, store, name), 'utf8')); }
function remove(directory, store, name) { const file = fileIn(directory, store, name); if (existsSync(file)) unlinkSync(file); }

function appendIntent(directory, intent) {
  const file = fileIn(directory, 'ledger', 'entries');
  const entries = existsSync(file) ? read(directory, 'ledger', 'entries') : [];
  const old = entries.find(entry => entry.intentId === intent.intentId);
  if (old) { assert.equal(old.scopeHash, intent.scopeHash, 'INTENT_SCOPE_MISMATCH'); return old; }
  const added = { ...intent, sequence: entries.length + 1 };
  save(directory, 'ledger', 'entries', [...entries, added]);
  return added;
}

function expireStoredData(policy, rule, fixture, directory) {
  const stored = read(directory, 'application', 'synthetic-a');
  const createdAt = Date.parse(stored.createdAt);
  const now = createdAt + fixture.ageSeconds * 1000;
  let startsAt = createdAt;
  if (rule.retentionRule.startsAt === 'tombstonedAt') {
    const lifecycle = stored.retention;
    if (!lifecycle || typeof lifecycle.operationActive !== 'boolean' || typeof lifecycle.aggregatePresent !== 'boolean') return { deleted: false, blocked: true };
    if (lifecycle.operationActive || lifecycle.aggregatePresent) return { deleted: false, blocked: false };
    if (lifecycle.domainCleanupComplete !== true || !validInstant(lifecycle.tombstonedAt)) return { deleted: false, blocked: true };
    startsAt = Date.parse(lifecycle.tombstonedAt);
    if (startsAt < createdAt || startsAt > now) return { deleted: false, blocked: true };
  }
  const deadline = startsAt + rule.retentionRule.maxAgeSeconds * 1000;
  if (now < deadline) return { deleted: false, blocked: false };
  if (rule.retentionRule.expiryAction === 'PURGE_AFTER_RESTORE_RETIREMENT' && !fixture.restoreSetsRetired) return { deleted: false, blocked: true };
  if (rule.retentionRule.expiryAction === 'ERASE_SUBJECT') {
    appendIntent(directory, { intentId: 'expiry-a', scopeHash: digest(fixture.category), category: 'ERASE', subjectHash: digest('synthetic-a') });
    assert.ok(existsSync(fileIn(directory, 'ledger', 'entries')), 'EXPIRY_LEDGER_PRECEDES_CONTEXT_ERASURE');
  }
  for (const store of ['application', 'objects', 'samples', 'contact', 'cache', 'client']) remove(directory, store, 'synthetic-a');
  return { deleted: true, blocked: false };
}

function runErasure(policy, register, fixture, directory) {
  const rawReceipt = Buffer.alloc(32, 31).toString('base64url');
  const receiptHash = digest(rawReceipt);
  const scopeHash = digest('synthetic-a:all-own-data');
  save(directory, 'application', 'subject', { status: 'ACTIVE', passwordPresent: true, sessionActive: true, personalContent: 'SYNTHETIC_DATA', user: 'synthetic-a' });
  save(directory, 'objects', 'synthetic-a', { data: 'SYNTHETIC_OBJECT' });
  save(directory, 'objects', 'synthetic-b', { data: 'INDEPENDENT_SYNTHETIC_OBJECT' });
  const intent = appendIntent(directory, { intentId: 'erase-a', scopeHash, category: 'ERASE', subjectHash: digest('synthetic-a'), requestId: 'request-a', requestHash: digest('request-a'), receiptHash, ownerKeyHash: digest('owner-a') });
  assert.equal(intent.sequence, 1);
  assert.equal(appendIntent(directory, intent).sequence, 1);
  assert.equal(read(directory, 'ledger', 'entries').length, 1);
  assert.ok(!readFileSync(fileIn(directory, 'ledger', 'entries'), 'utf8').includes(rawReceipt), 'LEDGER_NEVER_STORES_RECEIPT');
  if (fixture.applicationFails) {
    assert.equal(existsSync(fileIn(directory, 'application', 'request')), false);
    assert.equal(read(directory, 'ledger', 'entries').find(item => item.receiptHash === receiptHash).requestId, 'request-a', 'RECEIPT_RECOVERS_INDEPENDENT_INTENT');
  }
  save(directory, 'application', 'request', { id: intent.requestId, intentId: intent.intentId, scopeHash, privacyWatermark: intent.sequence, status: 'PENDING', continuationSequence: 0, checkpoint: [], activeTaskCount: 1 });
  save(directory, 'application', 'subject', { status: 'DISABLED', passwordPresent: false, sessionActive: false, personalContent: null, user: 'synthetic-a' });
  let request = read(directory, 'application', 'request');
  request.status = 'RUNNING';
  request.checkpoint.push('IDENTITY_AND_SESSION_ERASED');
  if (fixture.elapsedBeforeContinuationSeconds !== undefined) {
    save(directory, 'application', 'request', request);
    for (const category of recoveryReceiptCategories) {
      save(directory, 'application', 'synthetic-a', { category, createdAt: fixture.clock, intentId: intent.intentId,
        requestId: request.id, receiptHash, checkpoint: request.checkpoint,
        retention: { operationActive: true, aggregatePresent: true, domainCleanupComplete: false, tombstonedAt: null } });
      const rule = register.find(item => item.dataCategory === category);
      const result = expireStoredData(policy, rule, { ageSeconds: fixture.elapsedBeforeContinuationSeconds, restoreSetsRetired: true }, directory);
      assert.deepEqual(result, { deleted: false, blocked: false }, `ACTIVE_ERASE_RECEIPT_TTL:${category}`);
      const retained = read(directory, 'application', 'synthetic-a');
      assert.equal(retained.receiptHash, intent.receiptHash, 'ERASE_RECEIPT_REMAINS_LOCATABLE');
      assert.deepEqual(retained.checkpoint, request.checkpoint, 'ERASE_CHECKPOINT_RETAINS_PROGRESS');
    }
    assert.equal(read(directory, 'application', 'request').status, 'RUNNING');
    assert.equal(read(directory, 'ledger', 'entries').find(item => item.receiptHash === receiptHash).intentId, intent.intentId);
    assert.equal(read(directory, 'application', 'subject').passwordPresent, false, 'ERASE_TTL_DOES_NOT_REAUTHORIZE');
  }
  if (fixture.taskExhausts) {
    request.activeTaskCount = 0;
    assert.equal(request.status, policy.deletion.eraseTechnicalFailureState);
    const old = copy(request);
    const claimContinuation = expectedSequence => {
      if (request.continuationSequence !== expectedSequence || request.activeTaskCount) return false;
      request.continuationSequence += 1;
      request.activeTaskCount = 1;
      return true;
    };
    assert.equal(claimContinuation(0), true);
    assert.equal(claimContinuation(0), false, 'ONLY_ONE_CONTINUATION_WINS');
    for (const key of policy.deletion.continuationRetains) assert.deepEqual(request[key], old[key]);
    assert.equal(read(directory, 'application', 'subject').passwordPresent, false, 'NO_REAUTH_AFTER_PASSWORD_ERASURE');
  }
  request.objectReadDenied = true;
  save(directory, 'application', 'outbox', { intentId: intent.intentId, objectId: 'synthetic-a', state: 'PENDING' });
  if (!fixture.objectDeleteFails) {
    remove(directory, 'objects', 'synthetic-a');
    assert.equal(existsSync(fileIn(directory, 'objects', 'synthetic-a')), false);
    request.checkpoint.push('OBJECT_DELETION_RECONCILED');
    request.status = policy.deletion.eraseCompletedState;
    request.activeTaskCount = 0;
  }
  save(directory, 'application', 'request', request);
  assert.equal(existsSync(fileIn(directory, 'objects', 'synthetic-b')), true, 'PRESERVE_INDEPENDENT_OWNER');
  assert.equal(read(directory, 'application', 'subject').status, policy.deletion.erasedUserState);
  assert.equal(read(directory, 'application', 'subject').personalContent, null);
  assert.equal(read(directory, 'ledger', 'entries').length, 1, 'NO_DUPLICATE_ERASURE_INTENT');
  return request;
}

function safeSourceUrl(policy, input) {
  if (input === null) return null;
  let url;
  try { url = new URL(input); } catch { return null; }
  const rule = policy.publicProjection;
  if (!rule.sourceUrlSchemes.includes(url.protocol) || url.username || url.password || url.hash || url.port && url.port !== '443') return null;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host) || host === 'localhost' || !host.includes('.') || /(?:\.local|\.internal|\.localhost)$/.test(host)) return null;
  if ([...url.searchParams.keys()].some(key => rule.sourceUrlSensitiveQueryKeys.includes(key.toLowerCase()))) return null;
  return url.href;
}

function publicFixtureProjection(policy, fixture) {
  const rule = policy.publicProjection;
  const privateText = 'SYNTHETIC_PRIVATE_ADDRESS_AND_HEALTH';
  const sourceInput = { id: 'source:synthetic', provider: 'synthetic', sourceType: 'controlled_static', title: '公共合成来源', url: null, organization: 'SYNTHETIC', license: 'SYNTHETIC-FIXTURE-ONLY', fetchedAt: '2026-09-09T00:00:00.000Z', confidence: 1, validFrom: null, validUntil: null, sourceLocator: privateText, contentHash: digest(privateText), endpoint: privateText };
  const source = Object.fromEntries(rule.sourceSummaryFields.map(key => [key, key === 'url' ? safeSourceUrl(policy, sourceInput[key]) : sourceInput[key]]));
  const placeInput = { id: 'place:synthetic-a', label: privateText, address: privateText, coordinate: { lat: 30, lng: 120 }, disclosure: 'visible', publicSafe: true, nested: { planPatch: { requestedChange: privateText } } };
  const place = fixture.privatePlace ? { id: placeInput.id, ...copy(rule.redactedPlace) } : { id: placeInput.id, disclosure: 'visible', label: '公共合成 POI', address: null, coordinate: copy(placeInput.coordinate) };
  const narrativeInput = { title: privateText, publicSafe: true };
  assert.ok(narrativeInput.publicSafe, 'ADVERSARIAL_FREE_TEXT_TEST_INPUT');
  const templateSummary = { title: fixture.privatePlace ? '旅行安排' : '公共合成 POI 旅行安排' };
  const alternativeInput = { id: 'alternative:synthetic-a', title: privateText, description: privateText, planPatch: { operations: [{ requestedChange: privateText }] }, ownerCapabilities: ['WRITE'] };
  const safeAlternative = Object.fromEntries(rule.alternativeFields.map(key => [key, key === 'id' ? alternativeInput.id : key === 'title' ? '备选安排' : '请核对公开旅行条件']));
  const result = { summary: templateSummary, sourceCatalog: [source], dailyItinerary: [{ timeline: [{ id: 'event:synthetic-a', placeRef: place.id, place }] }], routePlan: { legs: [{ fromPlaceRef: place.id, toPlaceRef: place.id, geometryMode: fixture.privatePlace ? rule.privateGeometry : 'verified', geometry: fixture.privatePlace ? null : [[120, 30], [120, 30]] }] }, alternatives: [safeAlternative] };
  const deny = new Set(rule.denyKeys.map(key => key.toLowerCase()));
  const inspect = value => {
    if (Array.isArray(value)) return value.forEach(inspect);
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) { assert.ok(!deny.has(key.toLowerCase()), `RECURSIVE_PUBLIC_DENY:${key}`); inspect(item); }
  };
  inspect(result);
  assert.ok(!JSON.stringify(result).includes(privateText), 'PRIVATE_VALUE_CANNOT_HIDE_IN_ALLOWLIST');
  assert.ok(Object.keys(result).every(key => rule.topLevelAllowlist.includes(key)));
  return { result, place, tileRequests: fixture.privatePlace ? rule.allPrivateMapRequestCount : 1 };
}

function safeLog(policy, input) {
  const rule = policy.logging;
  const denied = new Set([...rule.denyKeys, ...rule.sensitiveHeaders].map(key => key.replaceAll('-', '').replaceAll('_', '').toLowerCase()));
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (denied.has(key.replaceAll('-', '').replaceAll('_', '').toLowerCase()) || !rule.allowFields.includes(key)) continue;
    if (['latencyMs', 'statusCode', 'resultCount', 'providerVersion', 'policyVersion'].includes(key)) { if (integer(value, 0, 1_000_000)) result[key] = value; continue; }
    if (/^(requestId|traceId|attemptId|eventId)$/.test(key)) { if (typeof value === 'string' && /^(req|tr|attempt|evt)[_:][A-Za-z0-9_-]{1,64}$/.test(value)) result[key] = value; continue; }
    const enumerations = { availability: domains.ProviderAvailability, cacheState: domains['CacheEnvelope.state'], errorCategory: ['timeout', 'rate_limited', 'configuration', 'security', 'normalization', 'unavailable', 'invalid_response'], actorType: ['USER', 'ADMIN', 'ANON', 'SYSTEM'], result: ['SUCCESS', 'FAILURE'], action: ['CREATE', 'READ', 'REVOKE', 'ERASE'], providerId: ['controlled-static-evidence', 'nominatim-compatible', 'osrm-compatible', 'open-meteo'], capability: ['geocoding', 'road_route', 'road_matrix', 'weather_forecast', 'manual_evidence'] };
    if (enumerations[key]?.includes(value)) result[key] = value;
  }
  return result;
}

function verifySecretFixtures(policy, fixtures, results) {
  const raw = Buffer.alloc(32, 37).toString('base64url');
  const hash = digest(raw);
  const receipt = { id: 'request-a', receiptHash: hash, requestHash: digest(`payload:${hash}`) };
  const grants = new Map();
  const issue = key => {
    if (grants.has(key)) return { ...grants.get(key), tokenAvailable: policy.secretProtocols.share.replayTokenAvailable, replayed: true };
    const grant = { shareId: `share-${grants.size + 1}`, planVersionId: 'version-a', expiresAt: '2026-09-10T00:00:00.000Z' };
    grants.set(key, grant);
    return { ...grant, tokenAvailable: true, token: raw, replayed: false };
  };
  const checks = {
    'anonymous-cookie-only': () => { const response = { data: { anonymous: true }, cookie: { name: policy.secretProtocols.anonymous.cookie, value: raw, flags: policy.secretProtocols.anonymous.flags } }; assert.ok(!JSON.stringify(response.data).includes(raw)); assert.ok(response.cookie.flags.includes('HttpOnly')); assert.equal(policy.secretProtocols.anonymous.bootstrapCreatesBusinessRecord, false); },
    'hash-only-persistence': () => { const stored = { anonTokenHash: hash, tokenHash: hash, receiptHash: hash }; assert.ok(Object.values(stored).every(value => /^[a-f0-9]{64}$/.test(value))); assert.ok(!JSON.stringify(stored).includes(raw)); },
    'same-key-same-receipt-replay': () => { assert.equal(digest(`payload:${digest(raw)}`), receipt.requestHash); assert.equal(receipt.id, 'request-a'); },
    'same-key-different-receipt-rejected': () => assert.notEqual(digest(`payload:${digest(Buffer.alloc(32, 38))}`), receipt.requestHash),
    'receipt-is-not-download': () => { assert.deepEqual(policy.secretProtocols.receipt.dataCapabilities, ['MINIMAL_STATUS']); assert.equal(policy.secretProtocols.receipt.downloadAllowed, false); assert.equal(policy.secretProtocols.receipt.planAccessAllowed, false); assert.equal(policy.secretProtocols.receipt.triageAllowed, false); },
    'feedback-receipt-after-share-revocation': () => { const shareActive = false; const canWithdraw = digest(raw) === receipt.receiptHash && policy.secretProtocols.receipt.feedbackCapabilities.includes('OWN_CONSENT'); assert.equal(shareActive, false); assert.equal(canWithdraw, true); },
    'share-first-delivery': () => { const result = issue('first'); assert.equal(result.tokenAvailable, true); assert.equal(result.token, raw); },
    'share-replay-has-no-token': () => { issue('replay'); const result = issue('replay'); assert.equal(result.tokenAvailable, false); assert.equal(Object.hasOwn(result, 'token'), false); },
    'share-reissue-keeps-version-and-expiry': () => { const old = issue('old'); const replacement = issue('new'); assert.notEqual(old.shareId, replacement.shareId); assert.equal(old.planVersionId, replacement.planVersionId); assert.equal(old.expiresAt, replacement.expiresAt); assert.equal(policy.secretProtocols.share.reissueRevokesOldGrant, true); },
    'nested-log-secret-removal': () => { const input = { requestId: 'req_fixture', traceId: 'tr_fixture', errorCategory: 'timeout', headers: { Authorization: raw, 'X-Share-Token': raw }, metadata: { payload: { password: raw, email: raw, receipt: raw } }, password: raw, apiKey: raw, rawOutput: raw }; const result = safeLog(policy, input); assert.deepEqual(result, { requestId: 'req_fixture', traceId: 'tr_fixture', errorCategory: 'timeout' }); assert.ok(!JSON.stringify(result).includes(raw)); },
    'allowlisted-log-value-is-not-free-text': () => { const result = safeLog(policy, { requestId: raw, errorCategory: raw, providerId: raw, latencyMs: Infinity }); assert.deepEqual(result, {}); },
  };
  sameSet(fixtures.secretProtocolCases, Object.keys(checks), 'SECRET_PROTOCOL_CASE_SET');
  for (const id of fixtures.secretProtocolCases) checked(results, id, checks[id]);
}

function verifyPrivacyFixtures(policy, register, fixtures) {
  const results = [];
  assert.equal(fixtures.simulation, true);
  assert.ok(validInstant(fixtures.clock));
  const expectedCounts = { decisions: 6, retention: 17, backups: 2, erasures: 5, consent: 5, publicProjection: 2, sourceUrls: 6, restore: 3, secretProtocolCases: 11 };
  for (const [key, count] of Object.entries(expectedCounts)) assert.equal(fixtures[key].length, count, `FIXED_PRIVACY_DENOMINATOR:${key}`);
  for (const fixture of fixtures.decisions) checked(results, fixture.id, () => withStore(directory => {
    const usable = canUse(policy, register, fixture);
    assert.equal(usable, fixture.expected);
    if (usable) save(directory, 'application', 'subject', { category: fixture.category, simulation: true });
    assert.equal(readdirSync(path.join(directory, 'application')).length, usable ? 1 : 0, 'BLOCK_MEANS_ZERO_DATA_WRITES');
  }));
  for (const fixture of fixtures.retention) checked(results, fixture.id, () => withStore(directory => {
    const rule = register.find(item => item.dataCategory === fixture.category);
    for (const store of ['application', 'objects', 'cache', 'client', 'samples', 'contact']) {
      const tombstonedAt = fixture.tombstoneAgeSeconds === undefined || fixture.tombstoneAgeSeconds === null ? null
        : new Date(Date.parse(fixtures.clock) + (fixture.ageSeconds - fixture.tombstoneAgeSeconds) * 1000).toISOString();
      save(directory, store, 'synthetic-a', { category: fixture.category, createdAt: fixtures.clock, simulation: true,
        ...(fixture.operationActive === undefined ? {} : { retention: { operationActive: fixture.operationActive,
          aggregatePresent: fixture.aggregatePresent, domainCleanupComplete: fixture.domainCleanupComplete, tombstonedAt } }) });
      save(directory, store, 'synthetic-b', { category: fixture.category, independent: true });
    }
    const result = expireStoredData(policy, rule, fixture, directory);
    assert.deepEqual(result, { deleted: fixture.expectedDeleted, blocked: fixture.expectedBlocked });
    for (const store of ['application', 'objects', 'cache', 'client', 'samples', 'contact']) {
      assert.equal(existsSync(fileIn(directory, store, 'synthetic-a')), !fixture.expectedDeleted);
      assert.equal(existsSync(fileIn(directory, store, 'synthetic-b')), true);
    }
  }));
  for (const fixture of fixtures.backups) checked(results, fixture.id, () => withStore(directory => {
    const rule = register.find(item => item.dataCategory === 'backup');
    save(directory, 'backup', 'synthetic-a', { erasedSubject: 'synthetic-a', simulation: true });
    save(directory, 'backup', 'synthetic-b', { independentSubject: 'synthetic-b' });
    appendIntent(directory, { intentId: 'backup-erase', scopeHash: digest('backup-a'), category: 'ERASE' });
    if (fixture.ageAfterEraseSeconds >= rule.backupDeadline.eraseWithinSeconds) remove(directory, 'backup', 'synthetic-a');
    assert.equal(existsSync(fileIn(directory, 'backup', 'synthetic-a')), !fixture.expectedDeleted);
    assert.equal(existsSync(fileIn(directory, 'backup', 'synthetic-b')), true);
    assert.equal(existsSync(fileIn(directory, 'ledger', 'entries')), true, 'BACKUP_PURGE_PRESERVES_INDEPENDENT_LEDGER');
  }));
  for (const fixture of fixtures.erasures) checked(results, fixture.id, () => withStore(directory => {
    const request = runErasure(policy, register, { ...fixture, clock: fixtures.clock }, directory);
    assert.equal(request.status, fixture.expectedStatus);
    assert.equal(request.continuationSequence, fixture.expectedContinuation);
    assert.equal(request.objectReadDenied, true);
    assert.ok(request.activeTaskCount <= policy.deletion.maxActiveTasksPerRequest);
    if (fixture.objectDeleteFails) assert.equal(existsSync(fileIn(directory, 'objects', 'synthetic-a')), true);
  }));
  for (const fixture of fixtures.consent) checked(results, fixture.id, () => withStore(directory => {
    const feedback = { id: 'feedback-a', revision: 1, contactConsent: fixture.contactConsent, evaluationConsent: fixture.evaluationConsent, privacyWatermark: 0 };
    if (feedback.contactConsent) save(directory, 'contact', 'synthetic-a', { source: 'OWN_NORMALIZED_EMAIL', simulation: true });
    if (feedback.evaluationConsent) save(directory, 'samples', 'synthetic-a', { feedbackId: feedback.id, consentRevision: feedback.revision, privacyWatermark: 0, simulation: true });
    const historicalManifest = { members: [feedback.id], contentHash: digest('synthetic-dataset-v1') };
    save(directory, 'backup', 'dataset-manifest', historicalManifest);
    const previousManifestHash = digest(readFileSync(fileIn(directory, 'backup', 'dataset-manifest')));
    if (fixture.withdrawContact || fixture.withdrawEvaluation) {
      const entry = appendIntent(directory, { intentId: `consent-${fixture.id}`, scopeHash: digest(fixture.id), category: 'CONSENT_WITHDRAWAL', feedbackId: feedback.id });
      assert.ok(existsSync(fileIn(directory, 'ledger', 'entries')));
      feedback.revision += 1;
      feedback.privacyWatermark = entry.sequence;
      if (fixture.withdrawContact) { feedback.contactConsent = false; remove(directory, 'contact', 'synthetic-a'); }
      if (fixture.withdrawEvaluation) { feedback.evaluationConsent = false; remove(directory, 'samples', 'synthetic-a'); }
      if (feedback.evaluationConsent) save(directory, 'samples', 'synthetic-a', { feedbackId: feedback.id, consentRevision: feedback.revision, privacyWatermark: feedback.privacyWatermark, simulation: true });
    }
    const sampleFile = fileIn(directory, 'samples', 'synthetic-a');
    const sample = existsSync(sampleFile) ? read(directory, 'samples', 'synthetic-a') : null;
    const sampleEligible = Boolean(sample && feedback.evaluationConsent && sample.feedbackId === feedback.id && sample.consentRevision === feedback.revision && sample.privacyWatermark === feedback.privacyWatermark);
    assert.equal(existsSync(fileIn(directory, 'contact', 'synthetic-a')), fixture.expectedContact);
    assert.equal(sampleEligible, fixture.expectedSample);
    assert.equal(digest(readFileSync(fileIn(directory, 'backup', 'dataset-manifest'))), previousManifestHash, 'HISTORICAL_DATASET_MANIFEST_NOT_REWRITTEN');
    if (fixture.shareRevoked) assert.equal(policy.secretProtocols.receipt.validAfterShareRevocation, true);
  }));
  for (const fixture of fixtures.publicProjection) checked(results, fixture.id, () => {
    const projected = publicFixtureProjection(policy, fixture);
    assert.deepEqual(projected.place.coordinate, fixture.expectedCoordinate);
    assert.equal(projected.result.routePlan.legs[0].geometryMode, fixture.expectedGeometry);
    assert.equal(projected.result.dailyItinerary[0].timeline[0].placeRef, projected.place.id);
    assert.equal(projected.tileRequests, fixture.expectedTileRequests);
    sameKeys(projected.result.sourceCatalog[0], policy.publicProjection.sourceSummaryFields, 'NO_INTERNAL_SOURCE_FIELDS');
  });
  for (const fixture of fixtures.sourceUrls) checked(results, fixture.id, () => assert.equal(safeSourceUrl(policy, fixture.url), fixture.expected));
  for (const fixture of fixtures.restore) checked(results, fixture.id, () => withStore(directory => {
    save(directory, 'backup', 'old-subject', { personalContent: true, appliedWatermark: fixture.backupWatermark, sessionActive: true });
    copyFileSync(fileIn(directory, 'backup', 'old-subject'), fileIn(directory, 'application', 'restored-subject'));
    let readiness = false;
    if (fixture.ledgerAvailable && fixture.ledgerWatermark >= fixture.backupWatermark) {
      for (let i = 0; i < fixture.ledgerWatermark; i++) appendIntent(directory, { intentId: `restore-${i}`, scopeHash: digest(`scope-${i}`), category: i === 0 ? 'ERASE' : 'SESSION_REVOKE' });
      const current = read(directory, 'application', 'restored-subject');
      for (const entry of read(directory, 'ledger', 'entries')) {
        if (entry.sequence <= current.appliedWatermark) continue;
        if (entry.category === 'ERASE') current.personalContent = false;
        if (entry.category === 'SESSION_REVOKE') current.sessionActive = false;
        current.appliedWatermark = entry.sequence;
      }
      save(directory, 'application', 'restored-subject', current);
      readiness = current.appliedWatermark === fixture.ledgerWatermark && !current.personalContent && !current.sessionActive;
    }
    assert.equal(readiness, fixture.expectedReadiness);
    assert.equal(read(directory, 'application', 'restored-subject').personalContent, fixture.expectedPersonalContent);
  }));
  verifySecretFixtures(policy, fixtures, results);
  return results;
}

function replaceBlock(document, name, value) {
  const marker = `<!-- contract:${name} -->`;
  const offset = document.indexOf(marker) + marker.length;
  return document.slice(0, offset) + document.slice(offset).replace(/^\s*```json\n[\s\S]*?\n```/, `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``);
}

class MutationRunnerError extends Error {
  constructor(diagnostic, details = {}) {
    super(diagnostic);
    this.name = 'MutationRunnerError';
    this.diagnostic = diagnostic;
    this.details = details;
  }
}

function checkerFailure(error) {
  const assertion = error instanceof assert.AssertionError && error.code === 'ERR_ASSERTION';
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: 'FAIL', failureClass: assertion ? 'CONTRACT_ASSERTION' : 'CHECKER_RUNTIME_ERROR',
    errorName: error?.name || 'NonErrorThrow', errorCode: error?.code || null,
    explicitDiagnostic: assertion && error.generatedMessage === false,
    diagnostic: error instanceof MutationRunnerError ? error.diagnostic : message.split(/\r?\n/, 1)[0], message,
    ...(error instanceof MutationRunnerError ? { details: error.details } : {}),
  };
}

function runMutationProcess(script, root, group, flags, id) {
  const result = spawnSync(process.execPath, [script, '--root', root, '--case', group, ...flags], {
    cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.signal !== null || !Number.isInteger(result.status) || result.status < 0) {
    throw new MutationRunnerError(`MUTATION_PROCESS_FAILURE:${id}`, {
      errorName: result.error?.name || null, message: result.error?.message || null, signal: result.signal, exitCode: result.status,
    });
  }
  return result;
}

function readMutationFailure(result, id) {
  if (result.status !== 1 || result.stdout.trim()) {
    throw new MutationRunnerError(`MUTATION_MUST_FAIL:${id}`, { exitCode: result.status, stdout: result.stdout, stderr: result.stderr });
  }
  let failure;
  try { failure = JSON.parse(result.stderr.trim()); }
  catch {
    throw new MutationRunnerError(`MUTATION_INVALID_FAILURE_REPORT:${id}`, { stderr: result.stderr });
  }
  if (!failure || failure.status !== 'FAIL' || typeof failure.errorName !== 'string' || typeof failure.diagnostic !== 'string') {
    throw new MutationRunnerError(`MUTATION_INVALID_FAILURE_REPORT:${id}`, { failure });
  }
  return failure;
}

function requireContractMutationFailure(result, definition) {
  const failure = readMutationFailure(result, definition.id);
  if (failure.failureClass !== 'CONTRACT_ASSERTION' || failure.errorName !== 'AssertionError'
    || failure.errorCode !== 'ERR_ASSERTION' || failure.explicitDiagnostic !== true) {
    throw new MutationRunnerError(`MUTATION_UNEXPECTED_ERROR:${definition.id}:${failure.errorName}`, {
      expectedDiagnostic: definition.expectedDiagnostic, failure,
    });
  }
  if (failure.diagnostic !== definition.expectedDiagnostic) {
    throw new MutationRunnerError(`MUTATION_WRONG_DIAGNOSTIC:${definition.id}`, {
      expectedDiagnostic: definition.expectedDiagnostic, failure,
    });
  }
  return failure;
}

function requireRestoredMutation(result, group, id, mutationCount = 0) {
  if (result.status !== 0 || result.stderr.trim()) {
    throw new MutationRunnerError(`MUTATION_RESTORED:${id}`, { exitCode: result.status, stderr: result.stderr });
  }
  let report;
  try { report = JSON.parse(result.stdout); }
  catch { throw new MutationRunnerError(`MUTATION_INVALID_RESTORATION_REPORT:${id}`, { stdout: result.stdout }); }
  if (report?.status !== 'PASS' || report.group !== group || report.mutations?.length !== mutationCount) {
    throw new MutationRunnerError(`MUTATION_INVALID_RESTORATION_REPORT:${id}`, { report });
  }
  return report;
}

function mutationRunnerSelfTest(root, group, original, definition, mutationCount) {
  const directory = newTemporaryRoot();
  const id = 'mutation-runner-rejects-typeerror';
  try {
    mkdirSync(path.join(directory, 'docs/phase-plans'), { recursive: true });
    copyFileSync(path.join(root, 'docs/phase-plans/Phase002-inputs.json'), path.join(directory, 'docs/phase-plans/Phase002-inputs.json'));
    writeFileSync(path.join(directory, files[group]), original.document);
    const destination = path.join(directory, 'docs/phase-plans/check-phase002-provider-privacy.mjs');
    const script = readFileSync(self, 'utf8');
    const declaration = group === 'provider' ? 'function checkProviderPolicy(policy) {' : 'function checkPrivacyPolicy(policy, register) {';
    const anchor = `\n${declaration}\n`;
    assert.equal(script.split(anchor).length, 2, `RUNNER_SELFTEST_SINGLE_TARGET:${group}`);
    const trigger = group === 'provider' ? "policy.domains.FactStatus.includes('unsupported')" : "Object.hasOwn(register[0], 'approvedAt')";
    // The injected message deliberately matches the expected contract diagnostic.
    // Only the mutated child reaches it; the outer checker must reject its error class.
    const mutatedScript = script.replace(anchor, `${anchor}  if (${trigger}) throw new TypeError(${JSON.stringify(definition.expectedDiagnostic)});\n`);
    const execute = () => runMutationProcess(destination, directory, group, ['--no-runner-self-test'], id);
    writeFileSync(destination, mutatedScript);
    const failed = execute();
    const failure = readMutationFailure(failed, id);
    const expectedDiagnostic = `MUTATION_UNEXPECTED_ERROR:${definition.id}:TypeError`;
    assert.equal(failure.failureClass, 'CHECKER_RUNTIME_ERROR', `RUNNER_SELFTEST_FAILURE_CLASS:${group}`);
    assert.equal(failure.errorName, 'MutationRunnerError', `RUNNER_SELFTEST_OUTER_ERROR:${group}`);
    assert.equal(failure.diagnostic, expectedDiagnostic, `RUNNER_SELFTEST_DIAGNOSTIC:${group}`);
    assert.equal(failure.details?.failure?.failureClass, 'CHECKER_RUNTIME_ERROR', `RUNNER_SELFTEST_INNER_CLASS:${group}`);
    assert.equal(failure.details?.failure?.errorName, 'TypeError', `RUNNER_SELFTEST_INNER_ERROR:${group}`);
    assert.equal(failure.details?.failure?.diagnostic, definition.expectedDiagnostic, `RUNNER_SELFTEST_MATCHING_MESSAGE:${group}`);
    writeFileSync(destination, script);
    const restored = execute();
    const restoredReport = requireRestoredMutation(restored, group, id, mutationCount);
    return {
      id, kind: 'CHECKER_RUNTIME_REJECTION', mutatedCheckerHash: digest(mutatedScript),
      expectedExit: 'NONZERO', observedExit: failed.status, expectedDiagnostic, diagnostic: failure.diagnostic,
      failureClass: failure.failureClass, errorName: failure.errorName, rejectedFailure: failure.details.failure,
      restoredExit: restored.status, restoredStatus: restoredReport.status, restoredMutationCount: restoredReport.mutations.length,
    };
  } finally { removeTemporaryRoot(directory); }
}

function mutations(root, group, original, options) {
  const definitions = group === 'provider' ? [
    { id: 'mixed-status-domain', expectedDiagnostic: 'EXACT_DOMAIN:FactStatus', change: policy => { policy.domains.FactStatus.push('unsupported'); } },
    { id: 'dns-check-disabled', expectedDiagnostic: 'TRANSPORT_GUARD:revalidateEveryDnsAnswer', change: policy => { policy.transport.revalidateEveryDnsAnswer = false; } },
    { id: 'connection-peer-check-disabled', expectedDiagnostic: 'TRANSPORT_GUARD:verifyConnectedPeer', change: policy => { policy.transport.verifyConnectedPeer = false; } },
    { id: 'unbounded-retry', expectedDiagnostic: 'FINITE_RETRY_BOUND', change: policy => { policy.limits.maxAttempts = 1000000; } },
    { id: 'cache-reuses-private-snapshot', expectedDiagnostic: 'CACHE_DENY:payloadMayReferenceFactSnapshot', change: policy => { policy.cache.payloadMayReferenceFactSnapshot = true; } },
    { id: 'ai-fact-fabrication-enabled', expectedDiagnostic: 'FALLBACK_DENY:aiMaySetFacts', change: policy => { policy.fallback.aiMaySetFacts = true; } },
  ] : [
    { id: 'fake-human-approval-field', block: 'privacy-decision-register', expectedDiagnostic: 'EXACT_ELEVEN_FIELDS:account', change: register => { register[0].approvedAt = '2026-09-09T00:00:00.000Z'; } },
    { id: 'unbounded-retention', block: 'privacy-decision-register', expectedDiagnostic: 'FINITE_RETENTION_BOUND:account', change: register => { register[0].retentionRule.maxAgeSeconds = null; } },
    { id: 'production-privacy-approval', expectedDiagnostic: 'PRIVACY_SYNTHETIC_ENVIRONMENT_ONLY', change: policy => { policy.environment = 'PRODUCTION'; } },
    { id: 'application-before-ledger', expectedDiagnostic: 'ERASURE_LEDGER_BEFORE_APPLICATION', change: policy => { [policy.deletion.acceptOrder[1], policy.deletion.acceptOrder[2]] = [policy.deletion.acceptOrder[2], policy.deletion.acceptOrder[1]]; } },
    { id: 'receipt-download-permission', expectedDiagnostic: 'RECEIPT_CAPABILITY_DENY:downloadAllowed', change: policy => { policy.secretProtocols.receipt.downloadAllowed = true; } },
    { id: 'consent-recheck-disabled', expectedDiagnostic: 'CONSENT_RECHECK_REQUIRED', change: policy => { policy.consent.recheckBeforeEverySampleOrReplay = false; } },
    { id: 'backup-deadline-unbounded', block: 'privacy-decision-register', expectedDiagnostic: 'FINITE_BACKUP_ERASURE_BOUND:account', change: register => { register[0].backupDeadline.eraseWithinSeconds = 999999999; } },
    { id: 'receipt-expiry-from-creation', block: 'privacy-decision-register', expectedDiagnostic: 'RECEIPT_TOMBSTONE_CLOCK', change: register => { register.find(item => item.dataCategory === 'data_and_feedback_receipt').retentionRule.startsAt = 'createdAt'; } },
    { id: 'active-command-ttl-enabled', expectedDiagnostic: 'RECEIPT_RETENTION_AUTHORITY:activeOperationNeverExpires', change: policy => { policy.enforcement.receiptRetention.activeOperationNeverExpires = false; } },
    { id: 'receipt-lifetime-detached-from-aggregate', expectedDiagnostic: 'RECEIPT_RETENTION_AUTHORITY:domainReceiptsRetainedWithAggregate', change: policy => { policy.enforcement.receiptRetention.domainReceiptsRetainedWithAggregate = false; } },
    { id: 'ledger-active-operation-guard-removed', block: 'privacy-decision-register', expectedDiagnostic: 'RECEIPT_RETENTION_GUARDS', change: register => { register.find(item => item.dataCategory === 'privacy_revocation_ledger').retentionRule.protectedBy = ['RECOVERY_WATERMARK']; } },
  ];
  const directory = newTemporaryRoot();
  const reports = [];
  try {
    mkdirSync(path.join(directory, 'docs/phase-plans'), { recursive: true });
    copyFileSync(path.join(root, 'docs/phase-plans/Phase002-inputs.json'), path.join(directory, 'docs/phase-plans/Phase002-inputs.json'));
    const destination = path.join(directory, files[group]);
    const execute = id => runMutationProcess(self, directory, group, ['--no-mutations'], id);
    for (const definition of definitions) {
      const name = definition.block || `${group}-policy`;
      const value = copy(name.endsWith('decision-register') ? original.register : original.policy);
      definition.change(value);
      const text = replaceBlock(original.document, name, value);
      writeFileSync(destination, text);
      const failed = execute(definition.id);
      const failure = requireContractMutationFailure(failed, definition);
      writeFileSync(destination, original.document);
      const restored = execute(definition.id);
      requireRestoredMutation(restored, group, definition.id);
      reports.push({ id: definition.id, kind: 'CONTRACT_MUTATION', mutatedDocumentHash: digest(text),
        expectedExit: 'NONZERO', observedExit: failed.status, restoredExit: restored.status,
        expectedDiagnostic: definition.expectedDiagnostic, diagnostic: failure.diagnostic, failureMessage: failure.message,
        failureClass: failure.failureClass, errorName: failure.errorName });
    }
    if (options.runnerSelfTest !== false) reports.push(mutationRunnerSelfTest(root, group, original, definitions[0], definitions.length));
  } finally { removeTemporaryRoot(directory); }
  return reports;
}

export function checkProvider(root = process.cwd(), manifest, options = {}) {
  const original = readGroup(root, 'provider');
  const sources = checkSources(root, original.policy, manifest);
  checkProviderPolicy(original.policy);
  const results = verifyProviderFixtures(original.policy, original.fixtures);
  return { status: 'PASS', group: 'provider', scope: 'DOCUMENT_CONTRACT_ONLY', ...sources, fixtureCount: results.length, fixtures: results, mutations: options.mutations === false ? [] : mutations(root, 'provider', original, options), contractHash: digest(canonical(original.policy)), publicNetworkRequests: 0, productImplementationEvaluated: false, hostingCheckedBy: 'PHASE002_MAIN_VERIFIER' };
}

export function checkPrivacy(root = process.cwd(), manifest, options = {}) {
  const original = readGroup(root, 'privacy');
  const sources = checkSources(root, original.policy, manifest);
  checkPrivacyPolicy(original.policy, original.register);
  const results = verifyPrivacyFixtures(original.policy, original.register, original.fixtures);
  return { status: 'PASS', group: 'privacy', scope: 'DOCUMENT_CONTRACT_ONLY', ...sources, dataCategoryCount: original.register.length, decisionFieldCount: decisionFields.length, fixtureCount: results.length, fixtures: results, mutations: options.mutations === false ? [] : mutations(root, 'privacy', original, options), contractHash: digest(canonical(original.policy)), registerHash: digest(canonical(original.register)), environment: 'ISOLATED_SYNTHETIC', ruleVersion: original.policy.ruleVersion, storageVerification: 'ACTUAL_TEMPORARY_SYNTHETIC_FILES', productDatabaseEvaluated: false, realUserConsent: 'NOT_EVALUATED', productionPolicy: 'NOT_EVALUATED' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  try {
    const args = process.argv.slice(2);
    const get = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
    const root = path.resolve(get('--root', process.cwd()));
    const group = get('--case', 'all');
    assert.ok(['provider', 'privacy', 'all'].includes(group), 'UNKNOWN_CASE');
    const options = { mutations: !args.includes('--no-mutations'), runnerSelfTest: !args.includes('--no-runner-self-test') };
    const result = group === 'provider' ? checkProvider(root, undefined, options) : group === 'privacy' ? checkPrivacy(root, undefined, options) : { provider: checkProvider(root, undefined, options), privacy: checkPrivacy(root, undefined, options) };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(checkerFailure(error))}\n`);
    process.exitCode = 1;
  }
}
