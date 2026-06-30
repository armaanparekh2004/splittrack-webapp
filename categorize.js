// /api/categorize.js
//
// Tiny proxy so SplitTrack's web app can use Claude for categorization
// without putting an Anthropic API key in the browser. The browser can't
// call api.anthropic.com directly (no CORS support on that domain) — this
// function sits in between, holds the real key as a Vercel environment
// variable, and is the only thing that talks to Anthropic.
//
// RELIABILITY NOTES (read before changing batch size or max_tokens):
// - Uses Claude's tool-use (forced JSON schema) instead of asking the model
//   to format JSON in prose. This eliminates the most common failure mode —
//   the model wrapping output in markdown, adding a preamble, or producing
//   near-valid-but-not-quite JSON. The API enforces the shape directly.
// - Batches are capped at 40 transactions per call, not 200. At 200,
//   responses were getting cut off mid-object before they could finish,
//   which is what caused "cannot parse JSON" — that was a truncation
//   problem, not a formatting problem, and no amount of prompt tweaking
//   fixes truncation. 40 per call with max_tokens scaled to batch size
//   leaves comfortable headroom.
// - The system prompt explicitly forbids guessing or inventing specifics
//   (no fabricated locations, items, or context) — if the merchant string
//   doesn't make the category obvious, it must use "other" rather than
//   invent a plausible-sounding guess.

export default async function handler(req, res) {
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
  if (!Array.isArray(transactions)) {
    res.status(400).json({ error: 'Expected { transactions: [{id, merchant, total}, ...] }' });
    return;
  }
  if (!transactions.length) {
    // Used by the app's connectivity check — a valid empty response, not an error.
    res.status(200).json({ result: {} });
    return;
  }

  const MAX_PER_BATCH = 40;
  const allBatches = [];
  for (let i = 0; i < transactions.length; i += MAX_PER_BATCH) {
    allBatches.push(transactions.slice(i, i + MAX_PER_BATCH));
  }

  const CATEGORY_VALUES = ['dining', 'groceries', 'transport', 'subscriptions', 'shopping', 'entertainment', 'health', 'other'];

  // Forced JSON schema via tool-use — the model MUST return exactly this
  // shape, so there is nothing to "parse" out of prose and no markdown
  // fencing to strip. This is the actual fix for the JSON parse failures.
  const tool = {
    name: 'categorize_transactions',
    description: 'Return category and a cleaned display name for each transaction by its id.',
    input_schema: {
      type: 'object',
      properties: {
        results: {
          type: 'object',
          description: 'Keyed by transaction id.',
          additionalProperties: {
            type: 'object',
            properties: {
              category: { type: 'string', enum: CATEGORY_VALUES },
              displayName: { type: 'string', description: 'Short, clean, human-readable merchant name.' },
            },
            required: ['category', 'displayName'],
          },
        },
      },
      required: ['results'],
    },
  };

  const systemPrompt = `You clean up raw bank/card merchant strings for a personal finance app.

Rules — follow these exactly:
1. category must be one of: ${CATEGORY_VALUES.join(', ')}.
2. displayName is a short, recognizable cleanup of the merchant string only — e.g. "ZAHAV RESTAURANT" -> "Zahav", "DD *DOORDASH" -> "DoorDash", "UBER *TRIP" -> "Uber", "AMZN MKTP US" -> "Amazon", "APPLE.COM/BILL" -> "Apple Subscription".
3. Do NOT invent, guess, or fabricate any detail that isn't directly derivable from the merchant string itself — no specific locations, items purchased, trip destinations, or reasons for the charge. If the merchant string is genuinely ambiguous or unrecognizable, category must be "other" and displayName should just be a cleaned-up version of the original string (fix casing/spacing), not a guess at what it might be.
4. Every transaction id given to you must appear in your output exactly once.`;

  async function categorizeBatch(batch) {
    const list = batch.map(t => `${t.id}: "${t.merchant}" ($${t.total})`).join('\n');
    const userPrompt = `Transactions:\n${list}`;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: Math.min(4096, 200 + batch.length * 80), // scales with batch size, generous headroom
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        tools: [tool],
        tool_choice: { type: 'tool', name: 'categorize_transactions' },
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      throw new Error(`Anthropic API error (${anthropicRes.status}): ${errText.slice(0, 300)}`);
    }

    const data = await anthropicRes.json();
    const toolUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === 'categorize_transactions');
    if (!toolUse || !toolUse.input || !toolUse.input.results) {
      throw new Error('Model did not return the expected tool call — no results in response');
    }
    return toolUse.input.results;
  }

  try {
    const merged = {};
    for (const batch of allBatches) {
      const batchResult = await categorizeBatch(batch);
      Object.assign(merged, batchResult);
    }
    res.status(200).json({ result: merged });
  } catch (err) {
    res.status(500).json({ error: `Proxy request failed: ${err.message}` });
  }
}
