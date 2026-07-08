const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 19300;

function getKeys() {
  const cfg = JSON.parse(fs.readFileSync('/home/moshe-assistant/.openclaw/openclaw.json', 'utf8'));
  return { googleKey: cfg.plugins.entries.google.config.webSearch.apiKey };
}

const { googleKey } = getKeys();
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

async function askGemini(prompt, maxTokens = 200) {
  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.5,
        thinkingConfig: { thinkingBudget: 0 }
      }
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

// Israeli meme IDEAS: Gemini generates Hebrew captions for relevant templates
app.post('/search/israeli', async (req, res) => {
  const { query } = req.body;
  if (!query || query.trim().length < 2) return res.status(400).json({ error: 'Query too short' });

  try {
    const memes = await getMemes();
    const memeList = memes.map((m, i) => `${i}: ${m.name} (boxes: ${m.box_count || 2})`).join('\n');

    const prompt = `You are an expert in Israeli meme culture and Hebrew internet humor.

User situation (Hebrew): "${query}"

Meme templates available (index: name, boxes=number of text fields):
${memeList}

Create 4 specific Israeli-flavored meme ideas. For each:
1. Pick the best template index
2. Write HEBREW text for each text box (short, punchy, authentic Israeli style — slang ok)
3. One-word "vibe" in Hebrew

Return ONLY valid JSON (no markdown):
[
  {"idx": 3, "texts": ["טקסט לתיבה 1", "טקסט לתיבה 2"], "vibe": "בייגל"},
  ...
]

Rules:
- Texts must be in Hebrew
- Keep each text under 8 words
- Israeli references, slang, and cultural context preferred
- Only the JSON array, nothing else`;

    const raw = await askGemini(prompt, 600);
    const clean = raw.replace(/```[a-z]*/g, '').replace(/```/g, '').trim();
    const jsonMatch = clean.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.status(500).json({ error: 'Parse error' });

    const ideas = JSON.parse(jsonMatch[0]);
    const results = ideas.map(idea => {
      const meme = memes[idea.idx];
      if (!meme) return null;
      return {
        id: meme.id,
        name: meme.name,
        url: meme.url,
        imgflipUrl: `https://imgflip.com/memegenerator/${meme.id}`,
        texts: idea.texts || [],
        vibe: idea.vibe || ''
      };
    }).filter(Boolean);

    res.json({ results });
  } catch (err) {
    console.error('israeli error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/search', async (req, res) => {
  req.url = '/search/templates';
  app._router.handle(req, res);
});

app.listen(PORT, () => {
  console.log(`ממ-טוב running on http://localhost:${PORT}`);
});
