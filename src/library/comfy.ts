import type { GenerationMeta } from '../api'

/**
 * #73: 生成情報から「ComfyUI へ」で何ができるか。
 *
 * - `workflow`: UI 形式がある → workflows フォルダへ保存して `?workflow=` で開く
 * - `api`: UI 形式は無いが API 形式がある → クリップボードへコピー
 * - `none`: どちらも無い → ボタンを出さない
 */
export type ComfyAction = 'workflow' | 'api' | 'none'

export function comfyActionFor(meta: GenerationMeta | null | undefined): ComfyAction {
  if (!meta) return 'none'
  if (meta.workflow_json?.trim()) return 'workflow'
  if (meta.api_prompt?.trim()) return 'api'
  return 'none'
}

/** #73: 「この設定で再実行」（`POST /prompt`）ができるか。 */
export function canQueuePrompt(meta: GenerationMeta | null | undefined): boolean {
  return Boolean(meta?.api_prompt?.trim())
}

/**
 * #73: 設定画面で ComfyUI の 2 項目だけを保存するときの差分。
 *
 * Rust 側で URL の前後の空白・末尾 `/` を落とすので、ここでは trim だけする。
 */
export function comfySettingsPatch(url: string, workflowsDir: string) {
  return {
    comfy_url: url.trim(),
    comfy_workflows_dir: workflowsDir.trim(),
  }
}
