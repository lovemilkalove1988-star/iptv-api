const db = require("./database");

const DRY_RUN = true;

const BAD_NAMES = [
  "index",
  "playlist",
  "stream",
  "test",
  "unknown",
  "default",
  "chunklist",
  "chunks",
  "manifest",
  "segment",
  "segments",
  "master",
  "variant",
  "media",
  "video",
  "audio"
];

const BAD_WORDS = [
  "apk",
  "android",
  "download",
  "install",
  "telegram",
  "t.me",
  "whatsapp",
  "discord",
  "advert",
  "ads"
];

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\b(uhd|fhd|hd|sd|4k|1080p|720p|576p|480p|360p)\b/gi, "")
    .replace(/[®©™ⓈⒼ]/g, "")
    .replace(/[^a-zа-яё0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isBadName(name) {
  const original = String(name || "").trim();
  const normalized = normalizeName(original);

  if (!normalized) {
    return true;
  }

  if (BAD_NAMES.includes(normalized)) {
    return true;
  }

  const technicalPatterns = [
    /^index(?:\s+\d+)?(?:\s+.*)?$/i,
    /^playlist(?:\s+\d+)?(?:\s+.*)?$/i,
    /^chunklist(?:\s+.*)?$/i,
    /^chunks(?:\s+.*)?$/i,
    /^segment(?:\s+.*)?$/i,
    /^segments(?:\s+.*)?$/i,
    /^master(?:\s+.*)?$/i,
    /^variant(?:\s+.*)?$/i,
    /^manifest(?:\s+.*)?$/i,
    /^media(?:\s+.*)?$/i,
    /^video(?:\s+.*)?$/i,
    /^audio(?:\s+.*)?$/i
  ];

  if (technicalPatterns.some(pattern => pattern.test(normalized))) {
    return true;
  }

  const badTechnicalWords = [
    "chunklist",
    "dvr timeshift",
    "streamlink",
    "manifest",
    "segment",
    "playlist",
    "master playlist"
  ];

  if (badTechnicalWords.some(word => normalized.includes(word))) {
    return true;
  }

  return BAD_WORDS.some(word =>
    original.toLowerCase().includes(word)
  );
}

function qualityScore(row) {
  let score = 0;

  if (row.hls_ok === true) score += 100;
  else score -= 100;

  if (row.http_status === 200) score += 20;

  const time = Number(row.response_time);

  if (Number.isFinite(time)) {
    if (time < 200) score += 20;
    else if (time < 500) score += 15;
    else if (time < 1000) score += 10;
    else if (time < 2000) score += 5;
  }

  const name = String(row.name || "").toLowerCase();

  if (name.includes("1080")) score += 8;
  else if (name.includes("720")) score += 6;
  else if (name.includes("576")) score += 4;
  else if (name.includes("480")) score += 2;

  return score;
}

async function main() {

  console.log("");
  console.log("================================");
  console.log(" IPTV-KZ CANDIDATE CLEANER");
  console.log("================================");
  console.log("DRY RUN:", DRY_RUN);
  console.log("");

  const result = await db.query(`
    SELECT
      id,
      name,
      url,
      http_status,
      response_time,
      hls_ok,
      status,
      source_kind,
      language,
      region,
      created_at
    FROM channel_candidates
    WHERE archived = FALSE
      AND admin_deleted = FALSE
  `);

  console.log("Кандидатов в БД:", result.rows.length);
  console.log("");

  const groups = new Map();

  let rejected = 0;

  for (const row of result.rows) {

    if (isBadName(row.name)) {

      rejected++;

      console.log(
        "МУСОР:",
        row.id,
        "|",
        row.name
      );

      continue;
    }

    const key = normalizeName(row.name);

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(row);
  }

  console.log("");
  console.log("================================");
  console.log(" ГРУППИРОВКА КАНАЛОВ");
  console.log("================================");
  console.log("");

  let duplicates = 0;

  for (const [name, rows] of groups) {

    if (rows.length > 1) {

      duplicates += rows.length - 1;

      rows.sort((a, b) => {

        const scoreDiff =
          qualityScore(b) - qualityScore(a);

        if (scoreDiff !== 0) {
          return scoreDiff;
        }

        const timeA = Number.isFinite(Number(a.response_time))
          ? Number(a.response_time)
          : 999999;

        const timeB = Number.isFinite(Number(b.response_time))
          ? Number(b.response_time)
          : 999999;

        return timeA - timeB;
      });

      const winner = rows[0];

      console.log("");
      console.log("CHANNEL:", name);
      console.log("SOURCES:", rows.length);
      console.log(
        "WINNER:",
        winner.id,
        "|",
        winner.name,
        "| score:",
        qualityScore(winner),
        "|",
        winner.response_time,
        "ms"
      );

      for (const row of rows.slice(1)) {

        console.log(
          " DUPLICATE:",
          row.id,
          "|",
          row.name,
          "| score:",
          qualityScore(row),
          "|",
          row.response_time,
          "ms"
        );
      }
    }
  }

  console.log("");
  console.log("================================");
  console.log(" РЕЗУЛЬТАТ");
  console.log("================================");
  console.log("Всего кандидатов:", result.rows.length);
  console.log("Мусорных:", rejected);
  console.log("Групп каналов:", groups.size);
  console.log("Дубликатов внутри групп:", duplicates);
  console.log("");

  console.log("DRY RUN — БАЗА НЕ ИЗМЕНЯЛАСЬ.");

  await db.end();
}

main().catch(error => {
  console.error("");
  console.error("CANDIDATE CLEANER ERROR:");
  console.error(error);
  process.exitCode = 1;
});

