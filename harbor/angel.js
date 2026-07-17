/* Harbor Angel client — prefers Supabase Edge Function, falls back locally */
(function () {
  const cfg = window.HARBOR_CONFIG || {};

  const LOCAL_NOTES = [
    'I’m a gentle companion — not a therapist or crisis line. Share only what feels safe.',
    'Your pace is welcome here. Setting something down is already a brave act.',
    'If this returns tomorrow, you can write it again. Repetition isn’t failure.',
  ];

  function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return h;
  }

  function pick(arr, seed) {
    return arr[Math.abs(hash(seed)) % arr.length];
  }

  function detectTheme(text) {
    const t = text.toLowerCase();
    if (/(grateful|thankful|blessed|happy|excited|proud|joy)/.test(t)) return 'joy';
    if (/(miss|lost|grief|funeral|passed|mourning|empty house|never again)/.test(t)) return 'grief';
    if (/(regret|should have|shouldn't have|wish i|my fault|mistake)/.test(t)) return 'regret';
    if (/(worried|anxious|afraid|scared|what if|stress|panic)/.test(t)) return 'worry';
    if (/(lonely|alone|no one|isolated|left out)/.test(t)) return 'loneliness';
    if (/(angry|furious|betrayed|hate that|rage|unfair)/.test(t)) return 'anger';
    if (/(goodbye|broke up|ended|leaving|moved away|last time)/.test(t)) return 'goodbye';
    if (/(hope|starting|chapter|begin|new|welcome)/.test(t)) return 'beginning';
    return 'general';
  }

  function extractEcho(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    let first = clean.split(/[.!?]/)[0].trim();
    if (first.length < 18) first = clean;
    if (first.length > 110) first = first.slice(0, 107).trim() + '…';
    return first;
  }

  const OPENERS = {
    joy: [
      'I can feel the light in what you shared.',
      'There’s a real brightness in these words.',
      'Thank you for bringing something hopeful to the shore.',
    ],
    grief: [
      'I’m sitting with the weight of what you lost.',
      'Grief deserves room, and you gave it some.',
      'What you named still matters — I hear that.',
    ],
    regret: [
      'Regret is often love looking for somewhere to go.',
      'You’re facing something unfinished with honesty.',
      'I hear the wish that things had gone differently.',
    ],
    worry: [
      'Worry is trying to protect you by rehearsing the storm.',
      'You don’t have to hold all of that alone tonight.',
      'Naming the fear already softens its grip a little.',
    ],
    loneliness: [
      'Feeling alone doesn’t mean you are unseen here.',
      'Longing for connection is deeply human — not a flaw.',
      'You reached toward the shore by writing. That matters.',
    ],
    anger: [
      'Anger often guards a softer truth underneath.',
      'You put the heat into words instead of into yourself.',
      'It’s allowed to feel sharp. It’s also allowed to set it down.',
    ],
    goodbye: [
      'Goodbyes rarely finish cleanly — you’re allowed to still feel this.',
      'Missing what was doesn’t mean you can’t keep walking.',
      'What ended still shaped you. There’s honor in admitting that.',
    ],
    beginning: [
      'New chapters can feel tender and brave at the same time.',
      'Starting something honest is already a kind of light.',
      'I hear the hope in this beginning.',
    ],
    general: [
      'Thank you for trusting this quiet place with something real.',
      'You don’t have to tidy the feeling before it’s welcome here.',
      'I heard you. You can leave this on the shore.',
    ],
  };

  const CLOSERS = [
    'Rest here as long as you need.',
    'You can come back whenever the tide rises again.',
    'Be gentle with yourself in the next small hour.',
    'One honest paragraph is enough for today.',
  ];

  function craftLocal(text) {
    const theme = detectTheme(text);
    const echo = extractEcho(text);
    const opener = pick(OPENERS[theme] || OPENERS.general, text.slice(0, 60) + theme);
    const closer = pick(CLOSERS, text.length + theme);
    const mid = echo
      ? `I especially hear this: “${echo}.”`
      : 'Whatever brought you here is welcome without performance.';
    return {
      theme,
      line: `${opener} ${mid} ${closer}`,
      note: pick(LOCAL_NOTES, theme + text.length),
      source: 'local',
    };
  }

  async function askGroqDirect(text) {
    const key = cfg.groqApiKey;
    if (!key) return null;
    const model = cfg.angelModel || 'llama-3.3-70b-versatile';
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        max_tokens: 220,
        messages: [
          {
            role: 'system',
            content: 'You are Harbor\'s Angel — calm, warm, brief (40–80 words). Acknowledge one concrete detail. Not a therapist or crisis line. No emojis. No politics. If self-harm intent appears, gently point to local emergency help or US 988.',
          },
          {
            role: 'user',
            content: `Someone set this down at Harbor:\n\n"""${text}"""\n\nRespond as the Angel.`,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
    const data = await res.json();
    const line = String(data?.choices?.[0]?.message?.content || '').trim();
    if (!line) throw new Error('Empty Groq Angel reply');
    return {
      line,
      note: LOCAL_NOTES[0],
      source: 'ai',
      theme: detectTheme(text),
    };
  }

  async function askAI(text) {
    // 1) Supabase Edge Function (keeps API keys server-side)
    try {
      const url = cfg.supabaseUrl;
      const key = cfg.supabaseAnonKey;
      const fn = cfg.angelFunction || 'harbor-angel';
      if (url && key) {
        const endpoint = `${url.replace(/\/$/, '')}/functions/v1/${fn}`;
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: key,
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({ text }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.line) {
            return {
              line: String(data.line).trim(),
              note: data.note || LOCAL_NOTES[0],
              source: data.source || 'ai',
              theme: detectTheme(text),
            };
          }
        }
      }
    } catch (err) {
      console.warn('Edge Angel unavailable', err);
    }

    // 2) Optional direct Groq key for personal prototypes
    return askGroqDirect(text);
  }

  async function respond(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return craftLocal('');
    try {
      const ai = await askAI(trimmed);
      if (ai?.line) return ai;
    } catch (err) {
      console.warn('Harbor Angel AI unavailable, using local companion', err);
    }
    return craftLocal(trimmed);
  }

  window.HarborAngel = {
    respond,
    craftLocal,
    detectTheme,
  };
})();
