-- M2: licence push tracking. license_* on schools is what we WANT the school
-- to have; license_pushed_version is the version the school last accepted
-- through set_license(). pushed < license_version means "saved, not synced".

alter table schools
  add column license_pushed_version bigint not null default 0,
  add column license_pushed_at timestamptz,
  add column license_push_error text,
  add constraint schools_license_pushed_le_version
    check (license_pushed_version <= license_version);
