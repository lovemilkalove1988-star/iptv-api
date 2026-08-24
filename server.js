const express = require("express");
const cors = require("cors");
const db = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    status: "online",
    message: "IPTV API is working"
  });
});

app.get("/api/test", (req, res) => {
  res.json({
    message: "API connection successful"
  });
});

app.get("/api/db-test", async (req, res) => {
  try {
    const result = await db.query("SELECT NOW()");
    res.json({
      database: "connected",
      time: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      database: "error",
      message: error.message
    });
  }
});

app.get("/api/channels", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM channels ORDER BY id");
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.get("/channels", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM channels ORDER BY id");

    let html = `
    <html>
    <head>
    <title>IPTV</title>
    <style>
    body {
      background:#111;
      color:white;
      font-family:Arial;
      padding:20px;
    }
    .channel {
      background:#222;
      padding:15px;
      margin:10px;
      border-radius:10px;
    }
    </style>
    </head>
    <body>
    <h1>IPTV Channels</h1>
    `;

    result.rows.forEach(ch => {
      html += `
      <div class="channel">
        <h2>${ch.name}</h2>
        <p>${ch.category}</p>
        <video controls width="400">
          <source src="${ch.url}" type="application/x-mpegURL">
        </video>
      </div>
      `;
    });

    html += "</body></html>";

    res.send(html);

  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.listen(PORT, () => {
  console.log(`IPTV API running on port ${PORT}`);
});
