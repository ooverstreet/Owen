/* Harbor Auth — Supabase email/password login + role-aware profile */
(function () {
  const cfg = window.HARBOR_CONFIG || {};
  let client = null;
  let session = null;
  let profile = null;
  let adminPromoteTried = false;
  const listeners = new Set();

  function configured() {
    return !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
  }

  function siteUrl() {
    if (cfg.siteUrl) return String(cfg.siteUrl).replace(/\/?$/, '/');
    try {
      const url = new URL(location.href);
      // Keep path under /Owen/harbor/ even if opened with index.html or query params
      const path = url.pathname.replace(/index\.html$/i, '');
      const base = path.endsWith('/') ? path : path.replace(/\/[^/]*$/, '/');
      return `${url.origin}${base}`;
    } catch (_) {
      return 'https://ooverstreet.github.io/Owen/harbor/';
    }
  }

  function emit() {
    listeners.forEach((fn) => {
      try { fn(getState()); } catch (_) {}
    });
  }

  function ownerEmail(email) {
    return String(email || '').trim().toLowerCase() === 'owenstreet7@gmail.com';
  }

  function computeIsAdmin() {
    if (profile && profile.role === 'admin') return true;
    // Owner email is always admin, even if the profile row is missing/stale
    if (ownerEmail(session?.user?.email) || ownerEmail(profile?.email)) return true;
    return false;
  }

  function getState() {
    return {
      ready: !!client,
      session,
      user: session?.user || null,
      profile,
      isAdmin: computeIsAdmin(),
      isLoggedIn: !!session?.user,
      guidelinesAccepted: !!(profile && profile.guidelines_accepted_at),
    };
  }

  function syncGuidelinesLocal(accepted) {
    if (!accepted) return;
    try { localStorage.setItem('harbor.guidelines.v1', 'accepted'); } catch (_) {}
    try {
      document.cookie = 'harbor_guidelines=accepted; Max-Age=31536000; Path=/; SameSite=Lax';
    } catch (_) {}
  }

  function localGuidelinesAccepted() {
    try {
      if (localStorage.getItem('harbor.guidelines.v1') === 'accepted') return true;
    } catch (_) {}
    try {
      return document.cookie.split(';').some((part) => part.trim() === 'harbor_guidelines=accepted');
    } catch (_) {
      return false;
    }
  }

  async function init() {
    if (!configured()) return getState();
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: {
        detectSessionInUrl: true,
        persistSession: true,
        autoRefreshToken: true,
      },
    });

    // Email confirmation / magic links land with tokens in the URL hash or query
    try {
      const url = new URL(location.href);
      const hasAuthParams = !!(
        url.searchParams.get('code')
        || url.hash.includes('access_token')
        || url.hash.includes('type=signup')
        || url.hash.includes('type=email')
      );
      if (hasAuthParams && client.auth.exchangeCodeForSession) {
        // PKCE code exchange when present; ignore failures and fall back to getSession
        if (url.searchParams.get('code')) {
          await client.auth.exchangeCodeForSession(location.href).catch(() => {});
        }
      }
    } catch (_) {}

    const { data } = await client.auth.getSession();
    session = data.session || null;
    if (session?.user) await refreshProfile();
    client.auth.onAuthStateChange(async (_event, next) => {
      session = next;
      if (session?.user) await refreshProfile();
      else profile = null;
      emit();
    });
    emit();
    return getState();
  }

  async function refreshProfile() {
    if (!client || !session?.user) {
      profile = null;
      return null;
    }
    const { data, error } = await client
      .from('harbor_profiles')
      .select('id,email,display_name,role,created_at,guidelines_accepted_at,strike_count,warned_at')
      .eq('id', session.user.id)
      .maybeSingle();
    if (error) {
      // Older DBs may not have guidelines_accepted_at yet — retry without it
      const retry = await client
        .from('harbor_profiles')
        .select('id,email,display_name,role,created_at')
        .eq('id', session.user.id)
        .maybeSingle();
      if (retry.error) {
        console.warn('Harbor profile load failed', error);
        profile = null;
        return null;
      }
      profile = retry.data || null;
    } else if (!data) {
      const email = session.user.email || '';
      profile = {
        id: session.user.id,
        email,
        display_name: email.split('@')[0] || 'Harbor friend',
        role: email.toLowerCase() === 'owenstreet7@gmail.com' ? 'admin' : 'member',
        guidelines_accepted_at: null,
      };
    } else {
      profile = data;
    }

    // Keep Owen as admin in memory. DB promote needs SQL (RLS blocks self-role changes).
    if (profile && ownerEmail(session.user.email || profile.email) && profile.role !== 'admin') {
      profile = { ...profile, role: 'admin' };
      if (!adminPromoteTried) {
        adminPromoteTried = true;
        // Best-effort only; ignore failures so phones don't stall
        client
          .from('harbor_profiles')
          .update({ role: 'admin', updated_at: new Date().toISOString() })
          .eq('id', session.user.id)
          .then(({ error: roleErr }) => {
            if (roleErr) console.warn('Harbor admin promote failed (run supabase-admin-promote.sql)', roleErr);
          })
          .catch(() => {});
      }
    }

    if (profile?.guidelines_accepted_at) {
      syncGuidelinesLocal(true);
    } else if (profile && localGuidelinesAccepted()) {
      // Device already agreed — attach that to the account once
      const stamp = new Date().toISOString();
      const { error: syncErr } = await client
        .from('harbor_profiles')
        .update({ guidelines_accepted_at: stamp, updated_at: stamp })
        .eq('id', session.user.id);
      if (!syncErr) profile = { ...profile, guidelines_accepted_at: stamp };
    }
    return profile;
  }

  async function acceptGuidelines() {
    syncGuidelinesLocal(true);
    if (!client || !session?.user) return getState().guidelinesAccepted || localGuidelinesAccepted();
    const stamp = new Date().toISOString();
    const { error } = await client
      .from('harbor_profiles')
      .update({ guidelines_accepted_at: stamp, updated_at: stamp })
      .eq('id', session.user.id);
    if (error) {
      console.warn('Harbor guidelines cloud save failed', error);
      return localGuidelinesAccepted();
    }
    if (profile) profile = { ...profile, guidelines_accepted_at: stamp };
    else await refreshProfile();
    emit();
    return true;
  }

  async function signUp(email, password, displayName) {
    if (!client) throw new Error('Auth not ready');
    const { data, error } = await client.auth.signUp({
      email: email.trim(),
      password,
      options: {
        emailRedirectTo: siteUrl(),
        data: { display_name: displayName || email.split('@')[0] },
      },
    });
    if (error) throw error;
    session = data.session;
    if (session?.user) await refreshProfile();
    emit();
    return data;
  }

  async function signIn(email, password) {
    if (!client) throw new Error('Auth not ready');
    const { data, error } = await client.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) throw error;
    session = data.session;
    await refreshProfile();
    emit();
    return data;
  }

  async function signOut() {
    if (!client) return;
    await client.auth.signOut();
    session = null;
    profile = null;
    emit();
  }

  async function updateDisplayName(name) {
    if (!client || !session?.user) throw new Error('Not signed in');
    const { error } = await client
      .from('harbor_profiles')
      .update({ display_name: name, updated_at: new Date().toISOString() })
      .eq('id', session.user.id);
    if (error) throw error;
    await refreshProfile();
    emit();
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function accessToken() {
    return session?.access_token || '';
  }

  function getClient() {
    return client;
  }

  window.HarborAuth = {
    init,
    getState,
    getClient,
    signUp,
    signIn,
    signOut,
    refreshProfile,
    updateDisplayName,
    acceptGuidelines,
    onChange,
    accessToken,
    siteUrl,
    isAdmin: () => getState().isAdmin,
    isLoggedIn: () => getState().isLoggedIn,
    guidelinesAccepted: () => !!(getState().guidelinesAccepted || localGuidelinesAccepted()),
  };
})();
