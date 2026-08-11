/**
 * Metadata schema for the AI-column engine (lives in the same local MySQL as
 * the corpus). Additive + idempotent: CREATE TABLE IF NOT EXISTS only, so
 * reruns never drop user data. Version history is first-class because sIVM
 * certifies reuse ACROSS prompt versions.
 *
 * Run: pnpm tsx scripts/migrate-lore-meta.ts
 */
import mysql from "mysql2/promise";

const MYSQL_URL =
  process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";

const TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS ai_columns (
    id VARCHAR(36) PRIMARY KEY,
    table_id VARCHAR(64) NOT NULL,
    name VARCHAR(120) NOT NULL,
    prompt_template TEXT NOT NULL,
    prompt_version INT NOT NULL DEFAULT 1,
    model VARCHAR(120) NOT NULL,
    output_spec JSON NOT NULL,
    tool_version INT NOT NULL DEFAULT 1,
    auto_run_new_rows BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_table (table_id)
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS ai_column_versions (
    column_id VARCHAR(36) NOT NULL,
    version INT NOT NULL,
    prompt_template TEXT NOT NULL,
    model VARCHAR(120) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (column_id, version)
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS ai_cells (
    column_id VARCHAR(36) NOT NULL,
    row_id VARCHAR(64) NOT NULL,
    prompt_version INT NOT NULL,
    model VARCHAR(120) NOT NULL,
    row_content_hash VARCHAR(64) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'pending',
    value JSON NULL,
    rationale TEXT NULL,
    error TEXT NULL,
    attempts INT NOT NULL DEFAULT 0,
    input_tokens INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0,
    cost_usd DECIMAL(12,8) NOT NULL DEFAULT 0,
    latency_ms INT NULL,
    certificate_id VARCHAR(36) NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (column_id, row_id, prompt_version),
    INDEX idx_cache (column_id, prompt_version, model, row_content_hash),
    INDEX idx_status (column_id, prompt_version, status)
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS cost_ledger (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    kind VARCHAR(24) NOT NULL,
    column_id VARCHAR(36) NULL,
    model VARCHAR(120) NOT NULL,
    cells INT NOT NULL DEFAULT 0,
    input_tokens INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0,
    cost_usd DECIMAL(12,8) NOT NULL DEFAULT 0,
    INDEX idx_at (at)
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS reuse_certificates (
    id VARCHAR(36) PRIMARY KEY,
    column_id VARCHAR(36) NOT NULL,
    from_version INT NOT NULL,
    to_version INT NOT NULL,
    alpha DECIMAL(6,4) NOT NULL,
    delta JSON NOT NULL,
    strata JSON NOT NULL,
    reused_count INT NOT NULL DEFAULT 0,
    recompute_count INT NOT NULL DEFAULT 0,
    sampled_count INT NOT NULL DEFAULT 0,
    verification_cost_usd DECIMAL(12,8) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_column (column_id, to_version)
  ) CHARACTER SET utf8mb4`,
];

async function main() {
  const db = await mysql.createConnection({ uri: MYSQL_URL });
  for (const ddl of TABLES) {
    await db.query(ddl);
  }
  const [rows] = await db.query(
    `SELECT TABLE_NAME FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND TABLE_NAME IN ('ai_columns','ai_column_versions','ai_cells','cost_ledger','reuse_certificates')
     ORDER BY TABLE_NAME`,
  );
  console.log(
    "META_TABLES:",
    (rows as Array<{ TABLE_NAME: string }>).map((r) => r.TABLE_NAME).join(","),
  );
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
