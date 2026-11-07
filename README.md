# Tournament Day

Mobile web app for tournament days: coaches enter match numbers, track courts, and message parents by WhatsApp or text.

- **Up Next** — waiting-area coach: who's close, "Post to group" / "Message parent", check-in, call, result.
- **Courts** — floor coaches: tap + when a match finishes.
- **Setup** — add athletes from the dojang roster, add matches (court + match #), copy parent links.
- **Parent page** — `#/p/<token>`: live court, match and status for one child. No login.

Plain HTML/CSS/JS, no build step. Data lives in the Dojang Portal Supabase project (tables `t_tournaments`, `t_athletes`, `t_matches`, `t_courts`).

## Sign in
- Coaches: coach password (shared account `coach@teamhankook.app`, role `coach` — tournament data only, no access to portal tables).
- Admin: "Sign in with admin email".

## Deploy
Drag this folder (or the zip) onto https://app.netlify.com/drop, or connect a GitHub repo with publish directory `.` and no build command.
