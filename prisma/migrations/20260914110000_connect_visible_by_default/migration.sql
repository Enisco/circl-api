-- Choosing a connection type and writing what you are looking for is the deliberate act; a profile
-- nobody can find is a dead end the member has no way to see. Existing rows keep the value they
-- have: somebody who is hidden today either chose that or was defaulted into it, and turning them
-- on would put people in front of strangers without asking.
ALTER TABLE "connect_profiles" ALTER COLUMN "is_visible" SET DEFAULT true;
