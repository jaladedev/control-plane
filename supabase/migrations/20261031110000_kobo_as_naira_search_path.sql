-- kobo_as_naira only uses built-in functions, so it can run with an empty
-- search_path. Clears the "function search path mutable" advisor warning.
alter function kobo_as_naira(bigint) set search_path = '';
