const db = require("./database");

async function main() {
  await db.query(`
    ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS milktv_quarantine_since timestamp,
    ADD COLUMN IF NOT EXISTS milktv_quarantine_last_check timestamp
  `);

  console.log("ПОЛЯ КАРАНТИНА ГОТОВЫ");
}

main()
  .catch(console.error)
  .finally(() => db.end?.());
