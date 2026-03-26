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

// Track search using Vercel KV REST API directly — no npm package needed
async function trackSearch(itemName, category) {
  try {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!url || !token) return; // KV not configured, skip silently

    const key = itemName.toLowerCase().trim().replace(/\s+/g, '_').slice(0, 60);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // Increment count
    await fetch(`${url}/hincrby/search_counts/${encodeURIComponent(key)}/1`, { method: 'POST', headers });

    // Store display name + category if not already set
    const existing = await fetch(`${url}/hget/item_meta/${encodeURIComponent(key)}`, { headers });
    const existingData = await existing.json().catch(() => ({}));
    if (!existingData.result) {
      await fetch(`${url}/hset/item_meta`, {
        method: 'POST',
        headers,
        body: JSON.stringify([key, JSON.stringify({ name: itemName, category })])
      });
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
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        input: [{
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Identify the MAIN product in this image. If any part is circled or highlighted, focus ONLY on that item.

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
    if (!visionRes.ok) return res.status(500).json({ error: visionData?.error?.message || `Vision failed (${visionRes.status})` });

    const parsedItem = tryParseJson(getResponseText(visionData));
    if (!parsedItem?.itemName) return res.status(500).json({ error: 'Could not identify item in photo. Try a clearer image.' });

    const item = {
      itemName: String(parsedItem.itemName).trim(),
      category: String(parsedItem.category || 'other').trim(),
      description: String(parsedItem.description || '').trim(),
      keywords: Array.isArray(parsedItem.keywords) ? parsedItem.keywords.map(k => String(k).trim()).filter(Boolean).slice(0, 6) : [],
      estimatedPrice: { min: Number(parsedItem?.estimatedPrice?.min || 0), max: Number(parsedItem?.estimatedPrice?.max || 0) }
    };

    const sizeClause = size ? `\nSize needed: ${size} — only include listings available in this size.` : '';
    const detailsClause = details ? `\nAdditional preferences: ${details}` : '';

    // Step 2: search listings — ask AI to find image URLs directly using web search
    const searchRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        tools: [{ type: 'web_search' }],
        input: `Find 5 to 7 real current product listings for this item. For each listing, also search for a direct image URL of that specific product.

Item: ${item.itemName}
Category: ${item.category}
Description: ${item.description}
Keywords: ${item.keywords.join(', ')}
Price range: $${item.estimatedPrice.min}–$${item.estimatedPrice.max}${sizeClause}${detailsClause}

Rules:
- Real in-stock listings only
- Direct product page URLs (not search pages)
- For imageUrl: find the actual product image URL from the listing page — it should end in .jpg, .jpeg, .png, or .webp and start with https://
- Include price and shipping (use 0 if unknown, mention in note)
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
      "imageUrl": "https://example.com/images/product.jpg",
      "note": "Free returns · In stock"
    }
  ]
}`
      })
    });

    const searchData = await searchRes.json().catch(() => ({}));
    if (!searchRes.ok) return res.status(500).json({ error: searchData?.error?.message || `Search failed (${searchRes.status})` });

    const parsedResults = tryParseJson(getResponseText(searchData));
    let results = Array.isArray(parsedResults?.results) ? parsedResults.results : [];

    results = results
      .filter(r => r?.productName && r?.store)
      .map(r => {
        const price = Number(r.price || 0);
        const shipping = Number(r.shipping || 0);
        const imageUrl = String(r.imageUrl || '').trim();
        return {
          store: String(r.store).trim(),
          productName: String(r.productName).trim(),
          price, shipping,
          totalCost: Number(r.totalCost ?? (price + shipping)),
          url: String(r.url || '').trim(),
          imageUrl: imageUrl.startsWith('https://') ? imageUrl : '',
          note: String(r.note || '').trim()
        };
      })
      .sort((a, b) => a.totalCost - b.totalCost)
      .slice(0, 7);

    // Track search non-blocking
    trackSearch(item.itemName, item.category);

    return res.status(200).json({ item, results });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
}
