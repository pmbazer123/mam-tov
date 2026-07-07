const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 19300;

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync('/home/moshe-assistant/.openclaw/openclaw.json', 'utf8'));
  return {
    googleKey: cfg.plugins.entries.google.config.webSearch.apiKey,
    braveKey: cfg.gateway?.auth?.token
      ? null // gateway token isn't Brave key
      : null,
  };
}

// Load keys directly
function getKeys() {
  try {
    const cfg = JSON.parse(fs.readFileSync('/home/moshe-assistant/.openclaw/openclaw.json', 'utf8'));
    const googleKey = cfg.plugins.entries.google.config.webSearch.apiKey;
    // Brave key is in gateway env file
    let braveKey = null;
    try {
      const env = fs.readFileSync('/home/moshe-assistant/.openclaw/gateway.systemd.env', 'utf8');
      const m = env.match(/BRAVE_API_KEY=(.+)/);
      if (m) braveKey = m[1].trim();
    } catch {}
    return { googleKey, braveKey };
  } catch (e) {
    throw new Error('Failed to load config: ' + e.message);
  }
}

const { googleKey, braveKey } = getKeys();
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${googleKey}`;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cache Imgflip meme list (24h)
let memesCache = null;
let cacheTime = 0;

async function getMemes() {
  if (memesCache && Date.now() - cacheTime < 24 * 60 * 60 * 1000) return memesCache;
  const res = await fetch('https://api.imgflip.com/get_memes');
  const data = await res.json();
  memesCache = data.data.memes;
  cacheTime = Date.now();
  return memesCache;
}

async function askGemini(prompt) {
  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 200, temperature: 0.3, thinkingConfig: { thinkingBudget: 0 } }
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  if (!data.candidates) throw new Error('No candidates');
  return data.candidates[0].content.parts[0].text.trim();
}

// International templates via Imgflip + Gemini
app.post('/search/templates', async (req, res) => {
  const { query } = req.body;
  if (!query || query.trim().length < 2) return res.status(400).json({ error: 'Query too short' });

  try {
    const memes = await getMemes();
    const memeList = memes.map((m, i) => `${i}: ${m.name}`).join('\n');
    const prompt = `User situation (Hebrew): "${query}"

Meme templates (index: name):
${memeList}

Return ONLY a JSON array of 6 index numbers for the most fitting meme templates.
Think: emotion, irony, power dynamics, universal humor.
Format: [4, 17, 23, 56, 71, 88] — only the array, nothing else.`;

    const text = await askGemini(prompt);
    const match = text.replace(/```[a-z]*/g, '').match(/\[[\d,\s]+\]/);
    if (!match) return res.status(500).json({ error: 'Parse error' });

    const indices = JSON.parse(match[0]);
    const results = indices.map(i => memes[i]).filter(Boolean).map(m => ({
      id: m.id, name: m.name, url: m.url,
      imgflipUrl: `https://imgflip.com/memegenerator/${m.id}`
    }));
    res.json({ results });
  } catch (err) {
    console.error('templates error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Israeli memes via Brave Image Search
app.post('/search/israeli', async (req, res) => {
  const { query } = req.body;
  if (!query || query.trim().length < 2) return res.status(400).json({ error: 'Query too short' });
  if (!braveKey) return res.status(503).json({ error: 'Image search not configured' });

  try {
    // Use Gemini to extract 2-3 punchy Hebrew keywords for the image search
    const kwPrompt = `Situation (Hebrew): "${query}"
Extract 2-3 key Hebrew words that capture the emotional/comedic core of this situation.
These words will be used to search for Israeli memes.
Return only the words separated by spaces, no punctuation.
Example input: "הבוס הגיע לפגישה שכחנו לכין"
Example output: בוס פגישה בושה`;

    const keywords = await askGemini(kwPrompt);
    const searchQuery = encodeURIComponent(`${keywords.trim()} ממ מצחיק ישראלי`);

    const braveRes = await fetch(
      `https://api.search.brave.com/res/v1/images/search?q=${searchQuery}&count=9&safesearch=strict`,
      {
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': braveKey
        }
      }
    );
    const data = await braveRes.json();
    if (data.errors) return res.status(500).json({ error: data.errors[0]?.message || 'Brave error' });

    const results = (data.results || [])
      .filter(r => r.properties?.url)
      .map(r => ({
        title: r.title,
        imageUrl: r.properties.url,
        thumbnail: r.thumbnail?.src || r.properties.url,
        sourceUrl: r.url,
        source: r.meta_url?.hostname || r.source
      }));

    res.json({ results, keywords: keywords.trim() });
  } catch (err) {
    console.error('israeli error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Keep backward-compat /search endpoint
app.post('/search', async (req, res) => {
  req.url = '/search/templates';
  app._router.handle(req, res);
});

app.listen(PORT, () => {
  console.log(`ממ-טוב running on http://localhost:${PORT}`);
});
