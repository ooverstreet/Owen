/* Harbor Auth — Supabase email/password login + role-aware profile */
(function () {
  const cfg = window.HARBOR_CONFIG || {};
  let client = null;
  let session = null;
  let profile = null;
  const listeners = new Set();

  function configured() {
    return !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
  }

  function emit() {
    listeners.forEach((fn) => {
      try { fn(getState()); } catch (_) {}
    });
  }

  function getState() {
    return {
      ready: !!client,
      session,
      user: session?.user || null,
      profile,
      isAdmin: !!(profile && profile.role === 'admin'),
      isLoggedIn: !!session?.user,
    };
  }

  async function init() {
    if (!configured()) return getState();
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
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
      .select('id,email,display_name,role,created_at')
      .eq('id', session.user.id)
      .maybeSingle();
    if (error) {
      console.warn('Harbor profile load failed', error);
      profile = null;
      return null;
    }
    // If trigger hasn’t created a row yet, create a soft local view
    if (!data) {
      const email = session.user.email || '';
      profile = {
        id: session.user.id,
        email,
        display_name: email.split('@')[0] || 'Harbor friend',
        role: email.toLowerCase() === 'owenstreet7@gmail.com' ? 'admin' : 'member',
      };
    } else {
      profile = data;
    }
    return profile;
  }

  async function signUp(email, password, displayName) {
    if (!client) throw new Error('Auth not ready');
    const { data, error } = await client.auth.signUp({
      email: email.trim(),
      password,
      options: {
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
    // Ensure Owen stays admin even if profile existed before SQL
    if (session?.user?.email?.toLowerCase() === 'owenstreet7@gmail.com' && profile && profile.role !== 'admin') {
      profile = { ...profile, role: 'admin' };
    }
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

  window.HarborAuth = {
    init,
    getState,
    signUp,
    signIn,
    signOut,
    refreshProfile,
    updateDisplayName,
    onChange,
    accessToken,
    isAdmin: () => getState().isAdmin,
    isLoggedIn: () => getState().isLoggedIn,
  };
})();
