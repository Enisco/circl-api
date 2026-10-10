-- The append-only trigger and the retention policy contradicted each other: the spec requires audit
-- rows to be undeletable (S11.2) and also requires them purged after six years (S11.4). A trigger
-- that refuses every DELETE makes the purge impossible, so one of the two was never going to run.
--
-- UPDATE stays refused unconditionally: there is no legitimate reason to rewrite a recorded action.
-- DELETE is refused unless the transaction has explicitly declared itself a purge, which only the
-- retention job does, and which it cannot do by accident — a stray `DELETE FROM audit_logs` from
-- application code still fails. The declaration lives in the transaction, so it cannot leak into
-- the next statement on a pooled connection.
CREATE OR REPLACE FUNCTION circl_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('circl.retention_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Retention purges must run inside a transaction that has set circl.retention_purge.';
END;
$$ LANGUAGE plpgsql;
