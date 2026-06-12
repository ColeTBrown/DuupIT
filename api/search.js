// Allow extra time for web search + validating/scraping product pages.
export const config = { maxDuration: 60 };

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

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

// ── HTML meta scraping ────────────────────────────────────────────────────────
function metaContent(html, names) {
  for (const name of names) {
    // property="og:image" content="..."  OR  content first then property
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

// Pull a price out of JSON-LD / meta tags
function scrapePrice(html) {
  const meta = metaContent(html, ['product:price:amount', 'og:price:amount']);
  if (meta && Number(meta) > 0) return Number(meta);
  // JSON-LD "price": "123.45" or "price": 123.45
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

    // Clearly dead → drop it.
    if (res.status === 404 || res.status === 410 || res.status === 451 || res.status >= 500) return null;

    const finalUrl = res.url || p.url;

    // Bot-blocked (we can't read the page). Keep only if the model gave a usable
    // image already, otherwise drop so we never show an image-less mystery card.
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      return p.imageUrl ? { ...p, url: finalUrl } : null;
    }

    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('html')) {
      return p.imageUrl ? { ...p, url: finalUrl } : null;
    }

    // Read a capped amount of HTML (meta tags live in <head>).
    const full = await res.text();
    const html = full.slice(0, 250000);

    const img = absUrl(metaContent(html, ['og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']), finalUrl);
    const title = metaContent(html, ['og:title', 'twitter:title']);
    const scrapedPrice = scrapePrice(html);

    const imageUrl = (img && /^https?:\/\//i.test(img)) ? img : p.imageUrl;
    // Require a preview image — the whole point is showing the product.
    if (!imageUrl) return null;

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
    return null; // timeout / DNS / connection error → treat as dead
  } finally {
    clearTimeout(timer);
  }
}

// Validate a list with limited concurrency; keep the first `keep` survivors.
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

// Normalise raw model output into candidate product objects.
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

function candidatePrompt(item, exactQuery, dupeQuery) {
  return `You are a shopping researcher. Use web search to find REAL, in-stock products a US shopper can buy right now.

ITEM: ${item.itemName}
BRAND: ${item.brand || '(unknown)'}
DESCRIPTION: ${item.description}
EXACT SEARCH: ${exactQuery}
DUPE / STYLE SEARCH: ${dupeQuery}

Return TWO lists:
1. "exact" — up to 8 listings of the SAME product. IMPORTANT: find the ORIGINAL SOURCE first — if you can identify the brand, include the product on that brand's OWN official website. Then add other legitimate retailers that carry the exact item (department stores, the brand's stockists, resale sites). Do NOT limit yourself to Amazon/SHEIN — search the whole web.
2. "dupes" — up to 8 cheaper lookalike products in the same style from any retailer.

Rules:
- Use the DIRECT product-page URL (a page for that one product), never a search-results or category page.
- Only include links you are confident resolve to a live product page. Skip anything uncertain.
- Provide the real image URL and price if you can see them.

Return ONLY valid JSON, no other text:
{
  "exact": [ { "store": "Retailer", "productName": "Full title", "price": 0.00, "shipping": 0.00, "url": "https://direct-product-page", "imageUrl": "https://...", "note": "short detail" } ],
  "dupes": [ { same fields } ]
}
Numbers in USD (0 shipping if free). If a list has nothing reliable, return it empty.`;
}

async function callWebSearch(apiKey, model, toolType, prompt) {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      tools: [{ type: toolType }],
      tool_choice: 'required',
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }]
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { ok: false, error: err?.error?.message || `web search ${res.status}` };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: true, parsed: tryParseJson(extractText(data)) || {} };
}

// Ask the model (with web search) for candidate products ANYWHERE on the web —
// prioritising the item's true source/brand site, then other retailers.
// Tries the current `web_search` tool, then the legacy `web_search_preview`,
// so it keeps working across OpenAI API/model variations.
async function findCandidates(apiKey, item, exactQuery, dupeQuery) {
  const prompt = candidatePrompt(item, exactQuery, dupeQuery);
  const attempts = [
    { model: 'gpt-4o', tool: 'web_search' },
    { model: 'gpt-4o', tool: 'web_search_preview' },
    { model: 'gpt-4.1', tool: 'web_search_preview' }
  ];
  for (const a of attempts) {
    const r = await callWebSearch(apiKey, a.model, a.tool, prompt);
    if (!r.ok) { console.error(`web search attempt failed (${a.model}/${a.tool}): ${r.error}`); continue; }
    const exact = normalizeCandidates(r.parsed.exact);
    const dupes = normalizeCandidates(r.parsed.dupes);
    if (exact.length || dupes.length) return { exact, dupes };
  }
  return { exact: [], dupes: [] };
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

    const sizeSuffix = size ? ` ${size}` : '';
    const detailsSuffix = details ? ` ${details}` : '';
    const exactQuery = (item.exactSearchQuery + sizeSuffix + detailsSuffix).trim();
    const dupeQuery = (item.dupeSearchQuery + sizeSuffix + detailsSuffix).trim();

    // ── Step 2: Find candidates anywhere on the web, then validate + enrich ────
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

    // Only fall back to broad live-search links if a list is empty.
    if (!exactResults.length) exactResults = fallbackLinks(exactQuery);
    if (!dupeResults.length) dupeResults = fallbackLinks(dupeQuery);

    // Record the search for the "Most Popular" tab.
    await trackSearch(item.itemName, item.category);

    return res.status(200).json({ item, exactResults, dupeResults });

  } catch (error) {
    console.error('Handler error:', error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
}
