#!/bin/sh
set -e

echo "▶ Applying database schema (drizzle-kit push)..."
node_modules/.bin/drizzle-kit push \
  --config=drizzle.docker.config.cjs \
  --force

echo "▶ Starting Euphoric Tickets..."
exec node dist/index.js
