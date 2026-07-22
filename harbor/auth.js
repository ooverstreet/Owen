/* Harbor Auth — Supabase email/password login + role-aware profile */
(function () {
  const cfg = window.HARBOR_CONFIG || {};
  let client = null;
  let session = null;
  let profile = null;
  let adminPromoteTried = false;
  let lastTouchAt = 0;
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
      .select('id,email,display_name,role,created_at,guidelines_accepted_at,strike_count,warned_at,avatar_url,last_active_at,password_changed_at')
      .eq('id', session.user.id)
      .maybeSingle();
    if (error) {
      // Older DBs may not have newer columns yet — retry without activity fields
      const retry = await client
        .from('harbor_profiles')
        .select('id,email,display_name,role,created_at,guidelines_accepted_at,strike_count,warned_at,avatar_url')
        .eq('id', session.user.id)
        .maybeSingle();
      if (retry.error) {
        const minimal = await client
          .from('harbor_profiles')
          .select('id,email,display_name,role,created_at')
          .eq('id', session.user.id)
          .maybeSingle();
        if (minimal.error) {
          console.warn('Harbor profile load failed', error);
          profile = null;
          return null;
        }
        profile = minimal.data || null;
      } else {
        profile = retry.data || null;
      }
    } else if (!data) {
      const email = session.user.email || '';
      profile = {
        id: session.user.id,
        email,
        display_name: email.split('@')[0] || 'Harbor friend',
        role: email.toLowerCase() === 'owenstreet7@gmail.com' ? 'admin' : 'member',
        guidelines_accepted_at: null,
        last_active_at: null,
        password_changed_at: null,
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
    lastTouchAt = 0;
    emit();
  }

  function inactiveCutoffMs() {
    const days = Number(cfg.inactiveDays);
    const safeDays = Number.isFinite(days) && days > 0 ? days : 90;
    return safeDays * 24 * 60 * 60 * 1000;
  }

  function inactiveDays() {
    const days = Number(cfg.inactiveDays);
    return Number.isFinite(days) && days > 0 ? days : 90;
  }

  /** True when the account has been quiet long enough to require a fresh password. */
  function needsPasswordRefresh() {
    if (!profile || computeIsAdmin()) return false;
    const last = profile.last_active_at || profile.created_at;
    if (!last) return false;
    return (Date.now() - new Date(last).getTime()) >= inactiveCutoffMs();
  }

  /** Bump last_active_at (throttled) when the person uses Harbor. */
  async function touchActivity() {
    if (!client || !session?.user) return null;
    if (needsPasswordRefresh()) return null;
    const now = Date.now();
    if (now - lastTouchAt < 5 * 60 * 1000) return profile?.last_active_at || null;
    lastTouchAt = now;
    try {
      const { data, error } = await client.rpc('harbor_touch_activity');
      if (error) throw error;
      if (profile && data) profile = { ...profile, last_active_at: data };
      return data;
    } catch (err) {
      console.warn('Harbor activity touch skipped', err);
      return null;
    }
  }

  async function changePassword(newPassword) {
    if (!client || !session?.user) throw new Error('Sign in first.');
    const password = String(newPassword || '');
    if (password.length < 8) {
      throw new Error('Use at least 8 characters for your new password.');
    }
    const { error } = await client.auth.updateUser({ password });
    if (error) throw error;
    try {
      const { data, error: markError } = await client.rpc('harbor_mark_password_changed');
      if (markError) throw markError;
      if (profile && data) {
        profile = { ...profile, last_active_at: data, password_changed_at: data };
      }
    } catch (err) {
      // Password already updated; activity SQL may not be run yet
      console.warn('Harbor password stamp skipped', err);
      const stamp = new Date().toISOString();
      if (profile) profile = { ...profile, last_active_at: stamp, password_changed_at: stamp };
    }
    lastTouchAt = Date.now();
    emit();
    return profile;
  }

  /** Permanently delete this account (avatar storage, profile cascade, auth user). */
  async function deleteAccount() {
    if (!client || !session?.access_token) throw new Error('Sign in first.');
    const base = String(cfg.supabaseUrl || '').replace(/\/$/, '');
    const anon = cfg.supabaseAnonKey;
    if (!base || !anon) throw new Error('Harbor is not configured.');

    const response = await fetch(`${base}/functions/v1/harbor-moderation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        apikey: anon,
      },
      body: JSON.stringify({ action: 'delete_own_account' }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || 'Could not delete account.');
    }
    session = null;
    profile = null;
    lastTouchAt = 0;
    try { await client.auth.signOut(); } catch (_) {}
    emit();
    return true;
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

  async function uploadAvatar(fileOrBlob) {
    if (!client || !session?.user) throw new Error('Sign in to add a photo.');
    if (!fileOrBlob) throw new Error('Choose a photo first.');

    let blob = fileOrBlob;
    const type = String(fileOrBlob.type || '').toLowerCase();
    // Cropper already outputs a JPEG blob — upload as-is when small enough
    const alreadyJpeg = type === 'image/jpeg' || type === 'image/jpg';
    if (!alreadyJpeg || fileOrBlob.size > 900000) {
      try {
        blob = await compressAvatar(fileOrBlob);
      } catch (err) {
        throw new Error(err.message || 'Could not read that photo. Try a JPG or PNG.');
      }
    }
    if (blob.size > 2.5 * 1024 * 1024) {
      throw new Error('Keep photos under about 2 MB.');
    }

    const path = `${session.user.id}/avatar.jpg`;
    let upErr = null;
    ({ error: upErr } = await client.storage
      .from('harbor-avatars')
      .upload(path, blob, { upsert: true, contentType: 'image/jpeg', cacheControl: '3600' }));
    // Some projects need update when the object already exists
    if (upErr && /exist|duplicate|already/i.test(upErr.message || '')) {
      ({ error: upErr } = await client.storage
        .from('harbor-avatars')
        .update(path, blob, { contentType: 'image/jpeg', cacheControl: '3600' }));
    }
    if (upErr) {
      if (/bucket|not found|row-level|policy|Unauthorized|403/i.test(upErr.message || '')) {
        throw new Error('Photo storage isn’t set up yet — run supabase-avatars.sql in Supabase, then try again.');
      }
      throw new Error(upErr.message || 'Could not upload photo.');
    }

    const { data: pub } = client.storage.from('harbor-avatars').getPublicUrl(path);
    const avatarUrl = `${pub?.publicUrl || ''}?v=${Date.now()}`;
    const { error } = await client
      .from('harbor_profiles')
      .update({ avatar_url: avatarUrl, updated_at: new Date().toISOString() })
      .eq('id', session.user.id);
    if (error) {
      if (/avatar_url|column/i.test(error.message || '')) {
        throw new Error('Photo column isn’t set up yet — run supabase-avatars.sql, then try again.');
      }
      throw error;
    }
    await refreshProfile();
    emit();
    return avatarUrl;
  }

  async function removeAvatar() {
    if (!client || !session?.user) throw new Error('Sign in to remove a photo.');
    const path = `${session.user.id}/avatar.jpg`;
    try {
      await client.storage.from('harbor-avatars').remove([path]);
    } catch (_) {}
    const { error } = await client
      .from('harbor_profiles')
      .update({ avatar_url: null, updated_at: new Date().toISOString() })
      .eq('id', session.user.id);
    if (error) throw error;
    await refreshProfile();
    emit();
  }

  function compressAvatar(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const max = 512;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob(
            (blob) => {
              URL.revokeObjectURL(url);
              if (!blob) reject(new Error('Could not process that photo.'));
              else resolve(blob);
            },
            'image/jpeg',
            0.85
          );
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not read that photo.'));
      };
      img.src = url;
    });
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
    uploadAvatar,
    removeAvatar,
    acceptGuidelines,
    touchActivity,
    needsPasswordRefresh,
    changePassword,
    deleteAccount,
    inactiveDays,
    onChange,
    accessToken,
    siteUrl,
    isAdmin: () => getState().isAdmin,
    isLoggedIn: () => getState().isLoggedIn,
    guidelinesAccepted: () => !!(getState().guidelinesAccepted || localGuidelinesAccepted()),
  };
})();
