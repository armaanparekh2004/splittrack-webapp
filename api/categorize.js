// /api/categorize.js
//
// Tiny proxy so SplitTrack's web app can use Claude for categorization
// without putting an Anthropic API key in the browser. The browser can't
// call api.anthropic.com directly (no CORS support on that domain) — this
// function sits in between, holds the real key as a Vercel environment
// variable, and is the only thing that talks to Anthropic.
//
// Deploy: vercel env add ANTHROPIC_API_KEY  (paste your key, all environments)
//         vercel --prod

export default async function handler(req, res) {
  // CORS: allow the page to call this from any origin (tighten to your
  // actual domain once you know it, e.g. https://splittrack.vercel.app)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY — set it in Vercel project settings.' });
    return;
  }

  const { transactions } = req.body || {};
  if (!Array.isArray(transactions) || !transactions.length) {
    res.status(400).json({ error: 'Expected { transactions: [{id, merchant, total}, ...] }' });
    return;
  }

  // Cap how much we ever send in one call — keeps cost and latency predictable
  const batch = transactions.slice(0, 200);
  const list = batch.map(t => `${t.id}:"${t.merchant}" $${t.total}`).join('\n');

  const prompt = `For each transaction return JSON with:
- category: one of dining, groceries, transport, subscriptions, shopping, entertainment, health, other
- displayName: clean readable name (e.g. "ZAHAV RESTAURANT"->"Zahav", "DD *DOORDASH"->"DoorDash", "UBER *EATS"->"Uber Eats", "APPLE.COM/BILL"->"Apple Subscription", "NJTRANSIT"->"NJ Transit", "SHEIN.COM"->"Shein")

Return ONLY JSON: {"id":{"category":"dining","displayName":"Zahav"}} — no markdown, no preamble.
Transactions:
${list}`;

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      res.status(anthropicRes.status).json({ error: `Anthropic API error: ${errText.slice(0, 300)}` });
      return;
    }

    const data = await anthropicRes.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) {
      res.status(502).json({ error: 'No text content in Anthropic response' });
      return;
    }

    const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
    let result;
    try {
      result = JSON.parse(cleaned);
    } catch (parseErr) {
      res.status(502).json({ error: 'Could not parse JSON from model response', raw: cleaned.slice(0, 300) });
      return;
    }

    res.status(200).json({ result });
  } catch (err) {
    res.status(500).json({ error: `Proxy request failed: ${err.message}` });
  }
}
