// Harbor Angel — Supabase Edge Function
// Deploy: supabase functions deploy harbor-angel --project-ref pequbpumggymlslakuwz
// Secrets (one of):
//   supabase secrets set GROQ_API_KEY=...
//   or supabase secrets set OPENAI_API_KEY=...

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SYSTEM = `You are Harbor's Angel — a calm, warm companion on a peaceful coastal app called Harbor.
People set down feelings here. Your job is gentle presence, not therapy and not advice overload.

Rules:
- Respond in 2 short paragraphs max (about 40–80 words total).
- Sound human, steady, and kind — like a trusted friend on a quiet beach.
- Acknowledge what they shared specifically — echo one concrete detail in their words.
- Do not diagnose, moralize, argue religion/politics, or claim to be a doctor/therapist/crisis line.
- Do not give a to-do list or “fix your life” advice. Presence first.
- If they express active self-harm or suicide intent, gently urge them to contact local emergency services or (US) call/text 988, and keep the rest brief and caring.
- No emojis. No lists unless truly needed. No “As an AI”.
- End with one quiet, hopeful sentence — not a command.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }

  if (req.method !== "POST") {
    return json({ error: "POST only" }, 405);
  }

  try {
    const body = await req.json();
    const text = String(body?.text || "").trim().slice(0, 4000);
    if (!text) return json({ error: "Missing text" }, 400);

    const groqKey = Deno.env.get("GROQ_API_KEY") || "";
    const openAiKey = Deno.env.get("OPENAI_API_KEY") || "";

    let apiUrl = "";
    let apiKey = "";
    let model = "";

    if (groqKey) {
      apiUrl = "https://api.groq.com/openai/v1/chat/completions";
      apiKey = groqKey;
      model = Deno.env.get("HARBOR_ANGEL_MODEL") || "llama-3.3-70b-versatile";
    } else if (openAiKey) {
      apiUrl = "https://api.openai.com/v1/chat/completions";
      apiKey = openAiKey;
      model = Deno.env.get("HARBOR_ANGEL_MODEL") || "gpt-4o-mini";
    } else {
      return json({ error: "No GROQ_API_KEY or OPENAI_API_KEY set" }, 503);
    }

    const upstream = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        max_tokens: 220,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: `Someone set this down at Harbor:\n\n"""${text}"""\n\nRespond as the Angel.`,
          },
        ],
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error("Angel upstream error", upstream.status, errText);
      return json({ error: "Angel upstream failed", detail: errText.slice(0, 300) }, 502);
    }

    const data = await upstream.json();
    const line = String(data?.choices?.[0]?.message?.content || "").trim();
    if (!line) return json({ error: "Empty Angel reply" }, 502);

    return json({
      line,
      note: "I’m a gentle companion — not a therapist or crisis line. Share only what feels safe.",
      source: "ai",
    });
  } catch (err) {
    console.error(err);
    return json({ error: String(err?.message || err) }, 500);
  }
});

function json(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });
}
