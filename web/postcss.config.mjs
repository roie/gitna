// Build boundary adapted from apps/diffshub/postcss.config.mjs at
// 59ec35ffac97abccef4c69f8d58d3747cbfbc6cb. The donor uses the same
// Tailwind/PostCSS pipeline under Next.js; Gitna runs it through Vite.
const config = {
  plugins: {
    'postcss-import': {},
    '@tailwindcss/postcss': {},
  },
}

export default config
