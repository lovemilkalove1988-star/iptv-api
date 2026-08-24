const fs = require("fs");
const db = require("./database");

const file = "ru.kz.m3u";

async function importM3U() {

  const data = fs.readFileSync(file, "utf8");
  const lines = data.split("\n");

  let name = "";
  let url = "";
  let category = "";
  let logo = "";

  for (const line of lines) {

    if (line.startsWith("#EXTINF")) {

      name = line.split(",").pop().trim();

      const group = line.match(/group-title="([^"]+)"/);
      category = group ? group[1] : "Other";

      const logoMatch = line.match(/tvg-logo="([^"]+)"/);
      logo = logoMatch ? logoMatch[1] : "";
    }

    if (line.startsWith("http")) {

      url = line.trim();

      await db.query(
        "INSERT INTO channels (name, url, category, logo) VALUES ($1,$2,$3,$4)",
        [name, url, category, logo]
      );

      console.log("Added:", name);
    }
  }

  console.log("Import finished");
  process.exit();
}

importM3U();
