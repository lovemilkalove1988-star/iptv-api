const db = require("./database");

const channels = [
  {
    name: "Первый канал",
    url: "http://example.com/1.m3u8",
    category: "Россия"
  },
  {
    name: "Россия 1",
    url: "http://example.com/2.m3u8",
    category: "Россия"
  }
];

async function importChannels() {
  try {
    for (const ch of channels) {
      await db.query(
        "INSERT INTO channels (name, url, category) VALUES ($1, $2, $3)",
        [ch.name, ch.url, ch.category]
      );
    }

    console.log("Channels imported");
    process.exit();

  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

importChannels();
