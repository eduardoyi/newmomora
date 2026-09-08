-- Expand only the model allowlist; retain old models for in-flight jobs and rollback.
create or replace function public.publish_portrait_generation_workflow_job(
  p_job_id uuid,
  p_model text
)
returns table (published boolean, already_published boolean, old_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.portrait_generation_jobs%rowtype;
  v_version public.family_member_portrait_versions%rowtype;
begin
  if p_model not in ('gpt-image-2.5-flare', 'gpt-image-2', 'gpt-image-1.5') then
    raise exception 'invalid model';
  end if;
  select * into v_job from public.portrait_generation_jobs where id = p_job_id for update;
  if not found then raise exception 'workflow job not found'; end if;
  select * into v_version from public.family_member_portrait_versions where id = v_job.portrait_version_id for update;
  if not found then raise exception 'portrait version not found'; end if;

  if v_job.status = 'succeeded' and v_version.illustrated_profile_key = v_job.output_key then
    return query select false, true, v_job.old_portrait_key;
    return;
  end if;
  if v_version.generation_token is distinct from v_job.attempt_id
    or v_version.generation_output_key is distinct from v_job.output_key
    or v_version.deletion_token is not null then
    update public.portrait_generation_jobs
    set status = 'superseded', completed_at = now(),
        source_photo_key = null, style_reference_key = null, portrait_prompt = null,
        upload_token = null, upload_started_at = null
    where id = p_job_id;
    return query select false, false, null::text;
    return;
  end if;
  if v_job.upload_token is not null or v_job.upload_started_at is not null
    or v_job.last_upload_completed_token is null then
    raise exception 'portrait upload has not completed' using errcode = '55000';
  end if;

  update public.family_member_portrait_versions
  set illustrated_profile_key = v_job.output_key,
      illustrated_profile_status = 'ready',
      generation_token = null,
      generation_started_at = null,
      generation_output_key = null
  where id = v_job.portrait_version_id;
  update public.portrait_generation_jobs
  set status = 'succeeded', completed_at = now(), model = p_model,
      source_photo_key = null, style_reference_key = null, portrait_prompt = null,
      upload_token = null, upload_started_at = null
  where id = p_job_id;
  return query select true, false, v_version.illustrated_profile_key;
end;
$$;
