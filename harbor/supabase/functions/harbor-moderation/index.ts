// Harbor moderation Edge Function
// Deploy: supabase functions deploy harbor-moderation --project-ref pequbpumggymlslakuwz
// Secret: supabase secrets set ADMIN_SECRET=your-strong-admin-pass

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return cors(null, 204);
  }
  if (req.method !== "POST") return cors({ error: "POST only" }, 405);

  try {
    const body = await req.json();
    const action = String(body?.action || "");
    const adminSecret = Deno.env.get("ADMIN_SECRET") || "";
    const provided = String(req.headers.get("x-harbor-admin") || body?.adminSecret || "");

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";

    const supabase = createClient(supabaseUrl, serviceKey);

    async function callerIsAdmin() {
      // 1) Shared admin secret (bootstrap / emergency)
      if (adminSecret && provided === adminSecret) return true;

      // 2) Logged-in user JWT with admin role in harbor_profiles
      const authHeader = req.headers.get("Authorization") || "";
      const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
      if (!jwt || !anonKey) return false;

      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
      });
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData?.user) return false;

      const { data: prof } = await supabase
        .from("harbor_profiles")
        .select("role,email")
        .eq("id", userData.user.id)
        .maybeSingle();

      if (prof?.role === "admin") return true;
      if ((userData.user.email || "").toLowerCase() === "owenstreet7@gmail.com") return true;
      return false;
    }

    if (action === "report") {
      const id = crypto.randomUUID();
      const row = {
        id,
        target_type: body.targetType,
        target_id: body.targetId,
        post_id: body.postId || null,
        reason: String(body.reason || "unspecified").slice(0, 200),
        details: String(body.details || "").slice(0, 2000),
        reporter_device_id: body.deviceId || null,
        reporter_name: body.reporterName || null,
      };
      const { error } = await supabase.from("harbor_reports").insert(row);
      if (error) return cors({ error: error.message }, 400);
      await supabase.from("harbor_moderation_events").insert({
        id: crypto.randomUUID(),
        action: "report",
        target_type: row.target_type,
        target_id: row.target_id,
        actor: row.reporter_name || row.reporter_device_id || "anonymous",
        reason: row.reason,
        meta: { details: row.details },
      });
      return cors({ ok: true, id });
    }

    // Language strike notify — Harbor Watch (AI) reviews the flag, then optional email
    if (action === "notify_strike" || action === "watch_review") {
      const alertId = String(body.alertId || "");
      let alertRow: Record<string, unknown> | null = null;
      if (alertId) {
        const { data } = await supabase
          .from("harbor_mod_alerts")
          .select("id,kind,email,display_name,match_text,sample_text,user_id,ai_review")
          .eq("id", alertId)
          .maybeSingle();
        if (!data) return cors({ error: "Unknown alert" }, 404);
        alertRow = data;
        body.kind = data.kind;
        body.email = data.email;
        body.displayName = data.display_name;
        body.match = data.match_text;
        body.sample = data.sample_text;
        body.userId = data.user_id;
      } else if (!(await callerIsAdmin())) {
        return cors({ error: "Unauthorized" }, 401);
      }

      const kind = String(body.kind || "warning");
      const who = String(body.displayName || body.email || body.userId || "someone");
      const match = String(body.match || "blocked language").slice(0, 120);
      const sample = String(body.sample || "").slice(0, 400);
      const strikes = Number(body.strikes || (kind === "ban" ? 2 : 1));

      // Harbor Watch — separate AI moderator (not Angel) reviews every flag
      let watch = null as null | { review: string; recommendation: string; source: string };
      const needsWatch = action === "watch_review" || !alertRow?.ai_review;
      if (needsWatch) {
        watch = await harborWatchReview({ kind, who, match, sample, strikes });
        if (alertId && watch) {
          await supabase.from("harbor_mod_alerts").update({
            ai_review: watch.review,
            ai_recommendation: watch.recommendation,
            ai_reviewed_at: new Date().toISOString(),
            watched_by: "Harbor Watch",
          }).eq("id", alertId);
        }
      }

      if (action === "watch_review") {
        return cors({ ok: true, watch, inbox: true });
      }

      const subject = kind === "ban" ? `Harbor ban: ${who}` : `Harbor warning: ${who}`;
      const text = [
        kind === "ban" ? "Automatic ban after a second language strike." : "Formal warning after blocked language.",
        `Who: ${who}`,
        body.email ? `Email: ${body.email}` : null,
        `Strikes: ${strikes}`,
        `Match: ${match}`,
        sample ? `Sample: ${sample}` : null,
        watch ? `Harbor Watch: ${watch.recommendation} — ${watch.review}` : null,
        "Flags land in Harbor → Account → Admin → Moderation alerts (Harbor Watch reviews them there).",
      ].filter(Boolean).join("\n");

      const resendKey = Deno.env.get("RESEND_API_KEY") || "";
      const toEmail = Deno.env.get("HARBOR_ALERT_EMAIL") || "owenstreet7@gmail.com";
      const fromEmail = Deno.env.get("HARBOR_ALERT_FROM") || "Harbor <onboarding@resend.dev>";

      if (resendKey) {
        const mail = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ from: fromEmail, to: [toEmail], subject, text }),
        });
        if (!mail.ok) {
          const errText = await mail.text();
          return cors({ ok: true, emailed: false, error: errText.slice(0, 300), inbox: true, watch });
        }
        return cors({ ok: true, emailed: true, watch });
      }

      return cors({ ok: true, emailed: false, inbox: true, watch });
    }

    // Member deletes their own account (avatar + profile cascade + auth user)
    if (action === "delete_own_account") {
      const authHeader = req.headers.get("Authorization") || "";
      const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
      if (!jwt || !anonKey) return cors({ error: "Sign in first" }, 401);

      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
      });
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData?.user) return cors({ error: "Sign in first" }, 401);

      const uid = userData.user.id;
      const email = (userData.user.email || "").toLowerCase();
      if (email === "owenstreet7@gmail.com") {
        return cors({ error: "The Harbor host account can’t be deleted this way." }, 400);
      }

      // Remove avatar objects before auth cascade (trigger also cleans on profile delete)
      try {
        const folder = await supabase.storage.from("harbor-avatars").list(uid, { limit: 20 });
        const names = (folder.data || []).map((f) => `${uid}/${f.name}`);
        if (names.length) await supabase.storage.from("harbor-avatars").remove(names);
        await supabase.storage.from("harbor-avatars").remove([`${uid}/avatar.jpg`]);
      } catch (_) {
        // Storage may already be empty
      }

      const { error: delErr } = await supabase.auth.admin.deleteUser(uid);
      if (delErr) return cors({ error: delErr.message || "Could not delete account" }, 400);

      try {
        await supabase.from("harbor_moderation_events").insert({
          id: crypto.randomUUID(),
          action: "delete_own_account",
          target_type: "user",
          target_id: uid,
          actor: email || uid,
          reason: "Member deleted their own account",
        });
      } catch (_) {
        // Audit trail is best-effort; account is already gone
      }

      return cors({ ok: true });
    }

    // Admin-only below
    if (!(await callerIsAdmin())) {
      return cors({ error: "Unauthorized" }, 401);
    }

    if (action === "hide_post") {
      const postId = String(body.postId || "");
      const reason = String(body.reason || "Removed for guidelines violation").slice(0, 500);
      const { data: post, error: getErr } = await supabase.from("harbor_posts").select("*").eq("id", postId).maybeSingle();
      if (getErr || !post) return cors({ error: getErr?.message || "Post not found" }, 404);

      await supabase.from("harbor_content_archive").insert({
        id: crypto.randomUUID(),
        original_type: "post",
        original_id: postId,
        post_id: postId,
        payload: post,
        reason,
        deleted_by: "admin",
      });

      const { error } = await supabase.from("harbor_posts").update({
        is_hidden: true,
        hidden_reason: reason,
      }).eq("id", postId);
      if (error) return cors({ error: error.message }, 400);

      await supabase.from("harbor_moderation_events").insert({
        id: crypto.randomUUID(),
        action: "hide_post",
        target_type: "post",
        target_id: postId,
        actor: "admin",
        reason,
      });
      return cors({ ok: true });
    }

    if (action === "ban") {
      const banType = body.banType === "username" ? "username" : "device";
      const banValue = String(body.banValue || "").trim().toLowerCase();
      const reason = String(body.reason || "Guidelines violation").slice(0, 500);
      if (!banValue) return cors({ error: "Missing ban value" }, 400);

      const { error } = await supabase.from("harbor_bans").insert({
        id: crypto.randomUUID(),
        ban_type: banType,
        ban_value: banValue,
        reason,
        active: true,
        created_by: "admin",
      });
      if (error) return cors({ error: error.message }, 400);

      await supabase.from("harbor_moderation_events").insert({
        id: crypto.randomUUID(),
        action: "ban",
        target_type: banType,
        target_id: banValue,
        actor: "admin",
        reason,
      });
      return cors({ ok: true });
    }

    if (action === "list_reports") {
      const { data, error } = await supabase
        .from("harbor_reports")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) return cors({ error: error.message }, 400);
      return cors({ ok: true, reports: data || [] });
    }

    return cors({ error: "Unknown action" }, 400);
  } catch (err) {
    return cors({ error: String(err?.message || err) }, 500);
  }
});

function cors(payload: Record<string, unknown> | null, status = 200) {
  return new Response(payload ? JSON.stringify(payload) : null, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-harbor-admin",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  });
}

/** Harbor Watch — AI moderator account that reviews language flags for the host. */
async function harborWatchReview(input: {
  kind: string;
  who: string;
  match: string;
  sample: string;
  strikes: number;
}): Promise<{ review: string; recommendation: string; source: string }> {
  const fallback = localWatchReview(input);
  const groqKey = Deno.env.get("GROQ_API_KEY") || "";
  const openAiKey = Deno.env.get("OPENAI_API_KEY") || "";
  if (!groqKey && !openAiKey) return { ...fallback, source: "local" };

  const apiUrl = groqKey
    ? "https://api.groq.com/openai/v1/chat/completions"
    : "https://api.openai.com/v1/chat/completions";
  const apiKey = groqKey || openAiKey;
  const model = Deno.env.get("HARBOR_WATCH_MODEL")
    || (groqKey ? "llama-3.3-70b-versatile" : "gpt-4o-mini");

  const system = `You are Harbor Watch — a separate AI moderator account for the Harbor community app.
You are NOT the Angel companion. You only review language/hate flags for the human host.

Harbor policy: first blocked-language strike = warning; second = ban.
Respond with ONLY compact JSON (no markdown):
{"recommendation":"keep_warning|ban_appropriate|review_manually|likely_false_positive","review":"1-2 short sentences for the host"}

Be calm, practical, and specific. Flag hate/slurs/threats as serious. Mild edge cases may be likely_false_positive.`;

  try {
    const upstream = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 180,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: [
              `Action already taken: ${input.kind}`,
              `Strikes: ${input.strikes}`,
              `Member: ${input.who}`,
              `Matched: ${input.match}`,
              `Sample: """${input.sample || "(empty)"}"""`,
              "Review this flag for the host.",
            ].join("\n"),
          },
        ],
      }),
    });
    if (!upstream.ok) return { ...fallback, source: "local" };
    const data = await upstream.json();
    const raw = String(data?.choices?.[0]?.message?.content || "").trim();
    const parsed = parseWatchJson(raw);
    if (!parsed) return { ...fallback, source: "local" };
    return { ...parsed, source: "ai" };
  } catch (_) {
    return { ...fallback, source: "local" };
  }
}

function parseWatchJson(raw: string): { review: string; recommendation: string } | null {
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const obj = JSON.parse(raw.slice(start, end + 1));
    const recommendation = String(obj.recommendation || "").trim();
    const review = String(obj.review || "").trim().slice(0, 400);
    const allowed = new Set([
      "keep_warning",
      "ban_appropriate",
      "review_manually",
      "likely_false_positive",
    ]);
    if (!review || !allowed.has(recommendation)) return null;
    return { recommendation, review };
  } catch (_) {
    return null;
  }
}

function localWatchReview(input: {
  kind: string;
  who: string;
  match: string;
  sample: string;
  strikes: number;
}): { review: string; recommendation: string; source: string } {
  const sample = `${input.match} ${input.sample}`.toLowerCase();
  const severe = /(kill|rape|nigger|faggot|gas the|lynch|genocide)/i.test(sample);
  if (input.kind === "ban" || input.strikes >= 2) {
    return {
      recommendation: severe ? "ban_appropriate" : "ban_appropriate",
      review: severe
        ? `Harbor Watch: severe language from ${input.who}. Ban looks appropriate — check if you want a longer restriction.`
        : `Harbor Watch: second strike for ${input.who}. Automatic ban applied; skim the sample if you want to reverse it.`,
      source: "local",
    };
  }
  if (severe) {
    return {
      recommendation: "review_manually",
      review: `Harbor Watch: first strike, but the sample looks severe. Warning stands — consider watching this account closely.`,
      source: "local",
    };
  }
  return {
    recommendation: "keep_warning",
    review: `Harbor Watch: first-strike warning for “${input.match || "blocked language"}”. No extra action needed unless this keeps happening.`,
    source: "local",
  };
}
