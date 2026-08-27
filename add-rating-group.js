const db = require("./database");

db.query(`
  ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS milktv_rating_group TEXT
`)
.then(() => {
  console.log("ПОЛЕ РЕЙТИНГОВОЙ ГРУППЫ ГОТОВО");
  process.exit();
})
.catch(e => {
  console.error(e);
  process.exit(1);
});
