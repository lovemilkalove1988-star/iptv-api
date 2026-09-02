const express = require("express");
const router = express.Router();
const db = require("../database");

router.get("/", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        id,
        name,
        url,
        category,
        status,
        http_status,
        response_time,
        hls_ok,
        stability_score,
        source_score,
        rejection_reason,
        created_at,
        checked_at
      FROM channel_candidates
      ORDER BY
        CASE status
          WHEN 'pending' THEN 1
          WHEN 'approved' THEN 2
          WHEN 'rejected' THEN 3
          ELSE 4
        END,
        source_score DESC,
        created_at DESC
    `);

    res.json(result.rows);

  } catch (error) {
    console.error("CANDIDATES GET ERROR:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


router.post("/:id/reject", async (req, res) => {
  try {
    const result = await db.query(`
      UPDATE channel_candidates
      SET
        status = 'rejected',
        rejection_reason = $1
      WHERE id = $2
      RETURNING *
    `, [
      req.body.reason || "Отклонён администратором",
      req.params.id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Кандидат не найден"
      });
    }

    res.json({
      success: true,
      candidate: result.rows[0]
    });

  } catch (error) {
    console.error("CANDIDATE REJECT ERROR:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


router.post("/:id/approve", async (req, res) => {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const candidateResult = await client.query(`
      SELECT *
      FROM channel_candidates
      WHERE id = $1
      FOR UPDATE
    `, [req.params.id]);

    if (candidateResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        error: "Кандидат не найден"
      });
    }

    const candidate = candidateResult.rows[0];

    const channelResult = await client.query(`
      INSERT INTO channels (
        name,
        url,
        category
      )
      VALUES ($1, $2, $3)
      ON CONFLICT (url)
      DO UPDATE SET
        name = EXCLUDED.name,
        category = COALESCE(EXCLUDED.category, channels.category)
      RETURNING id
    `, [
      candidate.name,
      candidate.url,
      candidate.category
    ]);

    const channelId = channelResult.rows[0].id;

    await client.query(`
      INSERT INTO channel_sources (
        channel_id,
        url,
        source_type,
        status
      )
      VALUES ($1, $2, 'primary', 'unknown')
      ON CONFLICT DO NOTHING
    `, [
      channelId,
      candidate.url
    ]);

    await client.query(`
      UPDATE channel_candidates
      SET
        status = 'approved',
        rejection_reason = NULL
      WHERE id = $1
    `, [candidate.id]);

    await client.query("COMMIT");

    res.json({
      success: true,
      channel_id: channelId
    });

  } catch (error) {

    await client.query("ROLLBACK");

    console.error("CANDIDATE APPROVE ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });

  } finally {
    client.release();
  }
});


router.post("/:id/check", async (req, res) => {
  try {

    const candidateResult = await db.query(`
      SELECT id, url
      FROM channel_candidates
      WHERE id = $1
    `, [req.params.id]);

    if (candidateResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Кандидат не найден"
      });
    }

    const candidate = candidateResult.rows[0];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    const started = Date.now();

    try {

      const response = await fetch(candidate.url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "*/*"
        }
      });

      const responseTime = Date.now() - started;
      const text = await response.text();

      clearTimeout(timer);

      const trimmed = text.trim();

      const hlsOk =
        response.ok &&
        trimmed.includes("#EXTM3U") &&
        (
          trimmed.includes("#EXTINF") ||
          trimmed.includes("#EXT-X-STREAM-INF") ||
          trimmed.includes("#EXT-X-TARGETDURATION")
        );

      const status = hlsOk
        ? "working"
        : "failed";

      const sourceScore = hlsOk
        ? Math.max(1, Math.min(100, 100 - Math.floor(responseTime / 100)))
        : 0;

      const updated = await db.query(`
        UPDATE channel_candidates
        SET
          status = CASE
            WHEN status = 'rejected' THEN 'rejected'
            WHEN status = 'approved' THEN 'approved'
            ELSE $1
          END,
          http_status = $2,
          response_time = $3,
          hls_ok = $4,
          source_score = $5,
          checked_at = NOW()
        WHERE id = $6
        RETURNING *
      `, [
        status,
        response.status,
        responseTime,
        hlsOk,
        sourceScore,
        candidate.id
      ]);

      return res.json({
        success: true,
        candidate: updated.rows[0]
      });

    } catch (error) {

      clearTimeout(timer);

      const updated = await db.query(`
        UPDATE channel_candidates
        SET
          status = CASE
            WHEN status = 'rejected' THEN 'rejected'
            WHEN status = 'approved' THEN 'approved'
            ELSE 'failed'
          END,
          http_status = NULL,
          response_time = NULL,
          hls_ok = false,
          source_score = 0,
          checked_at = NOW(),
          rejection_reason = $1
        WHERE id = $2
        RETURNING *
      `, [
        error.name === "AbortError" ? "TIMEOUT" : error.message,
        candidate.id
      ]);

      return res.json({
        success: true,
        candidate: updated.rows[0]
      });
    }

  } catch (error) {

    console.error("CANDIDATE CHECK ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


module.exports = router;
