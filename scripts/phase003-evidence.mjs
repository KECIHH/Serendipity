import assert from 'node:assert/strict';

function requireFileHash(file, expected, hashFile, label) {
  assert(typeof file === 'string' && file.length > 0 && !/^(?:\/|[A-Za-z]:)/.test(file) && !file.includes('\\') && !file.split('/').includes('..'), `${label}: invalid relative path`);
  assert.match(expected, /^[0-9a-f]{64}$/, `${label}: invalid SHA-256 for ${file}`);
  assert.equal(hashFile(file), expected, `${label}: bytes changed for ${file}`);
}

export function requirePhase003Artifacts(reports, hashFile, directory) {
  const files = [];
  for (const report of reports) {
    const artifacts = report.details?.artifacts ?? [];
    assert(Array.isArray(artifacts), 'ATTACHED_ARTIFACT: expected an array');
    const name = report.testCaseId.slice('Phase003:'.length);
    if (['browser-title', 'responsive-layout'].includes(name)) {
      // Each viewport has both a screenshot and DOM; focus evidence is separate.
      const widths = name === 'responsive-layout' ? [375, 1280] : [1280];
      const suffixes = [...widths.flatMap((width) => [`${name}-${width}.png`, `${name}-${width}.html`]), `${name}-focus-1280.png`, `${name}-focus-1280.html`];
      assert.deepEqual(artifacts.map(({ path }) => path).sort(), suffixes.map((suffix) => `${directory}/${suffix}`).sort(), `ATTACHED_ARTIFACT: incomplete ${name} evidence`);
    }
    for (const artifact of artifacts) {
      requireFileHash(artifact.path, artifact.sha256, hashFile, 'ATTACHED_ARTIFACT');
      files.push(artifact.path);
    }
  }
  assert.equal(new Set(files).size, files.length, 'ATTACHED_ARTIFACT: duplicated attachment');
  return files;
}

export function requirePhase003SupplementalHashes(review, hashFile) {
  const hashes = review.supplementalReportHashes;
  if (hashes === undefined) return [];
  assert(hashes && typeof hashes === 'object' && !Array.isArray(hashes), 'SUPPLEMENTAL_HASH: expected a hash map');
  for (const [file, expected] of Object.entries(hashes)) requireFileHash(file, expected, hashFile, 'SUPPLEMENTAL_HASH');
  return Object.keys(hashes);
}

export function requirePhase003EvidenceFixture(fixture, { hashFile, readJson }) {
  assert(fixture && fixture.acceptanceEvidence === false, 'EVIDENCE_FIXTURE: archived records are schema fixtures only');
  const fixturePlan = readJson(fixture.planPath);
  const support = readJson(`${fixture.directory}/supporting-commands.json`);
  const expected = [fixture.planPath, `${fixture.directory}/supporting-commands.json`, ...fixturePlan.cases.map((item) => item.outputPath), ...support.commands.map((_, index) => `${fixture.directory}/command-${String(index + 1).padStart(2, '0')}.json`)];
  assert.deepEqual(Object.keys(fixture.fileHashes).sort(), expected.sort(), 'EVIDENCE_FIXTURE: incomplete fixture hashes');
  for (const [file, sha256] of Object.entries(fixture.fileHashes)) requireFileHash(file, sha256, hashFile, 'EVIDENCE_FIXTURE');
  return { plan: fixturePlan, directory: fixture.directory, support, reports: fixturePlan.cases.map((item) => readJson(item.outputPath)) };
}

export function requirePhase003Bootstrap(bootstrap, { hashFile, readJson }) {
  assert.equal(bootstrap.status, 'PASS');
  assert.equal(bootstrap.phase, 3);
  assert(Array.isArray(bootstrap.commands) && bootstrap.commands.length > 0, 'BOOTSTRAP_COMMAND: receipts are required');
  for (const command of bootstrap.commands) {
    requireFileHash(command.outputPath, command.outputHash, hashFile, 'BOOTSTRAP_COMMAND');
    const record = readJson(command.outputPath);
    assert.equal(record.exitCode, command.exitCode, 'BOOTSTRAP_COMMAND: exit code differs');
    assert.equal([record.executable, ...record.arguments].join(' '), command.command, 'BOOTSTRAP_COMMAND: invocation differs');
  }
  // Earlier failed acquisition commands remain immutable; the final audit is
  // separately required to pass by both the runtime and supporting-command checks.
  requireFileHash('docs/runtime-baseline.json', bootstrap.runtimeBaselineHash, hashFile, 'BOOTSTRAP_RUNTIME');
  requireFileHash('.gitignore', bootstrap.ignoreMerge.mergedHash, hashFile, 'BOOTSTRAP_IGNORE');
  requireFileHash(bootstrap.generatedButton.path, bootstrap.generatedButton.sha256, hashFile, 'BOOTSTRAP_BUTTON');
  for (const [file, expected] of Object.entries(bootstrap.protectedDocumentHashes)) requireFileHash(file, expected, hashFile, 'BOOTSTRAP_PROTECTED_DOCUMENT');
  return { commandReceipts: bootstrap.commands.length, protectedDocuments: Object.keys(bootstrap.protectedDocumentHashes).length };
}

export function requirePhase003SupportingCommands(support, { plan, directory, reports, readJson }) {
  assert.equal(support.status, 'PASS', 'SUPPORT_COMMANDS: status must be PASS');
  assert.equal(support.actualCaseCount, plan.cases.length, 'SUPPORT_CASE_COUNT: case count differs');
  assert(Array.isArray(support.commands) && support.commands.length > 0, 'SUPPORT_COMMANDS: nonempty commands are required');
  assert(support.commands.every((record) => record.exitCode === 0 && record.error === null), 'SUPPORT_COMMANDS: a command did not succeed');
  for (const [index, record] of support.commands.entries()) {
    const file = `${directory}/command-${String(index + 1).padStart(2, '0')}.json`;
    assert.deepEqual(readJson(file), record, `SUPPORT_RAW_RECORD: command differs from ${file}`);
  }
  for (const item of plan.cases) assert.equal(support.commands.filter((record) => record.command === item.command).length, 1, `SUPPORT_CASE_COVERAGE: missing or duplicate ${item.testCaseId}`);
  for (const command of plan.requiredSupportingCommands) {
    if (command === 'npm ci') continue;
    assert(support.commands.some((record) => record.command === command), `SUPPORT_REQUIRED_COMMAND: missing ${command}`);
  }
  const regression = reports.find((report) => report.testCaseId === 'Phase003:verifier-regression');
  const installs = regression?.observations?.filter((record) => record.label === 'clean-install-npm-ci') ?? [];
  assert.equal(installs.length, 1, 'SUPPORT_NPM_CI: isolated installation receipt is required');
  assert.equal(installs[0].exitCode, 0, 'SUPPORT_NPM_CI: installation failed');
  assert.match(installs[0].arguments[0], /[\\/]npm-cli\.js$/);
  assert.deepEqual(installs[0].arguments.slice(1), ['ci', '--no-fund'], 'SUPPORT_NPM_CI: unexpected installation command');
  const audits = support.commands.filter((record) => record.command === 'npm audit --omit=dev --audit-level=high --json');
  assert(audits.length > 0, 'SUPPORT_AUDIT: production audit is required');
  for (const record of audits) {
    const audit = JSON.parse(record.stdout);
    assert(!audit.error, 'SUPPORT_AUDIT: service returned an error');
    assert.equal(audit.metadata.vulnerabilities.high, 0);
    assert.equal(audit.metadata.vulnerabilities.critical, 0);
  }
  return { commands: support.commands.length, cases: plan.cases.length, isolatedNpmCi: true };
}
