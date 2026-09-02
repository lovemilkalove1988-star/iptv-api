async function switchChannelSource(db, { channelId, fromSourceId, toSourceId, reason, automatic = false }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const channel = (await client.query('SELECT id,url,current_source_id FROM channels WHERE id=$1 FOR UPDATE', [channelId])).rows[0];
    if (!channel) throw new Error('channel_not_found');
    if (Number(channel.current_source_id) === Number(toSourceId)) { await client.query('ROLLBACK'); return { already_recovered: true, channel }; }
    if (Number(channel.current_source_id) !== Number(fromSourceId)) throw new Error('current_source_changed');
    const target = (await client.query('SELECT id,channel_id,url,enabled,status FROM milktv_channel_sources WHERE id=$1 FOR UPDATE', [toSourceId])).rows[0];
    if (!target || Number(target.channel_id) !== Number(channelId) || !target.enabled || target.status !== 'online') throw new Error('target_source_unavailable');
    await client.query('UPDATE channels SET url=$1,current_source_id=$2 WHERE id=$3 AND current_source_id=$4', [target.url, target.id, channelId, fromSourceId]);
    await client.query(`INSERT INTO milktv_source_switch_history(channel_id,from_source_id,to_source_id,reason,automatic,result) VALUES($1,$2,$3,$4,$5,'success')`, [channelId, fromSourceId, toSourceId, reason, automatic === true]);
    await client.query('UPDATE milktv_channel_sources SET enabled=FALSE,updated_at=NOW() WHERE id=$1 AND channel_id=$2', [fromSourceId, channelId]);
    await client.query('COMMIT');
    return { success: true, from_source_id: fromSourceId, to_source_id: toSourceId, target_url: target.url };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
}
module.exports = { switchChannelSource };
