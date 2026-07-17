/* Harbor Supabase adapter — no-ops until config.js is filled in */
(function () {
  const cfg = window.HARBOR_CONFIG || {};
  let client = null;
  let ready = false;

  function configured() {
    return !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
  }

  async function init() {
    if (!configured()) {
      ready = false;
      return false;
    }
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
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
      created_at: new Date(reply.createdAt || Date.now()).toISOString(),
    };
    const { error } = await client.from('harbor_replies').insert(row);
    if (error) throw error;
    return true;
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

  window.HarborDB = {
    init,
    configured,
    isReady: () => ready,
    listPosts,
    createPost,
    getPost,
    addReply,
    incrementFelt,
  };
})();
