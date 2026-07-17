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

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY") || "",
    );

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

    // Admin-only below
    if (!adminSecret || provided !== adminSecret) {
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
