ALTER TYPE "public"."task_kind" ADD VALUE 'export';--> statement-breakpoint
ALTER TABLE "plan_tracks" ADD COLUMN "jira_epic_key" text;--> statement-breakpoint
ALTER TABLE "plan_tracks" ADD COLUMN "jira_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "jira_issue_key" text;