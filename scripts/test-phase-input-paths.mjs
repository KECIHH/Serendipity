import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { requirePriorCaseBinding } from "./phase-evidence.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const from = "prisma/migrations/20260911000000_system_config/migration.sql";
const to = "prisma/migrations/20260911012345_system_config/migration.sql";
const receiptPath = "docs/evidence/attempts/Phase007/setup/migration-generation.json";
const rawMigrationPath = "docs/evidence/attempts/Phase007/setup/generated-system-config.sql";
const schemaPath = "prisma/schema.prisma";
const observations = [];

function fixture() {
  const rawMigration = 'CREATE TABLE "SystemConfig" ("id" TEXT NOT NULL);\n';
  const files = new Map([
    [rawMigrationPath, rawMigration],
    [to, rawMigration],
    [schemaPath, "model SystemConfig {\n  id String @id\n}\n"],
  ]);
  const priorPlan = {
    phase: 7,
    cases: [
      {
        testCaseId: "Phase007:migration",
        command: "node docs/phase-plans/verify-phase007.mjs --case migration",
        denominator: 1,
        expected: "Actual additive migration replays without drift.",
        inputPath: from,
        outputPath: "attempt-1/migration.json",
      },
      {
        testCaseId: "Phase007:schema",
        command: "node docs/phase-plans/verify-phase007.mjs --case schema",
        denominator: 1,
        expected: "Exact schema and constraints.",
        inputPath: "tests/integration/config-models.test.ts",
        outputPath: "attempt-1/schema.json",
      },
    ],
  };
  const plan = structuredClone(priorPlan);
  plan.cases[0].inputPath = to;
  plan.cases[0].outputPath = "attempt-3/migration.json";
  plan.inputPathCorrections = [
    {
      testCaseId: "Phase007:migration",
      from,
      to,
      receiptPath,
      receiptHash: "",
      reason: "Preserve the Prisma-generated migration timestamp required by docs/database.md.",
    },
  ];
  const generation = {
    generatedMigrationPath: to,
    rawMigrationPath,
    rawMigrationHash: digest(files.get(rawMigrationPath)),
    schemaHash: digest(files.get(schemaPath)),
    records: [
      {
        command: "npm run db:migrate -- --name system_config --create-only",
        exitCode: 0,
        timedOut: false,
        stdout:
          "The following migration(s) have been created:\nmigrations/\n  20260911012345_system_config/\n    migration.sql\n",
        stderr: "",
      },
    ],
  };
  const rebindReceipt = () => {
    files.set(receiptPath, `${JSON.stringify(generation)}\n`);
    plan.inputPathCorrections[0].receiptHash = digest(files.get(receiptPath));
  };
  const access = {
    readJson: (file) => {
      assert(files.has(file), `Missing synthetic receipt: ${file}`);
      return JSON.parse(files.get(file));
    },
    hashFile: (file) => {
      assert(files.has(file), `Missing synthetic artifact: ${file}`);
      return digest(files.get(file));
    },
  };
  rebindReceipt();
  return { plan, priorPlan, generation, files, access, rebindReceipt };
}

function positive(name, change = () => {}) {
  const context = fixture();
  change(context);
  requirePriorCaseBinding(context.plan, context.priorPlan, context.access);
  observations.push({ name, expected: "ACCEPT", status: "PASS" });
}

function negative(
  name,
  change,
  rebind = false,
  diagnostic = /PRIOR_PLAN_(?:CASES|PHASE|INPUT_PATH)/,
) {
  const context = fixture();
  change(context);
  if (rebind) context.rebindReceipt();
  assert.throws(
    () => requirePriorCaseBinding(context.plan, context.priorPlan, context.access),
    diagnostic,
    name,
  );
  observations.push({ name, expected: "REJECT", status: "PASS" });
}

positive("unchanged-case-needs-no-correction", ({ plan, priorPlan, files }) => {
  delete plan.inputPathCorrections;
  plan.cases[0].inputPath = priorPlan.cases[0].inputPath;
  files.clear();
});
positive("unchanged-other-phase-keeps-existing-protocol", ({ plan, priorPlan, files }) => {
  delete plan.inputPathCorrections;
  plan.phase = priorPlan.phase = 6;
  plan.cases = structuredClone(priorPlan.cases);
  files.clear();
});
positive("actual-generated-path-correction");
positive("later-retry-preserves-already-corrected-path", ({ priorPlan }) => {
  priorPlan.cases[0].inputPath = to;
});
positive("create-only-flag-order-and-skip-generate", (context) => {
  context.generation.records[0].command =
    "npm run db:migrate -- --create-only --name system_config --skip-generate";
  context.rebindReceipt();
});
positive("real-cli-format-omits-create-only-summary", (context) => {
  context.generation.records[0].command =
    "npm run db:migrate -- --name system_config --create-only --skip-generate";
  context.generation.records[0].stdout =
    '\n> serendipity@0.1.0 db:migrate\n> prisma migrate dev --name system_config --create-only --skip-generate\n\nPrisma schema loaded from prisma\\schema.prisma\nDatasource "db": PostgreSQL database "phase007_disposable_fixture", schema "public" at "127.0.0.1:5432"\n\n';
  context.generation.records[0].stderr = "";
  context.rebindReceipt();
});
positive("empty-cli-streams-preserve-file-and-schema-proof", (context) => {
  context.generation.records[0].stdout = "";
  context.generation.records[0].stderr = "";
  context.rebindReceipt();
});
positive("cli-summary-may-appear-on-stderr", (context) => {
  context.generation.records[0].stdout = "";
  context.generation.records[0].stderr =
    "Prisma Migrate created the following migration without applying it 20260911012345_system_config\n";
  context.rebindReceipt();
});
negative("missing-correction", ({ plan }) => {
  delete plan.inputPathCorrections;
});
negative("empty-corrections", ({ plan }) => {
  plan.inputPathCorrections = [];
});
negative("non-array-corrections", ({ plan }) => {
  plan.inputPathCorrections = {};
});
negative("duplicate-corrections", ({ plan }) => {
  plan.inputPathCorrections.push(structuredClone(plan.inputPathCorrections[0]));
});
negative("cross-phase-correction", ({ plan, priorPlan }) => {
  plan.phase = priorPlan.phase = 6;
});
negative("mismatched-prior-phase", ({ priorPlan }) => {
  priorPlan.phase = 6;
});
negative("correction-wrong-test-case", ({ plan }) => {
  plan.inputPathCorrections[0].testCaseId = "Phase007:schema";
});
negative("missing-prior-case", ({ plan }) => {
  plan.cases.splice(1, 1);
});
negative("changed-case-id", ({ plan }) => {
  plan.cases[0].testCaseId = "Phase007:other";
});
negative("incorrect-from-path", ({ plan }) => {
  plan.inputPathCorrections[0].from =
    "prisma/migrations/20260910000000_system_config/migration.sql";
});
negative("incorrect-to-path", ({ plan }) => {
  plan.inputPathCorrections[0].to = "prisma/migrations/20260911012346_system_config/migration.sql";
});
negative("incorrect-current-path", ({ plan }) => {
  plan.cases[0].inputPath = "prisma/migrations/20260911012346_system_config/migration.sql";
});
negative("invalid-from-shape", ({ plan }) => {
  plan.inputPathCorrections[0].from = "prisma/migrations/2026091100000_system_config/migration.sql";
});
negative("invalid-to-shape", ({ plan }) => {
  plan.inputPathCorrections[0].to = "prisma/migrations/20260911012345_other/migration.sql";
});
negative("migration-path-traversal", ({ plan }) => {
  plan.inputPathCorrections[0].to =
    "prisma/migrations/../20260911012345_system_config/migration.sql";
});
negative("no-op-correction", ({ plan }) => {
  plan.inputPathCorrections[0].from = to;
});
negative("blank-reason", ({ plan }) => {
  plan.inputPathCorrections[0].reason = " \n ";
});
negative("incorrect-receipt-path", ({ plan }) => {
  plan.inputPathCorrections[0].receiptPath =
    "docs/evidence/attempts/Phase006/setup/migration-generation.json";
});
negative("incorrect-receipt-hash", ({ plan }) => {
  plan.inputPathCorrections[0].receiptHash = "0".repeat(64);
});
negative("malformed-receipt-hash", ({ plan }) => {
  plan.inputPathCorrections[0].receiptHash = "invalid";
});
negative("changed-receipt-bytes", ({ files }) => {
  files.set(receiptPath, `${files.get(receiptPath)} `);
});
negative(
  "incorrect-generated-path",
  ({ generation }) => {
    generation.generatedMigrationPath = from;
  },
  true,
);
negative(
  "missing-generation-records",
  ({ generation }) => {
    delete generation.records;
  },
  true,
);
negative(
  "empty-generation-records",
  ({ generation }) => {
    generation.records = [];
  },
  true,
);
negative(
  "failed-create-only-command",
  ({ generation }) => {
    generation.records[0].exitCode = 1;
  },
  true,
);
negative(
  "timed-out-create-only-command",
  ({ generation }) => {
    generation.records[0].timedOut = true;
  },
  true,
);
negative(
  "command-did-not-create-only",
  ({ generation }) => {
    generation.records[0].command = "npm run db:migrate -- --name system_config";
  },
  true,
);
negative(
  "echoed-command-is-not-execution",
  ({ generation }) => {
    generation.records[0].command = "echo npm run db:migrate -- --name system_config --create-only";
  },
  true,
);
negative(
  "wrong-migration-command",
  ({ generation }) => {
    generation.records[0].command = "npm run db:migrate -- --name other --create-only";
  },
  true,
);
positive("cli-may-omit-generated-directory-output", (context) => {
  context.generation.records[0].stdout = "No pending migrations.";
  context.rebindReceipt();
});
positive("cli-output-cannot-override-bound-generated-path", (context) => {
  context.generation.records[0].stdout = "20260911012346_system_config";
  context.rebindReceipt();
});
positive("cli-directory-fragment-cannot-override-bound-generated-path", (context) => {
  context.generation.records[0].stdout = "prefix20260911012345_system_config_extra";
  context.rebindReceipt();
});
negative(
  "missing-stdout-record",
  ({ generation }) => {
    delete generation.records[0].stdout;
  },
  true,
);
negative(
  "missing-stderr-record",
  ({ generation }) => {
    delete generation.records[0].stderr;
  },
  true,
);
negative(
  "invalid-stdout-record",
  ({ generation }) => {
    generation.records[0].stdout = [];
  },
  true,
);
negative(
  "invalid-stderr-record",
  ({ generation }) => {
    generation.records[0].stderr = null;
  },
  true,
);
negative(
  "missing-timeout-result",
  ({ generation }) => {
    delete generation.records[0].timedOut;
  },
  true,
);
negative(
  "invalid-timeout-result",
  ({ generation }) => {
    generation.records[0].timedOut = "false";
  },
  true,
);
negative(
  "incorrect-generation-schema-hash",
  ({ generation }) => {
    generation.schemaHash = "0".repeat(64);
  },
  true,
);
negative(
  "missing-generation-schema-hash",
  ({ generation }) => {
    delete generation.schemaHash;
  },
  true,
);
negative(
  "malformed-generation-schema-hash",
  ({ generation }) => {
    generation.schemaHash = "invalid";
  },
  true,
);
negative("changed-generation-schema-bytes", ({ files }) => {
  files.set(schemaPath, "model Wrong {}\n");
});
negative(
  "missing-generated-migration-file",
  ({ files }) => {
    files.delete(to);
  },
  false,
  /Missing synthetic artifact: prisma\/migrations\//,
);
negative("invalid-generated-migration-hash", (context) => {
  const originalHash = context.access.hashFile;
  context.access.hashFile = (file) => (file === to ? "invalid" : originalHash(file));
});
negative(
  "raw-sql-outside-phase-evidence",
  ({ generation }) => {
    generation.rawMigrationPath = "prisma/migrations/20260911012345_system_config/migration.sql";
  },
  true,
);
negative(
  "raw-sql-path-traversal",
  ({ generation }) => {
    generation.rawMigrationPath = "docs/evidence/attempts/Phase007/setup/../generated.sql";
  },
  true,
);
negative(
  "incorrect-raw-sql-hash",
  ({ generation }) => {
    generation.rawMigrationHash = "0".repeat(64);
  },
  true,
);
negative("changed-raw-sql-bytes", ({ files }) => {
  files.set(rawMigrationPath, "ALTER TABLE other ADD COLUMN bypass INT;\n");
});
negative("changed-frozen-command", ({ plan }) => {
  plan.cases[0].command += " --skip-checks";
});
negative("changed-frozen-expected", ({ plan }) => {
  plan.cases[0].expected = "Migration exists.";
});
negative("changed-frozen-denominator", ({ plan }) => {
  plan.cases[0].denominator = 2;
});
negative("other-case-path-cannot-use-migration-correction", ({ plan }) => {
  plan.cases[1].inputPath = "tests/other.ts";
});
negative("unchanged-case-still-rejects-command-change", ({ plan, priorPlan }) => {
  delete plan.inputPathCorrections;
  plan.cases[0].inputPath = priorPlan.cases[0].inputPath;
  plan.cases[0].command = "echo PASS";
});
negative("unchanged-case-still-rejects-expected-change", ({ plan, priorPlan }) => {
  delete plan.inputPathCorrections;
  plan.cases[0].inputPath = priorPlan.cases[0].inputPath;
  plan.cases[0].expected = "Weaker assertion.";
});
negative("unchanged-case-still-rejects-denominator-change", ({ plan, priorPlan }) => {
  delete plan.inputPathCorrections;
  plan.cases[0].inputPath = priorPlan.cases[0].inputPath;
  plan.cases[0].denominator = 0;
});

console.log(
  JSON.stringify(
    {
      status: "PASS",
      scope: "PHASE007_GENERATED_MIGRATION_INPUT_PATH_CORRECTION_PROTOCOL",
      simulation: true,
      productionTraffic: false,
      caseCount: observations.length,
      accepted: observations.filter((item) => item.expected === "ACCEPT").length,
      rejected: observations.filter((item) => item.expected === "REJECT").length,
      observations,
    },
    null,
    2,
  ),
);
