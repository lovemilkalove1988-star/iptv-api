const db = require("./database");

function getMilktvRatingGroup(name) {

  let value = String(name || "")
    .trim()
    .toUpperCase();

  value = value.replace(
    /\s*\[[^\]]+\]\s*$/g,
    ""
  );

  value = value.replace(
    /\s*\((1080P|1080I|720P|720I|576P|576I|480P|480I|2160P|2160I|4K|UHD|FHD|HD)\)\s*$/i,
    ""
  );

  value = value.replace(
    /[\s._-]*(1080P|1080I|720P|720I|576P|576I|480P|480I|2160P|2160I|4K|UHD|FHD|HD)$/i,
    ""
  );

  return value.trim();

}

async function main() {

  const result = await db.query(`
    SELECT id, name
    FROM channels
    ORDER BY id
  `);

  for (const channel of result.rows) {

    const group = getMilktvRatingGroup(channel.name);

    await db.query(`
      UPDATE channels
      SET milktv_rating_group = $1
      WHERE id = $2
    `, [
      group,
      channel.id
    ]);

    console.log(
      channel.id + " | " +
      channel.name + " -> " +
      group
    );

  }

  console.log("");
  console.log("РЕЙТИНГОВЫЕ ГРУППЫ ЗАПОЛНЕНЫ");
  process.exit();

}

main().catch(error => {

  console.error(error);
  process.exit(1);

});

