// Reports the caller's remaining free searches for today — a read-only peek at
// the same per-IP counter that /api/search increments. Does NOT consume a search.
const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 8);

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const limit = FREE_DAILY_LIMIT;
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;

  // No KV configured → limits aren't enforced; report a full allowance.
  if (!url || !token) return res.status(200).json({ used: 0, limit, remaining: limit });

  try {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const key = `rl:${clientIp(req)}:${day}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['GET', key])
    });
    const d = await r.json().catch(() => ({}));
    const used = Number(d.result) || 0;
    return res.status(200).json({ used, limit, remaining: Math.max(0, limit - used) });
  } catch (e) {
    console.error('usage peek failed:', e);
    return res.status(200).json({ used: 0, limit, remaining: limit });
  }
}
