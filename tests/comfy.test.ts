import { expect, test } from 'vitest'
import type { GenerationMeta } from '../src/api.ts'
import { canQueuePrompt, comfyActionFor, comfySettingsPatch } from '../src/library/comfy.ts'

function meta(overrides: Partial<GenerationMeta> = {}): GenerationMeta {
  return {
    prompt: null,
    negative_prompt: null,
    model: null,
    loras: [],
    steps: null,
    sampler: null,
    cfg: null,
    seed: null,
    size: null,
    raw: null,
    source: 'comfy',
    workflow_json: null,
    api_prompt: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// #73: 「ComfyUI へ」の分岐
// ---------------------------------------------------------------------------

test('workflow があれば workflow を保存して開く', () => {
  expect(
    comfyActionFor(
      meta({
        workflow_json: '{"nodes":[]}',
        api_prompt: '{"3":{"class_type":"KSampler","inputs":{}}}',
      }),
    ),
  ).toBe('workflow')
})

test('workflow が無く API 形式だけならコピーする', () => {
  expect(
    comfyActionFor(meta({ api_prompt: '{"3":{"class_type":"KSampler","inputs":{}}}' })),
  ).toBe('api')
})

test('どちらも無ければボタンを出さない', () => {
  expect(comfyActionFor(meta())).toBe('none')
  expect(comfyActionFor(null)).toBe('none')
  // 空白だけの中身は無いものとして扱う
  expect(comfyActionFor(meta({ workflow_json: '   ', api_prompt: '  ' }))).toBe('none')
})

test('「この設定で再実行」は API 形式があるときだけ', () => {
  expect(canQueuePrompt(meta({ api_prompt: '{}' }))).toBe(true)
  expect(canQueuePrompt(meta({ workflow_json: '{"nodes":[]}' }))).toBe(false)
  expect(canQueuePrompt(null)).toBe(false)
})

test('設定の差分は前後の空白だけ落とす', () => {
  expect(comfySettingsPatch('  http://127.0.0.1:8188/  ', '  D:\\ComfyUI\\workflows  ')).toEqual({
    comfy_url: 'http://127.0.0.1:8188/',
    comfy_workflows_dir: 'D:\\ComfyUI\\workflows',
  })
})
