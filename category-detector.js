const db = require("./database");

const DRY_RUN = true;

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[®©™ⓈⒼ]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\b(uhd|fhd|hd|sd|4k|1080p|720p|576p|480p|360p)\b/gi, "")
    .replace(/[^a-zа-яё0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectCategory(row) {
  const name = normalizeName(row.name);

  if (
    /jibek|казахстан|қазақстан|kazakh|qazaq/.test(name)
  ) {
    return "Казахстан";
  }

  if (
    /карусел|детск|kids|cartoon|мульт/.test(name)
  ) {
    return "Детские";
  }

  if (
    /муз тв|муз-тв|music|xite/.test(name)
  ) {
    return "Музыка";
  }

  if (
    /спорт|sport|football|футбол|матч/.test(name)
  ) {
    return "Спорт";
  }

  if (
    /кино|film|movie|cinema|амедиа|amedia/.test(name)
  ) {
    return "Кино";
  }

  if (
    /russia today|rt español|cgtn|rt espanol/.test(name)
  ) {
    return "Международные";
  }

  if (
    /рбк|звезда|архыз 24|белгород 24|нижний новгород 24|якутия 24|север/.test(name)
  ) {
    return "Новости";
  }

  return "Развлекательные";
}

async function main() {
  console.log("");
  console.log("================================");
  console.log(" IPTV-KZ CATEGORY DETECTOR");
  console.log("================================");
  console.log("DRY RUN:", DRY_RUN);
  console.log("");

  const result = await db.query(`
    SELECT
      id,
      name,
      url,
      category,
      hls_ok,
      archived,
      admin_deleted
    FROM channel_candidates
    WHERE archived = FALSE
      AND admin_deleted = FALSE
      AND hls_ok = TRUE
  `);

  const rows = result.rows;

  console.log("Рабочих кандидатов:", rows.length);
  console.log("");

  const statistics = {};

  for (const row of rows) {
    const category = detectCategory(row);

    if (!statistics[category]) {
      statistics[category] = 0;
    }

    statistics[category]++;

    console.log(
      row.id,
      "|",
      row.name,
      "→",
      category
    );

    if (!DRY_RUN) {
      await db.query(`
        UPDATE channel_candidates
        SET category = $1
        WHERE id = $2
      `, [category, row.id]);
    }
  }

  console.log("");
  console.log("================================");
  console.log(" КАТЕГОРИИ");
  console.log("================================");

  console.table(
    Object.entries(statistics).map(([category, count]) => ({
      category,
      count
    }))
  );

  if (DRY_RUN) {
    console.log("");
    console.log("DRY RUN — БАЗА НЕ ИЗМЕНЯЛАСЬ.");
  } else {
    console.log("");
    console.log("КАТЕГОРИИ СОХРАНЕНЫ.");
  }

  await db.end();
}

main().catch(error => {
  console.error("");
  console.error("CATEGORY DETECTOR ERROR:");
  console.error(error);
  process.exitCode = 1;
});
