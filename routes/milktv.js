const express = require("express");
const router = express.Router();
const db = require("../database");

router.post("/start", async (req, res) => {

  try {

    const {
      channel_id,
      client_id,
      device_id
    } = req.body;

    if (!channel_id) {
      return res.status(400).json({
        error: "channel_id обязателен"
      });
    }

    const channel = await db.query(
      `
      SELECT id, name
      FROM channels
      WHERE id = $1
      `,
      [channel_id]
    );

    if (channel.rows.length === 0) {
      return res.status(404).json({
        error: "Канал не найден"
      });
    }

    const result = await db.query(
      `
      INSERT INTO milktv_view_events
      (
        channel_id,
        client_id,
        device_id,
        started_at
      )
      VALUES
      ($1, $2, $3, NOW())
      RETURNING id, channel_id, started_at
      `,
      [
        channel_id,
        client_id || null,
        device_id || null
      ]
    );

    await db.query(
      `
      UPDATE channels
      SET
        milktv_views = milktv_views + 1,
        milktv_last_view = NOW()
      WHERE id = $1
      `,
      [channel_id]
    );

    res.json({
      success: true,
      event: result.rows[0]
    });

  } catch (error) {

    console.error("МИЛК ТВ START:", error);

    res.status(500).json({
      error: error.message
    });

  }

});

module.exports = router;
