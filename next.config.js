/** @type {import('next').NextConfig} */

// GitHub Pages（静的サイト）向けの静的書き出し。
// プロジェクトページ（https://<user>.github.io/<repo>/）に置く場合は
// ビルド時に NEXT_PUBLIC_BASE_PATH=/<repo> を指定する（GitHub Actions で自動設定）。
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || ''

const nextConfig = {
  output: 'export',
  // GitHub Pages はディレクトリ index.html で配信するため trailingSlash を有効化
  trailingSlash: true,
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
  images: {
    // 静的書き出しでは画像最適化サーバーが使えないため無効化
    unoptimized: true,
  },
  experimental: {
    serverComponentsExternalPackages: ['sharp'],
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // pdfjs-dist, tesseract.js, xlsxのためのpolyfill/fallback
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
      }
    }
    // canvas モジュールの除外（pdfjs-dist用）
    config.resolve.alias = {
      ...config.resolve.alias,
      canvas: false,
    }
    return config
  },
}

module.exports = nextConfig
