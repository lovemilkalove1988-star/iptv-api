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

app.listen(PORT, () => {
  console.log(`IPTV API running on port ${PORT}`);
});
