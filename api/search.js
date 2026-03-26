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

// Build guaranteed-working search URLs for each retailer
function buildSearchUrls(exactQuery, dupeQuery, size, estimatedMax) {
  const eq = encodeURIComponent(exactQuery);
  const dq = encodeURIComponent(dupeQuery);

  // Exact match stores — search for the specific item
  const exactStores = [
    {
      store: 'Amazon',
      productName: `Search Amazon for "${exactQuery}"`,
      url: `https://www.amazon.com/s?k=${eq}`,
      note: 'Largest selection, fast shipping'
    },
    {
      store: 'eBay',
      productName: `Search eBay for "${exactQuery}"`,
      url: `https://www.ebay.com/sch/i.html?_nkw=${eq}`,
      note: 'New and pre-owned listings'
    },
    {
      store: 'Google Shopping',
      productName: `Search Google Shopping for "${exactQuery}"`,
      url: `https://www.google.com/search?q=${eq}&tbm=shop`,
      note: 'Compare prices across all stores'
    },
    {
      store: 'Walmart',
      productName: `Search Walmart for "${exactQuery}"`,
      url: `https://www.walmart.com/search?q=${eq}`,
      note: 'Low prices, free pickup'
    },
    {
      store: 'Poshmark',
      productName: `Search Poshmark for "${exactQuery}"`,
      url: `https://poshmark.com/search?query=${eq}`,
      note: 'Pre-loved items, great deals'
    }
  ];

  // Dupe stores — search for the style description (cheaper alternatives)
  const dupeStores = [
    {
      store: 'SHEIN',
      productName: `Search SHEIN for "${dupeQuery}"`,
      url: `https://www.shein.com/search?q=${dq}`,
      note: 'Very affordable alternatives'
    },
    {
      store: 'Amazon',
      productName: `Search Amazon for "${dupeQuery}"`,
      url: `https://www.amazon.com/s?k=${dq}`,
      note: 'Budget-friendly options with fast shipping'
    },
    {
      store: 'ASOS',
      productName: `Search ASOS for "${dupeQuery}"`,
      url: `https://www.asos.com/search/?q=${dq}`,
      note: 'Trendy affordable fashion'
    },
    {
      store: 'H&M',
      productName: `Search H&M for "${dupeQuery}"`,
      url: `https://www2.hm.com/en_us/search-results.html?q=${dq}`,
      note: 'Affordable high-street style'
    },
    {
      store: 'Zara',
      productName: `Search Zara for "${dupeQuery}"`,
      url: `https://www.zara.com/us/en/search?searchTerm=${dq}`,
      note: 'Trendy styles at mid-range prices'
    },
    {
      store: 'Target',
      productName: `Search Target for "${dupeQuery}"`,
      url: `https://www.target.com/s?searchTerm=${dq}`,
      note: 'Affordable everyday fashion'
    }
  ];

  return { exactStores, dupeStores };
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

    // ── Step 2: Build guaranteed working search URLs ───────────────────────────
    const { exactStores, dupeStores } = buildSearchUrls(
      exactQuery, dupeQuery, size, item.estimatedPrice.max
    );

    trackSearch(item.itemName, item.category);

    return res.status(200).json({
      item,
      exactResults: exactStores,
      dupeResults: dupeStores
    });

  } catch (error) {
    console.error('Handler error:', error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
}
