import type { FileSummary, RootInfo, WorkSummary } from '../src/api'

/** テスト用の作品。ID 以外は必要な項目だけ上書きする。 */
export function makeWork(overrides: Partial<WorkSummary> & { id: number }): WorkSummary {
  return {
    root_id: 1,
    rel_path: `work-${overrides.id}`,
    title: `作品 ${overrides.id}`,
    kind: 'image',
    cover_file_id: null,
    cover_thumb: null,
    preview_thumbs: [],
    file_count: 1,
    total_bytes: 1_000,
    mtime: 1_700_000_000_000,
    ...overrides,
  }
}

/** テスト用のルート（RootInfo）。 */
export function makeRootInfo(overrides: Partial<RootInfo> & { id: number }): RootInfo {
  return {
    root: {
      id: overrides.id,
      path: `D:\\Works\\root-${overrides.id}`,
      real_path: `D:\\Works\\root-${overrides.id}`,
      label: `ルート ${overrides.id}`,
      depth: 1,
      enabled: true,
      duplicate_of: null,
      created_at: 0,
    },
    works: 0,
    files: 0,
    total_bytes: 0,
    last_scan_at: null,
    last_scan_status: null,
    exists: true,
    ...overrides,
  }
}

/** テスト用のファイル。 */
export function makeFile(overrides: Partial<FileSummary> & { id: number }): FileSummary {
  return {
    work_id: 1,
    rel_path: `work-1/${overrides.id}.png`,
    name: `${overrides.id}.png`,
    kind: 'image',
    bytes: 1_000,
    width: 1280,
    height: 720,
    duration_ms: null,
    mtime: 1_700_000_000_000,
    thumb_path: null,
    work_title: '作品 1',
    work_rel_path: 'work-1',
    root_id: 1,
    position_ms: null,
    ...overrides,
  }
}
