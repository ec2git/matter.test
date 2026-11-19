DROP INDEX "requirements_project_key_idx";--> statement-breakpoint
ALTER TABLE "plan_tracks" ADD COLUMN "number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Existing plans are numbered in the order they were made.
UPDATE "plan_tracks" pt SET "number" = n.rn FROM (
  SELECT "id", row_number() OVER (PARTITION BY "project_id" ORDER BY "position", "created_at") AS rn FROM "plan_tracks"
) n WHERE n."id" = pt."id";--> statement-breakpoint
CREATE UNIQUE INDEX "plan_tracks_project_number_idx" ON "plan_tracks" USING btree ("project_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "requirements_track_key_idx" ON "requirements" USING btree ("track_id","key");