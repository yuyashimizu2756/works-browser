//! 計測系テストの共通ヘルパー（#43）。
//!
//! CI の `windows-latest`（2 コア）はローカルより遅く、コールドキャッシュの初回だけを
//! 測ると「ローカル 65ms / CI 312〜385ms」のようにぶれる。そのため
//!
//! 1. ウォームアップを 1 回流してから本計測する
//! 2. 3 回測って中央値を採用する
//! 3. CI では予算（しきい値）を 2 倍に緩める
//!
//! という前提で計測する。詳細は `docs/testing.md` を参照。

use std::time::{Duration, Instant};

/// 計測予算。CI ではランナーのばらつきを吸収するためローカルの 2 倍まで許す。
///
/// 例: ローカル 300ms → CI 600ms。遅いランナーでも「明らかな退行」は捕まえられる。
pub fn budget(local: Duration) -> Duration {
    if is_ci() {
        local * 2
    } else {
        local
    }
}

/// 環境変数 `CI` が真か。GitHub Actions は `CI=true` を設定する。
fn is_ci() -> bool {
    std::env::var("CI")
        .map(|value| {
            let value = value.trim();
            !value.is_empty() && value != "0" && !value.eq_ignore_ascii_case("false")
        })
        .unwrap_or(false)
}

/// ウォームアップ 1 回のあと 3 回計測し、中央値を返す。
///
/// `run` は計測対象の処理。結果の検証（`assert`）もここに含めてよい。
pub fn median_of_three(mut run: impl FnMut()) -> Duration {
    // 初回はディスク / SQLite のコールドキャッシュを温めるだけで測らない。
    run();

    let mut samples: Vec<Duration> = (0..3)
        .map(|_| {
            let started = Instant::now();
            run();
            started.elapsed()
        })
        .collect();

    samples.sort();
    samples[1]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn median_of_three_warms_up_and_returns_the_middle_sample() {
        let mut calls = 0;
        let elapsed = median_of_three(|| {
            calls += 1;
        });
        assert_eq!(calls, 4, "ウォームアップ 1 回 + 本計測 3 回");
        assert!(elapsed <= Duration::from_secs(1));
    }

    #[test]
    fn ci_budget_is_twice_the_local_budget() {
        let local = Duration::from_millis(300);
        // 環境変数を触ると他のテストと競合するため、`is_ci` の判定だけを検証する。
        if is_ci() {
            assert_eq!(budget(local), Duration::from_millis(600));
        } else {
            assert_eq!(budget(local), local);
        }
    }
}
