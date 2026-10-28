-- Phase 4 review: one live monthly auto-creation job per tenant, even when several API nodes boot at once.
DELETE FROM job_queue a USING job_queue b
 WHERE a.kind = 'tasks.auto_month' AND b.kind = 'tasks.auto_month' AND a.tenant_id = b.tenant_id
   AND a.dead_at IS NULL AND b.dead_at IS NULL AND a.id > b.id;
CREATE UNIQUE INDEX job_queue_auto_month_one ON job_queue (tenant_id, kind) WHERE kind = 'tasks.auto_month' AND dead_at IS NULL;
