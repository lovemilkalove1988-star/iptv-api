const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const db = require("../database");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


// =====================================================
// СПИСОК КЛИЕНТОВ
// =====================================================

router.get("/", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, name, phone, login, active, token
      FROM clients
      ORDER BY id DESC
    `);

    let html = `
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">

<title>Клиенты IPTV</title>

<style>
body {
  margin: 0;
  padding: 20px;
  background: #111;
  color: white;
  font-family: Arial, sans-serif;
}

.container {
  max-width: 700px;
  margin: auto;
}

h1 {
  margin-top: 0;
}

button,
input {
  width: 100%;
  box-sizing: border-box;
  padding: 12px;
  margin: 5px 0;
  border-radius: 8px;
  border: none;
  font-size: 15px;
}

input {
  background: #111;
  color: white;
  border: 1px solid #444;
}

button {
  background: #333;
  color: white;
  cursor: pointer;
}

button:hover {
  background: #444;
}

button:disabled {
  opacity: .5;
  cursor: wait;
}

.card {
  background: #222;
  padding: 15px;
  margin: 12px 0;
  border-radius: 12px;
  border: 1px solid #333;
}

.client-name {
  font-size: 20px;
  font-weight: bold;
}

.info {
  color: #aaa;
  margin-top: 5px;
}

.status {
  margin-top: 12px;
  padding: 10px;
  border-radius: 8px;
  background: #181818;
}

.status-active {
  color: #7cff7c;
}

.status-blocked {
  color: #ff7777;
}

.url {
  margin-top: 12px;
}

.url input {
  color: #7cff7c;
}

.actions {
  margin-top: 10px;
}

.actions a {
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 12px;
  margin: 5px 0;
  border-radius: 8px;
  background: #333;
  color: white;
  text-decoration: none;
  text-align: center;
}

.add-box {
  display: none;
  margin-top: 15px;
  padding: 15px;
  background: #1c1c1c;
  border-radius: 12px;
  border: 1px solid #333;
}

.devices {
  display: none;
  margin-top: 10px;
  padding: 12px;
  background: #181818;
  border-radius: 10px;
}

.device {
  background: #222;
  padding: 10px;
  margin: 7px 0;
  border-radius: 8px;
}

.device-id {
  color: #aaa;
  font-size: 13px;
}

.last-seen {
  color: #777;
  font-size: 12px;
}

.message {
  display: none;
  padding: 10px;
  margin: 10px 0;
  border-radius: 8px;
  background: #222;
}

.danger {
  background: #512020;
}

.success {
  background: #205120;
}
</style>
</head>

<body>

<div class="container">

<h1>👥 Клиенты</h1>

<button type="button" onclick="toggleAddClientForm()">
➕ Добавить клиента
</button>

<div id="add-client-form" class="add-box">

<form method="POST" action="/admin/clients/add">

<input
  name="name"
  placeholder="Имя"
  required
>

<input
  name="phone"
  placeholder="Телефон"
>

<input
  name="login"
  placeholder="Логин"
  required
>

<input
  name="password"
  type="text"
  placeholder="Пароль клиента"
  required
>

<button type="submit">
➕ Создать клиента
</button>

</form>

</div>

<div id="message" class="message"></div>

<hr>
`;

    result.rows.forEach(client => {

      const playlistUrl = client.token
        ? `${req.protocol}://${req.get("host")}/playlist/${client.token}.m3u`
        : "Токен отсутствует";

      html += `

<div
  class="card"
  id="client-${client.id}"
>

<div class="client-name">
${escapeHtml(client.name)}
</div>

<div class="info">
📱 ${escapeHtml(client.phone || "Телефон не указан")}
</div>

<div class="info">
🔑 Логин: ${escapeHtml(client.login)}
</div>

<div class="status">

<div
  class="status-text ${
    client.active
      ? "status-active"
      : "status-blocked"
  }"
>
${
  client.active
    ? "🟢 Активен"
    : "🔴 Заблокирован"
}
</div>

<button
  type="button"
  class="toggle-button"
  onclick="toggleClient(${client.id})"
>
${
  client.active
    ? "🔴 Заблокировать"
    : "🟢 Активировать"
}
</button>

</div>

<div class="actions">

<a href="/admin/clients/edit/${client.id}">
✏️ Редактировать
</a>

<button
  type="button"
  onclick="deleteClient(${client.id})"
>
🗑️ Удалить
</button>

</div>

<div style="margin-top:15px;">

<button
  type="button"
  onclick="toggleDevices(${client.id})"
>
📱 Устройства
</button>

<div
  id="devices-${client.id}"
  class="devices"
>

<div
  id="device-list-${client.id}"
>
</div>

<hr>

<div style="color:#aaa;margin-bottom:6px;">
Добавить устройство
</div>

<input
  type="text"
  id="device-name-${client.id}"
  placeholder="Название, например Samsung TV"
>

<input
  type="text"
  id="device-id-${client.id}"
  placeholder="ID устройства"
>

<button
  type="button"
  onclick="addDevice(${client.id})"
>
➕ Добавить устройство
</button>

</div>

</div>

<div class="url">

<div style="margin-bottom:5px;">
📺 IPTV-ссылка:
</div>

<input
  type="text"
  id="url-${client.id}"
  value="${escapeHtml(playlistUrl)}"
  readonly
  onclick="this.select()"
>

</div>

</div>
`;
    });

    html += `

</div>

<script>

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


// =====================================================
// ДОБАВЛЕНИЕ КЛИЕНТА
// =====================================================

function toggleAddClientForm() {

  const form = document.getElementById("add-client-form");

  if (!form) {
    return;
  }

  form.style.display =
    form.style.display === "block"
      ? "none"
      : "block";
}


// =====================================================
// УСТРОЙСТВА
// =====================================================

async function toggleDevices(clientId) {

  const box =
    document.getElementById("devices-" + clientId);

  if (!box) {
    return;
  }

  if (box.style.display === "none" ||
      box.style.display === "") {

    box.style.display = "block";

    await loadDevices(clientId);

  } else {

    box.style.display = "none";

  }
}


async function loadDevices(clientId) {

  const list =
    document.getElementById(
      "device-list-" + clientId
    );

  if (!list) {
    return;
  }

  list.innerHTML = "⏳ Загрузка...";

  try {

    const response = await fetch(
      "/admin/clients/devices/" + clientId
    );

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(
        data.error ||
        "Ошибка загрузки устройств"
      );
    }

    if (!data.devices ||
        data.devices.length === 0) {

      list.innerHTML =
        '<div style="color:#888;">Устройств пока нет</div>';

      return;
    }

    list.innerHTML = "";

    data.devices.forEach(device => {

      const item =
        document.createElement("div");

      item.className = "device";

      const deviceName =
        escapeHtml(
          device.device_name ||
          "Устройство"
        );

      const deviceId =
        escapeHtml(
          device.device_id ||
          ""
        );

      const lastSeen =
        device.last_seen
          ? new Date(
              device.last_seen
            ).toLocaleString()
          : "нет";

      item.innerHTML =
        '<div><b>Устройство</b></div>' +
        '<div class="device-id">ID: ' +
        deviceId +
        '</div>' +
        '<div class="last-seen">' +
        'Последняя активность: ' +
        lastSeen +
        '</div>' +
        '<button type="button" ' +
        'style="margin-top:7px;" ' +
        'onclick="deleteDevice(' +
        device.id +
        ',' +
        clientId +
        ')">' +
        'Удалить' +
        '</button>';


      list.appendChild(item);

    });

  } catch (error) {

    console.error(error);

    list.innerHTML =
      "❌ " + escapeHtml(error.message);

  }
}


// =====================================================
// ДОБАВИТЬ УСТРОЙСТВО
// =====================================================

async function addDevice(clientId) {

  const nameInput =
    document.getElementById(
      "device-name-" + clientId
    );

  const idInput =
    document.getElementById(
      "device-id-" + clientId
    );

  const deviceName =
    nameInput.value.trim();

  const deviceId =
    idInput.value.trim();

  if (!deviceId) {

    alert(
      "Введите ID устройства"
    );

    return;
  }

  try {

    const response =
      await fetch(
        "/admin/clients/devices/" + clientId,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            device_name:
              deviceName ||
              "Устройство",

            device_id:
              deviceId
          })
        }
      );

    const data =
      await response.json();

    if (!response.ok ||
        !data.success) {

      throw new Error(
        data.error ||
        "Ошибка добавления устройства"
      );
    }

    nameInput.value = "";
    idInput.value = "";

    await loadDevices(clientId);

  } catch (error) {

    console.error(error);

    alert(
      "❌ " + error.message
    );

  }
}


// =====================================================
// УДАЛЕНИЕ УСТРОЙСТВА
// =====================================================

async function deleteDevice(
  deviceId,
  clientId
) {

  if (!confirm(
    "Удалить это устройство?"
  )) {
    return;
  }

  try {

    const response =
      await fetch(
        "/admin/clients/devices/" + deviceId,
        {
          method: "DELETE"
        }
      );

    const data =
      await response.json();

    if (!response.ok ||
        !data.success) {

      throw new Error(
        data.error ||
        "Ошибка удаления устройства"
      );
    }

    await loadDevices(clientId);

  } catch (error) {

    console.error(error);

    alert(
      "❌ " + error.message
    );

  }
}


// =====================================================
// УДАЛЕНИЕ КЛИЕНТА
// =====================================================

async function deleteClient(id) {

  const card =
    document.getElementById(
      "client-" + id
    );

  if (!card) {
    return;
  }

  const clientName =
    card.querySelector(
      ".client-name"
    )?.innerText ||
    "этого клиента";

  if (!confirm(
    "Удалить " +
    clientName +
    "?"
  )) {
    return;
  }

  try {

    const response =
      await fetch(
        "/admin/clients/delete/" + id,
        {
          method: "DELETE"
        }
      );

    const data =
      await response.json();

    if (!response.ok ||
        !data.success) {

      throw new Error(
        data.error ||
        "Ошибка удаления"
      );
    }

    card.remove();

  } catch (error) {

    console.error(error);

    alert(
      "❌ Не удалось удалить клиента: " +
      error.message
    );

  }
}


// =====================================================
// АКТИВИРОВАТЬ / ЗАБЛОКИРОВАТЬ
// =====================================================

async function toggleClient(id) {

  const card =
    document.getElementById(
      "client-" + id
    );

  if (!card) {
    return;
  }

  const button =
    card.querySelector(
      ".toggle-button"
    );

  const statusText =
    card.querySelector(
      ".status-text"
    );

  const oldText =
    button.innerText;

  button.disabled = true;

  button.innerText =
    "⏳ Подождите...";

  try {

    const response =
      await fetch(
        "/admin/clients/toggle/" + id,
        {
          method: "POST",

          headers: {
            "Accept":
              "application/json"
          }
        }
      );

    const data =
      await response.json();

    if (!response.ok ||
        !data.success) {

      throw new Error(
        data.error ||
        "Ошибка изменения статуса"
      );
    }

    if (data.active) {

      statusText.innerText =
        "🟢 Активен";

      statusText.className =
        "status-text status-active";

      button.innerText =
        "🔴 Заблокировать";

    } else {

      statusText.innerText =
        "🔴 Заблокирован";

      statusText.className =
        "status-text status-blocked";

      button.innerText =
        "🟢 Активировать";

    }

    button.disabled = false;

  } catch (error) {

    console.error(error);

    button.innerText =
      oldText;

    button.disabled = false;

    alert(
      "❌ Не удалось изменить статус клиента: " +
      error.message
    );

  }
}

</script>

</body>
</html>
`;

    res.send(html);

  } catch (error) {

    console.error(error);

    res.status(500).send(
      "Ошибка: " + error.message
    );

  }
});


// =====================================================
// РЕДАКТИРОВАНИЕ КЛИЕНТА
// =====================================================

router.get("/edit/:id", async (req, res) => {

  try {

    const result = await db.query(
      `
      SELECT id, name, phone, login, password
      FROM clients
      WHERE id = $1
      `,
      [req.params.id]
    );

    if (result.rows.length === 0) {

      return res
        .status(404)
        .send("Клиент не найден");

    }

    const client =
      result.rows[0];

    res.send(`

<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
>

<title>Редактирование клиента</title>

<style>

body {
  margin: 0;
  min-height: 100vh;

  display: flex;
  align-items: center;
  justify-content: center;

  background: #111;
  color: white;

  font-family: Arial, sans-serif;

  padding: 20px;
}

.box {
  width: 100%;
  max-width: 420px;

  background: #1c1c1c;

  border: 1px solid #333;

  border-radius: 18px;

  padding: 25px;

  box-sizing: border-box;
}

h2 {
  text-align: center;
  margin-top: 0;
}

label {
  display: block;

  margin-top: 12px;
  margin-bottom: 6px;

  color: #aaa;
}

input {
  width: 100%;

  padding: 13px;

  border-radius: 10px;

  border: 1px solid #444;

  background: #111;

  color: white;

  font-size: 16px;

  box-sizing: border-box;
}

button,
.back {
  width: 100%;

  display: block;

  padding: 13px;

  margin-top: 12px;

  border-radius: 10px;

  border: none;

  box-sizing: border-box;

  text-align: center;

  text-decoration: none;

  font-size: 16px;

  cursor: pointer;
}

button {
  background: #333;
  color: white;
}

.back {
  background: #222;
  color: #aaa;
}

</style>

</head>

<body>

<div class="box">

<h2>✏️ Редактирование клиента</h2>

<form
  method="POST"
  action="/admin/clients/edit/${client.id}"
>

<label>Имя</label>

<input
  name="name"
  value="${escapeHtml(client.name)}"
  required
>

<label>Телефон</label>

<input
  name="phone"
  value="${escapeHtml(client.phone)}"
>

<label>Логин</label>

<input
  name="login"
  value="${escapeHtml(client.login)}"
  required
>

<label>Пароль</label>

<input
  name="password"
  type="text"
  value="${escapeHtml(client.password)}"
  required
>

<button type="submit">
💾 Сохранить
</button>

</form>

<a
  class="back"
  href="/admin/clients"
>
⬅ Назад к клиентам
</a>

</div>

</body>

</html>

`);

  } catch (error) {

    console.error(error);

    res.status(500).send(
      error.message
    );

  }

});


router.post("/edit/:id", async (req, res) => {

  try {

    const {
      name,
      phone,
      login,
      password
    } = req.body;

    const result =
      await db.query(
        `
        UPDATE clients
        SET
          name = $1,
          phone = $2,
          login = $3,
          password = $4
        WHERE id = $5
        RETURNING id
        `,
        [
          name,
          phone,
          login,
          password,
          req.params.id
        ]
      );

    if (result.rows.length === 0) {

      return res
        .status(404)
        .send("Клиент не найден");

    }

    res.redirect(
      "/admin/clients"
    );

  } catch (error) {

    console.error(error);

    res.status(500).send(
      error.message
    );

  }

});


// =====================================================
// УДАЛЕНИЕ КЛИЕНТА
// =====================================================

router.delete("/delete/:id", async (req, res) => {

  try {

    const result =
      await db.query(
        `
        DELETE FROM clients
        WHERE id = $1
        RETURNING id
        `,
        [req.params.id]
      );

    if (result.rows.length === 0) {

      return res.status(404).json({
        success: false,
        error: "Клиент не найден"
      });

    }

    res.json({
      success: true,
      id: result.rows[0].id
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });

  }

});


// =====================================================
// ДОБАВЛЕНИЕ КЛИЕНТА
// =====================================================

router.post("/add", async (req, res) => {

  try {

    const {
      name,
      phone,
      login,
      password
    } = req.body;

    const token =
      crypto
        .randomBytes(24)
        .toString("hex");

    await db.query(
      `
      INSERT INTO clients
      (
        name,
        phone,
        login,
        password,
        token,
        active
      )
      VALUES
      ($1, $2, $3, $4, $5, true)
      `,
      [
        name,
        phone,
        login,
        password,
        token
      ]
    );

    res.redirect(
      "/admin/clients"
    );

  } catch (error) {

    console.error(error);

    res.status(500).send(
      error.message
    );

  }

});


// =====================================================
// АКТИВИРОВАТЬ / ЗАБЛОКИРОВАТЬ
// =====================================================

router.post("/toggle/:id", async (req, res) => {

  try {

    const result =
      await db.query(
        `
        UPDATE clients
        SET active = NOT active
        WHERE id = $1
        RETURNING id, active
        `,
        [req.params.id]
      );

    if (result.rows.length === 0) {

      return res.status(404).json({
        success: false,
        error: "Клиент не найден"
      });

    }

    res.json({
      success: true,
      id: result.rows[0].id,
      active: result.rows[0].active
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });

  }

});


// =====================================================
// УСТРОЙСТВА КЛИЕНТА
// =====================================================

router.get("/devices/:clientId", async (req, res) => {

  try {

    const result =
      await db.query(
        `
        SELECT
          id,
          device_name,
          device_id,
          last_seen
        FROM devices
        WHERE client_id = $1
        ORDER BY id DESC
        `,
        [req.params.clientId]
      );

    res.json({
      success: true,
      devices: result.rows
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });

  }

});


router.post("/devices/:clientId", async (req, res) => {

  try {

    const {
      device_name,
      device_id
    } = req.body;

    if (!device_id) {

      return res.status(400).json({
        success: false,
        error: "ID устройства обязателен"
      });

    }

    const result =
      await db.query(
        `
        INSERT INTO devices
        (
          client_id,
          device_name,
          device_id
        )
        VALUES
        ($1, $2, $3)
        RETURNING
          id,
          client_id,
          device_name,
          device_id,
          last_seen
        `,
        [
          req.params.clientId,
          device_name || "Устройство",
          device_id
        ]
      );

    res.json({
      success: true,
      device: result.rows[0]
    });

  } catch (error) {

    console.error(error);

    if (error.code === "23505") {

      return res.status(409).json({
        success: false,
        error:
          "Такое устройство уже зарегистрировано"
      });

    }

    res.status(500).json({
      success: false,
      error: error.message
    });

  }

});


router.delete("/devices/:id", async (req, res) => {

  try {

    const result =
      await db.query(
        `
        DELETE FROM devices
        WHERE id = $1
        RETURNING id
        `,
        [req.params.id]
      );

    if (result.rows.length === 0) {

      return res.status(404).json({
        success: false,
        error: "Устройство не найдено"
      });

    }

    res.json({
      success: true,
      id: result.rows[0].id
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });

  }

});


module.exports = router;

