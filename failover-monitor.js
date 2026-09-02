const db = require("./database");

const FAIL_THRESHOLD = 3;
const SUCCESS_THRESHOLD = 3;
const CHECK_TIMEOUT = 10000;

async function checkSource(url) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, CHECK_TIMEOUT);

  const started = Date.now();

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "*/*"
      }
    });

    const responseTime = Date.now() - started;
    const text = await response.text();
    const trimmed = text.trim();

    const hlsOk =
      response.ok &&
      trimmed.includes("#EXTM3U") &&
      (
        trimmed.includes("#EXTINF") ||
        trimmed.includes("#EXT-X-STREAM-INF") ||
        trimmed.includes("#EXT-X-TARGETDURATION")
      );

    return {
      working: hlsOk,
      httpStatus: response.status,
      responseTime,
      hlsOk
    };

  } catch (error) {

    return {
      working: false,
      httpStatus: null,
      responseTime: null,
      hlsOk: false,
      error:
        error.name === "AbortError"
          ? "TIMEOUT"
          : error.message
    };

  } finally {
    clearTimeout(timer);
  }
}


async function processFailover(row, dryRun) {

  if (row.consecutive_failures < FAIL_THRESHOLD) {
    return false;
  }

  console.log("FAILOVER КАНДИДАТ");
  console.log("--------------------------------------");
  console.log("Канал:", row.name);
  console.log("Channel ID:", row.channel_id);
  console.log("Primary source ID:", row.primary_id);
  console.log("Основной:", row.primary_url);
  console.log("Статус:", row.primary_status);
  console.log("Активен:", row.primary_active);
  console.log(
    "Последовательных отказов:",
    row.consecutive_failures
  );

  const backupResult = await db.query(`
    SELECT
      id,
      url,
      status,
      priority,
      is_active,
      consecutive_failures
    FROM channel_sources
    WHERE channel_id = $1
      AND source_type = 'backup'
      AND status = 'working'
    ORDER BY
      priority ASC,
      consecutive_failures ASC,
      id ASC
  `, [row.channel_id]);

  if (backupResult.rows.length === 0) {

    console.log("Рабочих backup нет.");
    console.log("");

    return false;
  }

  for (const backup of backupResult.rows) {

    console.log("");
    console.log("Проверяем backup:");
    console.log("Backup ID:", backup.id);
    console.log("URL:", backup.url);
    console.log("Приоритет:", backup.priority);
    console.log("Активен:", backup.is_active);

    const check = await checkSource(backup.url);

    console.log(
      "HTTP:",
      check.httpStatus ?? "нет ответа"
    );

    console.log(
      "Время:",
      check.responseTime ?? "нет",
      "ms"
    );

    console.log(
      "HLS:",
      check.hlsOk
    );

    if (!check.working) {

      console.log("Backup не прошёл проверку.");
      continue;
    }

    console.log("🟢 Backup подтверждён.");

    console.log("");
    console.log("ГОТОВ К FAILOVER");
    console.log("--------------------------------------");
    console.log("Было:", row.primary_url);
    console.log("Станет активным:", backup.url);
    console.log("Backup ID:", backup.id);

    if (dryRun) {

      console.log("");
      console.log("DRY RUN:");
      console.log("База НЕ изменяется.");
      console.log("channels.url НЕ изменяется.");
      console.log("Primary НЕ удаляется.");
      console.log("Backup НЕ активируется.");

      return true;
    }

    await db.query("BEGIN");

    try {

      /*
       * Старый Primary:
       * оставляем source_type = primary,
       * но выключаем.
       */

      await db.query(`
        UPDATE channel_sources
        SET
          is_active = false
        WHERE id = $1
      `, [row.primary_id]);


      /*
       * Backup:
       * становится активным.
       */

      await db.query(`
        UPDATE channel_sources
        SET
          is_active = true,
          status = 'working',
          consecutive_failures = 0,
          consecutive_successes = 1,
          last_success = NOW()
        WHERE id = $1
      `, [backup.id]);


      /*
       * ВАЖНО:
       *
       * channels.url НЕ ТРОГАЕМ.
       *
       * Реальный активный источник определяется
       * через channel_sources.
       */

      await db.query("COMMIT");

      console.log("");
      console.log("🟢 FAILOVER ВЫПОЛНЕН");
      console.log("Активный источник:", backup.id);
      console.log("channels.url НЕ изменён.");

      return true;

    } catch (error) {

      await db.query("ROLLBACK");
      throw error;
    }
  }

  console.log("");
  return false;
}


async function processFailback(row, dryRun) {

  /*
   * Failback возможен только если:
   *
   * 1. Primary сейчас working
   * 2. Primary имеет 3 успешных проверки
   * 3. У канала есть активный backup
   */

  if (
    row.consecutive_successes < SUCCESS_THRESHOLD
  ) {
    return false;
  }

  const activeBackupResult = await db.query(`
    SELECT
      id,
      url,
      status,
      priority,
      is_active,
      consecutive_failures,
      consecutive_successes
    FROM channel_sources
    WHERE channel_id = $1
      AND source_type = 'backup'
      AND is_active = true
    ORDER BY priority ASC, id ASC
  `, [row.channel_id]);

  if (activeBackupResult.rows.length === 0) {
    return false;
  }

  console.log("");
  console.log("FAILBACK КАНДИДАТ");
  console.log("--------------------------------------");
  console.log("Канал:", row.name);
  console.log("Channel ID:", row.channel_id);
  console.log("Primary ID:", row.primary_id);
  console.log("Primary:", row.primary_url);
  console.log("Primary статус:", row.primary_status);
  console.log(
    "Последовательных успехов:",
    row.consecutive_successes
  );

  const primaryCheck = await checkSource(row.primary_url);

  console.log("");
  console.log("Повторная проверка Primary:");
  console.log("HTTP:", primaryCheck.httpStatus ?? "нет ответа");
  console.log(
    "Время:",
    primaryCheck.responseTime ?? "нет",
    "ms"
  );
  console.log("HLS:", primaryCheck.hlsOk);

  if (!primaryCheck.working) {

    console.log("Primary пока не подтверждён.");
    console.log("");

    return false;
  }

  console.log("🟢 Primary подтверждён.");

  for (const backup of activeBackupResult.rows) {

    console.log("");
    console.log("Активный Backup:");
    console.log("Backup ID:", backup.id);
    console.log("URL:", backup.url);

    console.log("");
    console.log("ГОТОВ К FAILBACK");
    console.log("--------------------------------------");
    console.log("Вернём Primary:", row.primary_url);
    console.log("Отключим Backup:", backup.url);

    if (dryRun) {

      console.log("");
      console.log("DRY RUN:");
      console.log("База НЕ изменяется.");
      console.log("Primary НЕ активируется.");
      console.log("Backup НЕ отключается.");
      console.log("channels.url НЕ изменяется.");

      return true;
    }

    await db.query("BEGIN");

    try {

      /*
       * Возвращаем Primary.
       */

      await db.query(`
        UPDATE channel_sources
        SET
          is_active = true,
          status = 'working',
          consecutive_failures = 0,
          last_success = NOW()
        WHERE id = $1
      `, [row.primary_id]);


      /*
       * Backup выключаем,
       * но не удаляем.
       */

      await db.query(`
        UPDATE channel_sources
        SET
          is_active = false
        WHERE id = $1
      `, [backup.id]);


      await db.query("COMMIT");

      console.log("");
      console.log("🟢 FAILBACK ВЫПОЛНЕН");
      console.log("Primary снова активен.");
      console.log("Backup отключён.");
      console.log("channels.url НЕ изменён.");

      return true;

    } catch (error) {

      await db.query("ROLLBACK");
      throw error;
    }
  }

  return false;
}


async function runMonitor(dryRun = true) {

  console.log("======================================");
  console.log("FAILOVER MONITOR v4");
  console.log("======================================");
  console.log(
    "Режим:",
    dryRun ? "DRY RUN" : "БОЕВОЙ"
  );
  console.log(
    "Порог отказов:",
    FAIL_THRESHOLD
  );
  console.log(
    "Порог восстановления:",
    SUCCESS_THRESHOLD
  );
  console.log("");

  /*
   * Получаем ВСЕ primary,
   * независимо от is_active.
   */

  const result = await db.query(`
    SELECT
      c.id AS channel_id,
      c.name,

      cs.id AS primary_id,
      cs.url AS primary_url,
      cs.status AS primary_status,
      cs.is_active AS primary_active,
      cs.consecutive_failures,
      cs.consecutive_successes

    FROM channels c

    JOIN channel_sources cs
      ON cs.channel_id = c.id

    WHERE cs.source_type = 'primary'

    ORDER BY c.id
  `);

  let checked = 0;
  let failoverCandidates = 0;
  let failoverVerified = 0;
  let failbackCandidates = 0;
  let failbackVerified = 0;

  for (const row of result.rows) {

    checked++;

    /*
     * Сначала FAILOVER.
     */

    if (
      row.consecutive_failures >= FAIL_THRESHOLD
    ) {

      failoverCandidates++;

      const done =
        await processFailover(row, dryRun);

      if (done) {
        failoverVerified++;
      }

      continue;
    }


    /*
     * Затем FAILBACK.
     */

    if (
      row.primary_status === "working" &&
      row.consecutive_successes >= SUCCESS_THRESHOLD
    ) {

      failbackCandidates++;

      const done =
        await processFailback(row, dryRun);

      if (done) {
        failbackVerified++;
      }
    }
  }

  console.log("");
  console.log("======================================");
  console.log("ПРОВЕРКА ЗАВЕРШЕНА");
  console.log("======================================");
  console.log(
    "Основных источников:",
    checked
  );
  console.log(
    "Failover кандидатов:",
    failoverCandidates
  );
  console.log(
    "Failover подтверждено:",
    failoverVerified
  );
  console.log(
    "Failback кандидатов:",
    failbackCandidates
  );
  console.log(
    "Failback подтверждено:",
    failbackVerified
  );
  console.log("");
}


runMonitor(true)
  .catch(error => {

    console.error(
      "FAILOVER MONITOR ERROR:",
      error
    );

    process.exitCode = 1;

  })
  .finally(async () => {

    await db.end();

  });