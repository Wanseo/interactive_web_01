import { defineConfig } from 'vite'

export default defineConfig({
  // GitHub Actions injects the actual Pages path (for example,
  // /interactive_web_01/). Local development keeps using the root path.
  base: process.env.BASE_PATH || '/',
  server: {
    port: 5175,
    strictPort: true,
  },
})
