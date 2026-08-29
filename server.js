const express = require("express");
const cors = require("cors");
const session = require("express-session");
const db = require("./database");
const clientsRouter = require("./routes/clients");
const adminClientsRouter = require("./routes/admin-clients");
const clientRouter = require("./routes/client");
const milktvRouter = require("./routes/milktv");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req,res,next)=>{
  res.setHeader("Content-Type","text/html; charset=utf-8");
  next();
});

app.use(session({
  secret: "iptv-secret-2026",
  resave: false,
  saveUninitialized: false
}));

app.use(express.static("public"));

function auth(req, res, next) {

  if (req.session.user) {
    return next();
  }

  const isAjax =
    req.headers.accept?.includes("application/json") ||
    req.headers["x-requested-with"] === "XMLHttpRequest";

  if (isAjax) {

    return res.status(401).json({
      success: false,
      sessionExpired: true,
      error: "???�???????? ?�?�???�???�?�???� ???�-?�?� ???�???�?�?�?????????? ?????????�????. ?????�?�?�???????�?�, ???????????�?� ?? ???????�?�???? ???????�????????."
    });

  }

  res.redirect("/login");

}

app.use("/api/clients", auth, clientsRouter);

app.use("/admin/clients", auth, adminClientsRouter);

app.use("/client", clientRouter);
app.use("/api/milktv", milktvRouter);

// IPTV playlist ???? ???�?????????�?�?????????? ?�?????�????
app.get("/playlist/:token.m3u", async (req, res) => {

  try {

    const result = await db.query(
      "SELECT id, active FROM clients WHERE token=$1",
      [req.params.token]
    );

    if (result.rows.length === 0) {
      return res.status(404).send("Playlist not found");
    }

    if (!result.rows[0].active) {
      return res.status(403).send("Client disabled");
    }

    const fs = require("fs");
    const path = require("path");

    const playlistPath = path.join(__dirname, "ru.kz.m3u");

    if (!fs.existsSync(playlistPath)) {
      return res.status(404).send("Playlist file not found");
    }

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");

    res.sendFile(playlistPath);

  } catch (error) {

    console.error("PLAYLIST ERROR:", error);

    res.status(500).send(error.message);

  }

});

// LOGIN ???�???�?????�?�
app.get("/login", (req, res) => {

  res.setHeader("Content-Type", "text/html; charset=utf-8");

  res.send(`
<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport" content="width=device-width, initial-scale=1">

<title>IPTV Manager — Авторизация</title>

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
  background: radial-gradient(circle at top, #202020 0%, #111 45%, #090909 100%);
  color: #fff;
  font-family: Arial, sans-serif;
  padding: 20px;
}

.login-box {
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
  font-size: 24px;
}

label {
  display: block;
  margin: 12px 0 6px;
  color: #bbb;
  font-size: 14px;
}

input {
  width: 100%;
  padding: 14px;
  border-radius: 10px;
  border: 1px solid #444;
  background: #111;
  color: #fff;
  font-size: 16px;
  outline: none;
}

input:focus {
  border-color: #666;
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
  cursor: pointer;
}

button:hover {
  background: #444;
}

.footer {
  text-align: center;
  margin-top: 18px;
  color: #666;
  font-size: 12px;
}

</style>

</head>

<body>

<div class="login-box">

  <div class="logo">📺</div>

  <h2>IPTV Manager</h2>

  <form method="POST" action="/login">

    <label>Логин</label>

    <input
      name="username"
      type="text"
      placeholder="Введите логин"
      autocomplete="username"
      required
    >

    <label>Пароль</label>

    <input
      name="password"
      type="password"
      placeholder="Введите пароль"
      autocomplete="current-password"
      required
    >

    <button type="submit">
      Войти
    </button>

  </form>

  <div class="footer">
    Панель управления IPTV
  </div>

</div>



</body>

</html>
  `);

});
app.post("/login",async(req,res)=>{

try{

const {username,password}=req.body;


const result = await db.query(
"SELECT * FROM users WHERE username=$1 AND password=$2",
[username,password]
);


if(result.rows.length===0){

return res.send("Неверный логин или пароль");

}


req.session.user=result.rows[0];


res.redirect("/admin");


}catch(error){

res.status(500).send(error.message);

}

});



// ?????????????�
app.get("/admin/milktv",auth,(req,res)=>{
  res.sendFile(__dirname+"/public/admin/milktv/index.html");
});

app.get("/admin",auth,(req,res)=>{

res.sendFile(__dirname+"/public/admin/index.html");

});



// ?�?�?�????
app.get("/logout",(req,res)=>{

req.session.destroy();

res.redirect("/login");

});



// ?�?�?�?????�??
app.get("/",(req,res)=>{

res.json({
status:"online",
message:"IPTV API is working"
});

});



// ???�???� API
app.get("/api/test",(req,res)=>{

res.json({
message:"API connection successful"
});

});



// ?????????�?????� ?�?�?�?�
app.get("/api/db-test",async(req,res)=>{

try{

const result=await db.query("SELECT NOW()");

res.json({
database:"connected",
time:result.rows[0]
});


}catch(error){

res.status(500).json({
error:error.message
});

}

});



// ???�?�?�???? ???????�?�???�
app.get("/api/system/status",auth,async(req,res)=>{

try{

await db.query("SELECT NOW()");

res.json({
 api:"online",
 database:"online",
 time:new Date()
});

}catch(error){

res.status(500).json({
 api:"online",
 database:"offline",
 error:error.message
});

}

});

// ???�???�?�?�
app.get("/api/channels",async(req,res)=>{

try{

const result=await db.query(`
SELECT
  c.*,
  COALESCE(
    ARRAY_AGG(DISTINCT m.category)
    FILTER (WHERE m.category IS NOT NULL),
    ARRAY[]::text[]
  ) AS milktv_categories
FROM channels c
LEFT JOIN milktv_channel_categories m
  ON m.channel_id = c.id
GROUP BY c.id
ORDER BY
  (
    COALESCE(c.milktv_rating,0)
    + COALESCE(c.milktv_manual_boost,0)
  ) DESC,
  c.name ASC
`);

res.json(result.rows);


}catch(error){

res.status(500).json({
error:error.message
});

}

});



// HTML ???????????? ???�???�?�????
app.get("/channels", async (req,res) => {

  try {

    const result = await db.query(`
      SELECT
        c.id,
        c.name,
        c.url,
        c.logo,
        c.milktv_rating,
        c.milktv_views,
        c.milktv_manual_boost,
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
        c.logo,
        c.milktv_rating,
        c.milktv_views,
        c.milktv_manual_boost
      ORDER BY
        (
          COALESCE(c.milktv_rating,0)
          + COALESCE(c.milktv_manual_boost,0)
        ) DESC,
        c.name ASC
    `);

    const channels = result.rows;

    const categories = [
      { name:"Казахстан", icon:"🇰🇿" },
      { name:"Детские", icon:"🧒" },
      { name:"Кино", icon:"🎬" },
      { name:"Музыка", icon:"🎵" },
      { name:"Спорт", icon:"⚽" }
    ];

    const selectedCategory =
      String(req.query.category || "").trim();

    const search =
      String(req.query.search || "").trim().toLowerCase();

    let filteredChannels = channels;

    if (selectedCategory) {

      filteredChannels = filteredChannels.filter(ch =>
        Array.isArray(ch.milktv_categories) &&
        ch.milktv_categories.includes(selectedCategory)
      );

    }

    if (search) {

      filteredChannels = filteredChannels.filter(ch =>
        String(ch.name || "")
          .toLowerCase()
          .includes(search)
      );

    }

    const escapeHtml = value =>
      String(value || "")
        .replace(/&/g,"&amp;")
        .replace(/</g,"&lt;")
        .replace(/>/g,"&gt;")
        .replace(/"/g,"&quot;")
        .replace(/'/g,"&#039;");

    let html = `

<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1">

<title>МИЛК ТВ</title>

<style>

* {
  box-sizing:border-box;
}

body {
  margin:0;
  padding:16px;
  background:#111;
  color:white;
  font-family:Arial,sans-serif;
}

.container {
  max-width:1000px;
  margin:auto;
}

h1 {
  text-align:center;
  margin:5px 0 18px;
}

.search-box {
  margin-bottom:14px;
}

.search-box form {
  display:flex;
  gap:8px;
}

.search-box input {
  flex:1;
  min-width:0;
  padding:12px;
  background:#1c1c1c;
  color:white;
  border:1px solid #333;
  border-radius:10px;
  font-size:15px;
}

.search-box button {
  padding:12px 16px;
  background:#333;
  color:white;
  border:0;
  border-radius:10px;
  cursor:pointer;
}

.categories {
  display:flex;
  flex-wrap:wrap;
  gap:6px;
  margin-bottom:16px;
}

.category {
  display:inline-flex;
  align-items:center;
  justify-content:center;
  padding:7px 11px;
  background:#1c1c1c;
  border:1px solid #333;
  border-radius:8px;
  color:white;
  text-decoration:none;
  text-align:center;
  font-size:13px;
  white-space:nowrap;
}

.category:hover {
  background:#292929;
}

.category.active {
  border-color:#777;
  background:#303030;
}

.count {
  display:inline;
  margin-left:5px;
  color:#888;
  font-size:11px;
}
  border-color:#777;
  background:#303030;
}

.count {
  display:block;
  margin-top:4px;
  color:#888;
  font-size:12px;
}

.channels-grid {
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(120px,1fr));
  gap:10px;
}

.channel {
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  min-height:125px;
  padding:10px;
  background:#202020;
  border:1px solid #333;
  border-radius:12px;
  color:white;
  text-decoration:none;
  text-align:center;
}

.channel:hover {
  background:#292929;
  border-color:#555;
}

.channel-logo {
  width:64px;
  height:64px;
  object-fit:contain;
  border-radius:10px;
  margin-bottom:8px;
}

.channel-placeholder {
  width:64px;
  height:64px;
  display:flex;
  align-items:center;
  justify-content:center;
  background:#111;
  border-radius:10px;
  font-size:30px;
  margin-bottom:8px;
}

.channel-name {
  width:100%;
  font-size:13px;
  line-height:16px;
  overflow:hidden;
  text-overflow:ellipsis;
}

.rating {
  margin-top:4px;
  color:#aaa;
  font-size:11px;
}

.empty {
  text-align:center;
  color:#888;
  padding:35px 10px;
}

.back {
  display:block;
  margin-top:20px;
  padding:12px;
  background:#1c1c1c;
  color:white;
  text-decoration:none;
  text-align:center;
  border-radius:10px;
}

</style>

</head>

<body>

<div class="container">

<h1>📺 МИЛК ТВ</h1>

<div class="search-box">

<form method="GET"
      action="/channels">

<input
  type="text"
  name="search"
  value="${escapeHtml(search)}"
  placeholder="🔎 Поиск канала по названию"
>

${selectedCategory
  ? `<input type="hidden" name="category" value="${escapeHtml(selectedCategory)}">`
  : ""}

<button type="submit">
🔎
</button>

</form>

</div>

<div class="categories">

<a
  class="category ${!selectedCategory ? "active" : ""}"
  href="/channels"
>
📺 Все
<span class="count">(${search ? filteredChannels.length : channels.length})</span>
</a>

`;

    categories.forEach(category => {

      const count = channels.filter(ch =>
        Array.isArray(ch.milktv_categories) &&
        ch.milktv_categories.includes(category.name)
      ).length;

      const href =
        "/channels?category=" +
        encodeURIComponent(category.name) +
        (search
          ? "&search=" + encodeURIComponent(search)
          : "");

      html += `

<a
  class="category ${selectedCategory === category.name ? "active" : ""}"
  href="${href}"
>
${category.icon} ${category.name}
<span class="count">(${count})</span>
</a>

`;

    });

    html += `

</div>

<div class="channels-grid">

`;

    if (filteredChannels.length === 0) {

      html += `

<div class="empty">
📺 Каналы не найдены
</div>

`;

    } else {

      filteredChannels.forEach(ch => {

        const logo = ch.logo
          ? `<img class="channel-logo" src="${escapeHtml(ch.logo)}" alt="">`
          : `<div class="channel-placeholder">📺</div>`;

        html += `

<a
  class="channel"
  href="/channels/${ch.id}"
>

${logo}

<div class="channel-name">
${escapeHtml(ch.name)}
</div>

</a>

`;

      });

    }

    html += `

</div>

<a
  class="back"
  href="/"
>
⬅️ На главную
</a>

</div>

</script>

</body>

</html>

`;

    res.setHeader(
      "Content-Type",
      "text/html; charset=utf-8"
    );

    res.send(html);

  } catch(error) {

    console.error("CHANNELS PAGE:", error);

    res.status(500).send(error.message);

  }

});

app.get("/channels/:id", async (req,res) => {

  try {

    const result = await db.query(
      `
      SELECT
        c.id,
        c.name,
        c.url,
        c.logo,
        c.category,
        COALESCE(
          ARRAY_AGG(DISTINCT m.category)
          FILTER (WHERE m.category IS NOT NULL),
          ARRAY[]::text[]
        ) AS milktv_categories
      FROM channels c
      LEFT JOIN milktv_channel_categories m
        ON m.channel_id = c.id
      WHERE c.id = $1
      GROUP BY
        c.id,
        c.name,
        c.url,
        c.logo,
        c.category
      `,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).send("Канал не найден");
    }

    const ch = result.rows[0];

    const safeName = String(ch.name || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

    const safeUrl = String(ch.url || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

    const logo = ch.logo
      ? `<img class="channel-logo" src="${ch.logo}" alt="">`
      : `<div class="channel-logo-placeholder">📺</div>`;
    const categories = ch.milktv_categories || [];

    const categoryText =
      categories.length > 0
        ? categories.join(" • ")
        : "Без категории";

    let html = `

<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1">

<title>${safeName}</title>

<style>

* {
  box-sizing:border-box;
}

body {
  margin:0;
  padding:16px;
  background:#111;
  color:white;
  font-family:Arial,sans-serif;
}

.container {
  max-width:700px;
  margin:auto;
}

.channel-header {
  text-align:center;
  padding:20px 10px;
}

.channel-logo {
  width:110px;
  height:110px;
  object-fit:contain;
  border-radius:18px;
  background:#1c1c1c;
}

.channel-logo-placeholder {
  width:110px;
  height:110px;
  margin:auto;
  display:flex;
  align-items:center;
  justify-content:center;
  background:#1c1c1c;
  border-radius:18px;
  font-size:55px;
}

.channel-name {
  margin-top:14px;
  font-size:25px;
  font-weight:bold;
}

.channel-category {
  margin-top:6px;
  color:#999;
  font-size:13px;
}

.player-box {
  margin-top:10px;
  border:1px solid #333;
  border-radius:14px;
  overflow:hidden;
  background:#000;
}

video {
  width:100%;
  display:block;
  background:#000;
  aspect-ratio:16/9;
}

.back {
  display:block;
  width:100%;
  margin-top:18px;
  padding:12px;
  text-align:center;
  background:#1c1c1c;
  border-radius:9px;
  color:white;
  text-decoration:none;
}

</style>

</head>

<body>

<div class="container">

<div class="channel-header">

${logo}

<div class="channel-name">
${safeName}
</div>

<div class="channel-category">
${categoryText}
</div>

</div>

<div class="player-box">

<video
  id="player"
  controls
  autoplay
  playsinline
>

</video>

</div>

<a
  class="back"
  href="/channels"
>
⬅️ Назад к каналам
</a>

</div>

<script>

const video = document.getElementById("player");

video.src = ${JSON.stringify(ch.url || "")};

video.load();

video.play().catch(() => {});

</script>

<script>

let milktvProgressTimer = null;

async function startMilktvCheck() {

  const button = document.getElementById("milktv-check-button");
  const progress = document.getElementById("milktv-check-progress");

  if (!button || !progress) {
    console.error("Элементы МИЛК ТВ не найдены");
    return;
  }

  button.disabled = true;
  button.innerText = "⏳ Запуск проверки...";
  progress.innerText = "";

  try {

    const response = await fetch("/admin/milktv/check", {
      method: "POST",
      headers: {
        "Accept": "application/json"
      }
    });

    const text = await response.text();

    console.log("MILKTV START STATUS:", response.status);
    console.log("MILKTV START RESPONSE:", text);

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Сервер вернул не JSON: " + text.substring(0, 200));
    }

    if (!data.success) {

      button.disabled = false;
      button.innerText = "🔄 Проверить каналы МИЛК ТВ";
      progress.innerText =
        data.message || "Ошибка запуска проверки";

      return;
    }

    if (milktvProgressTimer) {
      clearInterval(milktvProgressTimer);
    }

    await updateMilktvProgress();

    milktvProgressTimer =
      setInterval(updateMilktvProgress, 1000);

  } catch(error) {

    console.error("MILKTV START ERROR:", error);

    button.disabled = false;
    button.innerText = "🔄 Проверить каналы МИЛК ТВ";
    progress.innerText =
      "Ошибка запуска: " + error.message;

  }

}


async function updateMilktvProgress() {

  const button =
    document.getElementById("milktv-check-button");

  const progress =
    document.getElementById("milktv-check-progress");

  if (!button || !progress) {
    return;
  }

  try {

    const response =
      await fetch("/api/admin/milktv/check-progress", {
        headers: {
          "Accept": "application/json"
        }
      });

    const text = await response.text();

    console.log("MILKTV PROGRESS:", text);

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        "Сервер вернул не JSON: " +
        text.substring(0, 200)
      );
    }

    if (response.status === 401) {

      clearInterval(milktvProgressTimer);
      milktvProgressTimer = null;

      button.disabled = false;
      button.innerText = "🔄 Проверить каналы МИЛК ТВ";
      progress.innerText = "Сессия авторизации истекла";

      return;
    }

    if (data.running) {

      button.disabled = true;

      button.innerText =
        "⏳ МИЛК ТВ: " +
        data.current +
        "/" +
        data.total;

      progress.innerText =
        "🟢 ONLINE: " +
        data.online +
        "   🔴 OFFLINE: " +
        data.offline;

      return;
    }

    if (
      data.total > 0 &&
      data.current >= data.total
    ) {

      clearInterval(milktvProgressTimer);
      milktvProgressTimer = null;

      button.disabled = false;

      button.innerText =
        "✅ Проверка завершена";

      progress.innerText =
        "🟢 ONLINE: " +
        data.online +
        "   🔴 OFFLINE: " +
        data.offline +
        "   📺 ВСЕГО: " +
        data.total;

      setTimeout(() => {

        button.innerText =
          "🔄 Проверить каналы МИЛК ТВ";

      }, 5000);

    }

  } catch(error) {

    console.error("MILKTV PROGRESS ERROR:", error);

    progress.innerText =
      "Ошибка получения прогресса: " +
      error.message;

  }

}

</script>

</body>

</html>

`;

    res.setHeader(
      "Content-Type",
      "text/html; charset=utf-8"
    );

    res.send(html);

  } catch(error) {

    console.error("PUBLIC CHANNEL:", error);

    res.status(500).send(error.message);

  }

});

app.get("/api/categories",async(req,res)=>{

try{

const result=await db.query(
"SELECT category,COUNT(*) FROM channels GROUP BY category ORDER BY category"
);

res.json(result.rows);


}catch(error){

res.status(500).json({
error:error.message
});

}

});



// ?????????????� - ???�???�?�?�
app.post("/admin/channels/category", auth, async (req,res) => {

  try {

    const {
      id
    } = req.body;

    let categories = req.body.milktv_categories || [];

    if (!Array.isArray(categories)) {
      categories = [categories];
    }

    const allowedCategories = [
      "Казахстан",
      "Детские",
      "Кино",
      "Музыка",
      "Спорт"
    ];

    if (!id) {
      return res.status(400).send("ID канала не указан");
    }

    categories = [
      ...new Set(
        categories.filter(category =>
          allowedCategories.includes(category)
        )
      )
    ];

    await db.query(
      `
      DELETE FROM milktv_channel_categories
      WHERE channel_id = $1
      `,
      [id]
    );

    for (const category of categories) {

      await db.query(
        `
        INSERT INTO milktv_channel_categories
        (
          channel_id,
          category
        )
        VALUES
        ($1,$2)
        ON CONFLICT (channel_id,category)
        DO NOTHING
        `,
        [id, category]
      );

    }

    await db.query(
      `
      UPDATE channels
      SET milktv_manual_category = $1
      WHERE id = $2
      `,
      [
        categories[0] || null,
        id
      ]
    );

    res.redirect("/admin/channels/" + id);

  } catch (error) {

    console.error("МИЛК ТВ CATEGORY:", error);

    res.status(500).send(error.message);

  }

});
app.post("/admin/channels/manual-boost", auth, async (req,res) => {

  try {

    const rawId = Array.isArray(req.body.id)
      ? req.body.id[req.body.id.length - 1]
      : req.body.id;

    const id = Number(rawId);
    let boost = Number(req.body.manual_boost);

    if (!Number.isFinite(boost)) {
      boost = 0;
    }

    boost = Math.max(0, Math.min(100, Math.round(boost)));

    await db.query(
      `
      UPDATE channels
      SET milktv_manual_boost = $1
      WHERE id = $2
      `,
      [boost, id]
    );

    res.redirect("/admin/channels/" + id);

  } catch (error) {

    console.error("МИЛК ТВ MANUAL BOOST:", error);

    res.status(500).send(error.message);

  }

});


app.get("/admin/channels/:id", auth, async (req,res) => {

  try {

    const result = await db.query(
      "SELECT * FROM channels WHERE id=$1",
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).send("Канал не найден");
    }

    const ch = result.rows[0];
    const categoryResult = await db.query(
      `
      SELECT category
      FROM milktv_channel_categories
      WHERE channel_id = $1
      ORDER BY id
      `,
      [ch.id]
    );

    const milktvCategories =
      categoryResult.rows.map(row => row.category);


    const logo = ch.logo
      ? `<img class="channel-logo" src="${ch.logo}" alt="">`
      : `<div class="channel-logo-placeholder">📺</div>`;

    const safeName = String(ch.name || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

    const safeCategory = String(ch.category || "Без категории")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

    const safeUrl = String(ch.url || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

    let html = `

<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1">

<title>${safeName}</title>

<style>

* {
  box-sizing:border-box;
}

body {
  margin:0;
  padding:16px;
  background:#111;
  color:white;
  font-family:Arial,sans-serif;
}

.container {
  max-width:700px;
  margin:auto;
}

.channel-header {
  text-align:center;
  padding:20px 10px;
}

.channel-logo {
  width:110px;
  height:110px;
  object-fit:contain;
  border-radius:18px;
  background:#1c1c1c;
}

.channel-logo-placeholder {
  width:110px;
  height:110px;
  margin:auto;
  border-radius:18px;
  background:#1c1c1c;
  display:flex;
  align-items:center;
  justify-content:center;
  font-size:55px;
}

.channel-name {
  font-size:25px;
  font-weight:bold;
  margin-top:14px;
}

.channel-category {
  color:#999;
  margin-top:6px;
}

.player-box {
  margin-top:10px;
  background:#000;
  border-radius:14px;
  overflow:hidden;
  border:1px solid #333;
}

video {
  display:block;
  width:100%;
  aspect-ratio:16/9;
  background:#000;
}

.info-box {
  margin-top:14px;
  padding:14px;
  background:#1c1c1c;
  border-radius:12px;
  border:1px solid #333;
}

.info-title {

.milktv-category-option {
  display:flex;
  align-items:center;
  gap:12px;
  padding:12px 10px;
  margin-top:6px;
  background:#151515;
  border:1px solid #292929;
  border-radius:10px;
  cursor:pointer;
  transition:.2s;
}

.milktv-category-option:hover {
  background:#202020;
  border-color:#444;
}

.milktv-category-option input {
  width:20px;
  height:20px;
  margin:0;
  cursor:pointer;
}

.milktv-category-option span {
  font-size:15px;
}

  color:#aaa;
  font-size:13px;
  margin-bottom:8px;
}

.url-box {
  display:none;
}

.url-box input {
  width:100%;
  padding:11px;
  background:#111;
  color:#7cff7c;
  border:1px solid #333;
  border-radius:8px;
  font-size:12px;
}

button,
.back {
  width:100%;
  display:block;
  padding:12px;
  margin-top:10px;
  border:0;
  border-radius:9px;
  background:#333;
  color:white;
  text-align:center;
  text-decoration:none;
  font-size:15px;
  cursor:pointer;
}

button:hover,
.back:hover {
  background:#444;
}

.delete {
  background:#512020;
}

.delete:hover {
  background:#682828;
}

</style>

</head>

<body>

<div class="container">

<div class="channel-header">

${logo}

<div class="channel-name">
${safeName}
</div>

<div class="channel-category">
${safeCategory}
</div>

</div>

<div class="player-box">

<video
  id="player"
  controls
  autoplay
  playsinline
>
</video>

</div>

<div class="info-box">

<div class="info-title">
📂 Категории МИЛК ТВ
</div>

<form
  method="POST"
  action="/admin/channels/category"
>

<input
  type="hidden"
  name="id"
  value="${ch.id}"
>

<label class="milktv-category-option">
<input
  type="checkbox"
  name="milktv_categories"
  value="Казахстан"
  ${milktvCategories.includes("Казахстан") ? "checked" : ""}
>
<span>🇰🇿 Казахстан</span>
</label>

<label class="milktv-category-option">
<input
  type="checkbox"
  name="milktv_categories"
  value="Детские"
  ${milktvCategories.includes("Детские") ? "checked" : ""}
>
<span>🧒 Детские</span>
</label>

<label class="milktv-category-option">
<input
  type="checkbox"
  name="milktv_categories"
  value="Кино"
  ${milktvCategories.includes("Кино") ? "checked" : ""}
>
<span>🎬 Кино</span>
</label>

<label class="milktv-category-option">
<input
  type="checkbox"
  name="milktv_categories"
  value="Музыка"
  ${milktvCategories.includes("Музыка") ? "checked" : ""}
>
<span>🎵 Музыка</span>
</label>

<label class="milktv-category-option">
<input
  type="checkbox"
  name="milktv_categories"
  value="Спорт"
  ${milktvCategories.includes("Спорт") ? "checked" : ""}
>
<span>⚽ Спорт</span>
</label>
<button
  type="submit"
>
💾 Сохранить категории
</button>

</form>

<form
  method="POST"
  action="/admin/channels/manual-boost"
>

<input
  type="hidden"
  name="id"
  value="${ch.id}"
>

<div class="info-title">
⭐ Ручной приоритет
</div>

<div style="color:#888;font-size:13px;margin-bottom:8px;">
Чем выше значение, тем выше канал поднимается в МИЛК ТВ.
</div>

<input
  type="number"
  name="manual_boost"
  value="${Number(ch.milktv_manual_boost || 0)}"
  min="0"
  max="100"
  step="1"
  style="width:100%;padding:12px;background:#111;color:#fff;border:1px solid #333;border-radius:9px;font-size:16px;"
>

<button
  type="submit"
>
⭐ Сохранить приоритет
</button>

</form>

</div>

<div class="info-box">

<div class="info-title">
🔗 IPTV-ссылка
</div>

<button
  type="button"
  onclick="toggleUrl()"
  id="url-button"
>
👁️ Показать ссылку
</button>

<div
  class="url-box"
  id="url-box"
>

<input
  type="text"
  value="${safeUrl}"
  readonly
  onclick="this.select()"
>

</div>

</div>

<form
  method="POST"
  action="/admin/channels/delete"
  onsubmit="return confirm('Удалить этот канал?')"
>

<input
  type="hidden"
  name="id"
  value="${ch.id}"
>

<button
  type="submit"
  class="delete"
>
🗑️ Удалить канал
</button>

</form>

<a
  class="back"
  href="/admin/channels"
>
⬅️ Назад к каналам
</a>

</div>

<script>

function toggleUrl() {

  const box =
    document.getElementById("url-box");

  const button =
    document.getElementById("url-button");

  if (box.style.display === "block") {

    box.style.display = "none";

    button.textContent =
      "👁️ Показать ссылку";

  } else {

    box.style.display = "block";

    button.textContent =
      "🙈 Скрыть ссылку";

  }

}

const video =
  document.getElementById("player");

video.src =
  ${JSON.stringify(ch.url || "")};

video.load();

video.play().catch(() => {});

</script>

<script>

let milktvProgressTimer = null;

async function startMilktvCheck() {

  const button = document.getElementById("milktv-check-button");
  const progress = document.getElementById("milktv-check-progress");

  if (!button || !progress) {
    console.error("Элементы МИЛК ТВ не найдены");
    return;
  }

  button.disabled = true;
  button.innerText = "⏳ Запуск проверки...";
  progress.innerText = "";

  try {

    const response = await fetch("/admin/milktv/check", {
      method: "POST",
      headers: {
        "Accept": "application/json"
      }
    });

    const text = await response.text();

    console.log("MILKTV START STATUS:", response.status);
    console.log("MILKTV START RESPONSE:", text);

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Сервер вернул не JSON: " + text.substring(0, 200));
    }

    if (!data.success) {

      button.disabled = false;
      button.innerText = "🔄 Проверить каналы МИЛК ТВ";
      progress.innerText =
        data.message || "Ошибка запуска проверки";

      return;
    }

    if (milktvProgressTimer) {
      clearInterval(milktvProgressTimer);
    }

    await updateMilktvProgress();

    milktvProgressTimer =
      setInterval(updateMilktvProgress, 1000);

  } catch(error) {

    console.error("MILKTV START ERROR:", error);

    button.disabled = false;
    button.innerText = "🔄 Проверить каналы МИЛК ТВ";
    progress.innerText =
      "Ошибка запуска: " + error.message;

  }

}


async function updateMilktvProgress() {

  const button =
    document.getElementById("milktv-check-button");

  const progress =
    document.getElementById("milktv-check-progress");

  if (!button || !progress) {
    return;
  }

  try {

    const response =
      await fetch("/api/admin/milktv/check-progress", {
        headers: {
          "Accept": "application/json"
        }
      });

    const text = await response.text();

    console.log("MILKTV PROGRESS:", text);

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        "Сервер вернул не JSON: " +
        text.substring(0, 200)
      );
    }

    if (response.status === 401) {

      clearInterval(milktvProgressTimer);
      milktvProgressTimer = null;

      button.disabled = false;
      button.innerText = "🔄 Проверить каналы МИЛК ТВ";
      progress.innerText = "Сессия авторизации истекла";

      return;
    }

    if (data.running) {

      button.disabled = true;

      button.innerText =
        "⏳ МИЛК ТВ: " +
        data.current +
        "/" +
        data.total;

      progress.innerText =
        "🟢 ONLINE: " +
        data.online +
        "   🔴 OFFLINE: " +
        data.offline;

      return;
    }

    if (
      data.total > 0 &&
      data.current >= data.total
    ) {

      clearInterval(milktvProgressTimer);
      milktvProgressTimer = null;

      button.disabled = false;

      button.innerText =
        "✅ Проверка завершена";

      progress.innerText =
        "🟢 ONLINE: " +
        data.online +
        "   🔴 OFFLINE: " +
        data.offline +
        "   📺 ВСЕГО: " +
        data.total;

      setTimeout(() => {

        button.innerText =
          "🔄 Проверить каналы МИЛК ТВ";

      }, 5000);

    }

  } catch(error) {

    console.error("MILKTV PROGRESS ERROR:", error);

    progress.innerText =
      "Ошибка получения прогресса: " +
      error.message;

  }

}

</script>

</body>
</html>

`;

    res.setHeader(
      "Content-Type",
      "text/html; charset=utf-8"
    );

    res.send(html);

  } catch(error) {

    console.error(error);

    res.status(500).send(error.message);

  }

});

app.get("/admin/channels", auth, async (req,res) => {

  try {

    const search = String(req.query.search || "").trim();
    const selectedCategory = String(req.query.category || "").trim();

    const allowedCategories = [
      "Казахстан",
      "Детские",
      "Кино",
      "Музыка",
      "Спорт"
    ];

    const result = await db.query(`
      SELECT
        c.*,
        COALESCE(
          ARRAY_AGG(DISTINCT m.category)
          FILTER (WHERE m.category IS NOT NULL),
          ARRAY[]::text[]
        ) AS milktv_categories
      FROM channels c
      LEFT JOIN milktv_channel_categories m
        ON m.channel_id = c.id
      WHERE
        ($1 = '' OR c.name ILIKE '%' || $1 || '%')
      GROUP BY c.id
      ORDER BY c.id DESC
    `, [search]);

    let channels = result.rows;

    if (
      selectedCategory &&
      allowedCategories.includes(selectedCategory)
    ) {
      channels = channels.filter(ch =>
        Array.isArray(ch.milktv_categories) &&
        ch.milktv_categories.includes(selectedCategory)
      );
    }

    const categoryCounts = {};

    for (const category of allowedCategories) {
      categoryCounts[category] = result.rows.filter(ch =>
        Array.isArray(ch.milktv_categories) &&
        ch.milktv_categories.includes(category)
      ).length;
    }

    const safeSearch = search
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

    let html = `

<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1">

<title>Каналы</title>

<style>

* {
  box-sizing:border-box;
}

body {
  margin:0;
  padding:16px;
  background:#111;
  color:white;
  font-family:Arial,sans-serif;
}

.container {
  max-width:1000px;
  margin:auto;
}

h2 {
  margin:0 0 16px;
}

.add-button,
.form-button,
.search-button {
  width:100%;
  padding:11px;
  border:0;
  border-radius:9px;
  background:#333;
  color:white;
  font-size:15px;
  cursor:pointer;
}

.add-button:hover,
.form-button:hover,
.search-button:hover {
  background:#444;
}

.add-box {
  display:none;
  margin-top:10px;
  padding:12px;
  background:#1b1b1b;
  border:1px solid #333;
  border-radius:12px;
}

input {
  width:100%;
  padding:11px;
  margin:4px 0;
  border-radius:8px;
  font-size:14px;
  background:#111;
  color:white;
  border:1px solid #333;
}

.cancel-button {
  background:#512020;
}

.search-box {
  margin-top:14px;
  padding:12px;
  background:#1b1b1b;
  border:1px solid #333;
  border-radius:12px;
}

.category-title {
  margin-top:16px;
  margin-bottom:8px;
  color:#aaa;
  font-size:13px;
}

.categories {
  display:flex;
  flex-wrap:wrap;
  gap:6px;
}

.category-button {
  display:inline-flex;
  align-items:center;
  justify-content:center;
  padding:7px 11px;
  background:#1c1c1c;
  border:1px solid #333;
  border-radius:8px;
  color:white;
  text-decoration:none;
  text-align:center;
  font-size:13px;
  white-space:nowrap;
}

.category-button:hover {
  background:#292929;
}

.category-button.active {
  border-color:#777;
  background:#303030;
}

.count {
  color:#888;
}

.total {
  margin-top:14px;
  color:#aaa;
  text-align:center;
}

.channels-grid {
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(110px,1fr));
  gap:10px;
  margin-top:18px;
}

.channel-tile {
  min-height:145px;
  padding:8px;
  background:#202020;
  border:1px solid #333;
  border-radius:12px;
  text-decoration:none;
  color:white;
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  text-align:center;
}

.channel-tile:hover {
  background:#292929;
  border-color:#555;
}

.channel-logo {
  width:58px;
  height:58px;
  object-fit:contain;
  border-radius:10px;
  margin-bottom:6px;
}

.channel-logo-placeholder {
  width:58px;
  height:58px;
  border-radius:10px;
  background:#111;
  display:flex;
  align-items:center;
  justify-content:center;
  font-size:28px;
  margin-bottom:6px;
}

.channel-name {
  width:100%;
  font-size:12px;
  line-height:15px;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}

.channel-categories {
  margin-top:6px;
  width:100%;
  font-size:10px;
  line-height:13px;
  color:#aaa;
}

.empty {
  color:#888;
  text-align:center;
  padding:25px;
  grid-column:1/-1;
}

.back {
  display:block;
  margin-top:18px;
  padding:11px;
  text-align:center;
  background:#1c1c1c;
  border-radius:8px;
  color:white;
  text-decoration:none;
}

</style>

</head>

<body>

<div class="container">

<h2>📺 Каналы</h2>

<button
  type="button"
  class="add-button"
  onclick="toggleAddForm()"
>
➕ Добавить канал
</button>

<div style="margin-top:10px;">

  <button
    type="button"
    id="milktv-check-button"
    class="add-button"
    onclick="startMilktvCheck()"
  >
    🔄 Проверить каналы МИЛК ТВ
  </button>

  <div
    id="milktv-check-progress"
    style="
      margin-top:8px;
      text-align:center;
      color:#aaa;
      font-size:13px;
      min-height:20px;
    "
  ></div>

</div>

<div
  id="add-form"
  class="add-box"
>

<form
  method="POST"
  action="/admin/channels/add"
>

<input
  name="name"
  placeholder="Название канала"
  required
>

<input
  name="url"
  placeholder="URL потока"
  required
>

<button
  type="submit"
  class="form-button"
>
➕ Добавить канал
</button>

<button
  type="button"
  class="form-button cancel-button"
  onclick="toggleAddForm()"
>
✖ Отмена
</button>

</form>

</div>

<div class="search-box">

<form method="GET" action="/admin/channels">

<input
  type="text"
  name="search"
  value="${safeSearch}"
  placeholder="🔎 Поиск канала по названию"
>

<input
  type="hidden"
  name="category"
  value="${selectedCategory}"
>

<button
  type="submit"
  class="search-button"
>
🔎 Найти
</button>

</form>

<div class="category-title">
📂 Категории МИЛК ТВ
</div>

<div class="categories">

<a
  class="category-button ${!selectedCategory ? "active" : ""}"
  href="/admin/channels${search ? "?search=" + encodeURIComponent(search) : ""}"
>
📋 Все
<span class="count">(${result.rows.length})</span>
</a>

${allowedCategories.map(category => {

  const icon =
    category === "Казахстан" ? "🇰🇿" :
    category === "Детские" ? "🧒" :
    category === "Кино" ? "🎬" :
    category === "Музыка" ? "🎵" :
    "⚽";

  const params = new URLSearchParams();

  params.set("category", category);

  if (search) {
    params.set("search", search);
  }

  return `
<a
  class="category-button ${selectedCategory === category ? "active" : ""}"
  href="/admin/channels?${params.toString()}"
>
${icon} ${category}
<span class="count">(${categoryCounts[category]})</span>
</a>
`;

}).join("")}

</div>

<div class="total">
Показано каналов: <b>${channels.length}</b>
</div>

</div>

<div class="channels-grid">

`;

    if (channels.length === 0) {

      html += `

<div class="empty">
  📺 Каналы не найдены
</div>

`;

    }

    channels.forEach(ch => {

      const logo = ch.logo
        ? `<img class="channel-logo" src="${ch.logo}" alt="">`
        : `<div class="channel-logo-placeholder">📺</div>`;

      const categoryText =
        Array.isArray(ch.milktv_categories) &&
        ch.milktv_categories.length > 0
          ? ch.milktv_categories.join(" • ")
          : "Без категории";

      html += `

<a
  class="channel-tile"
  href="/admin/channels/${ch.id}"
>

${logo}

<div class="channel-name">
${ch.name}
</div>

<div class="channel-categories">
${categoryText}
</div>

</a>

`;

    });

    html += `

</div>

<a
  class="back"
  href="/admin"
>
⬅️ Назад
</a>

</div>

<script>

function toggleAddForm() {

  const form =
    document.getElementById("add-form");

  if (!form) {
    return;
  }

  form.style.display =
    form.style.display === "block"
      ? "none"
      : "block";

}

</script>

<script>

let milktvProgressTimer = null;

async function startMilktvCheck() {

  const button = document.getElementById("milktv-check-button");
  const progress = document.getElementById("milktv-check-progress");

  if (!button || !progress) {
    console.error("Элементы МИЛК ТВ не найдены");
    return;
  }

  button.disabled = true;
  button.innerText = "⏳ Запуск проверки...";
  progress.innerText = "";

  try {

    const response = await fetch("/admin/milktv/check", {
      method: "POST",
      headers: {
        "Accept": "application/json"
      }
    });

    const text = await response.text();

    console.log("MILKTV START STATUS:", response.status);
    console.log("MILKTV START RESPONSE:", text);

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Сервер вернул не JSON: " + text.substring(0, 200));
    }

    if (!data.success) {

      button.disabled = false;
      button.innerText = "🔄 Проверить каналы МИЛК ТВ";
      progress.innerText =
        data.message || "Ошибка запуска проверки";

      return;
    }

    if (milktvProgressTimer) {
      clearInterval(milktvProgressTimer);
    }

    await updateMilktvProgress();

    milktvProgressTimer =
      setInterval(updateMilktvProgress, 1000);

  } catch(error) {

    console.error("MILKTV START ERROR:", error);

    button.disabled = false;
    button.innerText = "🔄 Проверить каналы МИЛК ТВ";
    progress.innerText =
      "Ошибка запуска: " + error.message;

  }

}


async function updateMilktvProgress() {

  const button =
    document.getElementById("milktv-check-button");

  const progress =
    document.getElementById("milktv-check-progress");

  if (!button || !progress) {
    return;
  }

  try {

    const response =
      await fetch("/api/admin/milktv/check-progress", {
        headers: {
          "Accept": "application/json"
        }
      });

    const text = await response.text();

    console.log("MILKTV PROGRESS:", text);

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        "Сервер вернул не JSON: " +
        text.substring(0, 200)
      );
    }

    if (response.status === 401) {

      clearInterval(milktvProgressTimer);
      milktvProgressTimer = null;

      button.disabled = false;
      button.innerText = "🔄 Проверить каналы МИЛК ТВ";
      progress.innerText = "Сессия авторизации истекла";

      return;
    }

    if (data.running) {

      button.disabled = true;

      button.innerText =
        "⏳ МИЛК ТВ: " +
        data.current +
        "/" +
        data.total;

      progress.innerText =
        "🟢 ONLINE: " +
        data.online +
        "   🔴 OFFLINE: " +
        data.offline;

      return;
    }

    if (
      data.total > 0 &&
      data.current >= data.total
    ) {

      clearInterval(milktvProgressTimer);
      milktvProgressTimer = null;

      button.disabled = false;

      button.innerText =
        "✅ Проверка завершена";

      progress.innerText =
        "🟢 ONLINE: " +
        data.online +
        "   🔴 OFFLINE: " +
        data.offline +
        "   📺 ВСЕГО: " +
        data.total;

      setTimeout(() => {

        button.innerText =
          "🔄 Проверить каналы МИЛК ТВ";

      }, 5000);

    }

  } catch(error) {

    console.error("MILKTV PROGRESS ERROR:", error);

    progress.innerText =
      "Ошибка получения прогресса: " +
      error.message;

  }

}

</script>

</body>
</html>

`;

    res.setHeader(
      "Content-Type",
      "text/html; charset=utf-8"
    );

    res.send(html);

  } catch(error) {

    console.error(error);

    res.status(500).send(error.message);

  }

});

app.post("/admin/channels/add", auth, async(req,res)=>{

  try {

    const {name,url} = req.body;

    await db.query(
      "INSERT INTO channels(name,url) VALUES($1,$2)",
      [name,url]
    );

    res.redirect("/admin/channels");

  } catch(error) {

    res.status(500).send(error.message);

  }

});


app.post("/admin/channels/delete", auth, async(req,res)=>{

try{

await db.query(
"DELETE FROM channels WHERE id=$1",
[req.body.id]
);


res.redirect("/admin/channels");


}catch(error){

res.status(500).send(error.message);

}

});




// TEMP: проверка категорий МИЛК ТВ
app.get("/api/debug/milktv-categories", auth, async (req,res) => {
  try {
    const result = await db.query(
      "SELECT category, COUNT(*) FROM milktv_channel_categories GROUP BY category ORDER BY category"
    );

    res.json(result.rows);

  } catch(error) {
    console.error(error);
    res.status(500).json({ error:error.message });
  }
});


let milktvCheckProgress = {
  running: false,
  current: 0,
  total: 0,
  online: 0,
  offline: 0,
  startedAt: null,
  finishedAt: null
};
// ПРОВЕРКА КАНАЛОВ МИЛК ТВ



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
async function runMilktvCheck() {

  try {

    const result = await db.query(`
      SELECT
        id,
        name,
        url,
        milktv_status,
        milktv_failed_checks
      FROM channels
      WHERE url IS NOT NULL
        AND TRIM(url) <> ''
        AND COALESCE(milktv_status, '') <> 'quarantine'
      ORDER BY name
    `);

    milktvCheckProgress.total = result.rows.length;
    milktvCheckProgress.current = 0;
    milktvCheckProgress.online = 0;
    milktvCheckProgress.offline = 0;

    for (const channel of result.rows) {

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const started = Date.now();

      let isOnline = false;
      let responseTime = 0;
      let errorText = null;

      try {

        const response = await fetch(channel.url, {
          method: "GET",
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0"
          }
        });

        responseTime = Date.now() - started;

        clearTimeout(timer);

        if (response.ok) {
          isOnline = true;
        } else {
          errorText = `HTTP ${response.status}`;
        }

      } catch(error) {

        responseTime = Date.now() - started;

        clearTimeout(timer);

        errorText =
          error.name === "AbortError"
            ? "Таймаут"
            : error.message;

      }

      if (isOnline) {

        milktvCheckProgress.online++;

        await db.query(`
          UPDATE channels
          SET
            milktv_status = 'online',
            milktv_failed_checks = 0,
            milktv_last_check = NOW(),
            milktv_response_time = $1,
            milktv_check_error = NULL
          WHERE id = $2
        `, [
          responseTime,
          channel.id
        ]);

      } else {

        milktvCheckProgress.offline++;

        const failedChecks =
          Number(channel.milktv_failed_checks || 0) + 1;

        if (failedChecks >= 3) {

          await db.query(`
            UPDATE channels
            SET
              milktv_status = 'quarantine',
              milktv_failed_checks = $1,
              milktv_last_check = NOW(),
              milktv_quarantine_since =
                COALESCE(milktv_quarantine_since, NOW()),
              milktv_quarantine_last_check = NOW(),
              milktv_response_time = $2,
              milktv_check_error = $3
            WHERE id = $4
          `, [
            failedChecks,
            responseTime,
            errorText,
            channel.id
          ]);

          console.log(
            `🔴 КАРАНТИН: ${channel.name} | ${failedChecks} неудачных проверок`
          );

        } else {

          await db.query(`
            UPDATE channels
            SET
              milktv_status = 'offline',
              milktv_failed_checks = $1,
              milktv_last_check = NOW(),
              milktv_response_time = $2,
              milktv_check_error = $3
            WHERE id = $4
          `, [
            failedChecks,
            responseTime,
            errorText,
            channel.id
          ]);

        }

      }

      milktvCheckProgress.current++;

      console.log(
        `МИЛК ТВ: ${milktvCheckProgress.current}/${milktvCheckProgress.total} | ONLINE: ${milktvCheckProgress.online} | OFFLINE: ${milktvCheckProgress.offline}`
      );

    }

    milktvCheckProgress.running = false;
    milktvCheckProgress.finishedAt = new Date();

    console.log("");
    console.log("========== ПРОВЕРКА МИЛК ТВ ==========");
    console.log("🟢 ONLINE:", milktvCheckProgress.online);
    console.log("🔴 OFFLINE:", milktvCheckProgress.offline);
    console.log("📺 ВСЕГО:", milktvCheckProgress.total);
    console.log("======================================");
    console.log("");

  } catch(error) {

    console.error("ОШИБКА ПРОВЕРКИ МИЛК ТВ:", error);

    milktvCheckProgress.running = false;
    milktvCheckProgress.finishedAt = new Date();

  }

}
async function runMilktvQuarantineCheck() {

  console.log("");
  console.log("========== ПРОВЕРКА КАРАНТИНА МИЛК ТВ ==========");

  try {

    const result = await db.query(`
      SELECT
        id,
        name,
        url,
        milktv_rating,
        milktv_views,
        milktv_viewers,
        milktv_quarantine_last_check
      FROM channels
      WHERE milktv_status = 'quarantine'
        AND url IS NOT NULL
        AND TRIM(url) <> ''
      ORDER BY name
    `);

    console.log("🔎 Каналов в карантине:", result.rows.length);

    for (const channel of result.rows) {

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const started = Date.now();

      let isOnline = false;
      let responseTime = 0;
      let errorText = null;

      try {

        const response = await fetch(channel.url, {
          method: "GET",
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0"
          }
        });

        responseTime = Date.now() - started;

        clearTimeout(timer);

        if (response.ok) {
          isOnline = true;
        } else {
          errorText = `HTTP ${response.status}`;
        }

      } catch(error) {

        responseTime = Date.now() - started;

        clearTimeout(timer);

        errorText =
          error.name === "AbortError"
            ? "Таймаут"
            : error.message;

      }

      if (isOnline) {

        const duplicate = await db.query(`
          SELECT id
          FROM channels
          WHERE id <> $1
            AND LOWER(TRIM(name)) = LOWER(TRIM($2))
            AND COALESCE(milktv_status, '') <> 'quarantine'
          LIMIT 1
        `, [
          channel.id,
          channel.name
        ]);

        if (duplicate.rows.length > 0) {

          console.log(
            `⚠️ ${channel.name}: канал уже существует в основном списке — оставляем карантин`
          );

          await db.query(`
            UPDATE channels
            SET
              milktv_quarantine_last_check = NOW(),
              milktv_last_check = NOW(),
              milktv_response_time = $1,
              milktv_check_error = $2
            WHERE id = $3
          `, [
            responseTime,
            "Рабочий, но существует активный канал с таким же названием",
            channel.id
          ]);

        } else {

          await db.query(`
            UPDATE channels
            SET
              milktv_status = 'online',
              milktv_failed_checks = 0,
              milktv_quarantine_last_check = NOW(),
              milktv_last_check = NOW(),
              milktv_response_time = $1,
              milktv_check_error = NULL
            WHERE id = $2
          `, [
            responseTime,
            channel.id
          ]);

          console.log(
            `🟢 ВОЗВРАЩЁН ИЗ КАРАНТИНА: ${channel.name}`
          );

        }

      } else {

        await db.query(`
          UPDATE channels
          SET
            milktv_quarantine_last_check = NOW(),
            milktv_last_check = NOW(),
            milktv_response_time = $1,
            milktv_check_error = $2
          WHERE id = $3
        `, [
          responseTime,
          errorText,
          channel.id
        ]);

        console.log(
          `🔴 КАРАНТИН: ${channel.name} — ${errorText}`
        );

      }

    }

  } catch(error) {

    console.error(
      "ОШИБКА ПРОВЕРКИ КАРАНТИНА МИЛК ТВ:",
      error
    );

  }

  console.log("================================================");
  console.log("");
}
app.post("/admin/milktv/check", auth, async (req,res) => {

  if (milktvCheckProgress.running) {
    return res.json({
      success: false,
      message: "Проверка уже выполняется"
    });
  }

  milktvCheckProgress = {
    running: true,
    current: 0,
    total: 0,
    online: 0,
    offline: 0,
    startedAt: new Date(),
    finishedAt: null
  };

  runMilktvCheck();

  res.json({
    success: true
  });

});


app.get("/api/admin/milktv/check-progress", auth, async (req,res) => {

  res.json(milktvCheckProgress);

});


setTimeout(async () => {

  try {

    await runMilktvQuarantineCheck();

  } catch(error) {

    console.error(
      "ОШИБКА ПЕРВОЙ ПРОВЕРКИ КАРАНТИНА:",
      error
    );

  }

}, 5000);
const MILKTV_QUARANTINE_INTERVAL = 4 * 60 * 60 * 1000;

setInterval(async () => {

  try {

    await runMilktvQuarantineCheck();

  } catch(error) {

    console.error(
      "ОШИБКА АВТОПРОВЕРКИ КАРАНТИНА:",
      error
    );

  }

}, MILKTV_QUARANTINE_INTERVAL);

console.log(
  "⏱️ Автопроверка карантина МИЛК ТВ: каждые 4 часа"
);
app.listen(PORT,()=>{

console.log(`IPTV API running on port ${PORT}`);

});




























