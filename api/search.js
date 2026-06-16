// Vision (Claude) identifies the item; SerpAPI Google Shopping returns real
// products with photos, prices, store names and buy links.
export const config = { maxDuration: 30 };

// Sonnet 4.6 — best balance of capability and cost. Bump to 'claude-opus-4-8'
// for max capability, or 'claude-haiku-4-5' for lowest cost.
const MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const SERPAPI_URL = 'https://serpapi.com/search.json';

const VISION_TIMEOUT_MS = 18000;
const SERP_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function anthropicHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };
}

function tryParseJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(cleaned.slice(a, b + 1)); } catch {} }
  return null;
}

function extractText(data) {
  if (!Array.isArray(data?.content)) return '';
  return data.content
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim();
}

// ── Step 1: identify the item with Claude vision ──────────────────────────────
const VISION_SYSTEM = `You are an expert fashion and product analyst. You will be shown a photo of a product.
If any area is circled, highlighted, or annotated, focus ONLY on that specific item.
Respond with ONLY a single valid JSON object and nothing else — no preamble, no explanation, no markdown.

JSON shape:
{
  "itemName": "Complete product name. Include brand if visible, color, material, style. Be very specific.",
  "brand": "Brand name if clearly visible, otherwise empty string",
  "category": "one of: clothing, shoes, bag, jewelry, accessory, home_decor, electronics, beauty, other",
  "description": "Detailed visual description: color, material, cut, fit, distinguishing features, logos",
  "exactSearchQuery": "Best query to find THIS EXACT product to buy. Lead with brand if known. Include color, style, model. 4-8 words.",
  "dupeSearchQuery": "Query for CHEAPER SIMILAR alternatives. Describe the style WITHOUT brand names. 4-6 words.",
  "estimatedPrice": { "min": 0, "max": 0 }
}`;

async function identifyItem(apiKey, imageBase64) {
  let res;
  try {
    res = await fetchWithTimeout(ANTHROPIC_URL, {
      method: 'POST',
      headers: anthropicHeaders(apiKey),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: [{ type: 'text', text: VISION_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
            { type: 'text', text: 'Identify the product in this image and return the JSON.' }
          ]
        }]
      })
    }, VISION_TIMEOUT_MS);
  } catch {
    return { error: 'Vision timed out. Please try again.' };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data?.error?.message || `Vision failed (${res.status})` };
  return { parsed: tryParseJson(extractText(data)) };
}

// ── Step 2: real products via SerpAPI Google Shopping ─────────────────────────
function mapShoppingResult(r) {
  const price = Number(r.extracted_price) || 0;
  const url = r.link || r.product_link || '';
  const imageUrl = r.thumbnail || '';
  let note = '';
  if (r.delivery) note = String(r.delivery);
  else if (r.rating) note = `${r.rating}★${r.reviews ? ` (${r.reviews})` : ''}`;
  return {
    store: String(r.source || 'Shop').trim().slice(0, 40),
    productName: String(r.title || 'Product').trim().slice(0, 140),
    price,
    shipping: 0,
    totalCost: price || 0,
    url,
    imageUrl,
    note: note.slice(0, 60)
  };
}

// One Google Shopping search. cheapest=true sorts low→high (for dupes).
async function shoppingSearch(serpKey, query, { cheapest = false, limit = 8 } = {}) {
  const params = new URLSearchParams({
    engine: 'google_shopping',
    q: query,
    api_key: serpKey,
    gl: 'us',
    hl: 'en',
    num: '40'
  });
  let res;
  try {
    res = await fetchWithTimeout(`${SERPAPI_URL}?${params.toString()}`, {}, SERP_TIMEOUT_MS);
  } catch {
    return [];
  }
  if (!res.ok) { console.error('SerpAPI error', res.status); return []; }
  const data = await res.json().catch(() => ({}));
  let items = (data.shopping_results || [])
    .map(mapShoppingResult)
    // Require a real buy link and a product image — that's the whole point.
    .filter(p => /^https?:\/\//i.test(p.url) && /^https?:\/\//i.test(p.imageUrl));

  // De-dupe by URL.
  const seen = new Set();
  items = items.filter(p => (seen.has(p.url) ? false : (seen.add(p.url), true)));

  if (cheapest) items.sort((a, b) => (a.price || Infinity) - (b.price || Infinity));
  return items.slice(0, limit);
}

// Last-resort link if SerpAPI is unavailable or returns nothing.
function fallbackLink(query) {
  const q = encodeURIComponent(query);
  return [{
    store: 'Google Shopping',
    productName: `Browse listings for "${query}"`,
    url: `https://www.google.com/search?tbm=shop&q=${q}`,
    price: 0, shipping: 0, totalCost: 0, imageUrl: '',
    note: 'Compare prices across every store'
  }];
}

async function trackSearch(itemName, category) {
  try {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!url || !token) return;
    const key = itemName.toLowerCase().trim().replace(/\s+/g, '_').slice(0, 60);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    await fetch(url, { method: 'POST', headers, body: JSON.stringify(['HINCRBY', 'search_counts', key, '1']) });
    const existRes = await fetch(url, { method: 'POST', headers, body: JSON.stringify(['HEXISTS', 'item_meta', key]) });
    const existData = await existRes.json().catch(() => ({}));
    if (!existData.result) {
      await fetch(url, { method: 'POST', headers, body: JSON.stringify(['HSET', 'item_meta', key, JSON.stringify({ name: itemName, category })]) });
    }
  } catch (e) { console.error('KV error (non-fatal):', e); }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { imageBase64, size, details } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' });
    const serpKey = process.env.SERPAPI_KEY;

    // ── Step 1: identify ──────────────────────────────────────────────────────
    const vision = await identifyItem(apiKey, imageBase64);
    if (vision.error) return res.status(500).json({ error: vision.error });
    const parsedItem = vision.parsed;
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

    const sizeSuffix = size ? ` ${size}` : '';
    const detailsSuffix = details ? ` ${details}` : '';
    const exactQuery = (item.exactSearchQuery + sizeSuffix + detailsSuffix).trim();
    const dupeQuery = (item.dupeSearchQuery + sizeSuffix + detailsSuffix).trim();

    // ── Step 2: real products ─────────────────────────────────────────────────
    let exactResults = [];
    let dupeResults = [];
    if (serpKey) {
      [exactResults, dupeResults] = await Promise.all([
        shoppingSearch(serpKey, exactQuery, { limit: 8 }),
        shoppingSearch(serpKey, dupeQuery, { cheapest: true, limit: 8 })
      ]);
    } else {
      console.error('Missing SERPAPI_KEY — returning fallback links');
    }

    if (!exactResults.length) exactResults = fallbackLink(exactQuery);
    if (!dupeResults.length) dupeResults = fallbackLink(dupeQuery);

    await trackSearch(item.itemName, item.category);

    return res.status(200).json({ item, exactResults, dupeResults });

  } catch (error) {
    console.error('Handler error:', error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
}
