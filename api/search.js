function getResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (Array.isArray(data?.output)) {
    const texts = [];
    for (const item of data.output) {
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === 'string' && part.text.trim()) texts.push(part.text.trim());
        }
      }
    }
    if (texts.length) return texts.join('\n');
  }
  return '';
}

function tryParseJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)); } catch {}
  }
  return null;
}

async function fetchProductImage(url) {
  if (!url || !url.startsWith('http')) return '';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });
    clearTimeout(timeout);
    if (!res.ok) return '';
    const reader = res.body.getReader();
    let html = '';
    let bytesRead = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
      bytesRead += value.length;
      if (bytesRead >= 50000) { reader.cancel(); break; }
    }
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch?.[1]?.startsWith('http')) return ogMatch[1];
    const twMatch = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
    if (twMatch?.[1]?.startsWith('http')) return twMatch[1];
    return '';
  } catch { return ''; }
}

// Track search in Vercel KV — completely optional, silently skipped if KV not configured
async function trackSearch(itemName, category) {
  try {
    // Only attempt if KV env vars are present
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return;
    const { kv } = await import('@vercel/kv');
    const key = `item:${itemName.toLowerCase().trim()}`;
    await kv.hincrby('search_counts', key, 1);
    const existing = await kv.hget('item_meta', key);
    if (!existing) {
      await kv.hset('item_meta', { [key]: JSON.stringify({ name: itemName, category }) });
    }
  } catch (e) {
    console.error('KV tracking error (non-fatal):', e);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { imageBase64, size, details } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });

    // Step 1: identify the item
    const visionRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        input: [{
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Identify the MAIN product in this image. If part of the image is circled or highlighted, focus ONLY on that circled item.

Return ONLY valid JSON:
{
  "itemName": "specific item name",
  "category": "clothing",
  "description": "short visual description",
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4"],
  "estimatedPrice": { "min": 20, "max": 100 }
}

Allowed categories: clothing, shoes, bag, jewelry, accessory, home_decor, electronics, beauty, other`
            },
            { type: 'input_image', image_url: `data:image/jpeg;base64,${imageBase64}` }
          ]
        }]
      })
    });

    const visionData = await visionRes.json().catch(() => ({}));
    if (!visionRes.ok) {
      return res.status(500).json({ error: visionData?.error?.message || `Vision failed (${visionRes.status})` });
    }

    const parsedItem = tryParseJson(getResponseText(visionData));
    if (!parsedItem?.itemName) {
      return res.status(500).json({ error: 'Could not identify item in photo. Try a clearer image.' });
    }

    const item = {
      itemName: String(parsedItem.itemName).trim(),
      category: String(parsedItem.category || 'other').trim(),
      description: String(parsedItem.description || '').trim(),
      keywords: Array.isArray(parsedItem.keywords)
        ? parsedItem.keywords.map(k => String(k).trim()).filter(Boolean).slice(0, 6) : [],
      estimatedPrice: {
        min: Number(parsedItem?.estimatedPrice?.min || 0),
        max: Number(parsedItem?.estimatedPrice?.max || 0)
      }
    };

    const sizeClause = size ? `\nSize needed: ${size} — only include listings available in this size.` : '';
    const detailsClause = details ? `\nAdditional preferences: ${details}` : '';

    // Step 2: search listings
    const searchRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        tools: [{ type: 'web_search' }],
        input: `Find 5 to 7 real current product listings for this item.

Item: ${item.itemName}
Category: ${item.category}
Description: ${item.description}
Keywords: ${item.keywords.join(', ')}
Price range: $${item.estimatedPrice.min}–$${item.estimatedPrice.max}${sizeClause}${detailsClause}

Rules:
- Real listings only, direct product page URLs (not search pages)
- Include price and shipping (use 0 if unknown, note it)
- totalCost = price + shipping

Return ONLY valid JSON:
{
  "results": [
    {
      "store": "Store name",
      "productName": "Exact product title",
      "price": 29.99,
      "shipping": 0,
      "totalCost": 29.99,
      "url": "https://example.com/product",
      "note": "Free returns · In stock"
    }
  ]
}`
      })
    });

    const searchData = await searchRes.json().catch(() => ({}));
    if (!searchRes.ok) {
      return res.status(500).json({ error: searchData?.error?.message || `Search failed (${searchRes.status})` });
    }

    const parsedResults = tryParseJson(getResponseText(searchData));
    let results = Array.isArray(parsedResults?.results) ? parsedResults.results : [];

    results = results
      .filter(r => r?.productName && r?.store)
      .map(r => {
        const price = Number(r.price || 0);
        const shipping = Number(r.shipping || 0);
        return {
          store: String(r.store).trim(),
          productName: String(r.productName).trim(),
          price, shipping,
          totalCost: Number(r.totalCost ?? (price + shipping)),
          url: String(r.url || '').trim(),
          imageUrl: '',
          note: String(r.note || '').trim()
        };
      })
      .sort((a, b) => a.totalCost - b.totalCost)
      .slice(0, 7);

    // Step 3: fetch real product images in parallel
    await Promise.all(results.map(async r => {
      if (r.url?.startsWith('http')) r.imageUrl = await fetchProductImage(r.url);
    }));

    // Step 4: track search (non-blocking, non-fatal)
    trackSearch(item.itemName, item.category);

    return res.status(200).json({ item, results });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
}
