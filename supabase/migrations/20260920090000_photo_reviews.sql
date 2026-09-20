-- One verdict per job on the driver's POD photos, filed by a supervisor on /picture.
--
-- job_id is the PRIMARY KEY, so a job reviewed twice keeps only the latest verdict.
-- The queue is "today's completed jobs minus the ones already in here", and a second
-- opinion that appended instead of replacing would leave the pair with no way to say
-- which one counts.
--
-- `reason` holds the CODE, not the Vietnamese label: the whole point of a fixed list is
-- being able to count how many were blurry, which free text can never answer. Labels
-- live in the UI and can be reworded without rewriting history.
create table if not exists public.photo_reviews (
  job_id         bigint      primary key,
  review_date    date        not null,        -- VN date of the job, for the queue filter
  result         text        not null check (result in ('pass', 'fail')),
  reason         text        check (reason in ('blurry', 'qty_mismatch', 'qty_unclear')),
  reviewer_email text        not null,
  photo_count    integer     not null default 0,
  reviewed_at    timestamptz not null default now(),
  -- A fail without a reason is the one shape the report cannot use.
  constraint photo_reviews_fail_needs_reason check (result <> 'fail' or reason is not null)
);

create index if not exists photo_reviews_review_date_idx on public.photo_reviews (review_date);

alter table public.photo_reviews enable row level security;
