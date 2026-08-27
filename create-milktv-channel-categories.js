const pool = require("./database");

async function main() {
  try {

    await pool.query(`
      CREATE TABLE IF NOT EXISTS milktv_channel_categories (
        id SERIAL PRIMARY KEY,
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(channel_id, category)
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_milktv_channel_categories_channel
      ON milktv_channel_categories(channel_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_milktv_channel_categories_category
      ON milktv_channel_categories(category)
    `);

    console.log("");
    console.log("======================================");
    console.log("МИЛК ТВ — МНОЖЕСТВЕННЫЕ КАТЕГОРИИ");
    console.log("======================================");
    console.log("Таблица создана/проверена: milktv_channel_categories");
    console.log("Один канал может иметь несколько категорий.");
    console.log("======================================");

  } catch (error) {

    console.error(error);

  } finally {

    await pool.end();

  }
}

main();
