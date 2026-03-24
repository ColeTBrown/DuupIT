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
                text: `You are a fashion and product identification expert.
Identify the MAIN item in this image.

Return ONLY valid raw JSON.
Do not use markdown.
Do not use code fences.
Do not add explanation.

Schema:
{
  "itemName": "specific descriptive name",
  "category": "clothing|shoes|bag|jewelry|accessory|home_decor|electronics|beauty|other",
  "description": "2 short sentences describing color, material, shape, style, and notable visual details",
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

    const visionText = (visionData.output_text || '').trim();

    let item;
    try {
      item = JSON.parse(visionText);
    } catch {
      return res.status(500).json({
        error: 'Could not parse the item identification result'
      });
    }

    const searchPrompt = `You are a shopping deal finder.

Find 5 to 7 real current listings for this item:
Item: ${item.itemName}
Description: ${item.description}
Keywords: ${(item.keywords || []).join(', ')}
Expected price range: $${item.estimatedPrice?.min || 0}-$${item.estimatedPrice?.max || 0}

Search across stores like Amazon, Walmart, Target, ASOS, Zara, H&M, Nordstrom Rack, eBay, Poshmark, ThredUp, Revolve, and similar retailers/resale marketplaces.

Requirements:
- real current listings only
- real direct product URLs only
- include current price
- include shipping when possible
- if shipping is unknown, use 0 and mention that in note
- sort by totalCost ascending

Return ONLY valid raw JSON.
No markdown. No backticks. No explanation.

Schema:
{
  "results": [
    {
      "store": "Store name",
      "productName": "Exact product title",
      "price": 29.99,
      "shipping": 0,
      "totalCost": 29.99,
      "url": "https://...",
      "note": "Free returns · In stock"
    }
  ]
}`;

    const searchRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        tools: [{ type: 'web_search' }],
        input: searchPrompt
      })
    });

    const searchData = await searchRes.json().catch(() => ({}));

    if (!searchRes.ok) {
      return res.status(500).json({
        error: searchData?.error?.message || `Search request failed (${searchRes.status})`
      });
    }

    const searchText = (searchData.output_text || '').trim();

    let results = [];
    try {
      const parsed = JSON.parse(searchText);
      results = Array.isArray(parsed.results) ? parsed.results : [];
    } catch {
      const match = searchText.match(/\{[\s\S]*"results"[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          results = Array.isArray(parsed.results) ? parsed.results : [];
        } catch {
          results = [];
        }
      }
    }

    results = results
      .filter(r => r && r.productName && r.store)
      .map(r => ({
        store: String(r.store || '').trim(),
        productName: String(r.productName || '').trim(),
        price: Number(r.price || 0),
        shipping: Number(r.shipping || 0),
        totalCost: Number(r.totalCost ?? (Number(r.price || 0) + Number(r.shipping || 0))),
        url: String(r.url || '').trim(),
        note: String(r.note || '').trim()
      }))
      .sort((a, b) => a.totalCost - b.totalCost);

    return res.status(200).json({ item, results });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message || 'Server error'
    });
  }
}
