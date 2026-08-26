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
        ? "/playlist/" + client.token + ".m3u"
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


module.exports = router;
