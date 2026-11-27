/**
 * シールド発動時に、再生中の動画を止めて音を消す（#22）。
 *
 * `Document` に依存しない形にしてあるので、テストでは
 * `querySelectorAll('video')` を返すだけの偽物を渡せる。
 */

export type VideoLike = {
  pause: () => void
  muted: boolean
  /** 状態の記録用（実物の HTMLVideoElement では常にある）。 */
  paused?: boolean
  currentTime?: number
  dataset?: { [key: string]: string | undefined }
}

export type VideoContainer = {
  querySelectorAll: (selector: string) => ArrayLike<VideoLike>
}

/**
 * すべての `<video>` を pause + mute する。戻り値は対象件数。
 *
 * ライトボックスはシールド中にアンマウントされるが、アンマウント前に
 * 同期的に呼ぶことで「音が一瞬残る」ことを避ける。
 */
export function silenceVideos(container: VideoContainer): number {
  const videos = container.querySelectorAll('video')
  for (let index = 0; index < videos.length; index += 1) {
    const video = videos[index]
    if (!video) continue
    // 復帰時に「再生中だったか」「ミュートだったか」を戻せるよう、要素に印を付ける
    if (video.dataset) {
      if (video.paused === false) video.dataset.shieldWasPlaying = '1'
      if (typeof video.currentTime === 'number') {
        video.dataset.shieldPositionMs = String(Math.round(video.currentTime * 1000))
      }
      video.dataset.shieldWasMuted = video.muted ? '1' : '0'
    }
    try {
      video.pause()
    } catch {
      // pause() できない状態（メタデータ未読込など）でも mute は試す
    }
    video.muted = true
  }
  return videos.length
}
