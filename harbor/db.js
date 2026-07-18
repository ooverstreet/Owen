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

  function mapPost(row, replies = []) {
    return {
      id: row.id,
      featured: !!row.featured,
      authorMode: row.author_mode,
      authorName: row.author_name,
      text: row.body,
      tags: row.tags || [],
      createdAt: new Date(row.created_at).getTime(),
      angelLine: row.angel_line,
      angelNote: row.angel_note,
      feltCount: row.felt_count || 0,
      private: !!row.is_private,
      deviceId: row.device_id || null,
      replies,
      cloud: true,
    };
  }

  function mapReply(row) {
    return {
      id: row.id,
      authorMode: row.author_mode,
      authorName: row.author_name,
      text: row.body,
      createdAt: new Date(row.created_at).getTime(),
      cloud: true,
    };
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

    const posts = data || [];
    const ids = posts.map((p) => p.id);
    let repliesByPost = {};
    if (ids.length) {
      const { data: replies, error: rErr } = await client
        .from('harbor_replies')
        .select('*')
        .in('post_id', ids)
        .order('created_at', { ascending: true });
      if (rErr) throw rErr;
      (replies || []).forEach((r) => {
        if (!repliesByPost[r.post_id]) repliesByPost[r.post_id] = [];
        repliesByPost[r.post_id].push(mapReply(r));
      });
    }
    return posts.map((p) => mapPost(p, repliesByPost[p.id] || []));
  }

  async function createPost(post) {
    if (!ready || post.private) return null;
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
      created_at: new Date(post.createdAt || Date.now()).toISOString(),
    };
    const { error } = await client.from('harbor_posts').insert(row);
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
    return mapPost(data, (replies || []).map(mapReply));
  }

  async function addReply(postId, reply) {
    if (!ready) return null;
    const row = {
      id: reply.id,
      post_id: postId,
      author_mode: reply.authorMode,
      author_name: reply.authorName,
      body: reply.text,
      device_id: reply.deviceId || null,
      created_at: new Date(reply.createdAt || Date.now()).toISOString(),
    };
    const { error } = await client.from('harbor_replies').insert(row);
    if (error) throw error;
    return true;
  }

  async function isBanned({ deviceId, username }) {
    if (!ready) return false;
    const checks = [];
    if (deviceId) checks.push(client.from('harbor_bans').select('id').eq('active', true).eq('ban_type', 'device').eq('ban_value', deviceId).limit(1));
    if (username) checks.push(client.from('harbor_bans').select('id').eq('active', true).eq('ban_type', 'username').eq('ban_value', String(username).toLowerCase()).limit(1));
    const results = await Promise.all(checks);
    return results.some((r) => !r.error && r.data && r.data.length);
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

  function baseClient() {
    if (!configured()) return null;
    return client || window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  }

  function authedClient() {
    if (!configured()) return null;
    const jwt = (window.HarborAuth && HarborAuth.accessToken && HarborAuth.accessToken()) || '';
    return window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      global: jwt ? { headers: { Authorization: `Bearer ${jwt}` } } : undefined,
    });
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

  async function createInvite(note = '') {
    const c = authedClient();
    if (!c) throw new Error('Cloud not configured');
    const rand = (crypto.randomUUID && crypto.randomUUID().slice(0, 8))
      || Math.random().toString(16).slice(2, 10);
    const code = `shore-${rand}`;
    const row = {
      code,
      note: String(note || 'Admin invite').slice(0, 120),
      active: true,
      max_uses: 50,
      created_by: (window.HarborAuth && HarborAuth.getState && HarborAuth.getState().user?.id) || null,
    };
    const { data, error } = await c.from('harbor_invites').insert(row).select('code,note,active,use_count,max_uses,created_at').maybeSingle();
    if (error) throw error;
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
    incrementFelt,
    isBanned,
    modAction,
    validateInvite,
    listInvites,
    createInvite,
  };
})();
