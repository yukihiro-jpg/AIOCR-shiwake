import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    // 共通UI（GlobalNav 等）と iframe ラッパー。ここに無いとそこでしか使わないクラスが CSS から落ちる
    './src/core/**/*.{js,ts,jsx,tsx}',
    './src/modules/**/*.tsx',   // embedded.ts（HTML文字列）は走査しない
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
export default config
