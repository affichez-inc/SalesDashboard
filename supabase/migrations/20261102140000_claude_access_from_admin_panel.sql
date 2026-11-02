-- The Claude connector is given from Paramètres → Utilisateurs, so ticking the
-- box has to be all it takes.
--
-- mcp_claude_access() answers 'ok' only for an account with the flag on and no
-- password (20261030140000 says why). Until now that meant a second UPDATE on
-- auth.users by hand, which the browser cannot do and should not: only this
-- trigger's owner may write to that table. allowed_users_sync_metadata already
-- runs on every write to a row and already holds that right, so it now also
-- clears the password whenever the flag is on.
--
-- Unticking leaves the account without a password. Nothing needs it: the Zoho
-- sign-in is a one-time link.
--
-- Someone ticked before their first sign-in has no auth user yet, so this finds
-- nothing to clear, and generateLink then creates the account with a random
-- password. zoho-auth re-saves the flag right after that call, which runs this
-- trigger again.
--
-- Same function otherwise. Only an admin can write this column: the table's
-- write policies all require app_is_admin(), which a member and a connector
-- token both fail.

CREATE OR REPLACE FUNCTION public.sync_allowed_users_to_auth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  new_meta jsonb;
BEGIN
  new_meta := jsonb_build_object(
    'role',                COALESCE(NEW.role, 'member'),
    'can_access_factures', COALESCE(NEW.can_access_factures, false),
    'rep_name',            NEW.rep_name
  );

  UPDATE auth.users
  SET raw_user_meta_data =
        COALESCE(raw_user_meta_data, '{}'::jsonb) || new_meta,
      encrypted_password =
        CASE WHEN NEW.can_use_claude THEN '' ELSE encrypted_password END
  WHERE lower(email) = lower(NEW.email);

  RETURN NEW;
END;
$function$;
