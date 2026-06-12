function tryParseJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(cleaned.slice(a, b + 1)); } catch {} }
  return null;
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

// Build guaranteed-working search URLs for each retailer.
// Used as a fallback when live product search returns nothing.
function buildSearchUrls(exactQuery, dupeQuery) {
  const eq = encodeURIComponent(exactQuery);
  const dq = encodeURIComponent(dupeQuery);

  const exactStores = [
    { store: 'Amazon', productName: `Search Amazon for "${exactQuery}"`, url: `https://www.amazon.com/s?k=${eq}`, note: 'Largest selection, fast shipping' },
    { store: 'eBay', productName: `Search eBay for "${exactQuery}"`, url: `https://www.ebay.com/sch/i.html?_nkw=${eq}`, note: 'New and pre-owned listings' },
    { store: 'Google Shopping', productName: `Search Google Shopping for "${exactQuery}"`, url: `https://www.google.com/search?q=${eq}&tbm=shop`, note: 'Compare prices across all stores' },
    { store: 'Walmart', productName: `Search Walmart for "${exactQuery}"`, url: `https://www.walmart.com/search?q=${eq}`, note: 'Low prices, free pickup' },
    { store: 'Poshmark', productName: `Search Poshmark for "${exactQuery}"`, url: `https://poshmark.com/search?query=${eq}`, note: 'Pre-loved items, great deals' }
  ];

  const dupeStores = [
    { store: 'SHEIN', productName: `Search SHEIN for "${dupeQuery}"`, url: `https://www.shein.com/search?q=${dq}`, note: 'Very affordable alternatives' },
    { store: 'Amazon', productName: `Search Amazon for "${dupeQuery}"`, url: `https://www.amazon.com/s?k=${dq}`, note: 'Budget-friendly options with fast shipping' },
    { store: 'ASOS', productName: `Search ASOS for "${dupeQuery}"`, url: `https://www.asos.com/search/?q=${dq}`, note: 'Trendy affordable fashion' },
    { store: 'H&M', productName: `Search H&M for "${dupeQuery}"`, url: `https://www2.hm.com/en_us/search-results.html?q=${dq}`, note: 'Affordable high-street style' },
    { store: 'Target', productName: `Search Target for "${dupeQuery}"`, url: `https://www.target.com/s?searchTerm=${dq}`, note: 'Affordable everyday fashion' }
  ];

  return { exactStores, dupeStores };
}

// Normalise one product object coming back from the model into the exact
// shape the frontend renders. Drops anything without a usable http(s) link.
function normalizeProducts(arr, fallbackNote) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const p of arr) {
    const url = String(p?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const price = Number(p?.price);
    const shipping = Number(p?.shipping);
    const safePrice = Number.isFinite(price) && price > 0 ? price : 0;
    const safeShip = Number.isFinite(shipping) && shipping >= 0 ? shipping : 0;
    out.push({
      store: String(p?.store || 'Shop').trim().slice(0, 40),
      productName: String(p?.productName || 'Product').trim().slice(0, 140),
      price: safePrice,
      shipping: safeShip,
      totalCost: safePrice ? safePrice + safeShip : 0,
      url,
      imageUrl: /^https?:\/\//i.test(String(p?.imageUrl || '')) ? String(p.imageUrl).trim() : '',
      note: String(p?.note || fallbackNote || '').trim().slice(0, 120)
    });
  }
  return out;
}

// Use OpenAI's hosted web_search tool to find REAL products with live prices,
// images and buy links — for both the exact item and cheaper dupes.
async function findRealProducts(apiKey, item, exactQuery, dupeQuery) {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      tools: [{ type: 'web_search_preview' }],
      tool_choice: 'auto',
      input: [{ role: 'user', content: [{
        type: 'input_text',
        text: `You are a shopping assistant. Use web search to find REAL, currently-buyable products for a shopper in the United States.

ITEM: ${item.itemName}
DESCRIPTION: ${item.description}
EXACT SEARCH: ${exactQuery}
DUPE / STYLE SEARCH: ${dupeQuery}

Find:
1. "exact" — up to 6 listings of the SAME or closest matching product, cheapest total cost first.
2. "dupes" — up to 6 CHEAPER lookalike products in the same style (different/no brand).

Only include products you actually found a real product page for. Use the direct product-page URL (not a search results page). Include a real product image URL when one is available.

Return ONLY a valid JSON object, no other text:
{
  "exact": [
    { "store": "Retailer name", "productName": "Full product title", "price": 0.00, "shipping": 0.00, "url": "https://direct-product-page", "imageUrl": "https://...", "note": "one short detail (e.g. free shipping, on sale)" }
  ],
  "dupes": [ { same fields } ]
}
Use numbers for price/shipping in USD (0 for shipping if free). Sort each array cheapest total first. If you cannot find anything for a list, return it as an empty array.`
      }]}]
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { exact: [], dupes: [] };
  const parsed = tryParseJson(extractText(data)) || {};
  return {
    exact: normalizeProducts(parsed.exact, 'Found via live search'),
    dupes: normalizeProducts(parsed.dupes, 'Cheaper lookalike')
  };
}

async function trackSearch(itemName, category) {
  try {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!url || !token) return;
    const key = itemName.toLowerCase().trim().replace(/\s+/g, '_').slice(0, 60);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify(['HINCRBY', 'search_counts', key, '1'])
    });
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { imageBase64, size, details } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });

    // ── Step 1: Identify item with vision ─────────────────────────────────────
    const visionRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        input: [{ role: 'user', content: [
          {
            type: 'input_text',
            text: `You are an expert fashion and product analyst. Study this image carefully.
If any area is circled, highlighted, or annotated, focus ONLY on that specific item.

Return ONLY a valid JSON object — no other text:
{
  "itemName": "Complete product name. Include brand if visible, color, material, style. Be very specific.",
  "brand": "Brand name if clearly visible, otherwise empty string",
  "category": "one of: clothing, shoes, bag, jewelry, accessory, home_decor, electronics, beauty, other",
  "description": "Detailed visual description: color, material, cut, fit, distinguishing features, logos",
  "exactSearchQuery": "Best search query to find THIS EXACT product. Lead with brand if known. Include color, style, model name. Keep it concise — 4 to 7 words.",
  "dupeSearchQuery": "Search query for CHEAPER SIMILAR alternatives. Describe the style WITHOUT brand names. 4 to 6 words.",
  "estimatedPrice": { "min": 0, "max": 0 }
}`
          },
          { type: 'input_image', image_url: `data:image/jpeg;base64,${imageBase64}` }
        ]}]
      })
    });

    const visionData = await visionRes.json().catch(() => ({}));
    if (!visionRes.ok) return res.status(500).json({ error: visionData?.error?.message || `Vision failed (${visionRes.status})` });

    const parsedItem = tryParseJson(extractText(visionData));
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

    // Append size and details to search queries if provided
    const sizeSuffix = size ? ` ${size}` : '';
    const detailsSuffix = details ? ` ${details}` : '';
    const exactQuery = (item.exactSearchQuery + sizeSuffix + detailsSuffix).trim();
    const dupeQuery = (item.dupeSearchQuery + sizeSuffix + detailsSuffix).trim();

    // ── Step 2: Find real products via web search (with graceful fallback) ─────
    let exactResults = [];
    let dupeResults = [];
    try {
      const live = await findRealProducts(apiKey, item, exactQuery, dupeQuery);
      exactResults = live.exact;
      dupeResults = live.dupes;
    } catch (e) {
      console.error('Live product search failed, using fallback:', e);
    }

    // Backfill with guaranteed-working store search links if live search came up short
    const fallback = buildSearchUrls(exactQuery, dupeQuery);
    if (!exactResults.length) exactResults = fallback.exactStores;
    if (!dupeResults.length) dupeResults = fallback.dupeStores;

    // Record the search for the "Most Popular" tab. Await so the write isn't
    // dropped when the serverless function freezes after responding.
    await trackSearch(item.itemName, item.category);

    return res.status(200).json({
      item,
      exactResults,
      dupeResults
    });

  } catch (error) {
    console.error('Handler error:', error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
}
