function getResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  if (Array.isArray(data?.output)) {
    const texts = [];

    for (const item of data.output) {
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === 'string' && part.text.trim()) {
            texts.push(part.text.trim());
          }
        }
      }
    }

    if (texts.length) return texts.join('\n');
  }

  return '';
}

function tryParseJson(text) {
  if (!text) return null;

  const cleaned = text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const slice = cleaned.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(slice);
    } catch {}
  }

  return null;
}

// Fetch the og:image (or twitter:image) from a product page
async function fetchProductImage(url) {
  if (!url || !url.startsWith('http')) return '';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });
    clearTimeout(timeout);

    if (!res.ok) return '';

    // Only read first 50KB — enough to get <head> meta tags
    const reader = res.body.getReader();
    let html = '';
    let bytesRead = 0;
    const maxBytes = 50000;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
      bytesRead += value.length;
      if (bytesRead >= maxBytes) {
        reader.cancel();
        break;
      }
    }

    // Try og:image first
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch?.[1] && ogMatch[1].startsWith('http')) return ogMatch[1];

    // Fallback: twitter:image
    const twMatch = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
    if (twMatch?.[1] && twMatch[1].startsWith('http')) return twMatch[1];

    return '';
  } catch {
    return '';
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { imageBase64, size, details } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ error: 'Missing imageBase64' });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });
    }

    // Step 1: identify the item
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

Return ONLY valid JSON in exactly this format:
{
  "itemName": "specific item name",
  "category": "clothing",
  "description": "short visual description",
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4"],
  "estimatedPrice": { "min": 20, "max": 100 }
}

Allowed categories:
clothing, shoes, bag, jewelry, accessory, home_decor, electronics, beauty, other`
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
    const parsedItem = tryParseJson(visionText);

    if (!parsedItem) {
      return res.status(500).json({
        error: `Could not parse item identification result. Raw output: ${visionText || 'empty response'}`
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
        error: `Item identification incomplete. Raw output: ${visionText || 'empty response'}`
      });
    }

    // Build optional size/details context for the search prompt
    const sizeClause = size ? `\nSize needed: ${size} — only include listings available in this size.` : '';
    const detailsClause = details ? `\nAdditional user preferences: ${details}` : '';

    // Step 2: search listings
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
Expected price range: $${item.estimatedPrice.min}-$${item.estimatedPrice.max}${sizeClause}${detailsClause}

Rules:
- real listings only
- direct product page URLs only (not search pages)
- include price
- include shipping when possible; if unknown use 0 and note it
- include totalCost = price + shipping
- sort cheapest first

Return ONLY valid JSON in this format:
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
    const parsedResults = tryParseJson(searchText);

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
          imageUrl: '',
          note: String(r.note || '').trim()
        };
      })
      .sort((a, b) => a.totalCost - b.totalCost)
      .slice(0, 7);

    // Step 3: fetch real product images in parallel by scraping og:image from each listing page
    await Promise.all(
      results.map(async (r) => {
        if (r.url && r.url.startsWith('http')) {
          r.imageUrl = await fetchProductImage(r.url);
        }
      })
    );

    return res.status(200).json({ item, results });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message || 'Server error'
    });
  }
}
