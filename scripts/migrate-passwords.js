const db = require("../database");
const { hashPassword, isPasswordHash } = require("../password-utils");

async function migrateTable(client, table, idColumn) {
  const result = await client.query(
    `SELECT ${idColumn}, password FROM ${table} FOR UPDATE`
  );
  let migrated = 0;

  for (const row of result.rows) {
    if (isPasswordHash(row.password)) {
      continue;
    }

    await client.query(
      `UPDATE ${table} SET password = $1 WHERE ${idColumn} = $2`,
      [hashPassword(row.password), row[idColumn]]
    );
    migrated++;
  }

  return migrated;
}

async function main() {
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    const users = await migrateTable(client, "users", "id");
    const clients = await migrateTable(client, "clients", "id");
    await client.query("COMMIT");
    console.log(`Password migration complete. users=${users}, clients=${clients}`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Password migration failed:", error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.end();
  }
}

main();
