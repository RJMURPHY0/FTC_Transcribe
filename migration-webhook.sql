-- Creates the Supabase Database Webhook for the auto-fix pipeline.
-- Equivalent to what the Supabase Dashboard "Database Webhooks" UI creates.
-- Fires on every INSERT into public.error_log and calls the auto-fix endpoint.

CREATE OR REPLACE TRIGGER "auto_fix_trigger"
  AFTER INSERT ON "public"."error_logs"
  FOR EACH ROW
  EXECUTE FUNCTION supabase_functions.http_request(
    'https://ftctranscribe.vercel.app/api/auto-fix',
    'POST',
    '{"Content-Type":"application/json","X-Auto-Fix-Secret":"d89d89486d47afa6f8a5f421bc89b012b63c64aa9428a82bf770d3515802efed"}',
    '{}',
    '5000'
  );
