//! #7 フォルダ監視のテスト。
//!
//! - 追加 / 更新 / 削除 / リネームが索引に反映されること
//! - 無視パターン（`.tmp` / `.part` / `Thumbs.db` / `.DS_Store` / 設定 glob）
//! - 走査と同じ深さ・除外の規則
//! - 1,000 ファイル相当のバッチが詰まらないこと
//! - 上限超過で再走査へフォールバックすること
//! - 実際の `notify` デバウンサで 1 秒以内のイベントが DB に載ること

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::event::{CreateKind, EventKind, ModifyKind, RemoveKind, RenameMode};
use notify::Event;
use rusqlite::Connection;
use tempfile::TempDir;

use super::db;
use super::watch::{
    self, PendingCounts as WatchPendingCounts, WatchBatch, WatchChanged, WatchOptions,
    WatchPending, WatchService, WatchSettings, WatchTarget,
};

fn options() -> WatchOptions {
    WatchOptions::default()
}

fn setup(root: &Path, depth: i64) -> (Connection, WatchTarget) {
    let conn = db::open_in_memory().unwrap();
    let root = db::add_root(&conn, root.to_str().unwrap(), depth).unwrap();
    let target = WatchTarget::from_root(&root);
    (conn, target)
}

fn event(kind: EventKind, paths: &[&Path]) -> Event {
    let mut event = Event::new(kind);
    for path in paths {
        event = event.add_path(path.to_path_buf());
    }
    event
}

fn create_file(path: &Path) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, b"data").unwrap();
}

fn scalar(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

fn file_count(conn: &Connection) -> i64 {
    scalar(conn, "SELECT COUNT(*) FROM files")
}

fn work_count(conn: &Connection) -> i64 {
    scalar(conn, "SELECT COUNT(*) FROM works")
}

fn file_names(conn: &Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT name FROM files ORDER BY name")
        .unwrap();
    stmt.query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

#[test]
fn add_update_delete_and_rename_are_reflected() {
    let temp = TempDir::new().unwrap();
    let (mut conn, target) = setup(temp.path(), 1);
    let root = target.real_path.clone();
    let first = root.join("work").join("a.jpg");
    create_file(&first);

    // 追加
    let mut batch = WatchBatch::default();
    batch.record(
        &target,
        &event(EventKind::Create(CreateKind::File), &[&first]),
        &options(),
    );
    let applied = watch::apply_batch(&mut conn, &target, &batch, &options()).unwrap();
    assert_eq!(applied.added, 1);
    assert_eq!(file_count(&conn), 1);
    assert_eq!(work_count(&conn), 1);
    let title: String = conn
        .query_row("SELECT title FROM works", [], |row| row.get(0))
        .unwrap();
    assert_eq!(title, "work");
    // サムネイルは未生成（= 生成キューに載る）
    let thumb: Option<String> = conn
        .query_row("SELECT thumb_path FROM files", [], |row| row.get(0))
        .unwrap();
    assert!(thumb.is_none());

    // 更新（サイズが変わるので再生成対象に戻る）
    conn.execute(
        "UPDATE files SET thumb_path = 'C:\\cache\\a.webp', thumb_mtime = 1, thumb_bytes = 1",
        [],
    )
    .unwrap();
    fs::write(&first, b"much longer content").unwrap();
    let mut batch = WatchBatch::default();
    batch.record(
        &target,
        &event(EventKind::Modify(ModifyKind::Any), &[&first]),
        &options(),
    );
    let applied = watch::apply_batch(&mut conn, &target, &batch, &options()).unwrap();
    assert_eq!(applied.updated, 1);
    assert_eq!(file_count(&conn), 1);
    let row: (i64, Option<String>, Option<i64>) = conn
        .query_row(
            "SELECT bytes, thumb_path, thumb_mtime FROM files",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(row.0, 19);
    assert!(row.1.is_none(), "更新後はサムネイルを作り直す");
    assert!(row.2.is_none());

    // リネーム = 旧パス削除 + 新パス追加（id は変わってよい）
    let renamed = root.join("work").join("b.jpg");
    fs::rename(&first, &renamed).unwrap();
    let mut batch = WatchBatch::default();
    batch.record(
        &target,
        &event(
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            &[&first, &renamed],
        ),
        &options(),
    );
    let applied = watch::apply_batch(&mut conn, &target, &batch, &options()).unwrap();
    assert_eq!(applied.added, 1);
    assert_eq!(applied.removed, 1);
    assert_eq!(file_names(&conn), vec!["b.jpg"]);
    assert_eq!(work_count(&conn), 1);

    // 削除（空になった作品も消える）
    fs::remove_file(&renamed).unwrap();
    let mut batch = WatchBatch::default();
    batch.record(
        &target,
        &event(EventKind::Remove(RemoveKind::File), &[&renamed]),
        &options(),
    );
    let applied = watch::apply_batch(&mut conn, &target, &batch, &options()).unwrap();
    assert_eq!(applied.removed, 1);
    assert_eq!(file_count(&conn), 0);
    assert_eq!(work_count(&conn), 0);
}

#[cfg(windows)]
#[test]
fn rename_seen_only_as_a_create_moves_the_row() {
    // 新しいフォルダ直後のリネームでは、notify が旧パスの Remove を出さず
    // 新パスの Create だけを出すことがある。実体 ID で行を移せること。
    let temp = TempDir::new().unwrap();
    let (mut conn, target) = setup(temp.path(), 1);
    let root = target.real_path.clone();
    let first = root.join("work").join("a.jpg");
    create_file(&first);
    let mut batch = WatchBatch::default();
    batch.record(
        &target,
        &event(EventKind::Create(CreateKind::File), &[&first]),
        &options(),
    );
    watch::apply_batch(&mut conn, &target, &batch, &options()).unwrap();
    assert_eq!(file_names(&conn), vec!["a.jpg"]);

    let renamed = root.join("work").join("b.jpg");
    fs::rename(&first, &renamed).unwrap();
    let mut batch = WatchBatch::default();
    // Remove も Name も来ない、Create だけのイベント
    batch.record(
        &target,
        &event(EventKind::Create(CreateKind::File), &[&renamed]),
        &options(),
    );
    let applied = watch::apply_batch(&mut conn, &target, &batch, &options()).unwrap();
    assert_eq!(applied.added, 1);
    assert_eq!(applied.removed, 1);
    assert_eq!(file_names(&conn), vec!["b.jpg"]);
    assert_eq!(work_count(&conn), 1);
}

#[test]
fn ignored_files_and_configured_globs_are_skipped() {
    let temp = TempDir::new().unwrap();
    let (mut conn, target) = setup(temp.path(), 1);
    let root = target.real_path.clone();
    let names = [
        "work/a.jpg.tmp",
        "work/b.jpg.part",
        "work/Thumbs.db",
        "work/.DS_Store",
        "work/skip.bak",
        "work/node_modules/c.jpg",
        "work/.hidden/d.jpg",
        "work/.hidden.jpg",
        "work/keep.jpg",
    ];
    let mut paths = Vec::new();
    for name in names {
        let path = root.join(name);
        create_file(&path);
        paths.push(path);
    }

    let config = WatchOptions {
        exclude: vec!["*.bak".to_string()],
        ..options()
    };
    let mut batch = WatchBatch::default();
    for path in &paths {
        batch.record(
            &target,
            &event(EventKind::Create(CreateKind::File), &[path]),
            &config,
        );
    }
    watch::apply_batch(&mut conn, &target, &batch, &config).unwrap();

    assert_eq!(
        file_names(&conn),
        vec![".hidden.jpg", "keep.jpg"],
        "walk と同じくドットファイル自体は載る（除外はディレクトリだけ）"
    );
    assert!(
        watch::is_ignored(&target, &paths[4], &config),
        "設定の除外 glob が効いていない"
    );
}

#[test]
fn depth_rules_match_the_scanner() {
    // depth = 0: ルート直下だけが 1 作品に入る
    let temp = TempDir::new().unwrap();
    let (mut conn, target) = setup(temp.path(), 0);
    let root = target.real_path.clone();
    let loose = root.join("loose.jpg");
    let nested = root.join("work").join("nested.jpg");
    create_file(&loose);
    create_file(&nested);

    let mut batch = WatchBatch::default();
    batch.record(
        &target,
        &event(EventKind::Create(CreateKind::File), &[&loose, &nested]),
        &options(),
    );
    watch::apply_batch(&mut conn, &target, &batch, &options()).unwrap();
    assert_eq!(file_names(&conn), vec!["loose.jpg"]);
    assert_eq!(work_count(&conn), 1);

    // depth = 1: 第 1 階層で作品が分かれる
    let temp = TempDir::new().unwrap();
    let (mut conn, target) = setup(temp.path(), 1);
    let root = target.real_path.clone();
    let a = root.join("one").join("a.jpg");
    let b = root.join("two").join("b.jpg");
    create_file(&a);
    create_file(&b);
    let mut batch = WatchBatch::default();
    batch.record(
        &target,
        &event(EventKind::Create(CreateKind::File), &[&a, &b]),
        &options(),
    );
    watch::apply_batch(&mut conn, &target, &batch, &options()).unwrap();
    assert_eq!(file_count(&conn), 2);
    assert_eq!(work_count(&conn), 2);
}

#[test]
fn directory_events_walk_the_subtree() {
    let temp = TempDir::new().unwrap();
    let (mut conn, target) = setup(temp.path(), 1);
    let root = target.real_path.clone();
    let dir = root.join("work");
    create_file(&dir.join("a.jpg"));
    create_file(&dir.join("b.png"));

    // コピー直後はディレクトリの Create しか来ないことがある。
    // 中を歩いて索引できることを確かめる。
    let mut batch = WatchBatch::default();
    batch.record(
        &target,
        &event(EventKind::Create(CreateKind::Folder), &[&dir]),
        &options(),
    );
    assert_eq!(batch.dirs_added.len(), 1);
    let applied = watch::apply_batch(&mut conn, &target, &batch, &options()).unwrap();
    assert_eq!(applied.added, 2);
    assert_eq!(file_count(&conn), 2);

    // ディレクトリごと消すと配下のファイルも消える
    fs::remove_dir_all(&dir).unwrap();
    let mut batch = WatchBatch::default();
    batch.record(
        &target,
        &event(EventKind::Remove(RemoveKind::Folder), &[&dir]),
        &options(),
    );
    let applied = watch::apply_batch(&mut conn, &target, &batch, &options()).unwrap();
    assert_eq!(applied.removed, 2);
    assert_eq!(file_count(&conn), 0);
    assert_eq!(work_count(&conn), 0);
}

#[test]
fn deleted_files_remove_their_thumbnail_cache() {
    let temp = TempDir::new().unwrap();
    let (mut conn, target) = setup(temp.path(), 1);
    let root = target.real_path.clone();
    let image = root.join("work").join("a.jpg");
    create_file(&image);
    let mut batch = WatchBatch::default();
    batch.record(
        &target,
        &event(EventKind::Create(CreateKind::File), &[&image]),
        &options(),
    );
    watch::apply_batch(&mut conn, &target, &batch, &options()).unwrap();

    // キャッシュ先を一時ディレクトリにして、生成済みサムネイルを再現する
    let cache_dir = temp.path().join("thumbs");
    fs::create_dir_all(&cache_dir).unwrap();
    let cached = cache_dir.join("a.webp");
    fs::write(&cached, b"webp").unwrap();
    conn.execute(
        "UPDATE files SET thumb_path = ?1, thumb_mtime = mtime, thumb_bytes = bytes",
        [cached.to_string_lossy().to_string()],
    )
    .unwrap();

    fs::remove_file(&image).unwrap();
    let mut batch = WatchBatch::default();
    batch.record(
        &target,
        &event(EventKind::Remove(RemoveKind::File), &[&image]),
        &options(),
    );
    watch::apply_batch_with_cache(&mut conn, &target, &batch, &options(), &cache_dir).unwrap();

    assert_eq!(file_count(&conn), 0);
    assert!(!cached.exists(), "サムネイルキャッシュが残っている");
}

#[test]
fn batch_limit_falls_back_to_a_rescan() {
    let temp = TempDir::new().unwrap();
    let (mut conn, target) = setup(temp.path(), 1);
    let root = target.real_path.clone();
    let mut paths = Vec::new();
    for index in 0..60 {
        let path = root.join("work").join(format!("{index:03}.jpg"));
        create_file(&path);
        paths.push(path);
    }

    let config = WatchOptions {
        max_events: 10,
        ..options()
    };
    let mut batch = WatchBatch::default();
    for path in &paths {
        batch.record(
            &target,
            &event(EventKind::Create(CreateKind::File), &[path]),
            &config,
        );
    }
    assert!(batch.overflow, "上限を超えたら overflow になる");
    assert!(
        batch.added.is_empty() && batch.removed.is_empty(),
        "溢れたバッチはイベントを溜め込まない"
    );

    let applied = watch::apply_batch(&mut conn, &target, &batch, &config).unwrap();
    assert!(applied.rescanned);
    assert_eq!(applied.added, 60);
    assert_eq!(file_count(&conn), 60);
}

#[test]
fn thousand_file_copy_is_applied_without_stalling() {
    let temp = TempDir::new().unwrap();
    let (mut conn, target) = setup(temp.path(), 1);
    let dir = target.real_path.join("bulk");
    fs::create_dir_all(&dir).unwrap();

    let total = 1_000;
    let mut batch = WatchBatch::default();
    for index in 0..total {
        let path = dir.join(format!("{index:04}.jpg"));
        fs::write(&path, b"x").unwrap();
        batch.record(
            &target,
            &event(EventKind::Create(CreateKind::File), &[&path]),
            &options(),
        );
    }
    assert!(!batch.overflow);

    let started = Instant::now();
    let applied = watch::apply_batch(&mut conn, &target, &batch, &options()).unwrap();
    let elapsed = started.elapsed();

    assert_eq!(applied.added, total as u64);
    assert_eq!(file_count(&conn), total);
    assert_eq!(work_count(&conn), 1);
    // 1,000 件でも 1 バッチでまとめて書き込み、イベント処理が詰まらない
    assert!(
        elapsed < Duration::from_secs(30),
        "1,000 ファイルの反映に {elapsed:?} かかった"
    );

    // すべてサムネイル生成待ち（NULL）になっている
    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM files WHERE thumb_path IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(pending, total);
}

#[test]
fn glob_patterns_cover_names_and_relative_paths() {
    assert!(watch::glob_match("*.tmp", "a.tmp"));
    assert!(
        watch::glob_match("*.tmp", "A.TMP"),
        "Windows なので大小無視"
    );
    assert!(!watch::glob_match("*.tmp", "a.jpg"));
    assert!(watch::glob_match("Thumbs.db", "thumbs.db"));
    assert!(watch::glob_match("cache/**", "cache/2024/a.jpg"));
    assert!(watch::glob_match("cache/**", r"cache\2024\a.jpg"));
    assert!(
        watch::glob_match("**/*.jpg", "a.jpg"),
        "`**/` は 0 階層にも一致"
    );
    assert!(watch::glob_match("**/*.jpg", "work/a.jpg"));
    assert!(!watch::glob_match("work/*.jpg", "work/sub/a.jpg"));
    assert!(watch::glob_match("work/?.jpg", "work/a.jpg"));
}

#[cfg(windows)]
#[test]
fn network_paths_are_detected() {
    assert!(watch::is_network_path(Path::new(r"\\server\share\works")));
    assert!(watch::is_network_path(Path::new(
        r"\\?\UNC\server\share\works"
    )));
    assert!(!watch::is_network_path(Path::new(r"C:\Users")));
    // ローカルドライブの UNC 形式はネットワークではない
    assert!(!watch::is_network_path(Path::new(r"\\?\C:\Users")));
}

#[test]
fn disabled_setting_starts_nothing() {
    let temp = TempDir::new().unwrap();
    let library = temp.path().join("library");
    fs::create_dir_all(&library).unwrap();
    let db_path = temp.path().join("index.db");

    let conn = db::open(&db_path).unwrap();
    db::add_root(&conn, library.to_str().unwrap(), 1).unwrap();
    drop(conn);

    let settings = WatchSettings {
        enabled: false,
        exclude: Vec::new(),
        allow_network_drives: false,
        index_mpeg_ts: false,
    };
    let handler: watch::ChangeHandler = Arc::new(|_change| {});
    let started = WatchService::start(&db_path, &settings, handler).unwrap();
    assert!(started.is_none(), "設定で無効なら監視を開始しない");
}

fn wait_until(mut check: impl FnMut() -> bool, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if check() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    check()
}

fn count_files(db_path: &Path) -> i64 {
    db::open(db_path)
        .map(|conn| scalar(&conn, "SELECT COUNT(*) FROM files"))
        .unwrap_or(-1)
}

fn names(db_path: &Path) -> Vec<String> {
    let Ok(conn) = db::open(db_path) else {
        return Vec::new();
    };
    file_names(&conn)
}

#[test]
fn real_debouncer_adds_renames_and_removes_files() {
    let temp = TempDir::new().unwrap();
    let library = temp.path().join("library");
    fs::create_dir_all(&library).unwrap();
    let db_path: PathBuf = temp.path().join("index.db");

    let conn = db::open(&db_path).unwrap();
    db::add_root(&conn, library.to_str().unwrap(), 1).unwrap();
    drop(conn);

    let changes: Arc<Mutex<Vec<WatchChanged>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&changes);
    let handler: watch::ChangeHandler = Arc::new(move |change| {
        sink.lock().unwrap().push(change);
    });

    let settings = WatchSettings {
        enabled: true,
        exclude: Vec::new(),
        // 一時ディレクトリはローカルだが、CI のドライブ種別に依存しないようにする
        allow_network_drives: true,
        index_mpeg_ts: false,
    };
    let service = WatchService::start(&db_path, &settings, handler)
        .expect("watcher start")
        .expect("a root should be watched");
    assert!(service.status().enabled);
    assert!(service.status().roots.iter().any(|root| root.enabled));

    // 追加（エクスプローラ相当）→ 3 秒以内（デバウンス 1 秒）に索引へ
    let first = library.join("work").join("a.jpg");
    create_file(&first);
    assert!(
        wait_until(|| count_files(&db_path) == 1, Duration::from_secs(20)),
        "追加が索引に反映されない"
    );

    // リネーム
    let renamed = library.join("work").join("b.jpg");
    fs::rename(&first, &renamed).unwrap();
    assert!(
        wait_until(
            || names(&db_path) == vec!["b.jpg".to_string()],
            Duration::from_secs(20)
        ),
        "リネームが索引に反映されない: {:?}",
        names(&db_path)
    );

    // 削除
    fs::remove_file(&renamed).unwrap();
    assert!(
        wait_until(|| count_files(&db_path) == 0, Duration::from_secs(20)),
        "削除が索引に反映されない"
    );

    assert!(
        !changes.lock().unwrap().is_empty(),
        "watch://changed 相当の通知が 1 度も出ていない"
    );

    drop(service);
}

// ---------------------------------------------------------------------------
// #63 新着件数の累計
// ---------------------------------------------------------------------------

#[test]
fn pending_counts_accumulate_added_and_removed() {
    let mut counts = WatchPendingCounts::default();
    counts.accumulate(3, 0);
    counts.accumulate(0, 1);
    assert_eq!(counts.added, 3);
    assert_eq!(counts.removed, 1);
    assert_eq!(counts.net(), 2);
}

#[test]
fn pending_counts_never_go_negative() {
    let mut counts = WatchPendingCounts::default();
    counts.accumulate(1, 0);
    // 追加より削除が多い（別の操作で消えた分）→ 0 に丸める
    counts.accumulate(0, 5);
    assert_eq!(counts.net(), 0);
    assert!(counts.is_empty());
    assert_eq!(counts.added, 0);
    assert_eq!(counts.removed, 0);
}

#[test]
fn pending_map_records_lists_and_clears() {
    let mut map = watch::PendingMap::new();
    watch::record_pending(&mut map, 7, 3, 1);
    watch::record_pending(&mut map, 3, 5, 0);
    watch::record_pending(&mut map, 7, 0, 1);
    // 0 件の記録は増やさない（バッジは消えたまま）
    watch::record_pending(&mut map, 9, 0, 0);
    assert!(!map.contains_key(&9));

    let rows = watch::pending_list(&map);
    assert_eq!(
        rows,
        vec![
            WatchPending {
                root_id: 3,
                added: 5,
                removed: 0
            },
            WatchPending {
                root_id: 7,
                added: 3,
                removed: 2
            },
        ]
    );

    // クリアで 0 に戻る
    watch::clear_pending(&mut map, 3);
    assert_eq!(map.get(&3).map(|counts| counts.net()).unwrap_or(0), 0);
    assert!(watch::pending_list(&map).iter().all(|row| row.root_id != 3));
}
