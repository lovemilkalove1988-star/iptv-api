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


// ===============================
// СПИСОК КЛИЕНТОВ
// ===============================

router.get("/", async (req, res) => {

  try {

    const result = await db.query(
      "SELECT id, name, phone, login, active, token FROM clients ORDER BY id DESC"
    );

    let html = `
<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport" content="width=device-width, initial-scale=1">

<title>Клиенты</title>

<style>

body {
  background:#111;
  color:white;
  font-family:Arial,sans-serif;
  padding:20px;
}

input,
button {
  width:100%;
  padding:12px;
  margin:5px 0;
  border-radius:8px;
  border:none;
  box-sizing:border-box;
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
  border-radius:10px;
}

.url {
  word-break:break-all;
  color:#7cff7c;
}

.status {
  margin-top:8px;
  margin-bottom:8px;
}

.status button {
  width:auto;
  min-width:180px;
}

.message {
  margin:10px 0;
  padding:10px;
  border-radius:8px;
  background:#222;
  display:none;
}

</style>

</head>

<body>

<h2>👥 Клиенты</h2>

<button
  type="button"
  onclick="toggleAddClientForm()"
>
➕ Добавить клиента
</button>

<div
  id="add-client-form"
  style="
    display:none;
    margin-top:15px;
    padding:15px;
    background:#1c1c1c;
    border-radius:12px;
  "
>

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

<hr>

<div id="message" class="message"></div>
`;


    result.rows.forEach(c => {

      const playlistUrl = c.token
        ? `http://192.168.123.7:3000/playlist/${c.token}.m3u`
        : "Токен отсутствует";

      html += `

<div
  class="card"
  id="client-${c.id}"
  data-active="${c.active ? "true" : "false"}"
>

<b>${escapeHtml(c.name)}</b>

<br>

📱 ${escapeHtml(c.phone)}

<br>

🔑 Логин: ${escapeHtml(c.login)}

<div class="status">

<span class="status-text">
${
  c.active
    ? "🟢 Активен"
    : "🔴 Заблокирован"
}
</span>

<br>

<button
  type="button"
  class="toggle-button"
  onclick="toggleClient(${c.id})"
>
${
  c.active
    ? "🔴 Заблокировать"
    : "🟢 Активировать"
}
</button>

<a
  href="/admin/clients/edit/${c.id}"
  style="
    display:inline-block;
    width:auto;
    min-width:180px;
    padding:12px;
    margin:5px 0;
    border-radius:8px;
    background:#333;
    color:white;
    text-decoration:none;
    text-align:center;
    box-sizing:border-box;
  "
>
✏️ Редактировать
</a>

<button
  type="button"
  class="delete-button"
  onclick="deleteClient(${c.id})"
>
🗑️ Удалить
</button>

</div>

📺 IPTV ссылка:

<br>

<div style="margin-top:15px;">

<button
  type="button"
  onclick="toggleDevices(${c.id})"
>
📱 Устройства
</button>

<div
  id="devices-${c.id}"
  style="
    display:none;
    margin-top:10px;
    padding:12px;
    background:#181818;
    border-radius:10px;
  "
>

<div
  id="device-list-${c.id}"
  style="margin-bottom:10px;"
>
</div>

<div style="font-size:14px;color:#aaa;margin-bottom:6px;">
Добавить устройство
</div>

<input
  type="text"
  id="device-name-${c.id}"
  placeholder="Название, например Samsung TV"
>

<input
  type="text"
  id="device-id-${c.id}"
  placeholder="ID устройства"
>

<button
  type="button"
  onclick="addDevice(${c.id})"
>
➕ Добавить устройство
</button>

</div>

</div>

<input
  type="text"
  id="url-${c.id}"
  value="${playlistUrl}"
  readonly
  onclick="this.select()"
>

</div>

`;

    });


    html += `


function escapeHtml(value) {

  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

}



  if (form.style.display === "none") {

    form.style.display = "block";

  } else {

    form.style.display = "none";

  }

}


<script>

function escapeHtml(value) {

  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

}


function toggleAddClientForm() {

  const form =
    document.getElementById("add-client-form");

  if (!form) {
    return;
  }

  if (form.style.display === "none") {

    form.style.display = "block";

  } else {

    form.style.display = "none";

  }

}


async function toggleDevices(clientId) {

  const box = document.getElementById("devices-" + clientId);

  if (!box) {
    return;
  }

  if (box.style.display === "none") {

    box.style.display = "block";

    await loadDevices(clientId);

  } else {

    box.style.display = "none";

  }

}


async function loadDevices(clientId) {

  const list =
    document.getElementById("device-list-" + clientId);

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
        data.error || "Ошибка загрузки устройств"
      );
    }


    if (data.devices.length === 0) {

      list.innerHTML =
        '<div style="color:#888;">Устройств пока нет</div>';

      return;

    }


    list.innerHTML = "";

    data.devices.forEach(device => {

      const item = document.createElement("div");

      item.style.background = "#222";
item.style.padding = "10px";
item.style.margin = "6px 0";
item.style.borderRadius = "8px";

      item.innerHTML =
  "<b>📱 " +
  escapeHtml(device.device_name) +
  "</b>" +

  "<br>" +

  '<span style="font-size:13px;color:#aaa;">' +
  "ID: " +
  escapeHtml(device.device_id) +
  "</span>" +

  "<br>" +

  '<span style="font-size:12px;color:#777;">' +
  "Последняя активность: " +
  (
    device.last_seen
      ? new Date(device.last_seen).toLocaleString()
      : "нет"
  ) +
  "</span>" +

  "<br>" +

  '<button type="button" style="margin-top:6px;" ' +
  'onclick="deleteDevice(' +
  device.id +
  "," +
  clientId +
  ')">' +
  "🗑 Удалить" +
  "</button>";

      list.appendChild(item);

    });

  } catch (error) {

    console.error(error);

    list.innerHTML =
      "❌ " + error.message;

  }

}

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

    alert("Введите ID устройства");

    return;

  }


  try {

    const response = await fetch(
      "/admin/clients/devices/" + clientId,
      {
        method:"POST",

        headers:{
          "Content-Type":"application/json"
        },

        body:JSON.stringify({
          device_name:
            deviceName || "Устройство",

          device_id:
            deviceId
        })

      }
    );


    const data =
      await response.json();


    if (!response.ok || !data.success) {

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
      "❌ " +
      error.message
    );

  }

}


async function deleteDevice(deviceId, clientId) {

  if (!confirm("Удалить это устройство?")) {
    return;
  }


  try {

    const response = await fetch(
      "/admin/clients/devices/" + deviceId,
      {
        method:"DELETE"
      }
    );


    const data =
      await response.json();


    if (!response.ok || !data.success) {

      throw new Error(
        data.error ||
        "Ошибка удаления устройства"
      );

    }


    await loadDevices(clientId);


  } catch (error) {

    console.error(error);

    alert(
      "❌ " +
      error.message
    );

  }

}


async function deleteClient(id) {

  const card = document.getElementById("client-" + id);

  if (!card) {
    return;
  }

  const clientName =
    card.querySelector("b")?.innerText || "этого клиента";

  if (!confirm("Удалить " + clientName + "?")) {
    return;
  }

  try {

    const response = await fetch(
      "/admin/clients/delete/" + id,
      {
        method: "DELETE"
      }
    );

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(
        data.error || "Ошибка удаления"
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

async function toggleClient(id) {

  const card = document.getElementById("client-" + id);

  if (!card) {
    return;
  }

  const button = card.querySelector(".toggle-button");
  const statusText = card.querySelector(".status-text");

  const oldButtonText = button.innerText;

  button.disabled = true;
  button.innerText = "⏳ Подождите...";

  try {

    const response = await fetch(
      "/admin/clients/toggle/" + id,
      {
        method: "POST"
      }
    );

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(
        data.error || "Ошибка изменения статуса"
      );
    }


    if (data.active) {

      card.dataset.active = "true";

      statusText.innerText = "🟢 Активен";

      button.innerText = "🔴 Заблокировать";

    } else {

      card.dataset.active = "false";

      statusText.innerText = "🔴 Заблокирован";

      button.innerText = "🟢 Активировать";

    }


    button.disabled = false;

  } catch (error) {

    console.error(error);

    button.innerText = oldButtonText;

    button.disabled = false;

    alert(
      "Не удалось изменить статус клиента: " +
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

    res.status(500).send(error.message);

  }

});


// ===============================
// ДОБАВЛЕНИЕ КЛИЕНТА
// ===============================
// ===============================
// РЕДАКТИРОВАНИЕ КЛИЕНТА
// ===============================

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
      return res.status(404).send("Клиент не найден");
    }

    const client = result.rows[0];

    res.send(`
<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1">

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

<form method="POST"
      action="/admin/clients/edit/${client.id}">

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

<a class="back"
   href="/admin/clients">
⬅ Назад к клиентам
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


router.post("/edit/:id", async (req, res) => {

  try {

    const {
      name,
      phone,
      login,
      password
    } = req.body;

    const result = await db.query(
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
      return res.status(404).send("Клиент не найден");
    }

    res.redirect("/admin/clients");

  } catch (error) {

    console.error(error);

    res.status(500).send(error.message);

  }

});

router.delete("/delete/:id", async (req, res) => {

  try {

    const result = await db.query(
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

router.post("/add", async (req, res) => {

  try {

    const {
      name,
      phone,
      login,
      password
    } = req.body;


    const token =
      crypto.randomBytes(24).toString("hex");


    await db.query(
      `
      INSERT INTO clients
      (name, phone, login, password, token, active)
      VALUES ($1, $2, $3, $4, $5, true)
      `,
      [
        name,
        phone,
        login,
        password,
        token
      ]
    );


    res.redirect("/admin/clients");

  } catch (error) {

    console.error(error);

    res.status(500).send(error.message);

  }

});


// ===============================
// АКТИВИРОВАТЬ / ЗАБЛОКИРОВАТЬ
// БЕЗ ПЕРЕЗАГРУЗКИ СТРАНИЦЫ
// ===============================

router.post("/toggle/:id", async (req, res) => {

  try {

    const result = await db.query(
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

// ===============================
// УСТРОЙСТВА КЛИЕНТА
// ===============================

router.get("/devices/:clientId", async (req, res) => {

  try {

    const result = await db.query(
      `
      SELECT id, device_name, device_id, last_seen
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
        error: "device_id обязателен"
      });

    }

    const result = await db.query(
      `
      INSERT INTO devices
      (client_id, device_name, device_id)
      VALUES ($1, $2, $3)
      RETURNING id, client_id, device_name, device_id, last_seen
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
        error: "Такое устройство уже зарегистрировано"
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

    const result = await db.query(
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