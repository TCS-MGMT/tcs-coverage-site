/* ===========================================================================
   TCS Coverage Scheduler — connection settings
   ---------------------------------------------------------------------------
   Paste your Supabase project values here AFTER you create the project.
   Step-by-step instructions are in DEPLOY.md.

   • Leave these blank to run locally in single-user manager mode
     (the schedule saves in this browser only — no logins, no syncing).
   • Fill them in to turn on logins + a shared, synced schedule for the team.

   These two values are SAFE to be public — the "anon" key only allows what
   your database security rules allow (managers edit, everyone else reads).
   =========================================================================== */
window.TCS_CONFIG = {
  SUPABASE_URL: 'https://llgppyxbozwwafprwwiq.supabase.co',       // e.g. "https://abcdwxyz.supabase.co"
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxsZ3BweXhib3p3d2FmcHJ3d2lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2Nzg3NjAsImV4cCI6MjA5NzI1NDc2MH0.pTC5xy2F-0uHYiK43hda6H4XTq-40vS1Q7W7HuUiXYw'   // the long "anon public" key from Project Settings → API
};
