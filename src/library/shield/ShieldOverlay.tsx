import type { ReactNode } from 'react'
import { FileText, Folder, History, RotateCcw, Search } from 'lucide-react'
import { cn } from 'cn'
import type { ShieldAppearance } from './settings'

type Props = {
  active: boolean
  appearance: ShieldAppearance
  onRestore: () => void
}

/**
 * シールド中に最前面へ出す「作業アプリ風」の画面（#22）。
 *
 * - 事前マウントしておき、`active` の切り替えだけで表示する（再レンダリング最小）
 * - 画像・動画・サムネイルは一切使わない（`<img>` 0 件）
 * - 「隠しています」とは書かない。無地 or 汎用的なファイル名リストだけ
 * - 実際の作品名・ファイル名は出さない（中身が分からないことを優先）
 */
const RECENT_FILES = [
  { name: '議事録_2026-11-24.docx', place: 'ドキュメント', modified: '昨日 18:42', size: '38 KB' },
  { name: '見積書_第3版.xlsx', place: 'ドキュメント', modified: '昨日 15:10', size: '24 KB' },
  { name: '資料まとめ.pdf', place: 'デスクトップ', modified: '11/22 9:05', size: '1.2 MB' },
  { name: 'スケジュール.xlsx', place: 'ドキュメント', modified: '11/21 17:28', size: '31 KB' },
  { name: 'メモ.txt', place: 'デスクトップ', modified: '11/20 11:02', size: '2 KB' },
  { name: '報告書_下書き.docx', place: 'ドキュメント', modified: '11/18 16:47', size: '56 KB' },
]

export function ShieldOverlay({ active, appearance, onRestore }: Props) {
  return (
    <div
      data-privacy-shield
      data-shield-active={active ? 'true' : 'false'}
      data-appearance={appearance}
      aria-hidden={!active}
      className={cn(
        'fixed inset-0 z-[200] flex flex-col bg-[#f4f4f2] text-[#252525] transition-opacity duration-75',
        active ? 'visible opacity-100' : 'pointer-events-none invisible opacity-0',
      )}
    >
      {/* 上部バー（作業アプリ風） */}
      <div className="flex flex-none items-center gap-3 border-b border-[#dededb] bg-[#fbfbfa] px-4 py-2">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <Folder className="size-4 text-[#5b6b7c]" aria-hidden="true" />
          ファイル
        </div>
        <div className="flex h-7 min-w-0 max-w-[420px] flex-1 items-center gap-2 rounded-md border border-[#d8d8d4] bg-white px-2 text-xs text-[#8a8a86]">
          <Search className="size-3.5" aria-hidden="true" />
          <span className="truncate">検索</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-xs text-[#7d7d78] sm:inline">最近使用した項目</span>
          <button
            type="button"
            onClick={onRestore}
            data-restore-shield
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#cfcfca] bg-white px-2.5 text-xs font-medium text-[#333333] hover:bg-[#f0f0ec]"
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            戻す
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左ペイン */}
        <aside className="hidden w-48 flex-none flex-col gap-0.5 border-r border-[#e1e1dd] bg-[#f7f7f4] px-2 py-3 text-xs sm:flex">
          <SidebarItem icon={<History className="size-3.5" />} label="最近" active />
          <SidebarItem icon={<Folder className="size-3.5" />} label="ドキュメント" />
          <SidebarItem icon={<Folder className="size-3.5" />} label="デスクトップ" />
          <SidebarItem icon={<Folder className="size-3.5" />} label="ダウンロード" />
        </aside>

        {/* 本文 */}
        <main className="min-w-0 flex-1 overflow-hidden bg-[#fdfdfc] px-6 py-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="m-0 text-[13px] font-semibold text-[#3c3c3a]">最近のファイル</p>
            <span className="text-xs text-[#96968f]">更新日時で並べ替え</span>
          </div>

          {appearance === 'files' ? (
            <div className="overflow-hidden rounded-md border border-[#e3e3df]">
              <div className="grid grid-cols-[minmax(0,1fr)_6.5rem_5rem_4.5rem] gap-2 border-b border-[#e3e3df] bg-[#f5f5f2] px-3 py-1.5 text-xs font-semibold tracking-[0.04em] text-[#85857f] uppercase">
                <span>名前</span>
                <span>場所</span>
                <span className="text-right">更新日時</span>
                <span className="text-right">サイズ</span>
              </div>
              {RECENT_FILES.map((file) => (
                <div
                  key={file.name}
                  className="grid grid-cols-[minmax(0,1fr)_6.5rem_5rem_4.5rem] items-center gap-2 border-b border-[#efefeb] px-3 py-1.5 text-xs last:border-b-0"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <FileText className="size-3.5 flex-none text-[#7d8894]" aria-hidden="true" />
                    <span className="truncate text-[#343432]">{file.name}</span>
                  </span>
                  <span className="truncate text-[#83837d]">{file.place}</span>
                  <span className="text-right whitespace-nowrap text-[#83837d] tabular-nums">
                    {file.modified}
                  </span>
                  <span className="text-right whitespace-nowrap text-[#83837d] tabular-nums">
                    {file.size}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            // 無地: 中身の手がかりを一切出さない
            <div className="h-[calc(100%-2rem)] min-h-40 rounded-md border border-[#ecece7] bg-[#fafaf7]" />
          )}
        </main>
      </div>

      <div className="flex flex-none items-center justify-between border-t border-[#e1e1dd] bg-[#f7f7f4] px-4 py-1 text-xs text-[#8b8b85]">
        <span>{appearance === 'files' ? `${RECENT_FILES.length} 項目` : ''}</span>
        <span>最終更新 今日</span>
      </div>
    </div>
  )
}

function SidebarItem({
  icon,
  label,
  active,
}: {
  icon: ReactNode
  label: string
  active?: boolean
}) {
  return (
    <span
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5',
        active ? 'bg-[#e7e7e2] font-medium text-[#2f2f2d]' : 'text-[#5f5f5a]',
      )}
    >
      {icon}
      {label}
    </span>
  )
}
