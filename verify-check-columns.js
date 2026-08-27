require("dotenv").config();
const { Client } = require("pg");

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

client.connect()
  .then(() => client.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'channels' AND column_name LIKE 'milktv_%' ORDER BY ordinal_position"
  ))
  .then(result => {
    console.table(result.rows);
  })
  .catch(error => {
    console.error(error.message);
  })
  .finally(() => client.end());
