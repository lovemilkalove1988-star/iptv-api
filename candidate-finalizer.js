const db = require("./database");

const DRY_RUN = true;

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

function isTechnical(name) {
  const n = normalizeName(name);

  if (!n) return true;

  const exact = [
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

  if (exact.includes(n)) return true;

  const patterns = [
    /^index(?:\s+\d+)?(?:\s+.*)?$/i,
    /^playlist(?:\s+\d+)?(?:\s+.*)?$/i,
    /^chunklist(?:\s+.*)?$/i,
    /^chunks(?:\s+.*)?$/i,
    /^segment(?:\s+.*)?$/i,
    /^segments(?:\s+.*)?$/i,
    /^master(?:\s+.*)?$/i,
    /^variant(?:\s+.*)?$/i,
    /^media(?:\s+.*)?$/i,
    /^video(?:\s+.*)?$/i,
    /^audio(?:\s+.*)?$/i
  ];

  if (patterns.some(p => p.test(n))) return true;

  const badWords = [
    "chunklist",
    "dvr timeshift",
    "streamlink",
    "manifest",
    "segment"
  ];

  return badWords.some(word => n.includes(word));
}

function score(row) {
  let s = 0;

  if (row.hls_ok === true) s += 100;
  else s -= 100;

  if (Number(row.http_status) === 200) s += 20;

  const time = Number(row.response_time);

  if (Number.isFinite(time)) {
    if (time < 200) s += 20;
    else if (time < 500) s += 15;
    else if (time < 1000) s += 10;
    else if (time < 2000) s += 5;
  }

  const name = String(row.name || "").toLowerCase();

  if (name.includes("1080")) s += 8;
  else if (name.includes("720")) s += 6;
  else if (name.includes("576")) s += 4;
  else if (name.includes("480")) s += 2;

  return s;
}

async function main() {

  console.log("");
  console.log("================================");
  console.log(" IPTV-KZ CANDIDATE FINALIZER");
  console.log("================================");
  console.log("DRY RUN:", DRY_RUN);
  console.log("");

  const result = await db.query(`
    SELECT
      id,
      name,
      url,
      hls_ok,
      http_status,
      response_time,
      status,
      archived,
      admin_deleted
    FROM channel_candidates
    WHERE archived = FALSE
      AND admin_deleted = FALSE
  `);

  const rows = result.rows;

  console.log("Кандидатов:", rows.length);
  console.log("");

  const groups = new Map();

  let technical = 0;
  let notWorking = 0;

  for (const row of rows) {

    if (isTechnical(row.name)) {
      technical++;
      continue;
    }

    if (row.hls_ok !== true) {
      notWorking++;
      continue;
    }

    const key = normalizeName(row.name);

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(row);
  }

  let working = 0;
  let winners = 0;
  let duplicates = 0;

  const winnerIds = new Set();

  for (const [name, candidates] of groups) {

    working += candidates.length;

    candidates.sort((a, b) => {

      const scoreDiff = score(b) - score(a);

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

    const winner = candidates[0];

    winnerIds.add(winner.id);
    winners++;

    if (candidates.length > 1) {
      duplicates += candidates.length - 1;

      console.log("");
      console.log("КАНАЛ:", name);
      console.log("WINNER:", winner.id, "|", winner.name, "| score:", score(winner));

      for (const duplicate of candidates.slice(1)) {
        console.log(
          " DUPLICATE:",
          duplicate.id,
          "|",
          duplicate.name,
          "| score:",
          score(duplicate)
        );
      }
    }
  }

  console.log("");
  console.log("================================");
  console.log(" ПЛАН ОЧИСТКИ");
  console.log("================================");
  console.log("Всего:", rows.length);
  console.log("Технический мусор:", technical);
  console.log("Нерабочие:", notWorking);
  console.log("Рабочие:", working);
  console.log("Победители:", winners);
  console.log("Дубликаты рабочих:", duplicates);
  console.log("");

  if (DRY_RUN) {

    console.log("DRY RUN — БАЗА НЕ ИЗМЕНЯЛАСЬ.");
    console.log("");
    console.log("Следующий этап:");
    console.log("1. Архивировать технический мусор.");
    console.log("2. Архивировать нерабочие потоки.");
    console.log("3. Архивировать дубликаты рабочих потоков.");
    console.log("4. Оставить победителей как pending.");

  } else {

    await db.query("BEGIN");

    try {

      await db.query(`
        UPDATE channel_candidates
        SET archived = TRUE
        WHERE archived = FALSE
          AND admin_deleted = FALSE
          AND (
            hls_ok = FALSE
            OR hls_ok IS NULL
          )
      `);

      for (const row of rows) {

        if (isTechnical(row.name)) {

          await db.query(`
            UPDATE channel_candidates
            SET archived = TRUE
            WHERE id = $1
          `, [row.id]);

          continue;
        }

        if (row.hls_ok !== true) {
          continue;
        }

        const key = normalizeName(row.name);
        const candidates = groups.get(key) || [];

        const winner = candidates[0];

        if (winner && row.id !== winner.id) {

          await db.query(`
            UPDATE channel_candidates
            SET archived = TRUE
            WHERE id = $1
          `, [row.id]);

        } else if (winner && row.id === winner.id) {

          await db.query(`
            UPDATE channel_candidates
            SET status = 'pending'
            WHERE id = $1
          `, [row.id]);

        }
      }

      await db.query("COMMIT");

      console.log("");
      console.log("ОЧИСТКА ВЫПОЛНЕНА.");

    } catch (error) {

      await db.query("ROLLBACK");
      throw error;
    }
  }

  await db.end();
}

main().catch(error => {
  console.error("");
  console.error("CANDIDATE FINALIZER ERROR:");
  console.error(error);
  process.exitCode = 1;
});
