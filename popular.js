import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Get all search counts
    const counts = await kv.hgetall('search_counts');
    const metas = await kv.hgetall('item_meta');

    if (!counts || Object.keys(counts).length === 0) {
      return res.status(200).json({ items: [] });
    }

    // Sort by count descending, take top 20
    const items = Object.entries(counts)
      .map(([key, count]) => {
        let meta = { name: key.replace('item:', ''), category: 'other' };
        try {
          if (metas?.[key]) meta = JSON.parse(metas[key]);
        } catch {}
        return { ...meta, count: Number(count) };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    return res.status(200).json({ items });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
}
