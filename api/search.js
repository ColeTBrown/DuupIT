// Allow extra time for web search + validating/scraping product pages.
export const config = { maxDuration: 60 };

// Sonnet 4.6 — best balance of capability and cost for vision + web search.
// Bump to 'claude-opus-4-8' for max capability, or drop to 'claude-haiku-4-5'
// for the lowest cost on simpler tasks.
const MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

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

// Concatenate the text blocks from an Anthropic Messages response.
function extractText(data) {
  if (!Array.isArray(data?.content)) return '';
  return data.content
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim();
}

// ── HTML meta scraping ────────────────────────────────────────────────────────
function metaContent(html, names) {
  for (const name of names) {
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${name}["']`, 'i');
    const m = html.match(re1) || html.match(re2);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

function absUrl(maybe, base) {
  if (!maybe) return '';
  try { return new URL(maybe, base).href; } catch { return ''; }
}

function scrapePrice(html) {
  const meta = metaContent(html, ['product:price:amount', 'og:price:amount']);
  if (meta && Number(meta) > 0) return Number(meta);
  const ld = html.match(/"price"\s*:\s*"?(\d+(?:\.\d{1,2})?)"?/i);
  if (ld && Number(ld[1]) > 0) return Number(ld[1]);
  const low = html.match(/"lowPrice"\s*:\s*"?(\d+(?:\.\d{1,2})?)"?/i);
  if (low && Number(low[1]) > 0) return Number(low[1]);
  return 0;
}

// Fetch a product page: confirm it's live, and scrape its image/title/price.
// Returns null when the link is dead (404/410/gone/unreachable).
async function validateAndEnrich(p) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(p.url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' }
    });

    if (res.status === 404 || res.status === 410 || res.status === 451 || res.status >= 500) return null;

    const finalUrl = res.url || p.url;

    if (res.status === 401 || res.status === 403 || res.status === 429) {
      return p.imageUrl ? { ...p, url: finalUrl } : null;
    }

    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('html')) {
      return p.imageUrl ? { ...p, url: finalUrl } : null;
    }

    const full = await res.text();
    const html = full.slice(0, 250000);

    const img = absUrl(metaContent(html, ['og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']), finalUrl);
    const title = metaContent(html, ['og:title', 'twitter:title']);
    const scrapedPrice = scrapePrice(html);

    const imageUrl = (img && /^https?:\/\//i.test(img)) ? img : p.imageUrl;
    if (!imageUrl) return null; // require a preview image

    const price = scrapedPrice > 0 ? scrapedPrice : p.price;
    return {
      ...p,
      url: finalUrl,
      imageUrl,
      productName: title ? title.slice(0, 140) : p.productName,
      price,
      totalCost: price ? price + (p.shipping || 0) : 0
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function enrichList(products, keep) {
  const survivors = [];
  const pool = 6;
  let idx = 0;
  async function worker() {
    while (idx < products.length && survivors.length < keep) {
      const mine = products[idx++];
      const ok = await validateAndEnrich(mine);
      if (ok) survivors.push(ok);
    }
  }
  await Promise.all(Array.from({ length: Math.min(pool, products.length) }, worker));
  survivors.sort((a, b) => (a.totalCost || Infinity) - (b.totalCost || Infinity));
  return survivors;
}

function normalizeCandidates(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const p of arr) {
    const url = String(p?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    let host;
    try { host = new URL(url).host; } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    const price = Number(p?.price);
    const shipping = Number(p?.shipping);
    const safePrice = Number.isFinite(price) && price > 0 ? price : 0;
    const safeShip = Number.isFinite(shipping) && shipping >= 0 ? shipping : 0;
    out.push({
      store: String(p?.store || host.replace(/^www\./, '')).trim().slice(0, 40),
      productName: String(p?.productName || 'Product').trim().slice(0, 140),
      price: safePrice,
      shipping: safeShip,
      totalCost: safePrice ? safePrice + safeShip : 0,
      url,
      imageUrl: /^https?:\/\//i.test(String(p?.imageUrl || '')) ? String(p.imageUrl).trim() : '',
      note: String(p?.note || '').trim().slice(0, 120)
    });
  }
  return out;
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
  "exactSearchQuery": "Best query to find THIS EXACT product. Lead with brand if known. Include color, style, model. 4-7 words.",
  "dupeSearchQuery": "Query for CHEAPER SIMILAR alternatives. Describe the style WITHOUT brand names. 4-6 words.",
  "estimatedPrice": { "min": 0, "max": 0 }
}`;

async function identifyItem(apiKey, imageBase64) {
  const res = await fetch(ANTHROPIC_URL, {
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
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { error: data?.error?.message || `Vision failed (${res.status})` };
  }
  return { parsed: tryParseJson(extractText(data)) };
}

// ── Step 2: find candidate products anywhere on the web (Claude web search) ────
const SEARCH_SYSTEM = `You are a shopping researcher with a web search tool. Find REAL, in-stock products a US shopper can buy right now.
Search the WHOLE web — do not limit yourself to Amazon or SHEIN.
When you have gathered results, respond with ONLY a single valid JSON object and nothing else.`;

function searchPrompt(item, exactQuery, dupeQuery) {
  return `ITEM: ${item.itemName}
BRAND: ${item.brand || '(unknown)'}
DESCRIPTION: ${item.description}
EXACT SEARCH: ${exactQuery}
DUPE / STYLE SEARCH: ${dupeQuery}

Use web search to build two lists:
1. "exact" — up to 8 listings of the SAME product. Find the ORIGINAL SOURCE first: if you can identify the brand, include the product on that brand's OWN official website, then add other legitimate retailers carrying the exact item (department stores, stockists, resale sites).
2. "dupes" — up to 8 cheaper lookalike products in the same style, from any retailer.

Rules:
- Use the DIRECT product-page URL (a page for that one product), never a search-results or category page.
- Only include links you are confident resolve to a live product page.
- Include the real image URL and price when you can see them.

Respond with ONLY this JSON (no other text):
{
  "exact": [ { "store": "Retailer", "productName": "Full title", "price": 0.00, "shipping": 0.00, "url": "https://direct-product-page", "imageUrl": "https://...", "note": "short detail" } ],
  "dupes": [ { same fields } ]
}
Numbers in USD (0 shipping if free). If a list has nothing reliable, return it empty.`;
}

async function findCandidates(apiKey, item, exactQuery, dupeQuery) {
  const messages = [{ role: 'user', content: searchPrompt(item, exactQuery, dupeQuery) }];

  let data = null;
  // Server-tool loops can pause (stop_reason "pause_turn"); resume a few times.
  for (let i = 0; i < 4; i++) {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: anthropicHeaders(apiKey),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 3000,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
        system: [{ type: 'text', text: SEARCH_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages
      })
    });
    data = await res.json().catch(() => ({}));
    if (!res.ok) { console.error('web search failed:', data?.error?.message || res.status); return { exact: [], dupes: [] }; }
    if (data.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: data.content });
      continue;
    }
    break;
  }

  const parsed = tryParseJson(extractText(data)) || {};
  return {
    exact: normalizeCandidates(parsed.exact),
    dupes: normalizeCandidates(parsed.dupes)
  };
}

// Last-resort broad links (always live) if validation leaves a list empty.
function fallbackLinks(query) {
  const q = encodeURIComponent(query);
  return [
    { store: 'Google Shopping', productName: `Browse live listings for "${query}"`, url: `https://www.google.com/search?tbm=shop&q=${q}`, price: 0, shipping: 0, totalCost: 0, imageUrl: '', note: 'Compare prices across every store' },
    { store: 'Google', productName: `Search the web for "${query}"`, url: `https://www.google.com/search?q=${q}`, price: 0, shipping: 0, totalCost: 0, imageUrl: '', note: 'Find the original source and more' }
  ];
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

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' });

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

    // ── Step 2: find candidates, then validate + enrich ───────────────────────
    let exactResults = [];
    let dupeResults = [];
    try {
      const cand = await findCandidates(apiKey, item, exactQuery, dupeQuery);
      const [ex, du] = await Promise.all([
        enrichList(cand.exact, 6),
        enrichList(cand.dupes, 6)
      ]);
      exactResults = ex;
      dupeResults = du;
    } catch (e) {
      console.error('Product search/validation failed:', e);
    }

    if (!exactResults.length) exactResults = fallbackLinks(exactQuery);
    if (!dupeResults.length) dupeResults = fallbackLinks(dupeQuery);

    await trackSearch(item.itemName, item.category);

    return res.status(200).json({ item, exactResults, dupeResults });

  } catch (error) {
    console.error('Handler error:', error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
}
