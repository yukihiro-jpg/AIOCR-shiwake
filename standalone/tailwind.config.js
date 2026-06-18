/** @type {import('tailwindcss').Config} */
export default {
  // 元の src/ のコンポーネントを走査対象にする（元の tailwind.config.ts と同じ範囲）
  content: [
    '../src/components/**/*.{js,ts,jsx,tsx,mdx}',
    '../src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './index.html',
    './main.tsx',
  ],
  theme: { extend: {} },
  plugins: [],
}
