'use client'

// マーカー付きテキスト（# 見出し / 【小見出し】/ **強調**）を相続レポート風に整形描画する共通部品。
// 経営サマリー（KeieiContent）と経営課題（SectionIssues）で共用する。
export function StoryBody({ text }: { text: string }) {
  const blocks = text.split(/\n\n+/).map((s) => s.trim()).filter(Boolean)
  const renderInline = (s: string, keyBase: string) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith('**') && part.endsWith('**')
        ? <b key={`${keyBase}-${i}`} className="text-[#1f3a5f] font-bold">{part.slice(2, -2)}</b>
        : <span key={`${keyBase}-${i}`}>{part}</span>)
  return (
    <div className="space-y-3.5">
      {blocks.map((b, i) => {
        if (b.startsWith('# ')) {
          return <div key={i} className="text-[17px] font-extrabold text-[#1f3a5f] leading-snug">{b.slice(2)}</div>
        }
        const m = b.match(/^【([^】]+)】([\s\S]*)$/)
        if (m) {
          return (
            <div key={i} className="border-l-[3px] border-[#c8a24b] pl-3.5">
              <div className="text-[13px] font-bold text-[#1f3a5f] mb-0.5">{m[1]}</div>
              <p className="text-[13.5px] leading-[1.9] text-gray-700 whitespace-pre-line">{renderInline(m[2].trim(), `b${i}`)}</p>
            </div>
          )
        }
        return <p key={i} className="text-[13.5px] leading-[1.9] text-gray-700 whitespace-pre-line">{renderInline(b, `b${i}`)}</p>
      })}
    </div>
  )
}
