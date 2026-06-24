// src/utils/aiClient.js
// ─── Provider-agnostic AI text generation with graceful fallback ─────────────
// Supports OpenAI, Anthropic, or Gemini via env. If no key is configured,
// callers should use their own rule-based fallback (see isAIConfigured).

const PROVIDER = (process.env.AI_PROVIDER || 'openai').toLowerCase();

function isAIConfigured() {
  if (PROVIDER === 'openai') return !!process.env.OPENAI_API_KEY;
  if (PROVIDER === 'anthropic') return !!process.env.ANTHROPIC_API_KEY;
  if (PROVIDER === 'gemini') return !!process.env.GEMINI_API_KEY;
  return false;
}

/**
 * Generate a completion from the configured provider.
 * @param {string} system - system / instruction prompt
 * @param {string} user - user prompt (the data + question)
 * @returns {Promise<string>} model text output
 */
async function generate(system, user) {
  if (PROVIDER === 'anthropic') return generateAnthropic(system, user);
  if (PROVIDER === 'gemini') return generateGemini(system, user);
  return generateOpenAI(system, user);
}

async function generateOpenAI(system, user) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.4,
      max_tokens: 700,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error ${res.status}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || '';
}

async function generateAnthropic(system, user) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest',
      max_tokens: 700,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic error ${res.status}`);
  const json = await res.json();
  return json.content?.[0]?.text?.trim() || '';
}

async function generateGemini(system, user) {
  const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 700 },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini error ${res.status}`);
  const json = await res.json();
  return json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

module.exports = { isAIConfigured, generate, PROVIDER };
