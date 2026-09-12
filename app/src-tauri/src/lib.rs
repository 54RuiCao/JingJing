use std::sync::Mutex;

use rusqlite::types::ValueRef;
use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;

/// 全局 SQLite 连接。桌面端单用户场景，用 Mutex 串行化访问即可。
struct Db(Mutex<Connection>);

fn json_to_sql(v: &Value) -> rusqlite::types::Value {
    match v {
        Value::Null => rusqlite::types::Value::Null,
        Value::Bool(b) => rusqlite::types::Value::Integer(if *b { 1 } else { 0 }),
        Value::Number(n) => match n.as_i64() {
            Some(i) => rusqlite::types::Value::Integer(i),
            None => rusqlite::types::Value::Real(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        other => rusqlite::types::Value::Text(other.to_string()),
    }
}

fn sql_to_json(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::String(format!("<blob {} bytes>", b.len())),
    }
}

#[tauri::command]
fn engine_info() -> Value {
    json!({
        "name": "aireader",
        "version": env!("CARGO_PKG_VERSION"),
        "engine": "foliate-js"
    })
}

/// P0 验收用（每次前端 dist 变化后需要触摸本文件以强制重新嵌入资源）
#[tauri::command]
fn save_report(path: String, content: String) -> Result<String, String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path)
}

// ---------- 数据层 ----------

/// 执行写语句，返回受影响行数
#[tauri::command]
fn db_execute(state: tauri::State<'_, Db>, sql: String, params: Vec<Value>) -> Result<usize, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let owned: Vec<rusqlite::types::Value> = params.iter().map(json_to_sql).collect();
    conn.execute(&sql, rusqlite::params_from_iter(owned))
        .map_err(|e| format!("{e} | sql: {sql}"))
}

/// 执行多条语句（建表、迁移用）
#[tauri::command]
fn db_execute_batch(state: tauri::State<'_, Db>, sql: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute_batch(&sql).map_err(|e| e.to_string())
}

/// 批量写入（单事务）。用于建立全文索引这类成千上万行的一次性写入。
#[tauri::command]
fn db_execute_many(state: tauri::State<'_, Db>, sql: String, rows: Vec<Vec<Value>>) -> Result<usize, String> {
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut affected = 0usize;
    {
        let mut stmt = tx.prepare(&sql).map_err(|e| format!("{e} | sql: {sql}"))?;
        for row in rows.iter() {
            let owned: Vec<rusqlite::types::Value> = row.iter().map(json_to_sql).collect();
            affected += stmt
                .execute(rusqlite::params_from_iter(owned))
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(affected)
}

/// 查询，返回按列名索引的 JSON 数组
#[tauri::command]
fn db_select(state: tauri::State<'_, Db>, sql: String, params: Vec<Value>) -> Result<Vec<Value>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let owned: Vec<rusqlite::types::Value> = params.iter().map(json_to_sql).collect();
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("{e} | sql: {sql}"))?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt.query(rusqlite::params_from_iter(owned)).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut obj = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            let cell = row.get_ref(i).map_err(|e| e.to_string())?;
            obj.insert(name.clone(), sql_to_json(cell));
        }
        out.push(Value::Object(obj));
    }
    Ok(out)
}

// ---------- 书籍文件 ----------

fn books_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("books");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
fn get_books_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(books_dir(&app)?.to_string_lossy().to_string())
}

/// 把用户选中的文件复制进应用数据目录（内容寻址：文件名 = sha256 前 16 位 + 原扩展名）
#[tauri::command]
fn import_book_file(app: tauri::AppHandle, src: String) -> Result<Value, String> {
    let src_path = std::path::PathBuf::from(&src);
    if !src_path.is_file() {
        return Err(format!("文件不存在: {src}"));
    }
    let bytes = std::fs::read(&src_path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    let sha = hex[..16].to_string();

    let ext = src_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let file_name = if ext.is_empty() {
        sha.clone()
    } else {
        format!("{sha}.{ext}")
    };
    let dest = books_dir(&app)?.join(&file_name);
    if !dest.exists() {
        std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    }

    let original_name = src_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    Ok(json!({
        "sha": sha,
        "path": dest.to_string_lossy(),
        "originalName": original_name,
        "ext": ext,
        "size": bytes.len(),
    }))
}

/// 保存"派生文件"（目前是 TXT 转换出来的 EPUB）。
/// 用 base64 传二进制，避免把几十万个数字的数组塞进 IPC。
#[tauri::command]
fn save_book_derived(
    app: tauri::AppHandle,
    sha: String,
    ext: String,
    base64: String,
) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| e.to_string())?;
    let dest = books_dir(&app)?.join(format!("{sha}.{ext}"));
    std::fs::write(&dest, bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
fn delete_book_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let dir = books_dir(&app)?;
    let p = std::path::PathBuf::from(&path);
    // 只允许删除书籍目录内的文件，避免前端传入任意路径
    if p.parent() != Some(dir.as_path()) {
        return Err("拒绝删除书籍目录之外的文件".into());
    }
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------- 技能目录（P2.5）----------
//
// 形态照 DSH 的 discoverRoot（内部设计笔记 §1.1）：只认两种形态，**深度仅一层**，
// 刻意不递归找 SKILL.md：
//   目录 bundle  <root>/<dir>/SKILL.md   （resourceBase = <root>/<dir>）
//   平铺文件     <root>/<name>.md        （resourceBase = <root>）
//
// 写侧只有一条纪律：**只允许 Markdown**（SKILL.md 与 references/ 下的 .md）。
// 技能是纯数据层，AI 生成技能也不生成代码 —— 这条在 Rust 侧强制，TS 侧绕不过去。

fn skills_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("skills");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 相对路径 → 绝对路径。拒绝绝对路径、`..`、空段与冒号，避免越出给定的根目录。
/// 技能目录与插件目录共用它。
fn safe_rel_path(root: &std::path::Path, rel: &str) -> Result<std::path::PathBuf, String> {
    let norm = rel.replace('\\', "/");
    if norm.is_empty() || norm.starts_with('/') || norm.contains("..") || norm.contains(':') {
        return Err(format!("非法路径: {rel}"));
    }
    let mut p = root.to_path_buf();
    for seg in norm.split('/') {
        if seg.is_empty() || seg == "." {
            return Err(format!("非法路径: {rel}"));
        }
        p.push(seg);
    }
    Ok(p)
}

/// 收集技能附带的资源（只看 references/，深度 ≤ 3 层，只收 .md/.txt）
fn collect_resources(dir: &std::path::Path, base: &std::path::Path, out: &mut Vec<String>, depth: u32) {
    if depth > 3 || out.len() >= 32 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut items: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    items.sort_by_key(|e| e.file_name());
    for entry in items {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let kind = match entry.file_type() {
            Ok(f) => f,
            Err(_) => continue,
        };
        if kind.is_dir() {
            collect_resources(&path, base, out, depth + 1);
        } else if kind.is_file() {
            let lower = name.to_lowercase();
            if !(lower.ends_with(".md") || lower.ends_with(".txt")) {
                continue;
            }
            if let Ok(rel) = path.strip_prefix(base) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                // SKILL.md 是技能本身，不是"附带资源"，不要列进资源清单
                if rel != "SKILL.md" {
                    out.push(rel);
                }
            }
        }
    }
}

#[tauri::command]
fn get_skills_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(skills_dir(&app)?.to_string_lossy().to_string())
}

/// 扫描技能根目录。没有 SKILL.md 的目录会被静默跳过（DSH 同：那是"没这个技能"，不是错误）
#[tauri::command]
fn scan_skills(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let root = skills_dir(&app)?;
    let mut out: Vec<Value> = Vec::new();
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };
    let mut items: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    items.sort_by_key(|e| e.file_name());
    for entry in items {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let kind = match entry.file_type() {
            Ok(f) => f,
            Err(_) => continue,
        };
        if kind.is_dir() {
            let skill = path.join("SKILL.md");
            if !skill.is_file() {
                continue;
            }
            let mut resources: Vec<String> = Vec::new();
            collect_resources(&path, &path, &mut resources, 1);
            out.push(json!({
                "relPath": format!("{name}/SKILL.md"),
                "dirRel": name,
                "absDir": path.to_string_lossy(),
                "resources": resources,
            }));
        } else if kind.is_file() && name.to_lowercase().ends_with(".md") {
            out.push(json!({
                "relPath": name,
                "dirRel": "",
                "absDir": root.to_string_lossy(),
                "resources": [],
            }));
        }
    }
    Ok(out)
}

/// 读技能文件（SKILL.md 或资源）。上限 1MB：技能正文没有大小上限（DSH 同），
/// 但一个 10MB 的"技能"只可能是事故。
#[tauri::command]
fn read_skill_text(app: tauri::AppHandle, rel_path: String) -> Result<String, String> {
    let root = skills_dir(&app)?;
    let p = safe_rel_path(&root, &rel_path)?;
    let meta = std::fs::metadata(&p).map_err(|e| format!("读取技能文件失败: {e}"))?;
    if meta.len() > 1024 * 1024 {
        return Err(format!("技能文件过大（{} 字节，上限 1MB）", meta.len()));
    }
    std::fs::read_to_string(&p).map_err(|e| format!("读取技能文件失败: {e}"))
}

/// 写技能文件：**只允许 Markdown 数据**（<name>.md / <name>/SKILL.md / <name>/references/*.md）。
/// 这是"AI 生成技能只生成数据、不生成代码"在文件系统层的强制点。
#[tauri::command]
fn write_skill_text(
    app: tauri::AppHandle,
    rel_path: String,
    text: String,
    overwrite: bool,
) -> Result<String, String> {
    let root = skills_dir(&app)?;
    let norm = rel_path.replace('\\', "/");
    let ok = (norm.ends_with(".md") && !norm.contains('/'))
        || (norm.ends_with("/SKILL.md"))
        || (norm.contains("/references/") && norm.ends_with(".md"));
    if !ok {
        return Err(format!(
            "只允许写 Markdown 数据文件（<name>.md、<name>/SKILL.md、<name>/references/*.md），收到: {rel_path}"
        ));
    }
    let p = safe_rel_path(&root, &norm)?;
    if p.exists() && !overwrite {
        return Err(format!("技能文件已存在（覆盖需要 overwrite=true）: {norm}"));
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, text).map_err(|e| format!("写入技能文件失败: {e}"))?;
    Ok(p.to_string_lossy().to_string())
}

/// 删除一个用户技能（整个技能目录，或平铺的 <name>.md）。
/// 只允许删技能根目录下的东西，且目录必须真的有 SKILL.md。
#[tauri::command]
fn delete_skill(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let root = skills_dir(&app)?;
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("非法技能名: {name}"));
    }
    let dir = root.join(&name);
    if dir.is_dir() {
        if !dir.join("SKILL.md").is_file() {
            return Err(format!("{name} 不是技能目录（里面没有 SKILL.md）"));
        }
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let flat = root.join(format!("{name}.md"));
    if flat.is_file() {
        std::fs::remove_file(&flat).map_err(|e| e.to_string())?;
        return Ok(());
    }
    Err(format!("没有名为 {name} 的技能"))
}

// ---------- 插件目录（P3.1）----------
//
// 形态：<root>/<pluginId>/manifest.json（+ main / ui 等文件）。
// 宿主**不解释** manifest 的语义（那是 TS 侧 plugin/manifest.ts 的事），
// Rust 只负责：安全列目录、安全读、安全写、安全删。
//
// 与技能目录的区别：插件包含代码文件（.js），所以写侧虽然允许它落盘，
// **执行权**不在这一层 —— P3.3 的 quickjs 运行时 + 授权层才是执行的门。

fn plugins_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("plugins");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 列出一个插件包里的文件（相对包根，排序；只收常规文件，跳过隐藏文件与子目录递归里的隐藏项）
fn collect_package_files(dir: &std::path::Path, base: &std::path::Path, out: &mut Vec<String>, depth: u32) {
    if depth > 4 || out.len() >= 128 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut items: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    items.sort_by_key(|e| e.file_name());
    for entry in items {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let kind = match entry.file_type() {
            Ok(f) => f,
            Err(_) => continue,
        };
        if kind.is_dir() {
            collect_package_files(&path, base, out, depth + 1);
        } else if kind.is_file() {
            if let Ok(rel) = path.strip_prefix(base) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

#[tauri::command]
fn get_plugins_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(plugins_dir(&app)?.to_string_lossy().to_string())
}

/// 扫插件根目录：只认"目录里有 manifest.json"的包（平铺的 .json 不算插件）
#[tauri::command]
fn scan_plugins(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let root = plugins_dir(&app)?;
    let mut out: Vec<Value> = Vec::new();
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };
    let mut items: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    items.sort_by_key(|e| e.file_name());
    for entry in items {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let kind = match entry.file_type() {
            Ok(f) => f,
            Err(_) => continue,
        };
        if !kind.is_dir() || !path.join("manifest.json").is_file() {
            continue;
        }
        let mut files: Vec<String> = Vec::new();
        collect_package_files(&path, &path, &mut files, 1);
        out.push(json!({
            "relDir": name,
            "absDir": path.to_string_lossy(),
            "files": files,
        }));
    }
    Ok(out)
}

#[tauri::command]
fn read_plugin_text(app: tauri::AppHandle, rel_path: String) -> Result<String, String> {
    let root = plugins_dir(&app)?;
    let p = safe_rel_path(&root, &rel_path)?;
    let meta = std::fs::metadata(&p).map_err(|e| format!("读取插件文件失败: {e}"))?;
    if meta.len() > 2 * 1024 * 1024 {
        return Err(format!("插件文件过大（{} 字节，上限 2MB）", meta.len()));
    }
    std::fs::read_to_string(&p).map_err(|e| format!("读取插件文件失败: {e}"))
}

/// 写插件文件（安装/开发用）。只允许文本类扩展名：**不解释、不执行**，执行权在 P3.3 的运行时那层。
#[tauri::command]
fn write_plugin_text(
    app: tauri::AppHandle,
    rel_path: String,
    text: String,
    overwrite: bool,
) -> Result<String, String> {
    let root = plugins_dir(&app)?;
    let norm = rel_path.replace('\\', "/");
    let lower = norm.to_lowercase();
    let ok = [".json", ".js", ".mjs", ".css", ".md", ".txt"]
        .iter()
        .any(|ext| lower.ends_with(ext));
    if !ok {
        return Err(format!("只允许写文本类插件文件（.json/.js/.mjs/.css/.md/.txt），收到: {rel_path}"));
    }
    let p = safe_rel_path(&root, &norm)?;
    if p.exists() && !overwrite {
        return Err(format!("插件文件已存在（覆盖需要 overwrite=true）: {norm}"));
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, text).map_err(|e| format!("写入插件文件失败: {e}"))?;
    Ok(p.to_string_lossy().to_string())
}

/// 删掉一个插件包（整个目录）。目录必须真的有 manifest.json，防止误删。
#[tauri::command]
fn delete_plugin(app: tauri::AppHandle, rel_dir: String) -> Result<(), String> {
    let root = plugins_dir(&app)?;
    if rel_dir.is_empty() || rel_dir.contains('/') || rel_dir.contains('\\') || rel_dir.contains("..") {
        return Err(format!("非法插件目录名: {rel_dir}"));
    }
    let dir = root.join(&rel_dir);
    if !dir.is_dir() {
        return Err(format!("没有这个插件目录: {rel_dir}"));
    }
    if !dir.join("manifest.json").is_file() {
        return Err(format!("{rel_dir} 不是插件包（里面没有 manifest.json）"));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("无法解析应用数据目录");
            std::fs::create_dir_all(&dir).expect("无法创建应用数据目录");
            let conn = Connection::open(dir.join("aireader.db")).expect("无法打开数据库");
            conn.execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA foreign_keys = ON;
                 PRAGMA synchronous = NORMAL;",
            )
            .expect("数据库初始化失败");
            app.manage(Db(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine_info,
            save_report,
            db_execute,
            db_execute_batch,
            db_execute_many,
            db_select,
            get_books_dir,
            import_book_file,
            save_book_derived,
            delete_book_file,
            get_skills_dir,
            scan_skills,
            read_skill_text,
            write_skill_text,
            delete_skill,
            get_plugins_dir,
            scan_plugins,
            read_plugin_text,
            write_plugin_text,
            delete_plugin
        ])
        .run(tauri::generate_context!())
        .expect("error while running aireader");
}
