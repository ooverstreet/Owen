// Harbor cloud config (Supabase)
// publishable key = the modern client key (same role as the old anon key)
//
// AI Angel:
// - Preferred: deploy harbor/supabase/functions/harbor-angel + set GROQ_API_KEY as a Supabase secret
// - Or: signed-in admins can paste a Groq key under Account → Admin (device only)
window.HARBOR_CONFIG = {
  supabaseUrl: 'https://pequbpumggymlslakuwz.supabase.co',
  supabaseAnonKey: 'sb_publishable_nRk3hNTGty6LVbUqcEhwnw_V2bT7F9t',
  // Used for auth email confirmation / password-reset redirects
  siteUrl: 'https://ooverstreet.github.io/Owen/harbor/',
  angelFunction: 'harbor-angel',
  groqApiKey: '',
};
