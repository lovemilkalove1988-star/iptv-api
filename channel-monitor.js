process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const db = require("./database");

const FAIL_THRESHOLD = 3;
const RECOVERY_THRESHOLD = 3;
const DOWN_DELETE_DAYS = 7;
const CHECK_TIMEOUT = 10000;
const MONITOR_CONCURRENCY = 10;

const QUARANTINE_HOURS = 4;
const QUARANTINE_STATUS = "quarantine";


async function checkHls(url) {

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
      ok: hlsOk,
      statusCode: response.status,
      responseTime,
      reason: hlsOk
        ? "HLS OK"
        : response.ok
          ? "Не похож на HLS"
          : "HTTP " + response.status
    };

  } catch (error) {

    return {
      ok: false,
      indeterminate: true,
      statusCode: null,
      responseTime: null,
      reason:
        error.name === "AbortError"
          ? "TIMEOUT"
          : error.message
    };

  } finally {

    clearTimeout(timer);

  }
}


async function findBackup(channelId, currentSourceId) {

  const result = await db.query(`
    SELECT
      id,
      url,
      source_type,
      status,
      priority,
      is_active,
      consecutive_failures
    FROM channel_sources

    WHERE channel_id = $1
      AND id <> $2
      AND source_type = 'backup'
      AND status = 'working'

    ORDER BY
      priority ASC,
      consecutive_failures ASC,
      id ASC
  `, [channelId, currentSourceId]);


  for (const backup of result.rows) {

    console.log("   Проверяем резерв:", backup.url);

    const check = await checkHls(backup.url);

    console.log(
      "   HTTP:",
      check.statusCode ?? "нет ответа"
    );

    console.log(
      "   Время:",
      check.responseTime ?? "нет",
      "ms"
    );

    console.log(
      "   HLS:",
      check.ok
    );


    if (!check.ok) {
      continue;
    }


    return {
      ...backup,
      responseTime: check.responseTime
    };
  }


  return null;
}


async function performFailover(
  channelId,
  currentSourceId,
  backupId,
  responseTime
) {

  const client = await db.connect();

  try {

    await client.query("BEGIN");

    const sources = await client.query(`
      SELECT
        id,
        source_type,
        status,
        is_active
      FROM channel_sources
      WHERE channel_id = $1
      FOR UPDATE
    `, [channelId]);

    const currentSource =
      sources.rows.find(source => source.id === currentSourceId);

    const backup =
      sources.rows.find(source => source.id === backupId);

    if (!currentSource || !currentSource.is_active) {
      throw new Error(
        `FAILOVER: активный источник ${currentSourceId} не найден для канала ${channelId}`
      );
    }

    if (
      !backup ||
      backup.source_type !== "backup" ||
      backup.status !== "working"
    ) {
      throw new Error(
        `FAILOVER: рабочий backup ${backupId} не найден для канала ${channelId}`
      );
    }

    /*
     * Старый источник выключаем.
     */

    const deactivateCurrent = await client.query(`
      UPDATE channel_sources
      SET
        is_active = false,
        status = 'down',
        last_failure = NOW(),
        last_error = 'FAILOVER: источник отключён'
      WHERE id = $1
        AND channel_id = $2
        AND is_active = true
    `, [currentSourceId, channelId]);

    if (deactivateCurrent.rowCount !== 1) {
      throw new Error(
        `FAILOVER: не удалось выключить активный источник ${currentSourceId}`
      );
    }

    /*
     * До включения нового источника выключаем все источники канала.
     */

    const deactivateAll = await client.query(`
      UPDATE channel_sources
      SET is_active = false
      WHERE channel_id = $1
    `, [channelId]);

    if (deactivateAll.rowCount < 1) {
      throw new Error(
        `FAILOVER: источники канала ${channelId} не найдены`
      );
    }


    /*
     * Backup включаем.
     */

    const activateBackup = await client.query(`
      UPDATE channel_sources
      SET
        is_active = true,
        status = 'working',
        response_time_ms = $2,
        consecutive_failures = 0,
        consecutive_successes = consecutive_successes + 1,
        last_success = NOW(),
        last_error = NULL,
        down_since = NULL
      WHERE id = $1
        AND channel_id = $3
        AND source_type = 'backup'
        AND status = 'working'
    `, [
      backupId,
      responseTime,
      channelId
    ]);

    if (activateBackup.rowCount !== 1) {
      throw new Error(
        `FAILOVER: не удалось включить backup ${backupId}`
      );
    }


    /*
     * ВАЖНО:
     *
     * channels.url НЕ изменяем.
     *
     * Активный источник теперь определяется
     * через channel_sources.is_active.
     */


    const activeSources = await client.query(`
      SELECT id
      FROM channel_sources
      WHERE channel_id = $1
        AND is_active = true
    `, [channelId]);

    if (activeSources.rowCount !== 1 || activeSources.rows[0].id !== backupId) {
      throw new Error(
        `FAILOVER: для канала ${channelId} должен остаться ровно один активный backup`
      );
    }

    await client.query("COMMIT");

    return true;

  } catch (error) {

    await client.query("ROLLBACK");

    throw error;

  } finally {

    client.release();
  }
}


async function performFailback(
  channelId,
  primaryId,
  backupId,
  responseTime
) {

  const client = await db.connect();

  try {

    await client.query("BEGIN");

    const sources = await client.query(`
      SELECT
        id,
        source_type,
        is_active
      FROM channel_sources
      WHERE channel_id = $1
      FOR UPDATE
    `, [channelId]);

    const primary =
      sources.rows.find(source => source.id === primaryId);

    const backup =
      sources.rows.find(source => source.id === backupId);

    if (!primary || primary.source_type !== "primary") {
      throw new Error(
        `FAILBACK: primary ${primaryId} не найден для канала ${channelId}`
      );
    }

    if (
      !backup ||
      backup.source_type !== "backup" ||
      !backup.is_active
    ) {
      throw new Error(
        `FAILBACK: активный backup ${backupId} не найден для канала ${channelId}`
      );
    }

    /*
     * Backup выключаем до включения primary.
     */

    const deactivateBackup = await client.query(`
      UPDATE channel_sources
      SET is_active = false
      WHERE id = $1
        AND channel_id = $2
        AND is_active = true
    `, [
      backupId,
      channelId
    ]);

    if (deactivateBackup.rowCount !== 1) {
      throw new Error(
        `FAILBACK: не удалось выключить backup ${backupId}`
      );
    }

    /*
     * До включения primary выключаем все источники канала.
     */

    const deactivateAll = await client.query(`
      UPDATE channel_sources
      SET is_active = false
      WHERE channel_id = $1
    `, [channelId]);

    if (deactivateAll.rowCount < 1) {
      throw new Error(
        `FAILBACK: источники канала ${channelId} не найдены`
      );
    }

    /*
     * Primary снова активируем.
     */

    const activatePrimary = await client.query(`
      UPDATE channel_sources
      SET
        is_active = true,
        status = 'working',
        response_time_ms = $2,
        consecutive_failures = 0,
        consecutive_successes = consecutive_successes + 1,
        last_success = NOW(),
        last_error = NULL,
        down_since = NULL
      WHERE id = $1
        AND channel_id = $3
    `, [
      primaryId,
      responseTime,
      channelId
    ]);

    if (activatePrimary.rowCount !== 1) {
      throw new Error(
        `FAILBACK: не удалось включить primary ${primaryId}`
      );
    }


    /*
     * channels.url НЕ изменяем.
     */


    const activeSources = await client.query(`
      SELECT id
      FROM channel_sources
      WHERE channel_id = $1
        AND is_active = true
    `, [channelId]);

    if (activeSources.rowCount !== 1 || activeSources.rows[0].id !== primaryId) {
      throw new Error(
        `FAILBACK: для канала ${channelId} должен остаться ровно один активный primary`
      );
    }

    await client.query("COMMIT");

    return true;

  } catch (error) {

    await client.query("ROLLBACK");

    throw error;

  } finally {

    client.release();
  }
}


async function checkActiveSource(row) {

  const check = await checkHls(row.source_url);


  if (check.ok) {

    await db.query(`
      UPDATE channel_sources
      SET
        status = 'working',
        last_check = NOW(),
        last_success = NOW(),
        last_error = NULL,
        response_time_ms = $2,
        success_count = success_count + 1,
        consecutive_successes = consecutive_successes + 1,
        consecutive_failures = 0,
        down_since = NULL
      WHERE id = $1
    `, [
      row.source_id,
      check.responseTime
    ]);


    return {
      ok: true,
      check
    };
  }

  if (check.indeterminate) {
    await db.query(`
      UPDATE channel_sources
      SET last_check = NOW(), last_error = $2
      WHERE id = $1
    `, [row.source_id, check.reason]);

    return { ok: false, indeterminate: true, check };
  }


  const failures =
    Number(row.consecutive_failures || 0) + 1;


  await db.query(`
    UPDATE channel_sources
    SET
      status = 'down',
      last_check = NOW(),
      last_failure = NOW(),
      last_error = $2,
      failure_count = failure_count + 1,
      consecutive_failures = $3,
      consecutive_successes = 0,
      down_since = COALESCE(down_since, NOW())
    WHERE id = $1
  `, [
    row.source_id,
    check.reason,
    failures
  ]);


  return {
    ok: false,
    check,
    failures
  };
}


async function checkPrimaryRecovery(primary) {

  const check = await checkHls(primary.source_url);


  if (!check.ok) {

    if (check.indeterminate) {
      await db.query(`
        UPDATE channel_sources
        SET last_check = NOW(), last_error = $2
        WHERE id = $1
      `, [primary.source_id, check.reason]);

      return { recovered: false, indeterminate: true, check };
    }

    await db.query(`
      UPDATE channel_sources
      SET
        status = 'down',
        last_check = NOW(),
        last_failure = NOW(),
        last_error = $2,
        consecutive_successes = 0,
        consecutive_failures = consecutive_failures + 1
      WHERE id = $1
    `, [
      primary.source_id,
      check.reason
    ]);


    return {
      recovered: false,
      check
    };
  }


  const successes =
    Number(primary.consecutive_successes || 0) + 1;


  await db.query(`
    UPDATE channel_sources
    SET
      status = 'working',
      last_check = NOW(),
      last_success = NOW(),
      last_error = NULL,
      response_time_ms = $2,
      consecutive_successes = $3,
      consecutive_failures = 0,
      down_since = NULL
    WHERE id = $1
  `, [
    primary.source_id,
    check.responseTime,
    successes
  ]);


  return {
    recovered: successes >= RECOVERY_THRESHOLD,
    successes,
    check
  };
}


async function quarantineExpiredSources() {

  const result = await db.query(`
    UPDATE channel_sources
    SET
      status = $1,
      is_active = false,
      next_check = NOW() + INTERVAL '${QUARANTINE_HOURS} hours'
    WHERE
      status = 'down'
      AND down_since IS NOT NULL
      AND down_since <= NOW() - INTERVAL '${QUARANTINE_HOURS} hours'
    RETURNING
      id,
      channel_id,
      url,
      down_since
  `, [
    QUARANTINE_STATUS
  ]);

  for (const row of result.rows) {

    console.log("");
    console.log("======================================");
    console.log("QUARANTINE");
    console.log("======================================");
    console.log("Source ID:", row.id);
    console.log("Channel ID:", row.channel_id);
    console.log("URL:", row.url);
    console.log("DOWN с:", row.down_since);
    console.log(
      "Следующая проверка через:",
      QUARANTINE_HOURS,
      "час."
    );
  }

  return result.rows.length;
}

async function checkQuarantineSources() {

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

  let recovered = 0;
  let stillQuarantine = 0;

  for (const source of result.rows) {

    console.log("");
    console.log("======================================");
    console.log("QUARANTINE CHECK");
    console.log("======================================");
    console.log("Source ID:", source.id);
    console.log("Channel ID:", source.channel_id);
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

      console.log("QUARANTINE -> WORKING");

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

      stillQuarantine++;

      console.log(
        "Остаётся в карантине.",
        "Следующая проверка через",
        QUARANTINE_HOURS,
        "час."
      );
    }
  }

  console.log("");
  console.log(
    "Карантин: проверено",
    result.rows.length,
    "| восстановлено",
    recovered,
    "| осталось",
    stillQuarantine
  );

  return result.rows.length;
}

async function deleteExpiredChannels() {

  const result = await db.query(`
    SELECT
      c.id,
      c.name,
      MIN(s.down_since) AS down_since

    FROM channels c

    JOIN channel_sources s
      ON s.channel_id = c.id

    GROUP BY
      c.id,
      c.name

    HAVING
      COUNT(*) FILTER (
        WHERE
          s.is_active = true
          AND s.status = 'working'
      ) = 0

      AND COUNT(*) FILTER (
        WHERE
          s.down_since IS NULL
          OR s.down_since >
            NOW() - INTERVAL '${DOWN_DELETE_DAYS} days'
      ) = 0
  `);


  for (const row of result.rows) {

    console.log("");
    console.log("??? УДАЛЕНИЕ КАНАЛА");
    console.log("Канал:", row.name);
    console.log("DOWN с:", row.down_since);


    await db.query(`
      DELETE FROM channels
      WHERE id = $1
    `, [row.id]);


    console.log("Канал удалён.");
  }


  return result.rows.length;
}


async function runWithConcurrency(items, limit, worker) {
  const results = [];
  let index = 0;

  async function runner() {
    while (true) {
      const i = index++;
      if (i >= items.length) return;

      try {
        results[i] = await worker(items[i]);
      } catch (error) {
        results[i] = { error };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => runner()
  );

  await Promise.all(workers);
  return results;
}


async function monitor() {

  console.log("");
  console.log("======================================");
  console.log("CHANNEL MONITOR v3");
  console.log("======================================");
  console.log("Порог отказов:", FAIL_THRESHOLD);
  console.log("Порог восстановления:", RECOVERY_THRESHOLD);
  console.log("Удаление после DOWN:", DOWN_DELETE_DAYS, "дней");
  console.log("");


  /*
   * Получаем ВСЕ источники.
   *
   * Для каждого канала может быть:
   *
   * primary
   * backup
   *
   * Активный источник определяется
   * через is_active.
   */

  const result = await db.query(`
    SELECT
      c.id AS channel_id,
      c.name,
      c.url AS channel_url,

      s.id AS source_id,
      s.url AS source_url,
      s.source_type,
      s.status,
      s.priority,
      s.is_active,
      s.consecutive_failures,
      s.consecutive_successes,
      s.down_since

    FROM channels c

    JOIN channel_sources s
      ON s.channel_id = c.id

    ORDER BY
      c.id,
      s.source_type DESC,
      s.priority ASC,
      s.id ASC
  `);


  /*
   * Группируем источники по каналам.
   */

  const channels = new Map();


  for (const row of result.rows) {

    if (!channels.has(row.channel_id)) {

      channels.set(
        row.channel_id,
        {
          id: row.channel_id,
          name: row.name,
          url: row.channel_url,
          sources: []
        }
      );
    }


    channels
      .get(row.channel_id)
      .sources
      .push(row);
  }


  let checked = 0;
  let working = 0;
  let failed = 0;
  let failovers = 0;
  let failbacks = 0;


  /*
   * Обрабатываем каждый канал отдельно.
   */

  const channelList = Array.from(channels.values());

  await runWithConcurrency(
    channelList,
    MONITOR_CONCURRENCY,
    async (channel) => {


    const primary =
      channel.sources.find(
        s => s.source_type === "primary"
      );


    const active =
      channel.sources.find(
        s => s.is_active === true
      );


    if (!primary) {
      return;
    }


    /*
     * Если активен Backup,
     * проверяем Backup как текущий источник.
     */

    if (
      active &&
      active.source_type === "backup"
    ) {

      checked++;


      console.log("");
      console.log("Канал:", channel.name);
      console.log("Активный источник: BACKUP");
      console.log("URL:", active.source_url);


      const activeCheck =
        await checkActiveSource(active);


      if (activeCheck.ok) {

        working++;

        console.log(
          "?? BACKUP WORKING |",
          activeCheck.check.responseTime,
          "ms"
        );

      } else {

        failed++;

        console.log(
          "?? BACKUP DOWN |",
          activeCheck.check.reason
        );
      }


      /*
       * Одновременно проверяем Primary
       * на возможность FAILBACK.
       */

      if (active && active.source_type === "backup") {

        const recovery =
          await checkPrimaryRecovery(primary);


        console.log(
          "Primary recovery:",
          recovery.successes ?? 0,
          "/",
          RECOVERY_THRESHOLD
        );


        if (recovery.recovered) {

          console.log("");
          console.log("======================================");
          console.log("FAILBACK");
          console.log("======================================");
          console.log("Канал:", channel.name);
          console.log("Primary:", primary.source_url);
          console.log("Backup:", active.source_url);


          await performFailback(
            channel.id,
            primary.source_id,
            active.source_id,
            recovery.check.responseTime
          );


          failbacks++;

          console.log("?? FAILBACK выполнен.");
        }
      }


      return;
    }


    /*
     * Если активен Primary —
     * проверяем его.
     */

    if (
      active &&
      active.source_type === "primary"
    ) {

      checked++;


      console.log("");
      console.log("Канал:", channel.name);
      console.log("Активный источник: PRIMARY");
      console.log("URL:", active.source_url);


      const current =
        await checkActiveSource(active);


      if (current.ok) {

        working++;

        console.log(
          "?? PRIMARY WORKING |",
          current.check.responseTime,
          "ms"
        );


        return;
      }


      failed++;


      console.log(
        "?? PRIMARY DOWN |",
        current.check.reason
      );


      console.log(
        "Отказов подряд:",
        current.failures
      );


      if (
        current.failures <
        FAIL_THRESHOLD
      ) {

        return;
      }


      console.log(
        "?? Достигнут порог FAILOVER."
      );


      const backup =
        await findBackup(
          channel.id,
          active.source_id
        );


      if (!backup) {

        console.log(
          "   Рабочего резерва нет."
        );

        return;
      }


      console.log("");
      console.log("======================================");
      console.log("FAILOVER");
      console.log("======================================");
      console.log("Канал:", channel.name);
      console.log("Было:", active.source_url);
      console.log("Станет:", backup.url);
      console.log("Приоритет:", backup.priority);


      await performFailover(
        channel.id,
        active.source_id,
        backup.id,
        backup.responseTime
      );


      failovers++;


      console.log(
        "?? FAILOVER выполнен."
      );
    }

    }
  );
  const quarantined =
    await quarantineExpiredSources();

  console.log('Переведено в карантин:', quarantined);

  await checkQuarantineSources();

  const deleted =
    await deleteExpiredChannels();


  console.log("");
  console.log("======================================");
  console.log("MONITOR ЗАВЕРШЁН");
  console.log("======================================");
  console.log("Каналов:", channels.size);
  console.log("Проверено источников:", checked);
  console.log("Работают:", working);
  console.log("Не работают:", failed);
  console.log("FAILOVER:", failovers);
  console.log("FAILBACK:", failbacks);
  console.log("Удалено за 7 дней:", deleted);
  console.log("");
}


monitor()
  .catch(error => {

    console.error("");
    console.error("CHANNEL MONITOR ERROR:");
    console.error(error);
    console.error("");

    process.exitCode = 1;

  })
  .finally(async () => {

    await db.end();

  });











