-- Allow 'answer-question' in public.ai_cache check constraint

alter table public.ai_cache
  drop constraint ai_cache_task_check,
  add constraint ai_cache_task_check check (
    task in ('explain-file', 'explain-folder', 'classify-file', 'answer-question')
  );
