const express = require("express");
const cors = require("cors");
const session = require("express-session");
const db = require("./database");
const clientsRouter = require("./routes/clients");
const adminClientsRouter = require("./routes/admin-clients");
const clientRouter = require("./routes/client");

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

const result=await db.query(
"SELECT * FROM channels ORDER BY id"
);

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

    const result = await db.query(
      "SELECT * FROM channels ORDER BY id"
    );

    let html = `

<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1">

<title>Просмотр каналов</title>

<style>

body {
  margin:0;
  background:#111;
  color:white;
  font-family:Arial,sans-serif;
  padding:20px;
}

.container {
  max-width:900px;
  margin:auto;
}

h1 {
  margin-bottom:20px;
}

.channel {
  background:#222;
  padding:15px;
  margin:10px 0;
  border-radius:10px;
}

.channel h2 {
  margin-top:0;
}

video {
  width:100%;
  max-width:600px;
  border-radius:8px;
  background:#000;
}

.category {
  color:#aaa;
  margin-bottom:10px;
}

</style>

</head>

<body>

<div class="container">

<h1>📺 Просмотр каналов</h1>

`;

    result.rows.forEach(ch => {

      html += `

<div class="channel">

<h2>${ch.name}</h2>

<div class="category">
${ch.category || "Без категории"}
</div>

<video controls>

<source src="${ch.url}" type="application/x-mpegURL">

Ваш браузер не поддерживает воспроизведение этого потока.

</video>

</div>

`;

    });

    html += `

</div>

</body>

</html>

`;

    res.setHeader(
      "Content-Type",
      "text/html; charset=utf-8"
    );

    res.send(html);

  } catch(error) {

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
app.get("/admin/channels", auth, async (req,res) => {

  try {

    const result = await db.query(
      "SELECT * FROM channels ORDER BY id DESC"
    );

    let html = `

<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1">

<title>Каналы</title>

<style>

body {
  background:#111;
  color:white;
  font-family:Arial,sans-serif;
  padding:20px;
}

.container {
  max-width:900px;
  margin:auto;
}

h2 {
  margin-bottom:20px;
}

input,button {
  width:100%;
  padding:12px;
  margin:5px 0;
  border-radius:8px;
  border:none;
}

input {
  background:#1c1c1c;
  color:white;
  border:1px solid #333;
}

button {
  background:#333;
  color:white;
  cursor:pointer;
}

button:hover {
  background:#444;
}

.card {
  background:#222;
  padding:15px;
  margin:10px 0;
  border-radius:12px;
}

a {
  color:white;
  text-decoration:none;
}

.back {
  display:block;
  margin-top:20px;
  padding:12px;
  text-align:center;
  background:#1c1c1c;
  border-radius:8px;
}

</style>

</head>

<body>

<div class="container">

<h2>📺 Управление каналами</h2>

<form method="POST" action="/admin/channels/add">

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

<input
  name="category"
  placeholder="Категория"
>

<button type="submit">
  ➕ Добавить
</button>

</form>

<hr>

`;

    result.rows.forEach(ch => {

      html += `

<div class="card">

<b>${ch.name}</b>

<br>

${ch.category || "Без категории"}

<br>

<small>${ch.url}</small>

<form method="POST" action="/admin/channels/delete">

<input
  type="hidden"
  name="id"
  value="${ch.id}"
>

<button type="submit">
  🗑️ Удалить
</button>

</form>

</div>

`;

    });

    html += `

<a class="back" href="/admin">
  ⬅️ Назад
</a>

</div>

</body>
</html>

`;

    res.setHeader(
      "Content-Type",
      "text/html; charset=utf-8"
    );

    res.send(html);

  } catch(error) {

    res.status(500).send(error.message);

  }

});

app.post("/admin/channels/add", auth, async(req,res)=>{

try{

const {name,url,category}=req.body;


await db.query(
"INSERT INTO channels(name,url,category) VALUES($1,$2,$3)",
[name,url,category]
);


res.redirect("/admin/channels");


}catch(error){

res.status(500).send(error.message);

}

});



// ?????�?�?�?????� ???�???�?�?�
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



app.listen(PORT,()=>{

console.log(`IPTV API running on port ${PORT}`);

});




