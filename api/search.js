function getResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  if (Array.isArray(data?.output)) {
    const parts = [];

    for (const item of data.output) {
      if (Array.isArray(item?.content)) {
        for (const c of item.content) {
          if (typeof c?.text === 'string' && c.text.trim()) {
            parts.push(c.text);
          }
        }
      }
    }

    return parts.join('\n').trim();
  }

  return '';
}

function extractJsonObject(text) {
  if (!text) return null;

  const cleaned = text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    const candidate = cleaned.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { imageBase64 } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ error: 'Missing imageBase64' });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });
    }

    // STEP 1: identify the item
    const visionRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `Identify the MAIN product in this image.

Return ONLY JSON in this exact shape:
{
  "itemName": "specific product name",
  "category": "clothing|shoes|bag|jewelry|accessory|home_decor|electronics|beauty|other",
  "description": "2 short sentences about color, style, material, and notable details",
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4"],
  "estimatedPrice": { "min": 20, "max": 120 }
}`
              },
              {
                type: 'input_image',
                image_url: `data:image/jpeg;base64,${imageBase64}`
              }
            ]
          }
        ]
      })
    });

    const visionData = await visionRes.json().catch(() => ({}));

    if (!visionRes.ok) {
      return res.status(500).json({
        error: visionData?.error?.message || `Vision request failed (${visionRes.status})`
      });
    }

    const visionText = getResponseText(visionData);
    const parsedItem = extractJsonObject(visionText);

    if (!parsedItem) {
      return res.status(500).json({
        error: `Could not parse item identification result. Raw model output: ${visionText || 'empty response'}`
      });
    }

    const item = {
      itemName: String(parsedItem.itemName || '').trim(),
      category: String(parsedItem.category || 'other').trim(),
      description: String(parsedItem.description || '').trim(),
      keywords: Array.isArray(parsedItem.keywords)
        ? parsedItem.keywords.map(k => String(k).trim()).filter(Boolean).slice(0, 6)
        : [],
      estimatedPrice: {
        min: Number(parsedItem?.estimatedPrice?.min || 0),
        max: Number(parsedItem?.estimatedPrice?.max || 0)
      }
    };

    if (!item.itemName) {
      return res.status(500).json({
        error: `Item identification came back incomplete. Raw model output: ${visionText || 'empty response'}`
      });
    }

    // STEP 2: search for listings
    const searchRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        tools: [{ type: 'web_search' }],
        input: `Find 5 to 7 real current product listings for this item.

Item: ${item.itemName}
Category: ${item.category}
Description: ${item.description}
Keywords: ${item.keywords.join(', ')}
Expected price range: $${item.estimatedPrice.min}-$${item.estimatedPrice.max}

Rules:
- real listings only
- direct product URLs only
- include price
- include shipping when possible
- if shipping is unknown, use 0 and explain that in note
- include totalCost = price + shipping
- sort cheapest first

Return ONLY JSON in this exact shape:
{
  "results": [
    {
      "store": "Store name",
      "productName": "Exact product title",
      "price": 29.99,
      "shipping": 0,
      "totalCost": 29.99,
      "url": "https://example.com/product",
      "note": "Free returns · In stock"
    }
  ]
}`
      })
    });

    const searchData = await searchRes.json().catch(() => ({}));

    if (!searchRes.ok) {
      return res.status(500).json({
        error: searchData?.error?.message || `Search request failed (${searchRes.status})`
      });
    }

    const searchText = getResponseText(searchData);
    const parsedResults = extractJsonObject(searchText);

    let results = Array.isArray(parsedResults?.results) ? parsedResults.results : [];

    results = results
      .filter(r => r && r.productName && r.store)
      .map(r => {
        const price = Number(r.price || 0);
        const shipping = Number(r.shipping || 0);
        const totalCost = Number(r.totalCost ?? (price + shipping));

        return {
          store: String(r.store || '').trim(),
          productName: String(r.productName || '').trim(),
          price,
          shipping,
          totalCost,
          url: String(r.url || '').trim(),
          note: String(r.note || '').trim()
        };
      })
      .sort((a, b) => a.totalCost - b.totalCost)
      .slice(0, 7);

    return res.status(200).json({ item, results });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message || 'Server error'
    });
  }
}
