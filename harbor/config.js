// Harbor cloud config (Supabase)
// publishable key = the modern client key (same role as the old anon key)
//
// AI Angel (pick one):
// 1) Preferred: deploy harbor/supabase/functions/harbor-angel and set GROQ_API_KEY or OPENAI_API_KEY as a Supabase secret
// 2) Quick personal test: paste a free Groq key below (visible in the browser — fine for a private prototype)
window.HARBOR_CONFIG = {
  supabaseUrl: 'https://pequbpumggymlslakuwz.supabase.co',
  supabaseAnonKey: 'sb_publishable_nRk3hNTGty6LVbUqcEhwnw_V2bT7F9t',
  angelFunction: 'harbor-angel',
  groqApiKey: '', // optional quick-start: https://console.groq.com/keys
};
