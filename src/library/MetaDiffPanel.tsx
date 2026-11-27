/**
 * 比較ビューの「差分」タブ（#74）。
 *
 * 2 枚分の生成情報を `getGenerationMeta` で読み、`src/lib/promptDiff.ts` の
 * 差分モデルを描画するだけのコンポーネント。比較ロジックは持たない。
 *
 * - 一致した項目は 1 行にまとめて薄く出す（差分のある項目だけ展開）
 * - prompt / negative はトークン単位（削除 = 赤 / 追加 = 緑）
 * - LoRA はセット差（共通 / 1 のみ / 2 のみ）
 * - 片方に生成情報が無い場合は「生成情報なし」を明示（空欄の `（空）` とは別）
 */
import { useEffect, useState } from 'react'
import { ArrowLeftRight } from 'lucide-react'
import { cn } from 'cn'
import { api } from '../api'
import type { GenerationMeta } from '../api'
import type { CompareItem } from './compareItems'
import { diffGenerationMeta, formatMetaValue } from '../lib/promptDiff'
import type { DiffToken, LoraMetaFieldDiff, MetaFieldDiff } from '../lib/promptDiff'

type Props = {
  itemA: CompareItem
  itemB: CompareItem
  /** ベンチ / headless では Tauri IPC が無いので実データを読みに行かない。 */
  bench: boolean
}

type LoadState =
  | { status: 'loading' }
  | { status: 'bench' }
  | { status: 'error' }
  | { status: 'ready'; a: GenerationMeta | null; b: GenerationMeta | null }

export function MetaDiffPanel({ itemA, itemB, bench }: Props) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    if (bench) {
      setState({ status: 'bench' })
      return
    }

    const idA = itemA.fileId
    const idB = itemB.fileId
    if (idA === null || idB === null) {
      setState({ status: 'ready', a: null, b: null })
      return
    }

    let alive = true
    setState({ status: 'loading' })
    Promise.all([api.getGenerationMeta(idA), api.getGenerationMeta(idB)])
      .then(([a, b]) => {
        if (alive) setState({ status: 'ready', a, b })
      })
      .catch(() => {
        if (alive) setState({ status: 'error' })
      })
    return () => {
      alive = false
    }
  }, [bench, itemA.fileId, itemB.fileId])

  if (state.status === 'loading') {
    return (
      <div
        data-meta-diff
        data-meta-diff-status="loading"
        className="min-h-0 flex-1 overflow-y-auto bg-black/35 px-4 py-3 text-xs text-white/60"
      >
        生成情報を読み込み中…
      </div>
    )
  }

  if (state.status === 'bench') {
    return (
      <div
        data-meta-diff
        data-meta-diff-status="bench"
        className="min-h-0 flex-1 overflow-y-auto bg-black/35 px-4 py-3 text-xs text-white/60"
      >
        ベンチモードでは生成情報を表示できません。
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div
        data-meta-diff
        data-meta-diff-status="error"
        className="min-h-0 flex-1 overflow-y-auto bg-black/35 px-4 py-3 text-xs text-white/70"
      >
        生成情報を読み込めませんでした。ファイルを開き直して再度お試しください。
      </div>
    )
  }

  const diff = diffGenerationMeta(state.a, state.b)
  const bothMissing = diff.presence === 'none'

  return (
    <div
      data-meta-diff
      data-meta-diff-status="ready"
      data-meta-diff-presence={diff.presence}
      data-meta-diff-seed-only={diff.seedOnly ? 'true' : undefined}
      className="min-h-0 flex-1 select-text overflow-y-auto bg-black/35 px-4 py-3 text-xs text-white/85"
    >
      {/* 見出し（どちらが 1 / 2 か、一致・差分の件数） */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1 font-semibold">
          <ArrowLeftRight className="size-3.5 text-white/50" aria-hidden="true" />
          生成設定の差分
        </span>
        <span className="flex min-w-0 items-center gap-1 text-white/60">
          <span className="rounded border border-white/20 bg-white/10 px-1 font-semibold tabular-nums">
            1
          </span>
          <span className="max-w-56 truncate">{itemA.title}</span>
          <span className="text-white/35">↔</span>
          <span className="rounded border border-white/20 bg-white/10 px-1 font-semibold tabular-nums">
            2
          </span>
          <span className="max-w-56 truncate">{itemB.title}</span>
        </span>
        <span className="ml-auto flex items-center gap-2 tabular-nums">
          {diff.seedOnly && (
            <span
              data-meta-diff-seed-badge
              className="rounded-full border border-emerald-400/40 bg-emerald-400/15 px-2 py-0.5 text-xs font-semibold text-emerald-200"
              title="seed 以外の生成設定がすべて同じです"
            >
              seed 違い
            </span>
          )}
          <span className="text-white/55">
            一致 {diff.sameCount} / 差分 {diff.changedCount}
          </span>
        </span>
      </div>

      {/* 片方（または両方）に生成情報が無い */}
      {diff.presence !== 'both' && (
        <div className="mt-2 flex flex-col gap-1">
          {diff.presence !== 'onlyA' && (
            <p
              data-diff-missing="a"
              className="m-0 rounded border border-amber-400/35 bg-amber-400/10 px-2 py-1 text-amber-100/90"
            >
              1 枚目（{itemA.title}）: 生成情報なし（項目が空なのとは別です）
            </p>
          )}
          {diff.presence !== 'onlyB' && (
            <p
              data-diff-missing="b"
              className="m-0 rounded border border-amber-400/35 bg-amber-400/10 px-2 py-1 text-amber-100/90"
            >
              2 枚目（{itemB.title}）: 生成情報なし（項目が空なのとは別です）
            </p>
          )}
        </div>
      )}

      {/* 一致した項目は 1 行にまとめて薄く */}
      {diff.sameCount > 0 && (
        <p
          data-diff-same
          className="mt-2 mb-0 rounded border border-white/10 bg-white/[0.03] px-2 py-1 text-white/40"
        >
          一致（{diff.sameCount}）: {diff.sameFields.map((field) => field.label).join(' / ')}
        </p>
      )}

      {bothMissing ? (
        <p className="mt-3 mb-0 text-white/60">
          どちらのファイルにも生成情報がありません（空欄の項目ではありません）。
        </p>
      ) : diff.changedCount === 0 ? (
        <p className="mt-3 mb-0 text-white/60">表示対象の項目はすべて一致しました。</p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {diff.changedFields.map((field) => (
            <ChangedField key={field.key} field={field} presence={diff.presence} />
          ))}
        </div>
      )}
    </div>
  )
}

function ChangedField({
  field,
  presence,
}: {
  field: MetaFieldDiff
  presence: 'both' | 'onlyA' | 'onlyB' | 'none'
}) {
  if (field.kind === 'loras') return <LoraRow field={field} presence={presence} />

  return (
    <section
      data-diff-field={field.key}
      className="rounded-lg border border-white/12 bg-white/[0.03] px-2.5 py-2"
    >
      <h3 className="m-0 text-xs font-semibold tracking-wide text-white/55">
        {field.label}
      </h3>
      <div className="mt-1 grid gap-1.5 lg:grid-cols-2">
        <TextSide
          side="a"
          label="1"
          value={field.a}
          tokens={field.tokens?.a ?? null}
          missing={presence === 'onlyB'}
        />
        <TextSide
          side="b"
          label="2"
          value={field.b}
          tokens={field.tokens?.b ?? null}
          missing={presence === 'onlyA'}
        />
      </div>
    </section>
  )
}

function TextSide({
  side,
  label,
  value,
  tokens,
  missing,
}: {
  side: 'a' | 'b'
  label: string
  value: string | null
  tokens: DiffToken[] | null
  missing: boolean
}) {
  return (
    <div data-diff-side={side} className="flex min-w-0 gap-1.5">
      <span className="mt-0.5 flex size-4 flex-none items-center justify-center rounded border border-white/20 bg-white/10 text-xs font-semibold text-white/60 tabular-nums">
        {label}
      </span>
      <div className="min-w-0 flex-1 rounded bg-black/30 px-2 py-1 leading-relaxed whitespace-pre-wrap break-words">
        {missing ? (
          <span className="text-amber-100/70">生成情報なし</span>
        ) : tokens && tokens.length > 0 ? (
          tokens.map((token, index) => (
            <span
              key={`${index}-${token.kind}`}
              data-diff-token={token.kind}
              className={
                token.kind === 'removed'
                  ? 'rounded-sm bg-red-500/25 text-red-200 line-through decoration-red-300/60'
                  : token.kind === 'added'
                    ? 'rounded-sm bg-emerald-500/25 text-emerald-200'
                    : undefined
              }
            >
              {token.text}
            </span>
          ))
        ) : value === null || value.trim() === '' ? (
          <span className="text-white/40">{formatMetaValue(value)}</span>
        ) : (
          value
        )}
      </div>
    </div>
  )
}

function LoraRow({
  field,
  presence,
}: {
  field: LoraMetaFieldDiff
  presence: 'both' | 'onlyA' | 'onlyB' | 'none'
}) {
  const hasLoras = field.a.length > 0 || field.b.length > 0

  return (
    <section
      data-diff-field="loras"
      className="rounded-lg border border-white/12 bg-white/[0.03] px-2.5 py-2"
    >
      <h3 className="m-0 text-xs font-semibold tracking-wide text-white/55">LoRA</h3>
      {!hasLoras ? (
        <p className="mt-1 mb-0 text-white/40">
          {presence === 'both'
            ? '（なし）'
            : 'LoRA の記録はありません（生成情報なしのファイルがあります）'}
        </p>
      ) : presence !== 'both' ? (
        <p className="mt-1 mb-0 text-white/40">
          LoRA のセット比較は両方に生成情報があるときだけ行います。
        </p>
      ) : (
        <div className="mt-1 flex flex-col gap-1">
          <LoraGroup label="共通" names={field.common} tone="same" />
          <LoraGroup label="1 のみ（削除）" names={field.onlyA} tone="removed" />
          <LoraGroup label="2 のみ（追加）" names={field.onlyB} tone="added" />
        </div>
      )}
      <p className="mt-1 mb-0 text-xs text-white/35">
        1: {field.a.length > 0 ? field.a.join(', ') : '（なし）'} / 2:{' '}
        {field.b.length > 0 ? field.b.join(', ') : '（なし）'}
      </p>
    </section>
  )
}

function LoraGroup({
  label,
  names,
  tone,
}: {
  label: string
  names: string[]
  tone: 'same' | 'added' | 'removed'
}) {
  if (names.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="w-20 flex-none text-white/40">{label}</span>
      {names.map((name) => (
        <span
          key={name}
          data-diff-lora={tone === 'same' ? 'common' : tone === 'added' ? 'onlyB' : 'onlyA'}
          className={cn(
            'rounded-full border px-1.5 py-0.5 text-xs',
            tone === 'same' && 'border-white/20 bg-white/10 text-white/70',
            tone === 'added' && 'border-emerald-400/40 bg-emerald-400/15 text-emerald-200',
            tone === 'removed' && 'border-red-400/40 bg-red-400/15 text-red-200 line-through',
          )}
        >
          {name}
        </span>
      ))}
    </div>
  )
}
