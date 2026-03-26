function getResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
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
  const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(cleaned.slice(a, b + 1)); } catch {} }
  return null;
}

// Validate a URL looks like a real product page (not a search/category/blog page)
function isLikelyProductUrl(url) {
  if (!url || !url.startsWith('http')) return false;
  const bad = [
    '/search', '/s?', '?q=', '/category', '/categories', '/c/',
    '/collections', '/browse', '/listing?', 'google.com', 'bing.com',
    'pinterest.com', 'instagram.com', 'youtube.com', 'tiktok.com',
    'reddit.com', 'wikipedia.org', 'facebook.com', 'twitter.com',
    '/blog/', '/news/', '/article', '/guide', '/how-to'
  ];
  return !bad.some(s => url.toLowerCase().includes(s));
}

// Track search using Vercel KV REST API directly — no npm package needed
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

// Run one search pass with web_search tool, with strict instructions
async function runSearch(apiKey, systemPrompt, userPrompt) {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4.1',
      tools: [{ type: 'web_search_preview' }],
      tool_choice: { type: 'web_search_preview' },
      instructions: systemPrompt,
      input: userPrompt
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Search request failed (${res.status})`);
  return getResponseText(data);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { imageBase64, size, details } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });

    // ── Step 1: Vision — identify the item ────────────────────────────────────
    const visionRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `You are an expert fashion and product analyst. Study this image carefully.
If any area is circled, highlighted, or annotated, focus ONLY on that specific item — ignore everything else.

Return ONLY a valid JSON object, no other text:
{
  "itemName": "Complete descriptive product name. Include brand if visible, color, material, and style. Be specific.",
  "brand": "Brand name if clearly visible in the image, otherwise empty string",
  "category": "one of: clothing, shoes, bag, jewelry, accessory, home_decor, electronics, beauty, other",
  "description": "Detailed visual description: color, material, cut, fit, distinguishing features, any visible logos or hardware",
  "exactSearchQuery": "A precise search query to find THIS EXACT product for sale online. If brand is known, lead with it. Include color, style name, model if visible. End with 'buy online'.",
  "dupeSearchQuery": "A search query to find CHEAPER SIMILAR alternatives. Describe the style and look WITHOUT any brand names. Focus on visual characteristics, silhouette, material, color. End with 'affordable'.",
  "estimatedPrice": { "min": 0, "max": 0 }
}`
            },
            { type: 'input_image', image_url: `data:image/jpeg;base64,${imageBase64}` }
          ]
        }]
      })
    });

    const visionData = await visionRes.json().catch(() => ({}));
    if (!visionRes.ok) return res.status(500).json({ error: visionData?.error?.message || `Vision failed (${visionRes.status})` });

    const parsedItem = tryParseJson(getResponseText(visionData));
    if (!parsedItem?.itemName) return res.status(500).json({ error: 'Could not identify item. Try a clearer photo with better lighting.' });

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
    const detailsSuffix = details ? `. Additional requirements: ${details}` : '';

    const sharedSystem = `You are a shopping assistant that finds REAL, VERIFIABLE product listings.

CRITICAL RULES — failure to follow these makes your response useless:
1. Every URL you return MUST be a real, working, direct product page URL that you have confirmed exists via web search
2. NEVER invent, guess, or construct URLs — only return URLs you have actually seen in search results
3. NEVER return search page URLs (like amazon.com/s?k=...) — only direct product listing pages
4. Only return products that are currently in stock and available to buy
5. Include the real price shown on the page
6. Return ONLY the JSON object — no explanation, no markdown, no other text`;

    const exactPrompt = `Search the web right now for: "${item.exactSearchQuery}${sizeSuffix}${detailsSuffix}"

Find 4-5 real product listings where someone can buy this item today. Visit the actual pages to confirm they exist.

Return ONLY this JSON:
{
  "results": [
    {
      "store": "retailer name",
      "productName": "exact product title from the page",
      "price": 49.99,
      "url": "https://actual-product-page-url.com/product/...",
      "note": "any useful info like shipping, returns, in stock status"
    }
  ]
}`;

    const dupePrompt = `Search the web right now for: "${item.dupeSearchQuery}${sizeSuffix}${detailsSuffix}"

Find 4-6 real cheaper alternative products — similar style but lower price than $${item.estimatedPrice.max || 100}. Visit the actual pages to confirm they exist. Do NOT include ${item.brand ? `"${item.brand}" brand or` : ''} search page URLs.

Return ONLY this JSON:
{
  "results": [
    {
      "store": "retailer name",
      "productName": "exact product title from the page",
      "price": 24.99,
      "url": "https://actual-product-page-url.com/product/...",
      "note": "any useful info like shipping, returns, similarity to original"
    }
  ]
}`;

    // ── Step 2: Run exact + dupe searches in parallel ─────────────────────────
    const [exactText, dupeText] = await Promise.all([
      runSearch(apiKey, sharedSystem, exactPrompt),
      runSearch(apiKey, sharedSystem, dupePrompt)
    ]);

    const exactParsed = tryParseJson(exactText);
    const dupeParsed = tryParseJson(dupeText);

    const cleanResults = (raw) =>
      (Array.isArray(raw?.results) ? raw.results : [])
        .filter(r => r?.productName && r?.store && isLikelyProductUrl(r.url))
        .map(r => ({
          store: String(r.store).trim(),
          productName: String(r.productName).trim(),
          price: parseFloat(String(r.price || '0').replace(/[^0-9.]/g, '')) || 0,
          shipping: 0,
          totalCost: parseFloat(String(r.price || '0').replace(/[^0-9.]/g, '')) || 0,
          url: String(r.url).trim(),
          imageUrl: '',
          note: String(r.note || '').trim()
        }))
        .sort((a, b) => a.totalCost - b.totalCost)
        .slice(0, 6);

    const exactResults = cleanResults(exactParsed);
    const dupeResults = cleanResults(dupeParsed);

    // Track non-blocking
    trackSearch(item.itemName, item.category);

    return res.status(200).json({ item, exactResults, dupeResults });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
}
