function tryParseJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(cleaned.slice(a, b + 1)); } catch {} }
  return null;
}

function isProductUrl(url) {
  if (!url) return false;
  try { new URL(url); } catch { return false; }
  if (!url.startsWith('http')) return false;
  const bad = [
    'google.com', 'bing.com', 'yahoo.com',
    'pinterest.com', 'instagram.com', 'youtube.com', 'tiktok.com',
    'reddit.com', 'wikipedia.org', 'facebook.com', 'twitter.com', 'x.com',
    '/blog/', '/news/', '/article', '/how-to',
    'amazon.com/s?', 'ebay.com/sch/', 'walmart.com/search'
  ];
  return !bad.some(s => url.toLowerCase().includes(s));
}

function extractText(data) {
  if (typeof data?.output_text === 'string') return data.output_text.trim();
  if (Array.isArray(data?.output)) {
    const parts = [];
    for (const item of data.output) {
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === 'string') parts.push(part.text);
        }
      }
    }
    if (parts.length) return parts.join('\n').trim();
  }
  return '';
}

async function trackSearch(itemName, category) {
  try {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!url || !token) return;
    const key = itemName.toLowerCase().trim().replace(/\s+/g, '_').slice(0, 60);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // Upstash REST API uses POST with command array format
    await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify(['HINCRBY', 'search_counts', key, '1'])
    });

    // Check if meta exists then set it
    const existRes = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify(['HEXISTS', 'item_meta', key])
    });
    const existData = await existRes.json().catch(() => ({}));
    if (!existData.result) {
      await fetch(url, {
        method: 'POST', headers,
        body: JSON.stringify(['HSET', 'item_meta', key, JSON.stringify({ name: itemName, category })])
      });
    }
  } catch (e) { console.error('KV error (non-fatal):', e); }
}

async function openAISearch(apiKey, prompt) {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      tools: [{ type: 'web_search' }],
      input: prompt
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI error (${res.status})`);
  return extractText(data);
}

async function openAIVision(apiKey, imageBase64, prompt) {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      input: [{ role: 'user', content: [
        { type: 'input_text', text: prompt },
        { type: 'input_image', image_url: `data:image/jpeg;base64,${imageBase64}` }
      ]}]
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI vision error (${res.status})`);
  return extractText(data);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { imageBase64, size, details } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Missing OPENAI_API_KEY — add it in Vercel environment variables.' });

    // ── Step 1: Identify item ─────────────────────────────────────────────────
    const visionText = await openAIVision(apiKey, imageBase64, `You are an expert fashion and product analyst. Study this image carefully.
If any area is circled, highlighted, or annotated, focus ONLY on that specific item — ignore everything else.

Return ONLY a valid JSON object — no other text, no markdown:
{
  "itemName": "Complete product name including brand if visible, color, material, style. Be very specific.",
  "brand": "Brand name if clearly visible, otherwise empty string",
  "category": "one of: clothing, shoes, bag, jewelry, accessory, home_decor, electronics, beauty, other",
  "description": "Detailed visual description: color, material, cut, fit, distinguishing features, logos",
  "exactSearchQuery": "Best search query to find THIS EXACT product for sale. Lead with brand if known. Include color, style, model name.",
  "dupeSearchQuery": "Search query for CHEAPER SIMILAR alternatives. Describe style WITHOUT brand names.",
  "estimatedPrice": { "min": 0, "max": 0 }
}`);

    const parsedItem = tryParseJson(visionText);
    if (!parsedItem?.itemName) return res.status(500).json({ error: 'Could not identify item. Try a clearer photo.' });

    const item = {
      itemName: String(parsedItem.itemName).trim(),
      brand: String(parsedItem.brand || '').trim(),
      category: String(parsedItem.category || 'other').trim(),
      description: String(parsedItem.description || '').trim(),
      exactSearchQuery: String(parsedItem.exactSearchQuery || parsedItem.itemName).trim(),
      dupeSearchQuery: String(parsedItem.dupeSearchQuery || parsedItem.description).trim(),
      estimatedPrice: {
        min: Number(parsedItem?.estimatedPrice?.min || 0),
        max: Number(parsedItem?.estimatedPrice?.max || 0)
      }
    };

    const sizeSuffix = size ? ` in size ${size}` : '';
    const detailsSuffix = details ? `. User notes: ${details}` : '';
    const dupeMax = Math.round((item.estimatedPrice.max || 150) * 0.65);

    const jsonRule = `Return ONLY a raw JSON object — no markdown, no code fences, no explanation. Start with { end with }.`;

    // ── Step 2: Exact + dupe searches in parallel ─────────────────────────────
    const exactPrompt = `Search the web for: "${item.exactSearchQuery}${sizeSuffix}${detailsSuffix}"

Find 4-5 real current listings to buy this item online now. Use web search for actual results.

${jsonRule}
{
  "results": [
    {
      "store": "Retailer name",
      "productName": "Exact product title from the listing",
      "price": 49.99,
      "url": "https://direct-product-page-url",
      "note": "shipping, availability, return policy"
    }
  ]
}

Rules:
- Only direct product page URLs (amazon.com/dp/... not amazon.com/s?k=...)
- Only in-stock items with a real price
- Sort cheapest first`;

    const dupePrompt = `Search the web for cheaper alternatives to: "${item.dupeSearchQuery}${sizeSuffix}${detailsSuffix}"

Find 4-6 similar products under $${dupeMax}${item.brand ? ` — NOT ${item.brand} brand` : ''}. Use web search for actual results.

${jsonRule}
{
  "results": [
    {
      "store": "Retailer name",
      "productName": "Exact product title from the listing",
      "price": 19.99,
      "url": "https://direct-product-page-url",
      "note": "why it's a good dupe, shipping info"
    }
  ]
}

Rules:
- Only direct product page URLs (not search pages)
- Only in-stock items with a real price
- Sort cheapest first`;

    const [exactText, dupeText] = await Promise.all([
      openAISearch(apiKey, exactPrompt),
      openAISearch(apiKey, dupePrompt)
    ]);

    const cleanResults = (raw) => {
      const parsed = tryParseJson(raw);
      if (!Array.isArray(parsed?.results)) return [];
      return parsed.results
        .filter(r => r?.productName && r?.store && isProductUrl(r?.url))
        .map(r => ({
          store: String(r.store).trim(),
          productName: String(r.productName).trim(),
          price: parseFloat(String(r.price || '0').replace(/[^0-9.]/g, '')) || 0,
          shipping: 0,
          totalCost: parseFloat(String(r.price || '0').replace(/[^0-9.]/g, '')) || 0,
          url: String(r.url || '').trim(),
          imageUrl: '',
          note: String(r.note || '').trim()
        }))
        .sort((a, b) => a.totalCost - b.totalCost)
        .slice(0, 6);
    };

    const exactResults = cleanResults(exactText);
    const dupeResults = cleanResults(dupeText);

    trackSearch(item.itemName, item.category);

    return res.status(200).json({ item, exactResults, dupeResults });

  } catch (error) {
    console.error('Handler error:', error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
}
