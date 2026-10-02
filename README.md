# Cashbook Local

A personal cashbook web app for tracking income and outcome entries offline.

## What it does

- Stores entries locally in the browser on your PC.
- Works offline after the first load thanks to service worker caching.
- Supports add, edit, delete, search, filter, export, and import.

## Run it

1. Install dependencies with `npm install`.
2. Start the app with `npm run dev`.
3. Open the local URL shown by Vite.

## Data storage

The app saves data locally in browser storage and can also connect to a local JSON file for automatic save-and-restore across restarts. Use the Save data file button once to bind a file, and keep Export backup for an extra copy on your drive.

## Supabase sync

Supabase is configured through `.env.local`. Before cloud sync can work, open the Supabase SQL Editor and run the SQL in `supabase-schema.sql`. The app then syncs the current workspace to Supabase while keeping browser and local-file storage available for offline use.

For Vercel, add these variables under **Project Settings > Environment Variables** for the Production environment, then redeploy:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

The Vite config accepts both `NEXT_PUBLIC_*` and `VITE_*` names.
