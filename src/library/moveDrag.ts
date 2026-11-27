/** #57: 作品カードのドラッグであることを示す dataTransfer の型。 */
export const WORK_DRAG_TYPE = 'application/x-works-work'

/** dataTransfer から作品 id を取り出す（不正なら null）。 */
export function readDraggedWorkId(dataTransfer: DataTransfer): number | null {
  const raw = dataTransfer.getData(WORK_DRAG_TYPE)
  if (!raw) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}
