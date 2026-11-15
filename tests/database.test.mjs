import assert from "node:assert";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { executeTool } from "../dist/tools/index.js";
import { clearDbHistory, exportDbData, formatSchemaMermaidEr, handleDbCommand, inspectDatabaseSchema, loadDbHistory, maskDsn, parseConnectionTarget } from "../dist/tools/db.js";
import { assessSqlRisk, isQueryReadOnly } from "../dist/tools/risk.js";

async function runDatabaseTests() {
  console.log("Testing Wide CLI Database subsystem...");

  assert.strictEqual(assessSqlRisk("DROP TABLE users").destructive, true);
  assert.strictEqual(assessSqlRisk("TRUNCATE TABLE audit_logs").destructive, true);
  assert.strictEqual(assessSqlRisk("ALTER TABLE users ADD COLUMN role TEXT").destructive, true);
  assert.strictEqual(assessSqlRisk("GRANT ALL PRIVILEGES ON users TO eve").destructive, true);
  assert.strictEqual(assessSqlRisk("DELETE FROM users").destructive, true);
  assert.strictEqual(assessSqlRisk("DELETE FROM users WHERE 1=1").destructive, true);
  assert.strictEqual(assessSqlRisk("UPDATE users SET active = 0").destructive, true);
  assert.strictEqual(assessSqlRisk("SELECT 1; -- safe\nDROP TABLE users").destructive, true);
  assert.strictEqual(assessSqlRisk("SELECT 'DROP TABLE users' AS example").destructive, false);
  assert.strictEqual(assessSqlRisk("DELETE FROM users WHERE id = 7").destructive, false);
  assert.strictEqual(isQueryReadOnly("SELECT id FROM users"), true);
  assert.strictEqual(isQueryReadOnly("SELECT 'DELETE FROM users'"), true);
  assert.strictEqual(isQueryReadOnly("SELECT 1; INSERT INTO users VALUES (1)"), false);
  assert.strictEqual(assessSqlRisk("FLUSHALL", "redis").destructive, true);
  assert.strictEqual(isQueryReadOnly("SCAN 0 COUNT 10", "redis"), true);
  assert.strictEqual(isQueryReadOnly("SET k v", "redis"), false);
  console.log("[PASS] SQL and Redis risk/read-only analysis");

  assert.strictEqual(
    maskDsn("postgres://alice:super_secret_pw@db.example.com:5432/app?sslmode=disable"),
    "postgres://alice:****@db.example.com:5432/app?sslmode=disable"
  );
  const parsedPg = parseConnectionTarget("postgres://alice:secret@db.prod.local:5432/app?sslmode=disable", process.cwd(), {
    environment: "prod",
    readOnly: true,
  });
  assert.strictEqual(parsedPg.meta.kind, "postgres");
  assert.strictEqual(parsedPg.meta.sslMode, "disable");
  assert.strictEqual(parsedPg.meta.readOnly, true);
  assert.strictEqual(parsedPg.secret, "secret");
  console.log("[PASS] DSN masking & connection parsing");

  const tempRoot = mkdtempSync(join(tmpdir(), "wide-cli-db-"));
  const tempHome = join(tempRoot, "home");
  const tempWs = join(tempRoot, "ws");
  const dbPath = join(tempWs, "app.sqlite");
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;

  try {
    await import("node:fs").then((fs) => {
      fs.mkdirSync(tempHome, { recursive: true });
      fs.mkdirSync(tempWs, { recursive: true });
      writeFileSync(join(tempWs, "schema.prisma"), 'datasource db { provider = "sqlite" }\n');
      writeFileSync(join(tempWs, ".env"), "DATABASE_URL=postgres://secret:should_not_appear@internal/db\n");
    });

    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        api_token TEXT NOT NULL
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        total_cents INTEGER NOT NULL
      );
      INSERT INTO users (id, email, password_hash, api_token)
      VALUES (1, 'alice@example.com', '5f4dcc3b5aa765d61d8327deb882cf99', 'tok_live_12345');
      INSERT INTO orders (id, user_id, total_cents) VALUES (10, 1, 2500);
    `);
    rawDb.close();

    await handleDbCommand(`/db connect ${dbPath} --name rodb --env prod --readonly`, {
      workingDirectory: tempWs,
      ask: async () => "n",
    });

    const listRes = await executeTool("db_list", {}, { workingDirectory: tempWs });
    assert.strictEqual(listRes.success, true);
    const listJson = JSON.parse(listRes.output);
    assert.strictEqual(listJson.saved.length, 1);
    assert.strictEqual(listJson.saved[0].id, "rodb");
    assert.strictEqual(listJson.saved[0].readOnly, true);
    assert.ok(listJson.discovered.some((d) => d.kind === "sqlite"));
    assert.ok(listJson.discovered.some((d) => d.kind === "prisma"));
    assert.ok(!listRes.output.includes("should_not_appear"), "Must never leak .env contents");
    console.log("[PASS] db_list discovery & isolation");

    const schemaRes = await executeTool("db_inspect_schema", { connection: "rodb" }, { workingDirectory: tempWs });
    assert.strictEqual(schemaRes.success, true);
    assert.ok(schemaRes.output.includes("users"));
    assert.ok(schemaRes.output.includes("orders"));
    assert.ok(schemaRes.output.includes("REFERENCES users(id)"));
    console.log("[PASS] db_inspect_schema");

    const qRead = await executeTool(
      "db_query",
      { connection: "rodb", query: "SELECT id, email, password_hash, api_token FROM users" },
      { workingDirectory: tempWs, autoApproveRead: true }
    );
    assert.strictEqual(qRead.success, true);
    const qJson = JSON.parse(qRead.output);
    assert.strictEqual(qJson.rows[0].email, "alice@example.com");
    assert.strictEqual(qJson.rows[0].password_hash, "[REDACTED]");
    assert.strictEqual(qJson.rows[0].api_token, "[REDACTED]");

    const qBlockedRo = await executeTool(
      "db_query",
      { connection: "rodb", query: "DELETE FROM users WHERE id = 1" },
      { workingDirectory: tempWs, autoApproveWrite: true }
    );
    assert.strictEqual(qBlockedRo.success, false);
    assert.ok((qBlockedRo.error || "").includes("read-only"));
    console.log("[PASS] db_query AI redaction & read-only enforcement");

    const auditRes = await executeTool("db_audit", { connection: "rodb" }, { workingDirectory: tempWs });
    assert.strictEqual(auditRes.success, true);
    const auditJson = JSON.parse(auditRes.output);
    assert.ok(auditJson.findings.some((f) => f.category === "weak-credential-storage" && f.severity === "CRITICAL"));
    assert.ok(auditJson.findings.some((f) => f.category === "pii-discovery"));
    console.log("[PASS] db_audit weak hash & PII detection");

    const histBefore = loadDbHistory();
    assert.ok(histBefore.some((h) => h.sql.includes("SELECT id, email, password_hash, api_token FROM users")));
    assert.strictEqual(typeof histBefore[0].durationMs, "number");

    const exportCsvRes = await executeTool(
      "db_export",
      { connection: "rodb", query: "SELECT id, email, password_hash FROM users", format: "csv", tableName: "users" },
      { workingDirectory: tempWs }
    );
    assert.strictEqual(exportCsvRes.success, true);
    assert.ok(exportCsvRes.output.includes("alice@example.com"));
    assert.ok(exportCsvRes.output.includes("[REDACTED]"));

    const exportSqlStr = exportDbData("sql", "users", ["id", "email"], [{ id: 1, email: "o'malley@example.com" }], "sqlite");
    assert.ok(exportSqlStr.includes("INSERT INTO"));
    assert.ok(exportSqlStr.includes("o''malley@example.com"));

    await handleDbCommand(`/db export rodb csv "SELECT id, email FROM users" --out exported.csv`, {
      workingDirectory: tempWs,
      ask: async () => "n",
    });
    assert.ok(existsSync(join(tempWs, "exported.csv")));
    assert.ok(readFileSync(join(tempWs, "exported.csv"), "utf8").includes("alice@example.com"));

    const erdTarget = parseConnectionTarget(dbPath, tempWs, { name: "erdcheck", readOnly: true });
    const erdSchema = await inspectDatabaseSchema(erdTarget.meta, erdTarget.secret);
    const mermaid = formatSchemaMermaidEr(erdSchema);
    assert.ok(mermaid.includes("erDiagram"));
    assert.ok(mermaid.includes("orders }o--|| users"));
    clearDbHistory();
    assert.strictEqual(loadDbHistory().length, 0);
    console.log("[PASS] db history, CSV/JSON/SQL export, and Mermaid ERD generation");

    await handleDbCommand(`/db connect ${dbPath} --name rwdb --env local`, {
      workingDirectory: tempWs,
      ask: async () => "n",
    });

    const dropNoInteract = await executeTool(
      "db_query",
      { connection: "rwdb", query: "DROP TABLE orders" },
      { workingDirectory: tempWs, autoApproveWrite: true, autoApproveRun: true }
    );
    assert.strictEqual(dropNoInteract.success, false);
    assert.ok((dropNoInteract.error || "").includes("Interactive confirmation required"));

    const dropWithConfirm = await executeTool(
      "db_query",
      { connection: "rwdb", query: "DROP TABLE orders" },
      {
        workingDirectory: tempWs,
        requestApproval: async (req) => {
          assert.strictEqual(req.destructive, true);
          return "once";
        },
      }
    );
    assert.strictEqual(dropWithConfirm.success, true);
    console.log("[PASS] destructive SQL requires explicit confirmation");
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

await runDatabaseTests();
