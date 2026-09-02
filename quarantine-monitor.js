require("dotenv").config();

const db = require("./database");

const QUARANTINE_HOURS = 4;

async function checkHls(url) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 10000);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "*/*"
      }
    });

    const text = (await response.text()).trim();

    const ok =
      response.ok &&
      text.includes("#EXTM3U") &&
      (
        text.includes("#EXTINF") ||
        text.includes("#EXT-X-STREAM-INF") ||
        text.includes("#EXT-X-TARGETDURATION")
      );

    return {
      ok,
      reason: ok
        ? "HLS OK"
        : response.ok
          ? "Не похож на HLS"
          : "HTTP " + response.status
    };

  } catch (error) {

    return {
      ok: false,
      reason:
        error.name === "AbortError"
          ? "TIMEOUT"
          : error.message
    };

  } finally {
    clearTimeout(timer);
  }
}

async function monitorQuarantine() {

  const result = await db.query(`
    SELECT
      id,
      channel_id,
      url
    FROM channel_sources
    WHERE status = 'quarantine'
      AND next_check IS NOT NULL
      AND next_check <= NOW()
    ORDER BY next_check ASC
  `);

  console.log("");
  console.log("======================================");
  console.log("QUARANTINE MONITOR");
  console.log("Источников к проверке:", result.rows.length);
  console.log("======================================");

  let recovered = 0;
  let stillDown = 0;

  for (const source of result.rows) {

    console.log("");
    console.log("Проверяем source:", source.id);
    console.log("Channel:", source.channel_id);
    console.log("URL:", source.url);

    const check = await checkHls(source.url);

    if (check.ok) {

      await db.query(`
        UPDATE channel_sources
        SET
          status = 'working',
          is_active = false,
          next_check = NULL,
          last_check = NOW(),
          last_success = NOW(),
          last_error = NULL,
          consecutive_failures = 0,
          consecutive_successes = consecutive_successes + 1,
          down_since = NULL
        WHERE id = $1
      `, [source.id]);

      recovered++;

      console.log("ВОССТАНОВЛЕН → WORKING");

    } else {

      await db.query(`
        UPDATE channel_sources
        SET
          status = 'quarantine',
          is_active = false,
          next_check = NOW() + INTERVAL '${QUARANTINE_HOURS} hours',
          last_check = NOW(),
          last_failure = NOW(),
          last_error = $2
        WHERE id = $1
      `, [source.id, check.reason]);

      stillDown++;

      console.log(
        "ОСТАЛСЯ В КАРАНТИНЕ → следующая проверка через",
        QUARANTINE_HOURS,
        "час."
      );
    }
  }

  console.log("");
  console.log("Восстановлено:", recovered);
  console.log("Осталось в карантине:", stillDown);
}

monitorQuarantine()
  .catch(error => {
    console.error("");
    console.error("QUARANTINE MONITOR ERROR:");
    console.error(error);
    console.error("");
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });