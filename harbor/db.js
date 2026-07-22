/* Harbor Supabase adapter — no-ops until config.js is filled in */
(function () {
  const cfg = window.HARBOR_CONFIG || {};
  let client = null;
  let ready = false;

  function configured() {
    return !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
  }

  let lastError = null;

  async function init() {
    lastError = null;
    if (!configured()) {
      ready = false;
      return false;
    }
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    // Probe that schema exists
    const { error } = await client.from('harbor_posts').select('id').limit(1);
    if (error) {
      lastError = error;
      ready = false;
      console.warn('Harbor cloud schema not ready:', error.message || error);
      return false;
    }
    ready = true;
    return true;
  }

  function currentUserId() {
    try {
      return (window.HarborAuth && HarborAuth.getState && HarborAuth.getState().user?.id) || null;
    } catch (_) {
      return null;
    }
  }

  function writeClient() {
    // Prefer signed-in client so user_id stamps / edit RPCs see auth.uid()
    return authedClient() || client;
  }

  function mapPost(row, replies = [], avatars = {}) {
    const uid = row.user_id || null;
    return {
      id: row.id,
      featured: !!row.featured,
      authorMode: row.author_mode,
      authorName: row.author_name,
      text: row.body,
      tags: row.tags || [],
      createdAt: new Date(row.created_at).getTime(),
      editedAt: row.edited_at ? new Date(row.edited_at).getTime() : null,
      angelLine: row.angel_line,
      angelNote: row.angel_note,
      feltCount: row.felt_count || 0,
      private: !!row.is_private,
      deviceId: row.device_id || null,
      userId: uid,
      avatarUrl: (uid && avatars[uid]) || null,
      replies,
      cloud: true,
    };
  }

  function mapReply(row, avatars = {}) {
    const uid = row.user_id || null;
    return {
      id: row.id,
      authorMode: row.author_mode,
      authorName: row.author_name,
      text: row.body,
      createdAt: new Date(row.created_at).getTime(),
      editedAt: row.edited_at ? new Date(row.edited_at).getTime() : null,
      deviceId: row.device_id || null,
      userId: uid,
      avatarUrl: (uid && avatars[uid]) || null,
      cloud: true,
    };
  }

  async function fetchAvatarMap(userIds) {
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (!ids.length || !ready) return {};
    const c = writeClient();
    const { data, error } = await c
      .from('harbor_profiles')
      .select('id,avatar_url')
      .in('id', ids);
    if (error) {
      console.warn('Harbor avatar lookup failed', error.message || error);
      return {};
    }
    const map = {};
    (data || []).forEach((row) => {
      if (row.avatar_url) map[row.id] = row.avatar_url;
    });
    return map;
  }

  async function listPosts() {
    if (!ready) return null;
    const { data, error } = await client
      .from('harbor_posts')
      .select('*')
      .eq('is_private', false)
      .order('featured', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Prefer RLS (is_hidden = false); also filter client-side if column is present.
    const posts = (data || []).filter((p) => !p.is_hidden);
    const ids = posts.map((p) => p.id);
    let repliesByPost = {};
    let replyRows = [];
    if (ids.length) {
      const { data: replies, error: rErr } = await client
        .from('harbor_replies')
        .select('*')
        .in('post_id', ids)
        .order('created_at', { ascending: true });
      if (rErr) throw rErr;
      replyRows = (replies || []).filter((r) => !r.is_hidden);
      replyRows.forEach((r) => {
        if (!repliesByPost[r.post_id]) repliesByPost[r.post_id] = [];
        repliesByPost[r.post_id].push(r);
      });
    }
    const avatarIds = [
      ...posts.map((p) => p.user_id),
      ...replyRows.map((r) => r.user_id),
    ];
    const avatars = await fetchAvatarMap(avatarIds);
    return posts.map((p) => mapPost(
      p,
      (repliesByPost[p.id] || []).map((r) => mapReply(r, avatars)),
      avatars
    ));
  }

  async function createPost(post) {
    if (!ready || post.private) return null;
    const c = writeClient();
    const row = {
      id: post.id,
      featured: !!post.featured,
      author_mode: post.authorMode,
      author_name: post.authorName,
      body: post.text,
      tags: post.tags || [],
      angel_line: post.angelLine,
      angel_note: post.angelNote,
      felt_count: post.feltCount || 0,
      is_private: false,
      device_id: post.deviceId || null,
      user_id: post.userId || currentUserId(),
      created_at: new Date(post.createdAt || Date.now()).toISOString(),
    };
    let { error } = await c.from('harbor_posts').insert(row);
    if (error && /user_id|edited_at|PGRST/i.test(error.message || '')) {
      delete row.user_id;
      ({ error } = await c.from('harbor_posts').insert(row));
    }
    if (error) throw error;
    return true;
  }

  async function getPost(id) {
    if (!ready) return null;
    const { data, error } = await client.from('harbor_posts').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const { data: replies, error: rErr } = await client
      .from('harbor_replies')
      .select('*')
      .eq('post_id', id)
      .order('created_at', { ascending: true });
    if (rErr) throw rErr;
    const replyRows = (replies || []).filter((r) => !r.is_hidden);
    const avatars = await fetchAvatarMap([
      data.user_id,
      ...replyRows.map((r) => r.user_id),
    ]);
    return mapPost(data, replyRows.map((r) => mapReply(r, avatars)), avatars);
  }

  async function addReply(postId, reply) {
    if (!ready) return null;
    const c = writeClient();
    const row = {
      id: reply.id,
      post_id: postId,
      author_mode: reply.authorMode,
      author_name: reply.authorName,
      body: reply.text,
      device_id: reply.deviceId || null,
      user_id: reply.userId || currentUserId(),
      created_at: new Date(reply.createdAt || Date.now()).toISOString(),
    };
    let { error } = await c.from('harbor_replies').insert(row);
    if (error && /user_id|edited_at|PGRST/i.test(error.message || '')) {
      delete row.user_id;
      ({ error } = await c.from('harbor_replies').insert(row));
    }
    if (error) throw error;
    return true;
  }

  function editSetupError(msg) {
    if (/function|does not exist|PGRST202/i.test(msg || '')) {
      return 'Edit/delete isn’t set up in Supabase yet — run supabase-edit.sql, then try again.';
    }
    return msg || 'Could not complete that action';
  }

  async function updatePost(postId, text, { deviceId = null } = {}) {
    if (!ready) return null;
    if (!currentUserId()) throw new Error('Sign in to edit.');
    const c = writeClient();
    const cleaned = String(text || '').trim();
    if (!cleaned) throw new Error('Message can’t be empty');
    const rpc = await c.rpc('harbor_edit_post', {
      p_id: postId,
      p_body: cleaned,
      p_device_id: deviceId || null,
    });
    if (rpc.error) throw new Error(editSetupError(rpc.error.message));
    const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
    return row ? mapPost(row, []) : { id: postId, text: cleaned, editedAt: Date.now() };
  }

  async function updateReply(replyId, text, { deviceId = null } = {}) {
    if (!ready) return null;
    if (!currentUserId()) throw new Error('Sign in to edit.');
    const c = writeClient();
    const cleaned = String(text || '').trim();
    if (!cleaned) throw new Error('Message can’t be empty');
    const rpc = await c.rpc('harbor_edit_reply', {
      p_id: replyId,
      p_body: cleaned,
      p_device_id: deviceId || null,
    });
    if (rpc.error) throw new Error(editSetupError(rpc.error.message));
    const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
    return row ? mapReply(row) : { id: replyId, text: cleaned, editedAt: Date.now() };
  }

  async function hidePost(postId, reason = 'Removed by admin') {
    if (!ready) return null;
    if (!currentUserId()) throw new Error('Sign in as admin to delete.');
    const c = writeClient();
    const rpc = await c.rpc('harbor_admin_hide_post', {
      p_id: postId,
      p_reason: String(reason || 'Removed by admin').slice(0, 500),
    });
    if (!rpc.error) return true;
    // Fallback to edge moderation function if RPC missing
    if (/function|does not exist|PGRST202/i.test(rpc.error.message || '')) {
      await modAction({ action: 'hide_post', postId, reason });
      return true;
    }
    throw new Error(editSetupError(rpc.error.message));
  }

  async function hideReply(replyId, reason = 'Removed by admin') {
    if (!ready) return null;
    if (!currentUserId()) throw new Error('Sign in as admin to delete.');
    const c = writeClient();
    const rpc = await c.rpc('harbor_admin_hide_reply', {
      p_id: replyId,
      p_reason: String(reason || 'Removed by admin').slice(0, 500),
    });
    if (rpc.error) throw new Error(editSetupError(rpc.error.message));
    return true;
  }

  async function isBanned({ deviceId, username, userId } = {}) {
    if (!ready) return false;
    const uid = userId || currentUserId();
    const checks = [];
    if (uid) {
      checks.push(
        client.from('harbor_bans').select('id').eq('active', true).eq('ban_type', 'user').eq('ban_value', String(uid).toLowerCase()).limit(1)
      );
    }
    if (deviceId) {
      checks.push(
        client.from('harbor_bans').select('id').eq('active', true).eq('ban_type', 'device').eq('ban_value', deviceId).limit(1)
      );
    }
    if (username) {
      checks.push(
        client.from('harbor_bans').select('id').eq('active', true).eq('ban_type', 'username').eq('ban_value', String(username).toLowerCase()).limit(1)
      );
    }
    if (!checks.length) return false;
    const results = await Promise.all(checks);
    return results.some((r) => !r.error && r.data && r.data.length);
  }

  async function recordLanguageStrike({
    sample = '',
    match = '',
    deviceId = null,
    username = null,
    targetUserId = null,
  } = {}) {
    if (!ready) return null;
    if (!currentUserId()) throw new Error('Sign in required');
    const c = writeClient();
    const rpc = await c.rpc('harbor_apply_language_strike', {
      p_sample: String(sample || '').slice(0, 500),
      p_match: String(match || '').slice(0, 120),
      p_device_id: deviceId || null,
      p_username: username || null,
      p_target_user_id: targetUserId || null,
    });
    if (rpc.error) {
      if (/function|does not exist|PGRST202/i.test(rpc.error.message || '')) {
        throw new Error('Strike system isn’t set up yet — run supabase-strikes.sql in Supabase.');
      }
      throw new Error(rpc.error.message || 'Could not record warning');
    }
    const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
    // Fire-and-forget email/push path via edge function (optional)
    try {
      await modAction({
        action: 'notify_strike',
        kind: row?.status || row?.kind,
        email: row?.email,
        displayName: row?.displayName,
        match: row?.match,
        sample: row?.sample,
        strikes: row?.strikes,
        userId: row?.userId,
        alertId: row?.alertId,
      });
    } catch (_) {}
    return row;
  }

  async function listModAlerts({ limit = 40 } = {}) {
    if (!ready) return [];
    const c = writeClient();
    const { data, error } = await c
      .from('harbor_mod_alerts')
      .select('id,kind,user_id,email,display_name,device_id,username,match_text,sample_text,created_at,read_at,ai_review,ai_recommendation,ai_reviewed_at,watched_by')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      // Older DBs before Harbor Watch columns
      if (/ai_review|watched_by|column/i.test(error.message || '')) {
        const retry = await c
          .from('harbor_mod_alerts')
          .select('id,kind,user_id,email,display_name,device_id,username,match_text,sample_text,created_at,read_at')
          .order('created_at', { ascending: false })
          .limit(limit);
        if (retry.error) {
          if (/relation|does not exist|PGRST/i.test(retry.error.message || '')) return [];
          throw retry.error;
        }
        return retry.data || [];
      }
      if (/relation|does not exist|PGRST/i.test(error.message || '')) return [];
      throw error;
    }
    return data || [];
  }

  async function requestWatchReview(alertId) {
    if (!alertId) return null;
    return modAction({ action: 'watch_review', alertId });
  }

  async function markModAlertRead(alertId) {
    if (!ready || !alertId) return false;
    const c = writeClient();
    const rpc = await c.rpc('harbor_mark_mod_alert_read', { p_id: alertId });
    if (rpc.error) {
      const { error } = await c
        .from('harbor_mod_alerts')
        .update({ read_at: new Date().toISOString() })
        .eq('id', alertId);
      if (error) throw error;
    }
    return true;
  }

  async function modAction(payload, adminSecret) {
    const url = cfg.supabaseUrl;
    const key = cfg.supabaseAnonKey;
    if (!url || !key) throw new Error('Cloud not configured');
    const endpoint = `${url.replace(/\/$/, '')}/functions/v1/harbor-moderation`;
    const userJwt = (window.HarborAuth && HarborAuth.accessToken && HarborAuth.accessToken()) || '';
    const headers = {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${userJwt || key}`,
    };
    if (adminSecret) headers['x-harbor-admin'] = adminSecret;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Moderation HTTP ${res.status}`);
    return data;
  }

  async function incrementFelt(postId) {
    if (!ready) return null;
    const { data, error } = await client.from('harbor_posts').select('felt_count').eq('id', postId).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const next = (data.felt_count || 0) + 1;
    const { error: uErr } = await client.from('harbor_posts').update({ felt_count: next }).eq('id', postId);
    if (uErr) throw uErr;
    return next;
  }

  let authed = null;
  let authedJwt = '';

  function baseClient() {
    if (!configured()) return null;
    return client || window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  }

  function authedClient() {
    if (!configured()) return null;
    // Prefer HarborAuth’s client — it holds the real session. A second client with only
    // an Authorization header gets overwritten by the anon/publishable key, so RPC
    // sees auth.uid() = null (“Not signed in”) and Generate just flashes.
    if (window.HarborAuth && typeof HarborAuth.getClient === 'function') {
      const shared = HarborAuth.getClient();
      if (shared) return shared;
    }
    // Fallback only if Auth isn’t ready yet
    const jwt = (window.HarborAuth && HarborAuth.accessToken && HarborAuth.accessToken()) || '';
    if (!authed || authedJwt !== jwt) {
      authedJwt = jwt;
      authed = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        global: jwt ? { headers: { Authorization: `Bearer ${jwt}` } } : undefined,
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
    }
    return authed;
  }

  async function validateInvite(code) {
    const c = baseClient();
    if (!c) return false;
    const normalized = String(code || '').trim().toLowerCase();
    if (!normalized) return false;
    const { data, error } = await c
      .from('harbor_invites')
      .select('code,active,use_count,max_uses')
      .eq('code', normalized)
      .eq('active', true)
      .maybeSingle();
    if (error) {
      // Table may not exist yet — caller can fall back to config codes
      console.warn('Harbor invite lookup failed', error.message || error);
      return false;
    }
    if (!data) return false;
    if (data.max_uses != null && data.use_count >= data.max_uses) return false;
    return true;
  }

  async function listInvites() {
    const c = authedClient();
    if (!c) throw new Error('Cloud not configured');
    const query = c
      .from('harbor_invites')
      .select('code,note,active,use_count,max_uses,created_at')
      .order('created_at', { ascending: false });
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  function newInviteCode() {
    const rand = (crypto.randomUUID && crypto.randomUUID().slice(0, 8))
      || Math.random().toString(16).slice(2, 10);
    return `shore-${rand}`;
  }

  async function createInvite(note = '', code = '') {
    const c = authedClient();
    if (!c) throw new Error('Cloud not configured');
    const token = (window.HarborAuth && HarborAuth.accessToken && HarborAuth.accessToken()) || '';
    if (!token) throw new Error('Sign in again, then tap Generate invite code.');

    const normalized = String(code || newInviteCode()).trim().toLowerCase();
    const payload = {
      p_code: normalized,
      p_note: String(note || 'Admin invite').slice(0, 120),
      p_max_uses: 50,
    };

    // Prefer SECURITY DEFINER RPC (works even if profile.role is stale)
    const rpc = await c.rpc('harbor_create_invite', payload);
    if (!rpc.error && rpc.data) {
      return Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
    }

    // Fallback: direct insert (needs admin RLS / owner-email policy)
    const row = {
      code: normalized,
      note: payload.p_note,
      active: true,
      max_uses: 50,
      created_by: (window.HarborAuth && HarborAuth.getState && HarborAuth.getState().user?.id) || null,
    };
    const { data, error } = await c
      .from('harbor_invites')
      .insert(row)
      .select('code,note,active,use_count,max_uses,created_at')
      .maybeSingle();
    if (error) {
      const rpcMsg = rpc.error?.message || '';
      throw new Error(rpcMsg || error.message || 'Could not create invite');
    }
    if (!data && rpc.error) {
      throw new Error(rpc.error.message || 'Could not create invite');
    }
    return data || row;
  }

  window.HarborDB = {
    init,
    configured,
    isReady: () => ready,
    lastError: () => lastError,
    listPosts,
    createPost,
    getPost,
    addReply,
    updatePost,
    updateReply,
    hidePost,
    hideReply,
    incrementFelt,
    isBanned,
    recordLanguageStrike,
    listModAlerts,
    markModAlertRead,
    requestWatchReview,
    modAction,
    validateInvite,
    listInvites,
    createInvite,
  };
})();
