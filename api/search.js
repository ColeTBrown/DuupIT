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

    // STEP 1: identify the item from the image
    const visionRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        text: {
          format: {
            type: 'json_schema',
            name: 'identified_item',
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                itemName: { type: 'string' },
                category: {
                  type: 'string',
                  enum: [
                    'clothing',
                    'shoes',
                    'bag',
                    'jewelry',
                    'accessory',
                    'home_decor',
                    'electronics',
                    'beauty',
                    'other'
                  ]
                },
                description: { type: 'string' },
                keywords: {
                  type: 'array',
                  items: { type: 'string' }
                },
                estimatedPrice: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    min: { type: 'number' },
                    max: { type: 'number' }
                  },
                  required: ['min', 'max']
                }
              },
              required: [
                'itemName',
                'category',
                'description',
                'keywords',
                'estimatedPrice'
              ]
            }
          }
        },
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Identify the main product in this image. Be specific but concise.'
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
      const match = visionText.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          item = JSON.parse(match[0]);
        } catch {
          return res.status(500).json({
            error: 'Could not parse the item identification result'
          });
        }
      } else {
        return res.status(500).json({
          error: 'Could not parse the item identification result'
        });
      }
    }

    // Safety cleanup
    item = {
      itemName: String(item.itemName || '').trim(),
      category: String(item.category || 'other').trim(),
      description: String(item.description || '').trim(),
      keywords: Array.isArray(item.keywords)
        ? item.keywords.map(k => String(k).trim()).filter(Boolean).slice(0, 6)
        : [],
      estimatedPrice: {
        min: Number(item.estimatedPrice?.min || 0),
        max: Number(item.estimatedPrice?.max || 0)
      }
    };

    // STEP 2: search for real product listings
    const searchRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        tools: [{ type: 'web_search' }],
        text: {
          format: {
            type: 'json_schema',
            name: 'shopping_results',
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                results: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      store: { type: 'string' },
                      productName: { type: 'string' },
                      price: { type: 'number' },
                      shipping: { type: 'number' },
                      totalCost: { type: 'number' },
                      url: { type: 'string' },
                      note: { type: 'string' }
                    },
                    required: [
                      'store',
                      'productName',
                      'price',
                      'shipping',
                      'totalCost',
                      'url',
                      'note'
                    ]
                  }
                }
              },
              required: ['results']
            }
          }
        },
        input: `Find 5 to 7 real current product listings for this item.

Item: ${item.itemName}
Category: ${item.category}
Description: ${item.description}
Keywords: ${item.keywords.join(', ')}
Expected price range: $${item.estimatedPrice.min}-$${item.estimatedPrice.max}

Search across major retailers and resale sites when relevant.

Rules:
- return real listings only
- include direct product URLs only
- include current price
- include shipping when possible
- if shipping is unknown, use 0 and explain that in note
- totalCost should equal price + shipping
- sort cheapest first`
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
      .map(r => {
        const price = Number(r.price || 0);
        const shipping = Number(r.shipping || 0);
        const totalCost = Number(
          r.totalCost ?? (price + shipping)
        );

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
