function tryParseJson(text) {
  if (!text) return null;
  // Strip markdown code fences
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  // Try direct parse
  try { return JSON.parse(cleaned); } catch {}
  // Try extracting first JSON object
  const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(cleaned.slice(a, b + 1)); } catch {} }
  return null;
}

function isProductUrl(url) {
  if (!url) return false;
  try { new URL(url); } catch { return false; }
  if (!url.startsWith('http')) return false;
  // Block obvious non-product pages
  const bad = [
    'google.com', 'bing.com', 'yahoo.com',
    'pinterest.com', 'instagram.com', 'youtube.com', 'tiktok.com',
    'reddit.com', 'wikipedia.org', 'facebook.com', 'twitter.com', 'x.com',
    '/blog/', '/news/', '/article', '/how-to', '/magazine',
    'amazon.com/s?', 'ebay.com/sch/', 'walmart.com/search'
  ];
  return !bad.some(s => url.toLowerCase().includes(s));
}

function extractOpenAIText(data) {
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

function extractAnthropicText(content) {
  if (!Array.isArray(content)) return '';
  return content.filter(b => b.type === 'text').map(b => b.text || '').join('\n').trim();
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
    const ed = await existing.json().catch(() => ({}));
    if (!ed.result) {
      await fetch(`${url}/hset/item_meta`, {
        method: 'POST', headers,
        body: JSON.stringify([key, JSON.stringify({ name: itemName, category })])
      });
    }
  } catch (e) { console.error('KV error (non-fatal):', e); }
}

// ── OpenAI search ─────────────────────────────────────────────────────────────
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
  return extractOpenAIText(data);
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
  return extractOpenAIText(data);
}

// ── Anthropic search ──────────────────────────────────────────────────────────
async function anthropicSearch(apiKey, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 2048,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Anthropic error (${res.status})`);
  return extractAnthropicText(data.content);
}

async function anthropicVision(apiKey, imageBase64, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: prompt }
      ]}]
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Anthropic vision error (${res.status})`);
  return extractAnthropicText(data.content);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { imageBase64, size, details } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

    // Use whichever API key is configured — Anthropic preferred, OpenAI fallback
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const openAiKey = process.env.OPENAI_API_KEY;
    const useAnthropic = !!anthropicKey;
    const useOpenAI = !!openAiKey;

    if (!useAnthropic && !useOpenAI) {
      return res.status(500).json({ error: 'No API key found. Add ANTHROPIC_API_KEY or OPENAI_API_KEY in Vercel environment variables.' });
    }

    const visionFn = useAnthropic
      ? (prompt) => anthropicVision(anthropicKey, imageBase64, prompt)
      : (prompt) => openAIVision(openAiKey, imageBase64, prompt);

    const searchFn = useAnthropic
      ? (prompt) => anthropicSearch(anthropicKey, prompt)
      : (prompt) => openAISearch(openAiKey, prompt);

    // ── Step 1: Identify item from image ──────────────────────────────────────
    const visionPrompt = `You are an expert fashion and product analyst. Study this image carefully.
If any area is circled, highlighted, or annotated, focus ONLY on that specific item — ignore everything else.

Return ONLY a valid JSON object — no other text, no markdown, no explanation:
{
  "itemName": "Complete product name. Include brand if visible, color, material, style. Be very specific.",
  "brand": "Brand name if clearly visible, otherwise empty string",
  "category": "one of: clothing, shoes, bag, jewelry, accessory, home_decor, electronics, beauty, other",
  "description": "Detailed visual description: color, material, cut, fit, distinguishing features, logos",
  "exactSearchQuery": "Best search query to find THIS EXACT product for sale online. Lead with brand if known. Include color, style, model name.",
  "dupeSearchQuery": "Search query for CHEAPER SIMILAR alternatives. Describe style WITHOUT brand names.",
  "estimatedPrice": { "min": 0, "max": 0 }
}`;

    const visionText = await visionFn(visionPrompt);
    const parsedItem = tryParseJson(visionText);
    if (!parsedItem?.itemName) {
      return res.status(500).json({ error: 'Could not identify item. Try a clearer photo with better lighting.' });
    }

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

    // Build context from user inputs
    const sizeSuffix = size ? ` in size ${size}` : '';
    const detailsSuffix = details ? `. User notes: ${details}` : '';
    const maxPrice = item.estimatedPrice.max || 150;
    const dupeMax = Math.round(maxPrice * 0.65);

    const jsonRule = `Return ONLY a raw JSON object. No markdown, no code fences, no explanation — just the JSON starting with { and ending with }.`;

    // ── Step 2: Exact match search ────────────────────────────────────────────
    const exactPrompt = `Search the web for: "${item.exactSearchQuery}${sizeSuffix}${detailsSuffix}"

Find 4-5 real places to buy this item online right now. Use web search to get actual current listings.

${jsonRule}
{
  "results": [
    {
      "store": "Retailer name",
      "productName": "Exact product title from the listing",
      "price": 49.99,
      "url": "https://direct-link-to-product-page",
      "note": "e.g. free shipping, in stock, returns info"
    }
  ]
}

IMPORTANT:
- Only direct product page URLs (e.g. amazon.com/dp/..., not amazon.com/s?k=...)
- Only in-stock items with a real price
- Sort by price low to high`;

    // ── Step 3: Dupe search ───────────────────────────────────────────────────
    const dupePrompt = `Search the web for affordable alternatives to: "${item.dupeSearchQuery}${sizeSuffix}${detailsSuffix}"

Find 4-6 cheaper similar products under $${dupeMax}. Similar style, lower price${item.brand ? ` — NOT ${item.brand} brand` : ''}.

${jsonRule}
{
  "results": [
    {
      "store": "Retailer name",
      "productName": "Exact product title from the listing",
      "price": 19.99,
      "url": "https://direct-link-to-product-page",
      "note": "why it's a good dupe, shipping info"
    }
  ]
}

IMPORTANT:
- Only direct product page URLs (not search pages)
- Only in-stock items with a real price
- Sort by price low to high`;

    const [exactText, dupeText] = await Promise.all([
      searchFn(exactPrompt),
      searchFn(dupePrompt)
    ]);

    const cleanResults = (raw, label) => {
      const parsed = tryParseJson(raw);
      console.log(`${label} raw:`, raw?.slice(0, 300));
      console.log(`${label} parsed:`, JSON.stringify(parsed)?.slice(0, 300));
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

    const exactResults = cleanResults(exactText, 'EXACT');
    const dupeResults = cleanResults(dupeText, 'DUPES');

    trackSearch(item.itemName, item.category);

    return res.status(200).json({
      item,
      exactResults,
      dupeResults,
      _debug: { provider: useAnthropic ? 'anthropic' : 'openai', exactRaw: exactText?.slice(0, 500), dupeRaw: dupeText?.slice(0, 500) }
    });

  } catch (error) {
    console.error('Handler error:', error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
}
