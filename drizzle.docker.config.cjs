const { defineConfig } = require('drizzle-kit')

module.exports = defineConfig({
  schema: './dist/db/schema/index.js',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
})
