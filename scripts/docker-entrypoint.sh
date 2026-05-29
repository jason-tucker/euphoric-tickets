#!/bin/sh
set -e

# The web (euphoric-tickets-web) owns the schema and runs drizzle-kit push
# on its own container start. The bot used to push too — removed so we
# don't have a race over the same tables. Just connect and run.

echo "▶ Starting Euphoric Tickets..."
exec node dist/index.js
