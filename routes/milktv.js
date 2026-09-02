const express = require("express");
const router = express.Router();
const db = require("../database");
const crypto = require("crypto");

function getSessionClientId(req) {
  const clientId = Number(req.session?.client?.id);

  return Number.isInteger(clientId) && clientId > 0
    ? clientId
    : null;
}

function requireClient(req, res) {
  const id = getSessionClientId(req);
  if (!id) { res.status(401).json({ success: false, error: "Client authentication required" }); return null; }
  return id;
}
function requireCsrf(req, res) {
  const supplied = req.get("X-CSRF-Token") || req.body?._csrf;
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  if (typeof supplied !== "string" || supplied !== req.session.csrfToken) { res.status(403).json({ success: false, error: "CSRF token required" }); return false; }
  return true;
}
function reminderDeviceKey(req) { return String(req.get("X-MILKTV-DEVICE") || req.sessionID || "session").slice(0, 128); }

router.get("/epg/reminders/csrf", (req, res) => {
  if (!getSessionClientId(req)) return res.status(401).json({ success: false, error: "Client authentication required" });
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  res.json({ success: true, token: req.session.csrfToken });
});

router.get("/epg/reminders", async (req, res) => {
  const clientId = requireClient(req, res); if (!clientId) return;
  try { const q = await db.query("SELECT id,channel_id,programme_key,programme_start_at,programme_title,created_at,cancelled_at,completed_at,status FROM milktv_epg_reminders WHERE client_id=$1 ORDER BY programme_start_at", [clientId]); res.json({ success: true, reminders: q.rows }); }
  catch (e) { res.status(500).json({ success: false, error: "Reminders unavailable" }); }
});

router.post("/epg/reminders", async (req, res) => {
  const clientId = requireClient(req, res); if (!clientId || !requireCsrf(req, res)) return;
  const channelId = Number(req.body?.channel_id), key = String(req.body?.programme_key || "").trim();
  if (!Number.isInteger(channelId) || channelId <= 0 || !key) return res.status(400).json({ success: false, error: "Invalid programme" });
  try {
    const p = await db.query("SELECT p.programme_key,p.start_at,p.title FROM milktv_epg_programmes p WHERE p.channel_id=$1 AND p.programme_key=$2 AND p.start_at>NOW()", [channelId, key]);
    if (!p.rows.length) return res.status(400).json({ success: false, error: "Programme is not available or already started" });
    const r = await db.query("INSERT INTO milktv_epg_reminders(client_id,channel_id,programme_key,programme_start_at,programme_title) VALUES($1,$2,$3,$4,$5) ON CONFLICT(client_id,channel_id,programme_key) DO UPDATE SET status=CASE WHEN milktv_epg_reminders.status IN ('cancelled','expired','unavailable') THEN 'active' ELSE milktv_epg_reminders.status END,programme_start_at=EXCLUDED.programme_start_at,programme_title=EXCLUDED.programme_title,cancelled_at=NULL,completed_at=CASE WHEN milktv_epg_reminders.status IN ('cancelled','expired','unavailable') THEN NULL ELSE milktv_epg_reminders.completed_at END RETURNING *", [clientId, channelId, key, p.rows[0].start_at, p.rows[0].title]);
    res.json({ success: true, reminder: r.rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: "Reminder could not be created" }); }
});

router.delete("/epg/reminders/:id", async (req, res) => {
  const clientId = requireClient(req, res); if (!clientId || !requireCsrf(req, res)) return;
  try { const q = await db.query("UPDATE milktv_epg_reminders SET status='cancelled',cancelled_at=NOW() WHERE id=$1 AND client_id=$2 RETURNING id", [Number(req.params.id), clientId]); if (!q.rows.length) return res.status(404).json({ success: false, error: "Reminder not found" }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ success: false, error: "Reminder could not be cancelled" }); }
});

router.get("/epg/reminders/due", async (req, res) => {
  const clientId = requireClient(req, res); if (!clientId) return;
  const device = reminderDeviceKey(req);
  try {
    await db.query("UPDATE milktv_epg_reminders r SET status='unavailable' WHERE r.client_id=$1 AND r.status='active' AND NOT EXISTS (SELECT 1 FROM milktv_epg_programmes p WHERE p.channel_id=r.channel_id AND p.programme_key=r.programme_key)", [clientId]);
    await db.query("UPDATE milktv_epg_reminders r SET status='expired',completed_at=COALESCE(completed_at,NOW()) FROM milktv_epg_programmes p WHERE r.client_id=$1 AND r.status='active' AND p.channel_id=r.channel_id AND p.programme_key=r.programme_key AND p.stop_at<=NOW()", [clientId]);
    const q = await db.query("SELECT r.id AS reminder_id,r.channel_id,c.name AS channel_name,r.programme_key,p.title AS programme_title,p.start_at,EXTRACT(EPOCH FROM (p.start_at-NOW()))::int AS seconds_until_start FROM milktv_epg_reminders r JOIN channels c ON c.id=r.channel_id JOIN milktv_epg_programmes p ON p.channel_id=r.channel_id AND p.programme_key=r.programme_key LEFT JOIN milktv_epg_reminder_deliveries d ON d.reminder_id=r.id AND d.device_key=$2 WHERE r.client_id=$1 AND r.status='active' AND d.completed_at IS NULL AND p.start_at BETWEEN NOW()+INTERVAL '5 seconds' AND NOW()+INTERVAL '35 seconds' ORDER BY p.start_at", [clientId, device]);
    res.json({ success: true, reminders: q.rows });
  } catch (e) { res.status(500).json({ success: false, error: "Due reminders unavailable" }); }
});

router.post("/epg/reminders/:id/delivered", async (req, res) => {
  const clientId = requireClient(req, res); if (!clientId || !requireCsrf(req, res)) return;
  try { const q = await db.query("INSERT INTO milktv_epg_reminder_deliveries(reminder_id,device_key,delivered_at,completed_at) SELECT id,$3,NOW(),NOW() FROM milktv_epg_reminders WHERE id=$1 AND client_id=$2 ON CONFLICT(reminder_id,device_key) DO UPDATE SET delivered_at=COALESCE(milktv_epg_reminder_deliveries.delivered_at,NOW()),completed_at=COALESCE(milktv_epg_reminder_deliveries.completed_at,NOW()) RETURNING reminder_id", [Number(req.params.id), clientId, reminderDeviceKey(req)]); if (!q.rows.length) return res.status(404).json({ success: false, error: "Reminder not found" }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ success: false, error: "Delivery state unavailable" }); }
});

router.post("/start", async (req, res) => {

  try {

    const {
      channel_id
    } = req.body;
    const clientId = getSessionClientId(req);

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
        clientId,
        null
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

router.post("/stop", async (req, res) => {

  try {

    const {
      channel_id,
      event_id
    } = req.body;
    const clientId = getSessionClientId(req);
    const eventId = Number(event_id);

    if (!channel_id) {
      return res.status(400).json({
        error: "channel_id обязателен"
      });
    }

    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({
        error: "Некорректный event_id"
      });
    }

    const result = await db.query(
      `
      SELECT
        id,
        started_at
      FROM milktv_view_events
      WHERE channel_id = $1
        AND id = $2::bigint
        AND client_id IS NOT DISTINCT FROM $3::integer
        AND stopped_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1
      `,
      [
        channel_id,
        eventId,
        clientId
      ]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        message: "Активный просмотр не найден"
      });
    }

    const event = result.rows[0];

    const update = await db.query(
      `
      UPDATE milktv_view_events
      SET
        stopped_at = NOW(),
        duration_seconds =
          GREATEST(
            0,
            EXTRACT(
              EPOCH FROM (NOW() - started_at)
            )::integer
          )
      WHERE id = $1
      RETURNING
        id,
        channel_id,
        started_at,
        stopped_at,
        duration_seconds
      `,
      [event.id]
    );

    res.json({
      success: true,
      event: update.rows[0]
    });

  } catch (error) {

    console.error("МИЛК ТВ STOP:", error);

    res.status(500).json({
      error: error.message
    });

  }

});

module.exports = router;
