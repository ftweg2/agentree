//! 便携版（cargo feature `portable`）：运行环境内嵌在 exe 里。
//!
//! 构建时 `npm run portable` 把 node.exe、打包成单文件的后端、前端构建产物和许可证文本
//! 打成一个 tar 并用 brotli 压缩，这里用 include_bytes! 把它嵌进 exe。
//! 首次启动时解压到 `%LOCALAPPDATA%\agentree\runtime\<payload 哈希>\`，之后直接复用。
//!
//! 解压先写到同级的临时目录，写完放一个完成标记再整体改名，所以不会留下"半截"的运行环境；
//! 发现目录不完整（被杀毒软件或用户删了文件）会重新解压。
//! 解压位置可以用环境变量 `AGENTREE_RUNTIME_DIR` 覆盖（指定的是 runtime 这一级，里面仍按哈希分目录）。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

/// payload 的内容（brotli 压缩的 tar），路径由 build.rs 给出
static PAYLOAD: &[u8] = include_bytes!(env!("AGENTREE_PAYLOAD_FILE"));
/// payload 的哈希（构建脚本算好的 SHA256 前 16 位），也是解压目录名
pub const PAYLOAD_ID: &str = env!("AGENTREE_PAYLOAD_ID");

/// 解压完成后写入的标记文件，只有它存在才认为运行环境完整
const COMPLETE_MARKER: &str = ".complete";
/// 运行环境里必须存在的文件
const REQUIRED: [&str; 3] = ["node.exe", "server/index.mjs", "web/index.html"];
/// 临时目录多久没动过才算是崩溃留下的残骸，可以清理
const STALE_TMP_AGE: Duration = Duration::from_secs(10 * 60);

/// 解压位置的上一级（runtime 目录）
pub fn runtime_base() -> PathBuf {
    if let Some(v) = std::env::var_os("AGENTREE_RUNTIME_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(v);
    }
    match std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty()) {
        Some(v) => PathBuf::from(v).join("agentree").join("runtime"),
        None => std::env::temp_dir().join("agentree").join("runtime"),
    }
}

/// 本版本的运行环境目录
pub fn runtime_dir() -> PathBuf {
    runtime_base().join(PAYLOAD_ID)
}

pub fn node_exe(dir: &Path) -> PathBuf {
    dir.join("node.exe")
}

pub fn server_entry(dir: &Path) -> PathBuf {
    dir.join("server").join("index.mjs")
}

pub fn web_dist(dir: &Path) -> PathBuf {
    dir.join("web")
}

/// 运行环境是否完整
pub fn is_ready(dir: &Path) -> bool {
    dir.join(COMPLETE_MARKER).is_file() && REQUIRED.iter().all(|f| dir.join(f).is_file())
}

pub struct Prepared {
    pub dir: PathBuf,
    /// 这次是否真的解压了（false 表示直接复用）
    pub extracted: bool,
    pub elapsed: Duration,
}

/// 确保运行环境已经解压好
pub fn ensure_runtime() -> Result<Prepared, String> {
    let started = Instant::now();
    let base = runtime_base();
    let dir = base.join(PAYLOAD_ID);
    if is_ready(&dir) {
        return Ok(Prepared { dir, extracted: false, elapsed: started.elapsed() });
    }

    fs::create_dir_all(&base).map_err(|e| format!("无法创建目录 {}：{e}", base.display()))?;
    let tmp = base.join(format!("{PAYLOAD_ID}.tmp-{}", std::process::id()));
    if tmp.exists() {
        let _ = fs::remove_dir_all(&tmp);
    }
    if let Err(e) = extract(&tmp) {
        let _ = fs::remove_dir_all(&tmp);
        return Err(format!("解压运行环境到 {} 失败：{e}", tmp.display()));
    }

    // 改名成正式目录。刚写完的文件可能正被杀毒软件扫描，改名失败时稍等重试
    let mut last_err = None;
    for _ in 0..25 {
        if is_ready(&dir) {
            // 另一个进程已经抢先解压好了
            let _ = fs::remove_dir_all(&tmp);
            return Ok(Prepared { dir, extracted: true, elapsed: started.elapsed() });
        }
        if dir.exists() {
            // 不完整的旧目录：删掉重来
            let _ = fs::remove_dir_all(&dir);
        }
        match fs::rename(&tmp, &dir) {
            Ok(()) => {
                return Ok(Prepared { dir, extracted: true, elapsed: started.elapsed() });
            }
            Err(e) => last_err = Some(e),
        }
        thread::sleep(Duration::from_millis(200));
    }
    let _ = fs::remove_dir_all(&tmp);
    Err(format!(
        "无法把解压好的运行环境放到 {}：{}",
        dir.display(),
        last_err.map(|e| e.to_string()).unwrap_or_default()
    ))
}

fn extract(tmp: &Path) -> io::Result<()> {
    fs::create_dir_all(tmp)?;
    let reader = brotli_decompressor::Decompressor::new(PAYLOAD, 256 * 1024);
    let mut archive = tar::Archive::new(reader);
    archive.set_preserve_mtime(false);
    archive.set_preserve_permissions(false);
    archive.set_overwrite(true);
    archive.unpack(tmp)?;
    for f in REQUIRED {
        if !tmp.join(f).is_file() {
            return Err(io::Error::new(io::ErrorKind::NotFound, format!("payload 里缺少 {f}")));
        }
    }
    fs::write(tmp.join(COMPLETE_MARKER), PAYLOAD_ID)?;
    Ok(())
}

/// 这个名字是不是本程序创建的运行环境目录（16 位十六进制哈希，或它的临时目录）
fn is_our_dir_name(name: &str) -> Option<bool> {
    let (hash, rest) = name.split_at_checked(16)?;
    if !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    if rest.is_empty() {
        return Some(false);
    }
    let pid = rest.strip_prefix(".tmp-")?;
    (!pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit())).then_some(true)
}

/// 清理旧版本的运行环境和崩溃留下的临时目录。
/// 只删除名字符合本程序命名规则的目录，出错一律忽略（例如文件正被旧版本占用）。
pub fn cleanup_old() {
    let base = runtime_base();
    let Ok(entries) = fs::read_dir(&base) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let path = e.path();
        if !path.is_dir() || name == PAYLOAD_ID {
            continue;
        }
        let Some(is_tmp) = is_our_dir_name(&name) else { continue };
        if is_tmp {
            // 别的进程可能正在解压：只清理一段时间没动过的临时目录
            let age = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| SystemTime::now().duration_since(t).ok())
                .unwrap_or_default();
            if age < STALE_TMP_AGE {
                continue;
            }
        } else if !path.join(COMPLETE_MARKER).is_file() {
            continue;
        }
        let _ = fs::remove_dir_all(&path);
    }
}

// 缺少 WebView2 时不需要这里处理：Tauri 创建窗口失败时会自己弹出
// "Could not find the WebView2 Runtime…" 的提示框（普通桌面版也一样）。

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn our_dir_names() {
        assert_eq!(is_our_dir_name("0123456789abcdef"), Some(false));
        assert_eq!(is_our_dir_name("0123456789abcdef.tmp-1234"), Some(true));
        assert_eq!(is_our_dir_name("0123456789abcdef.tmp-"), None);
        assert_eq!(is_our_dir_name("0123456789abcdeg"), None);
        assert_eq!(is_our_dir_name("node_modules"), None);
        assert_eq!(is_our_dir_name("0123456789abcdef-old"), None);
    }
}
