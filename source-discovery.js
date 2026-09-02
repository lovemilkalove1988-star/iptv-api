const db = require("./database");
const SOURCES = require("./source-registry");

const DRY_RUN = false;

const BAD_PATTERNS = [
  "apk",
  "android",
  "download",
  "install",
  "subscribe",
  "telegram",
  "t.me/",
  "whatsapp",
  "discord",
  "advert",
  "ads"
];

function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase();
}

function cleanName(name) {
  return String(name || "")
    .replace(/^[-#\s]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function isLikelyIptvUrl(url) {
  try {
    const parsed = new URL(url);
    const lower = normalize(url);

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return false;
    }

    if (BAD_PATTERNS.some(pattern => lower.includes(pattern))) {
      return false;
    }

    return (
      lower.includes(".m3u8") ||
      lower.includes(".m3u")
    );

  } catch {
    return false;
  }
}

function detectRussianCandidate(meta) {
  const language = normalize(meta.language);
  const country = normalize(meta.country);
  const name = normalize(meta.name);
  const group = normalize(meta.group);

  if (
    language.includes("rus") ||
    language.includes("russian") ||
    language.includes("рус")
  ) {
    return true;
  }

  if (
    country === "ru" ||
    country.includes("russia") ||
    country.includes("russian") ||
    country.includes("рос")
  ) {
    return true;
  }

  if (
    name.includes("россия") ||
    name.includes("русский") ||
    group.includes("russia") ||
    group.includes("russian")
  ) {
    return true;
  }

  return false;
}

function parseExtInf(line) {
  const meta = {};

  const tvgId = line.match(/tvg-id="([^"]*)"/i);
  const tvgLogo = line.match(/tvg-logo="([^"]*)"/i);
  const groupTitle = line.match(/group-title="([^"]*)"/i);

  meta.tvgId = tvgId ? tvgId[1] : "";
  meta.logo = tvgLogo ? tvgLogo[1] : "";
  meta.group = groupTitle ? groupTitle[1] : "";

  const commaIndex = line.indexOf(",");

  meta.name =
    commaIndex >= 0
      ? cleanName(line.slice(commaIndex + 1))
      : "";

  const id = normalize(meta.tvgId);

  const countryMatch = id.match(/\.([a-z]{2})(?:@|$)/i);

  meta.country = countryMatch
    ? countryMatch[1]
    : "";

  if (
    id.includes(".ru@") ||
    id.includes(".ru")
  ) {
    meta.language = "rus";
  } else {
    meta.language = "";
  }

  return meta;
}

function extractCandidates(text, source) {
  const lines = text.split(/\r?\n/);

  const found = new Map();

  let currentMeta = {};

  for (const line of lines) {

    if (line.startsWith("#EXTINF:")) {
      currentMeta = parseExtInf(line);
      continue;
    }

    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    if (!isLikelyIptvUrl(trimmed)) {
      currentMeta = {};
      continue;
    }

    if (!detectRussianCandidate(currentMeta)) {
      currentMeta = {};
      continue;
    }

    const url = trimmed;

    if (!found.has(url)) {
      found.set(url, {
        name: currentMeta.name || "Unknown channel",
        url,
        logo: currentMeta.logo || null,
        category: currentMeta.group || null,
        source_id: source.id,
        source_name: source.name,
        source_priority: source.priority
      });
    }

    currentMeta = {};
  }

  return [...found.values()];
}

async function checkStream(url) {

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 10000);

  const started = Date.now();

  try {

    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 IPTV-KZ-Checker",
        "Accept": "*/*"
      }
    });

    const responseTime = Date.now() - started;

    const reader = response.body?.getReader();

    let sample = "";

    if (reader) {

      const firstChunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("STREAM_TIMEOUT")), 5000)
        )
      ]);

      if (firstChunk && firstChunk.value) {
        sample = Buffer.from(firstChunk.value)
          .toString("utf8");
      }

      try {
        await reader.cancel();
      } catch {}
    }

    clearTimeout(timer);

    const lowerSample = sample.toLowerCase();

    const hlsOk =
      response.ok &&
      (
        lowerSample.includes("#extm3u") ||
        lowerSample.includes("#ext-x-") ||
        url.toLowerCase().includes(".m3u8")
      );

    return {
      working: hlsOk,
      httpStatus: response.status,
      responseTime,
      hlsOk,
      error: null
    };

  } catch (error) {

    clearTimeout(timer);

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
  }
}

async function checkStreamsParallel(candidates, concurrency = 5) {

  const results = new Map();
  let index = 0;

  async function worker() {

    while (true) {

      const currentIndex = index++;

      if (currentIndex >= candidates.length) {
        return;
      }

      const candidate = candidates[currentIndex];

      console.log("");
      console.log("ПРОВЕРКА ПОТОКА:", candidate.name);

      const check = await checkStream(candidate.url);

      console.log(
        "HTTP:", check.httpStatus,
        "| Время:", check.responseTime, "ms",
        "| HLS:", check.hlsOk,
        "| Рабочий:", check.working
      );

      results.set(candidate.url, check);
    }
  }

  const workers = [];

  const count = Math.min(concurrency, candidates.length);

  for (let i = 0; i < count; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  return results;
}

async function sourceExists(url) {
  const result = await db.query(`
    SELECT 1
    FROM channels
    WHERE url = $1

    UNION

    SELECT 1
    FROM channel_candidates
    WHERE url = $1

    LIMIT 1
  `, [url]);

  return result.rows.length > 0;
}

async function scanSource(source) {

  console.log("");
  console.log("--------------------------------");
  console.log("Источник:", source.name);
  console.log("URL:", source.url);
  console.log("--------------------------------");

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 20000);

  try {

    const response = await fetch(source.url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 IPTV-KZ-Source-Discovery",
        "Accept": "*/*"
      }
    });

    const text = await response.text();

    clearTimeout(timer);

    console.log("HTTP:", response.status);
    console.log("Размер:", text.length, "байт");

    if (!response.ok) {
      console.log("Источник недоступен.");
      return [];
    }

    const candidates = extractCandidates(text, source);

    console.log(
      "Русскоязычных найдено:",
      candidates.length
    );

    return candidates;

  } catch (error) {

    clearTimeout(timer);

    console.log(
      "Ошибка:",
      error.name === "AbortError"
        ? "TIMEOUT"
        : error.message
    );

    return [];
  }
}

async function main() {

  console.log("");
  console.log("================================");
  console.log(" IPTV-KZ GLOBAL SOURCE DISCOVERY");
  console.log("================================");
  console.log("DRY RUN:", DRY_RUN);
  console.log("Фильтр: только русскоязычные");
  console.log("");

  const enabledSources =
    SOURCES.filter(source => source.enabled);

  console.log(
    "Активных источников:",
    enabledSources.length
  );

  const global = new Map();

  const statistics = [];

  for (const source of enabledSources) {

    const candidates =
      await scanSource(source);

    let newCount = 0;
    let existingCount = 0;

    for (const candidate of candidates) {

      if (!global.has(candidate.url)) {

        global.set(candidate.url, candidate);

      }

      const exists =
        await sourceExists(candidate.url);

      if (exists) {
        existingCount++;
      } else {
        newCount++;
      }
    }

    statistics.push({
      source: source.name,
      found: candidates.length,
      unique: new Set(
        candidates.map(candidate => candidate.url)
      ).size,
      new: newCount,
      existing: existingCount
    });
  }

  console.log("");
  console.log("================================");
  console.log(" РЕЗУЛЬТАТ ПО ИСТОЧНИКАМ");
  console.log("================================");

  console.table(statistics);

  console.log("");
  console.log("================================");
  console.log(" ГЛОБАЛЬНЫЙ РЕЗУЛЬТАТ");
  console.log("================================");

  console.log(
    "Уникальных IPTV URL:",
    global.size
  );

  let globalNew = 0;
  let globalExisting = 0;

  const newCandidates = [];

  for (const candidate of global.values()) {

    const exists = await sourceExists(candidate.url);

    if (exists) {
      globalExisting++;
    } else {
      globalNew++;
      newCandidates.push(candidate);
    }
  }

  console.log("");
  console.log("НОВЫХ КАНДИДАТОВ ДЛЯ ПРОВЕРКИ:", newCandidates.length);
  console.log("ПРОВЕРЯЕМ ПАРАЛЛЕЛЬНО: 5 ПОТОКОВ");

  const checks = await checkStreamsParallel(newCandidates, 5);

  let workingCount = 0;
  let failedCount = 0;

  for (const candidate of newCandidates) {

    const check = checks.get(candidate.url);

    if (!check || !check.working) {
      failedCount++;

      console.log(
        "ОТБРОШЕН:",
        candidate.name,
        "|",
        check?.error || "поток не прошёл проверку"
      );

      continue;
    }

    workingCount++;

    console.log(
      "РАБОЧИЙ:",
      candidate.name,
      "|",
      check.responseTime,
      "ms"
    );

    if (!DRY_RUN) {

      await db.query(`
        INSERT INTO channel_candidates (
          name,
          url,
          category,
          status,
          http_status,
          response_time,
          hls_ok,
          source_score,
          source_kind,
          language,
          region,
          client_enabled,
          milktv_enabled,
          archived,
          admin_deleted,
          admin_note
        )
        VALUES (
          $1,
          $2,
          $3,
          'pending',
          $4,
          $5,
          $6,
          $7,
          'web_discovery',
          'rus',
          NULL,
          TRUE,
          FALSE,
          FALSE,
          FALSE,
          $8
        )
        ON CONFLICT DO NOTHING
      `, [
        candidate.name,
        candidate.url,
        candidate.category,
        check.httpStatus,
        check.responseTime,
        check.hlsOk,
        Math.max(
          1,
          Math.min(
            100,
            100 - Math.floor((check.responseTime || 10000) / 100)
          )
        ),
        `Источник: ${candidate.source_name}`
      ]);

      console.log("ДОБАВЛЕН В channel_candidates");
    }
  }

  console.log("");
  console.log("ПРОВЕРКА ЗАВЕРШЕНА");
  console.log("Рабочих:", workingCount);
  console.log("Нерабочих:", failedCount);

  console.log("Новых:", globalNew);
  console.log("Уже существующих:", globalExisting);

  if (DRY_RUN) {
    console.log("");
    console.log("DRY RUN — БАЗА НЕ ИЗМЕНЯЛАСЬ.");
  } else {
    console.log("");
    console.log("Новые кандидаты записаны в БД.");
  }

  console.log("");
  console.log("Первые 20 уникальных результатов:");

  console.table(
    [...global.values()]
      .slice(0, 20)
      .map(candidate => ({
        name: candidate.name,
        source: candidate.source_name,
        url: candidate.url
      }))
  );
}

main()
  .catch(error => {
    console.error("");
    console.error("GLOBAL SOURCE DISCOVERY ERROR:");
    console.error(error);
    process.exitCode = 1;
  });








