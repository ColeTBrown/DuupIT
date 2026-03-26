function tryParseJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(cleaned.slice(a, b + 1)); } catch {} }
  return null;
}

function isLikelyProductUrl(url) {
  if (!url || !url.startsWith('http')) return false;
  const bad = [
    '/search', '/s?', '?q=', '/category', '/categories', '/c/',
    '/collections?', '/browse', 'google.com', 'bing.com',
    'pinterest.com', 'instagram.com', 'youtube.com', 'tiktok.com',
    'reddit.com', 'wikipedia.org', 'facebook.com', 'twitter.com', 'x.com',
    '/blog/', '/news/', '/article', '/guide', '/how-to'
  ];
  return !bad.some(s => url.toLowerCase().includes(s));
}

// Extract text from Anthropic response content blocks
function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(b => b.type === 'text')
    .map(b => b.text || '')
    .join('\n')
    .trim();
}

async function trackSearch(itemName, category) {
  try {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!url || !token) return;
    const key = itemName.toLowerCase().trim().replace(/\s+/g, '_').slice(0, 60);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    await fetch(`${url}/hincrby/search_counts/${encodeURIComponent(key)}/1`, { method: 'POST', headers });
    const existing = await fetch(`${url}/hget/item_meta/${encodeURIComponent(key)}`, { headers });
    const existingData = await existing.json().catch(() => ({}));
    if (!existingData.result) {
      await fetch(`${url}/hset/item_meta`, {
        method: 'POST', headers,
        body: JSON.stringify([key, JSON.stringify({ name: itemName, category })])
      });
    }
  } catch (e) {
    console.error('KV tracking error (non-fatal):', e);
  }
}

// Call Anthropic API with web search enabled
async function claudeSearch(anthropicKey, userPrompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 2048,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 5
      }],
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Anthropic API error (${res.status})`);
  }
  return extractText(data.content);
}

// Call Anthropic API for vision (no web search needed)
async function claudeVision(anthropicKey, imageBase64, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: prompt }
        ]
      }]
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Anthropic vision error (${res.status})`);
  }
  return extractText(data.content);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { imageBase64, size, details } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY — add it in Vercel environment variables' });

    // ── Step 1: Vision — identify the item ────────────────────────────────────
    const visionText = await claudeVision(anthropicKey, imageBase64, `You are an expert fashion and product analyst. Study this image carefully.
If any area is circled, highlighted, or annotated, focus ONLY on that specific item — ignore everything else in the image.

Return ONLY a valid JSON object — no other text, no markdown:
{
  "itemName": "Complete product name. Include brand if visible, color, material, style. Be very specific.",
  "brand": "Brand name if clearly visible in the image, otherwise empty string",
  "category": "one of: clothing, shoes, bag, jewelry, accessory, home_decor, electronics, beauty, other",
  "description": "Detailed visual description: color, material, cut, fit, distinguishing features, any visible logos or hardware",
  "exactSearchQuery": "Precise search query to find THIS EXACT product for sale online. If brand is known, lead with it. Include color, style, model name if visible.",
  "dupeSearchQuery": "Search query to find CHEAPER SIMILAR alternatives. Describe the style WITHOUT any brand names. Focus on visual look, silhouette, color, material.",
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
    const detailsSuffix = details ? `. Extra requirements: ${details}` : '';
    const maxPrice = item.estimatedPrice.max || 150;

    // ── Step 2: Exact + dupe searches in parallel ─────────────────────────────
    const exactPrompt = `Search the web for places to buy: "${item.exactSearchQuery}${sizeSuffix}${detailsSuffix}"

Use web search to find 4-5 real current listings where someone can buy this exact item right now. Check multiple retailers.

Return ONLY this JSON — no other text:
{
  "results": [
    {
      "store": "Retailer name",
      "productName": "Exact product title from the page",
      "price": 49.99,
      "url": "https://direct-product-page-url",
      "note": "shipping info, return policy, availability"
    }
  ]
}

Rules:
- Only URLs to actual product pages (not search results pages)
- Only currently available/in-stock items
- Include the real price shown on the listing
- Sort cheapest first`;

    const dupePrompt = `Search the web for cheaper alternatives to: "${item.dupeSearchQuery}${sizeSuffix}${detailsSuffix}"

Use web search to find 4-6 affordable similar products under $${Math.round(maxPrice * 0.6)}. These should look similar but cost less${item.brand ? ` — do NOT include ${item.brand} brand products` : ''}.

Return ONLY this JSON — no other text:
{
  "results": [
    {
      "store": "Retailer name",
      "productName": "Exact product title from the page",
      "price": 24.99,
      "url": "https://direct-product-page-url",
      "note": "why it's a good dupe, shipping info"
    }
  ]
}

Rules:
- Only URLs to actual product pages (not search results pages)
- Only currently available/in-stock items
- Include the real price shown on the listing
- Sort cheapest first`;

    const [exactText, dupeText] = await Promise.all([
      claudeSearch(anthropicKey, exactPrompt),
      claudeSearch(anthropicKey, dupePrompt)
    ]);

    const cleanResults = (raw) =>
      (Array.isArray(raw?.results) ? raw.results : [])
        .filter(r => r?.productName && r?.store && isLikelyProductUrl(r?.url))
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

    const exactResults = cleanResults(tryParseJson(exactText));
    const dupeResults = cleanResults(tryParseJson(dupeText));

    trackSearch(item.itemName, item.category);

    return res.status(200).json({ item, exactResults, dupeResults });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
}
