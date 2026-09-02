const db = require("./database");

async function main() {
  try {
    console.log("");
    console.log("======================================");
    console.log("SOURCE FAILOVER — DRY RUN");
    console.log("======================================");
    console.log("");

    const result = await db.query(`
      SELECT
        c.id AS channel_id,
        c.name AS channel_name,
        c.url AS current_url,

        s.id AS source_id,
        s.url AS source_url,
        s.source_type,
        s.status,
        s.priority,
        s.is_active,
        s.response_time_ms,
        s.consecutive_failures,
        s.consecutive_successes

      FROM channels c

      LEFT JOIN channel_sources s
        ON s.channel_id = c.id

      ORDER BY c.id, s.priority DESC NULLS LAST, s.id
    `);

    const channels = new Map();

    for (const row of result.rows) {

      if (!channels.has(row.channel_id)) {
        channels.set(row.channel_id, {
          id: row.channel_id,
          name: row.channel_name,
          currentUrl: row.current_url,
          sources: []
        });
      }

      if (row.source_id) {
        channels.get(row.channel_id).sources.push(row);
      }
    }

    let checked = 0;
    let failoverCandidates = 0;

    for (const channel of channels.values()) {

      checked++;

      const activeSources = channel.sources.filter(
        s => s.is_active === true
      );

      const currentSource = activeSources.find(
        s => s.url === channel.currentUrl
      );

      if (!currentSource) {
        console.log(
          `⚠️ ${channel.name} — текущий URL не найден среди активных источников`
        );
        continue;
      }

      const currentWorking =
        currentSource.status === "working";

      if (currentWorking) {
        console.log(
          `🟢 ${channel.name} — основной источник работает`
        );
        continue;
      }

      const backups = activeSources
        .filter(s =>
          s.id !== currentSource.id &&
          s.status === "working"
        )
        .sort((a, b) => {

          if (b.priority !== a.priority) {
            return b.priority - a.priority;
          }

          const aTime =
            a.response_time_ms ?? Number.MAX_SAFE_INTEGER;

          const bTime =
            b.response_time_ms ?? Number.MAX_SAFE_INTEGER;

          return aTime - bTime;
        });

      if (backups.length === 0) {

        console.log(
          `🔴 ${channel.name} — основной недоступен, рабочего резерва нет`
        );

        continue;
      }

      const best = backups[0];

      failoverCandidates++;

      console.log("");
      console.log(`🔴 ${channel.name}`);
      console.log(`   Основной: ${currentSource.url}`);
      console.log(`   Основной статус: ${currentSource.status}`);
      console.log(`   🟢 Лучший резерв: ${best.url}`);
      console.log(`   Приоритет: ${best.priority}`);
      console.log(`   Ping: ${best.response_time_ms ?? "не измерен"} ms`);
      console.log(`   👉 DRY RUN: переключение БЫЛО БЫ выполнено`);
      console.log("");
    }

    console.log("");
    console.log("======================================");
    console.log("ПРОВЕРКА ЗАВЕРШЕНА");
    console.log("======================================");
    console.log(`Каналов проверено: ${checked}`);
    console.log(`Кандидатов на переключение: ${failoverCandidates}`);
    console.log("");
    console.log("DRY RUN: база НЕ изменялась.");
    console.log("");

  } catch (error) {

    console.error("");
    console.error("FAILOVER ERROR:", error);
    console.error("");

  } finally {

    await db.end();

  }
}

main();
