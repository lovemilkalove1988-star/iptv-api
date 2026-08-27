const express = require("express");
const router = express.Router();
const db = require("../database");


// ===============================
// ВХОД КЛИЕНТА
// ===============================

router.get("/login", (req, res) => {

  res.send(`
<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1">

<title>IPTV — Вход</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;

  display: flex;
  align-items: center;
  justify-content: center;

  background:
    radial-gradient(circle at top, #202020 0%, #111 45%, #090909 100%);

  color: white;

  font-family: Arial, sans-serif;

  padding: 20px;
}

.box {
  width: 100%;
  max-width: 380px;

  background: #1c1c1c;

  border: 1px solid #333;

  border-radius: 18px;

  padding: 30px;

  box-shadow: 0 20px 50px rgba(0,0,0,.45);
}

.logo {
  text-align: center;
  font-size: 42px;
  margin-bottom: 10px;
}

h2 {
  text-align: center;
  margin: 0 0 25px;
}

label {
  display: block;
  margin: 12px 0 6px;
  color: #aaa;
}

input {
  width: 100%;
  padding: 14px;

  border-radius: 10px;
  border: 1px solid #444;

  background: #111;
  color: white;

  font-size: 16px;
}

button {
  width: 100%;

  margin-top: 20px;

  padding: 14px;

  border: none;
  border-radius: 10px;

  background: #333;
  color: white;

  font-size: 16px;
  font-weight: bold;
}

button:hover {
  background: #444;
}

</style>

</head>

<body>

<div class="box">

<div class="logo">📺</div>

<h2>IPTV</h2>

<form method="POST" action="/client/login">

<label>Логин</label>

<input
  name="login"
  type="text"
  autocomplete="username"
  required
>

<label>Пароль</label>

<input
  name="password"
  type="password"
  autocomplete="current-password"
  required
>

<button type="submit">
Войти
</button>

<a
  href="/client/channels"
  style="
    display:block;
    margin-top:12px;
    padding:14px;
    text-align:center;
    border-radius:10px;
    background:#222;
    color:white;
    text-decoration:none;
    font-size:16px;
    font-weight:bold;
  "
>
Милк Тв❤️
</a>

</form>

</div>

</body>

</html>
  `);

});


// ===============================
// АВТОРИЗАЦИЯ КЛИЕНТА
// ===============================

router.post("/login", async (req, res) => {

  try {

    const {
      login,
      password
    } = req.body;

    const result = await db.query(
      `
      SELECT id, name, phone, login, password, active, token
      FROM clients
      WHERE login = $1
      `,
      [login]
    );

    if (result.rows.length === 0) {

      return res.status(401).send("Неверный логин или пароль");

    }

    const client = result.rows[0];

    if (client.password !== password) {

      return res.status(401).send("Неверный логин или пароль");

    }

    if (!client.active) {

      return res.status(403).send("Ваш аккаунт заблокирован");

    }

    req.session.client = {
      id: client.id,
      name: client.name,
      login: client.login
    };

    res.redirect("/client");

  } catch (error) {

    console.error(error);

    res.status(500).send(error.message);

  }

});


// ===============================
// ЛИЧНЫЙ КАБИНЕТ
// ===============================

router.get("/", async (req, res) => {

  if (!req.session.client) {

    return res.redirect("/client/login");

  }

  try {

    const result = await db.query(
      `
      SELECT
        id,
        name,
        phone,
        login,
        active,
        token
      FROM clients
      WHERE id = $1
      `,
      [req.session.client.id]
    );

    if (result.rows.length === 0) {

      req.session.destroy();

      return res.redirect("/client/login");

    }

    const client = result.rows[0];

    if (!client.active) {

      req.session.destroy();

      return res.status(403).send("Ваш аккаунт заблокирован");

    }

    const playlistUrl =
  client.token
    ? `${req.protocol}://${req.get("host")}/playlist/${client.token}.m3u`
    : "IPTV-ссылка отсутствует";

    res.send(`
<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1">

<title>Личный кабинет IPTV</title>

<style>

body {
  margin: 0;
  background: #111;
  color: white;
  font-family: Arial, sans-serif;
  padding: 20px;
}

.login-small {
  display: flex;
  align-items: center;
  justify-content: center;

  width: 100%;
  height: 36px;

  margin-top: 4px;
  margin-bottom: 10px;

  background: linear-gradient(135deg, #333, #1f1f1f);
  border: 1px solid #555;
  border-radius: 9px;

  color: #fff;
  text-decoration: none;

  font-size: 13px;
  font-weight: 600;

  box-shadow: 0 4px 12px rgba(0,0,0,.35);
  transition: .15s;
}

.login-small:hover {
  background: linear-gradient(135deg, #444, #292929);
  border-color: #666;
  transform: translateY(-1px);
}

.login-small:active {
  transform: translateY(1px);
}
.container {
  max-width: 600px;
  margin: auto;
}

.card {
  background: #1c1c1c;
  border: 1px solid #333;
  border-radius: 15px;
  padding: 20px;
  margin-bottom: 15px;
}

h1 {
  margin-top: 0;
}

.label {
  color: #888;
  font-size: 13px;
  margin-bottom: 5px;
}

.value {
  font-size: 18px;
  margin-bottom: 15px;
}

.status {
  color: #7cff7c;
  font-weight: bold;
}

.url {
  width: 100%;
  padding: 12px;

  background: #111;
  color: #7cff7c;

  border: 1px solid #444;
  border-radius: 8px;

  box-sizing: border-box;
}

.logout {
  display: block;

  text-align: center;

  padding: 13px;

  background: #222;

  border-radius: 10px;

  color: #aaa;

  text-decoration: none;
}

</style>

</head>

<body>

<div class="container">

<h1>📺 IPTV</h1>

<div class="card">

<div class="label">
Клиент
</div>

<div class="value">
${client.name}
</div>

<div class="label">
Логин
</div>

<div class="value">
${client.login}
</div>

<div class="label">
Статус
</div>

<div class="value status">
🟢 Активен
</div>

</div>


<div class="card">

<h3>📺 Ваша IPTV-ссылка</h3>

<div class="label">
Скопируйте эту ссылку в IPTV-приложение
</div>

<input
  class="url"
  value="${playlistUrl}"
  readonly
  onclick="this.select()"
>

</div>


<a
  class="logout"
  href="/client/logout"
>
Выйти
</a>

</div>

</body>

</html>
    `);

  } catch (error) {

    console.error(error);

    res.status(500).send(error.message);

  }

});


// ===============================
// ВЫХОД КЛИЕНТА
// ===============================

router.get("/logout", (req, res) => {

  req.session.destroy((error) => {

    if (error) {
      console.error(error);
      return res.status(500).send("Ошибка выхода");
    }

    res.clearCookie("connect.sid");

    res.redirect("/client/login");

  });

});


// ===============================
// КАНАЛЫ КЛИЕНТА
// ===============================

router.get("/channels", async (req, res) => {

  try {

    const result = await db.query(
      `
      SELECT
        c.id,
        c.name,
        c.url,
        c.logo,
        COALESCE(
          ARRAY_AGG(DISTINCT m.category)
          FILTER (WHERE m.category IS NOT NULL),
          ARRAY[]::text[]
        ) AS milktv_categories
      FROM channels c
      LEFT JOIN milktv_channel_categories m
        ON m.channel_id = c.id
      WHERE COALESCE(c.milktv_status, '') <> 'quarantine'
      GROUP BY
        c.id,
        c.name,
        c.url,
        c.logo
      ORDER BY c.id
      `
    );

    const categories = [
      "Казахстан",
      "Детские",
      "Кино",
      "Музыка",
      "Спорт"
    ];

    let channelsHtml = "";

    result.rows.forEach(channel => {

      channelsHtml += `
<div
  class="channel"
  data-name="${String(channel.name).replace(/"/g, '&quot;')}"
  data-category="${JSON.stringify(channel.milktv_categories || []).replace(/"/g, '&quot;')}"
  data-url="${String(channel.url || "").replace(/"/g, '&quot;')}"
  data-logo="${String(channel.logo || "").replace(/"/g, '&quot;')}"
  onclick='playChannel(${JSON.stringify(channel.url)}, ${JSON.stringify(channel.name)})'
>

<img
  src="${String(channel.logo || "").replace(/"/g, '&quot;')}"
  alt=""
  loading="lazy"
  onerror="this.style.visibility='hidden'"
>

<div class="channel-name">
${channel.name}
</div>

</div>
`;
    });

    let html = `
<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1">

<title>Милк Тв❤️</title><style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #111;
  color: white;
  font-family: Arial, sans-serif;
  padding: 15px;
}

.login-small {
  display: flex;
  align-items: center;
  justify-content: center;

  width: 100%;
  height: 36px;

  margin-top: 4px;
  margin-bottom: 10px;

  background: linear-gradient(135deg, #333, #1f1f1f);
  border: 1px solid #555;
  border-radius: 9px;

  color: #fff;
  text-decoration: none;

  font-size: 13px;
  font-weight: 600;

  box-shadow: 0 4px 12px rgba(0,0,0,.35);
  transition: .15s;
}

.login-small:hover {
  background: linear-gradient(135deg, #444, #292929);
  border-color: #666;
  transform: translateY(-1px);
}

.login-small:active {
  transform: translateY(1px);
}
.container {
  max-width: 900px;
  margin: auto;
}

h1 {
  text-align: center;
  margin: 5px 0 15px;
}

/* ===============================
   ПОИСК
================================ */

.search-box {
  margin-bottom: 12px;
}

.search-box input {
  width: 100%;
  padding: 11px 14px;

  background: #1c1c1c;
  color: white;

  border: 1px solid #333;
  border-radius: 10px;

  outline: none;
  font-size: 14px;
}

.search-box input:focus {
  border-color: #555;
}

/* ===============================
   КАТЕГОРИИ
================================ */

.categories {
  display: flex;
  gap: 7px;

  overflow-x: auto;

  padding-bottom: 10px;
  margin-bottom: 10px;

  scrollbar-width: none;
}

.categories::-webkit-scrollbar {
  display: none;
}

.category {
  flex: 0 0 auto;

  padding: 7px 12px;

  border-radius: 20px;

  background: #1c1c1c;
  border: 1px solid #333;

  color: #aaa;

  font-size: 12px;

  cursor: pointer;

  user-select: none;
}

.category.active {
  background: #333;
  color: white;
  border-color: #555;
}

.player-box {
  display: none;
  position: relative;
}
/* ===============================
   ПЛЕЕР
================================ */

.player-box {
  display: none;

  background: #000;

  border-radius: 14px;

  overflow: hidden;

  margin-bottom: 20px;
}

video {
  width: 100%;

  display: block;

  background: #000;
}

/* ===============================
   ПЛИТКИ
================================ */

.channels {
  display: grid;

  grid-template-columns:
    repeat(auto-fill, minmax(105px, 1fr));

  gap: 10px;
}

.channel {
  background: #1c1c1c;

  border: 1px solid #333;

  border-radius: 12px;

  padding: 10px 6px;

  text-align: center;

  cursor: pointer;

  transition: .15s;
}

.channel:hover {
  background: #252525;

  transform: translateY(-1px);
}

.channel.hidden {
  display: none;
}

.channel img {
  width: 65px;
  height: 65px;

  object-fit: contain;

  display: block;

  margin: auto;

  border-radius: 8px;
}

.channel-name {
  margin-top: 7px;

  font-size: 12px;

  color: #ddd;

  line-height: 1.2;
}

.no-results {
  display: none;

  text-align: center;

  color: #777;

  padding: 30px 10px;
}

/* ===============================
   НАЗАД
================================ */

.back {
  display: block;

  margin-top: 20px;

  padding: 12px;

  text-align: center;

  background: #1c1c1c;

  border-radius: 10px;

  color: #aaa;

  text-decoration: none;
}

</style>

</head>

<body>

<div class="container">

<div class="page-title">
<h1>Милк Тв❤️</h1>
<a class="login-small" href="/client">Войти</a>
</div>

<div class="search-box">

<input
  id="search"
  type="search"
  placeholder="🔎 Найти канал..."
  autocomplete="off"
>

</div>

<div class="categories">

<div
  class="category active"
  data-category="all"
  onclick="selectCategory('all', this)"
>
Все
</div>
`;

    categories.forEach(category => {

      html += `
<div
  class="category"
  data-category="${String(category).replace(/"/g, '&quot;')}"
  onclick='selectCategory(${JSON.stringify(category)}, this)'
>
${category}
</div>
`;

    });

    html += `

</div>

<div
  id="player-box"
  class="player-box"
>

<video
  id="player"
  controls
  playsinline
></video>
</div>

<div class="channels">
${channelsHtml}
</div>
<div
  id="no-results"
  class="no-results"
>
Каналы не найдены
</div>

<a
  class="back"
  href="/client"
>
⬅️ В личный кабинет
</a>

</div>



<script>

let hls = null;

let selectedCategory = "all";

/* ===============================
   НОРМАЛИЗАЦИЯ ПОИСКА
================================ */

function normalizeText(text) {

  const map = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ё: "e",
    ж: "zh",
    з: "z",
    и: "i",
    й: "i",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "h",
    ц: "c",
    ч: "ch",
    ш: "sh",
    щ: "sh",
    ъ: "",
    ы: "y",
    ь: "",
    э: "e",
    ю: "yu",
    я: "ya"
  };

  return String(text)
    .toLowerCase()
    .split("")
    .map(char => map[char] || char)
    .join("")
    .replace(/[^a-z0-9]+/g, "");
}


/* ===============================
   ФИЛЬТРАЦИЯ
================================ */

function filterChannels() {

  const searchValue =
    normalizeText(
      document.getElementById("search").value
    );

  const channels =
    document.querySelectorAll(".channel");

  let visible = 0;

  channels.forEach(channel => {

    const name =
      normalizeText(
        channel.dataset.name || ""
      );

    let channelCategories = [];

    try {
      channelCategories =
        JSON.parse(channel.dataset.category || "[]");
    } catch (error) {
      channelCategories = [];
    }

    const searchMatch =
      !searchValue ||
      name.includes(searchValue);

    const categoryMatch =
      selectedCategory === "all" ||
      channelCategories.includes(selectedCategory);

    if (searchMatch && categoryMatch) {

      channel.classList.remove("hidden");

      visible++;

    } else {

      channel.classList.add("hidden");

    }

  });

  document.getElementById("no-results").style.display =
    visible === 0
      ? "block"
      : "none";
}


/* ===============================
   ВЫБОР КАТЕГОРИИ
================================ */

function selectCategory(category, element) {

  selectedCategory = category;

  document
    .querySelectorAll(".category")
    .forEach(item => {
      item.classList.remove("active");
    });

  element.classList.add("active");

  filterChannels();
}


/* ===============================
   ПОИСК
================================ */

document
  .getElementById("search")
  .addEventListener(
    "input",
    filterChannels
  );


/* ===============================
   ПЛЕЕР
================================ */

let videoPlayer = null;

function initVideoPlayer() {

  if (videoPlayer) {
    return videoPlayer;
  }

  videoPlayer = document.getElementById("player");

  if (!videoPlayer) {
    console.error("HTML5-плеер не найден");
    return null;
  }

  videoPlayer.controls = true;
  videoPlayer.preload = "auto";
  videoPlayer.playsInline = true;

  return videoPlayer;
}

function playChannel(url, name) {

  const box = document.getElementById("player-box");

  box.style.display = "block";

  const player = initVideoPlayer();

  if (!player) {
    alert("Плеер не найден.");
    return;
  }

  if (hls) {
    hls.destroy();
    hls = null;
  }

  player.pause();
  player.removeAttribute("src");
  player.load();

  if (
    url &&
    url.includes(".m3u8") &&
    typeof Hls !== "undefined" &&
    Hls.isSupported()
  ) {

    hls = new Hls();

    hls.loadSource(url);
    hls.attachMedia(player);

    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      player.play().catch(() => {});
    });

  } else {

    player.src = url;
    player.load();

    player.play().catch(() => {});

  }

  box.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });

}
/* ===============================
   ПОЛНОЭКРАННЫЙ ПЛЕЕР + МЕНЮ
================================ */


</script>

</body>

</html>

`;

    res.setHeader(
      "Content-Type",
      "text/html; charset=utf-8"
    );

    res.send(html);
  } catch (error) {

    console.error(error);

    res.status(500).send(error.message);

  }

});

module.exports = router;





































































