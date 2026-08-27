const pool = require("./database");

async function main() {
  try {
    await pool.query(`
      ALTER TABLE channels
      ADD COLUMN IF NOT EXISTS milktv_manual_category TEXT
    `);

    console.log("");
    console.log("======================================");
    console.log("МИЛК ТВ — РУЧНЫЕ КАТЕГОРИИ");
    console.log("======================================");
    console.log("Колонка milktv_manual_category: ГОТОВА");
    console.log("======================================");

  } catch (error) {
    console.error("ОШИБКА:", error);
  } finally {
    await pool.end();
  }
}

main();
