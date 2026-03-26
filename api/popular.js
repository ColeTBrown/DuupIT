const FALLBACK_TRENDING = [
  { name: 'Oversized blazer', category: 'clothing', count: 0 },
  { name: 'Linen wide-leg pants', category: 'clothing', count: 0 },
  { name: 'Mini shoulder bag', category: 'bag', count: 0 },
  { name: 'Platform mary jane shoes', category: 'shoes', count: 0 },
  { name: 'Gold hoop earrings', category: 'jewelry', count: 0 },
  { name: 'Ribbed tank top', category: 'clothing', count: 0 },
  { name: 'Leather tote bag', category: 'bag', count: 0 },
  { name: 'Ballet flats', category: 'shoes', count: 0 },
  { name: 'Chunky knit cardigan', category: 'clothing', count: 0 },
  { name: 'Silk slip dress', category: 'clothing', count: 0 },
];

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;

    // If KV not configured, return fallback trending items
    if (!kvUrl || !kvToken) {
      return res.status(200).json({ items: FALLBACK_TRENDING, source: 'fallback' });
    }

    const headers = { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' };

    // Fetch counts and metadata using Upstash REST API command format
    const [countsRes, metasRes] = await Promise.all([
      fetch(kvUrl, { method: 'POST', headers, body: JSON.stringify(['HGETALL', 'search_counts']) }),
      fetch(kvUrl, { method: 'POST', headers, body: JSON.stringify(['HGETALL', 'item_meta']) })
    ]);

    const countsData = await countsRes.json().catch(() => ({}));
    const metasData = await metasRes.json().catch(() => ({}));

    // Upstash HGETALL returns a flat array [key, val, key, val, ...]
    // Convert to object
    const toObject = (arr) => {
      if (!Array.isArray(arr)) return null;
      const obj = {};
      for (let i = 0; i < arr.length; i += 2) obj[arr[i]] = arr[i + 1];
      return obj;
    };

    const counts = toObject(countsData.result);
    const metas = toObject(metasData.result);

    // No real searches yet — return fallback
    if (!counts || Object.keys(counts).length === 0) {
      return res.status(200).json({ items: FALLBACK_TRENDING, source: 'fallback' });
    }

    // Build sorted list from real data
    const items = Object.entries(counts)
      .map(([key, count]) => {
        let meta = { name: key.replace(/_/g, ' '), category: 'other' };
        try {
          if (metas?.[key]) meta = JSON.parse(metas[key]);
        } catch {}
        return { ...meta, count: Number(count) };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    return res.status(200).json({ items, source: 'live' });
  } catch (error) {
    console.error(error);
    // On any error, return fallback so the page never breaks
    return res.status(200).json({ items: FALLBACK_TRENDING, source: 'fallback' });
  }
}
