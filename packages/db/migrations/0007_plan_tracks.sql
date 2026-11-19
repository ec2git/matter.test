CREATE TABLE "plan_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"focus" text,
	"source_ids" jsonb,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_questions" ADD COLUMN "track_id" uuid;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "track_id" uuid;--> statement-breakpoint
ALTER TABLE "test_plans" ADD COLUMN "track_id" uuid;--> statement-breakpoint
ALTER TABLE "plan_tracks" ADD CONSTRAINT "plan_tracks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_questions" ADD CONSTRAINT "client_questions_track_id_plan_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."plan_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_track_id_plan_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."plan_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_plans" ADD CONSTRAINT "test_plans_track_id_plan_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."plan_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Every project that already has sources or plans gets one test plan holding its existing work.
INSERT INTO "plan_tracks" ("project_id", "name")
SELECT p."id", 'Test plan' FROM "projects" p
WHERE EXISTS (SELECT 1 FROM "sources" s WHERE s."project_id" = p."id")
   OR EXISTS (SELECT 1 FROM "test_plans" t WHERE t."project_id" = p."id");--> statement-breakpoint
UPDATE "test_plans" t SET "track_id" = pt."id" FROM "plan_tracks" pt WHERE pt."project_id" = t."project_id";--> statement-breakpoint
UPDATE "requirements" r SET "track_id" = pt."id" FROM "plan_tracks" pt WHERE pt."project_id" = r."project_id";--> statement-breakpoint
UPDATE "client_questions" q SET "track_id" = pt."id" FROM "plan_tracks" pt WHERE pt."project_id" = q."project_id";
