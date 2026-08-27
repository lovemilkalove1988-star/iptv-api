const db = require("./database");

async function main() {
  await db.query(`
    ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS milktv_failed_checks integer NOT NULL DEFAULT 0
  `);

  console.log("СЧЁТЧИК 3 ПРОВЕРОК ГОТОВ");
}

main()
  .catch(console.error)
  .finally(() => db.end?.());
