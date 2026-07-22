// Harbor cloud config (Supabase)
// publishable key = the modern client key (same role as the old anon key)
//
// AI Angel (server-only):
//   supabase secrets set GROQ_API_KEY=gsk_... --project-ref pequbpumggymlslakuwz
//   supabase functions deploy harbor-angel --project-ref pequbpumggymlslakuwz
// Client never holds the Groq key; local companion is the offline fallback.
window.HARBOR_CONFIG = {
  supabaseUrl: 'https://pequbpumggymlslakuwz.supabase.co',
  supabaseAnonKey: 'sb_publishable_nRk3hNTGty6LVbUqcEhwnw_V2bT7F9t',
  // Used for auth email confirmation / password-reset redirects
  siteUrl: 'https://ooverstreet.github.io/Owen/harbor/',
  angelFunction: 'harbor-angel',
  // Early shore: new accounts need a valid invite code (sign-in still works)
  earlyAccess: true,
  inviteCodes: ['first-light', 'quiet-shore', 'harbor-friend'],
  // After this many quiet days, returning members must set a new password before posting
  inactiveDays: 90,
};
