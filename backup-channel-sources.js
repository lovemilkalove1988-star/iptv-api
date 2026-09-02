const pool = require("./database");
const fs = require("fs");

async function main() {
  try {
    const result = await pool.query(`
      SELECT *
      FROM channel_sources
      ORDER BY id
    `);

    const file = "backup-before-channel-sources-upgrade-20260827.json";

    fs.writeFileSync(
      file,
      JSON.stringify(result.rows, null, 2),
      "utf8"
    );

    console.log("BACKUP СОЗДАН:", file);
    console.log("Источников сохранено:", result.rows.length);

  } catch (error) {
    console.error(error);
  } finally {
    await pool.end();
  }
}

main();
