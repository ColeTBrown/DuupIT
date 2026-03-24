export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { imageBase64 } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ error: 'Missing imageBase64' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' });
    }

    // Step 1: identify the item
    const visionRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: imageBase64
                }
              },
              {
                type: 'text',
                text: `You are a fashion and product expert. Identify the main item in this image.
Return ONLY raw JSON with no markdown, no backticks, no extra text:
{
  "itemName": "descriptive name like 'Oversized beige linen blazer' or 'Mini brown leather crossbody bag'",
  "category": "clothing|shoes|bag|jewelry|accessory|home_decor|electronics|beauty|other",
  "description": "2 sentences covering style, color, material, and key identifying features",
  "keywords": ["4 to 6 search keywords"],
  "estimatedPrice": { "min": 25, "max": 150 }
}`
              }
            ]
          }
        ]
      })
    });

    const visionData = await visionRes.json().catch(() => ({}));

    if (!visionRes.ok) {
      return res.status(500).json({
        error: visionData?.error?.message || `Vision API error (${visionRes.status})`
      });
    }

    const visionText = (
      visionData?.content?.find(block => block.type === 'text')?.text || '{}'
    ).replace(/```json|```/g, '').trim();

    let item;
    try {
      item = JSON.parse(visionText);
    } catch {
      return res.status(500).json({
        error: 'Could not identify the item. Try a clearer photo with better lighting.'
      });
    }

    // Step 2: search for prices
    const searchRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [
          {
            role: 'user',
            content: `You are a price comparison shopping expert. Find the cheapest current listings for: "${item.itemName}".

Details: ${item.description}
Keywords: ${(item.keywords || []).join(', ')}
Expected price: $${item.estimatedPrice?.min}–$${item.estimatedPrice?.max}

Search across: Amazon, ASOS, Shein, Zara, H&M, Target, Walmart, eBay, Poshmark, Nordstrom Rack, ThredUp, Revolve, Forever 21.
Find 5–7 REAL current listings with REAL prices and REAL direct product URLs.

Return ONLY raw JSON (no markdown, no backticks):
{
  "results": [
    {
      "store": "Store Name",
      "productName": "Exact product title",
      "price": 29.99,
      "shipping": 0,
      "totalCost": 29.99,
      "url": "https://direct-product-url.com/product",
      "note": "e.g. Free returns · In stock"
    }
  ]
}
Sort ascending by totalCost. shipping:0 means free shipping.`
          }
        ]
      })
    });

    const searchData = await searchRes.json().catch(() => ({}));

    if (!searchRes.ok) {
      return res.status(500).json({
        error: searchData?.error?.message || `Search error (${searchRes.status})`
      });
    }

    const allText = (searchData.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    let results = [];
    try {
      const match = allText.match(/\{[\s\S]*"results"[\s\S]*\}/);
      const parsed = match ? JSON.parse(match[0]) : { results: [] };
      results = Array.isArray(parsed.results) ? parsed.results : [];
    } catch {
      results = [];
    }

    results.sort((a, b) => (a.totalCost || a.price || 0) - (b.totalCost || b.price || 0));

    return res.status(200).json({ item, results });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message || 'Server error'
    });
  }
}