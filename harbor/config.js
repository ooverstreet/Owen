// Harbor cloud config (Supabase)
// publishable key = the modern client key (same role as the old anon key)
//
// AI Angel:
// - Preferred: deploy harbor/supabase/functions/harbor-angel + set GROQ_API_KEY as a Supabase secret
// - Or: paste a Groq key in Harbor → Identity (stored only on that device)
window.HARBOR_CONFIG = {
  supabaseUrl: 'https://pequbpumggymlslakuwz.supabase.co',
  supabaseAnonKey: 'sb_publishable_nRk3hNTGty6LVbUqcEhwnw_V2bT7F9t',
  angelFunction: 'harbor-angel',
  groqApiKey: '',
};
