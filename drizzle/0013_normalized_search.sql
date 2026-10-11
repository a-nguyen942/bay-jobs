ALTER TABLE jobs ADD COLUMN search_text TEXT;
--> statement-breakpoint
ALTER TABLE jobs ADD COLUMN title_key TEXT;
--> statement-breakpoint
ALTER TABLE filtered_listings ADD COLUMN search_text TEXT;
--> statement-breakpoint
ALTER TABLE jobs ADD COLUMN is_intern INTEGER;
