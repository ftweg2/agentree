//! 后端进程管理：配置解析、启动命令解析、子进程启动与结束、健康检查。

use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

pub const DEFAULT_PORT: u16 = 4777;
/// 项目根目录下的可选配置文件
pub const CONFIG_FILE: &str = "desktop/agentree-desktop.json";
const LOG_CAPACITY: usize = 400;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Settings {
    pub root: PathBuf,
    pub port: u16,
    /// 显式配置的后端启动命令（环境变量或配置文件）
    pub server_command: Option<(String, &'static str)>,
    /// 读取配置文件时遇到的问题，显示在错误页上
    pub config_warning: Option<String>,
}

impl Settings {
    pub fn server_dir(&self) -> PathBuf {
        self.root.join("server")
    }
}

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn load_settings() -> Settings {
    // 项目根目录：AGENTREE_ROOT 优先，否则用编译时的 CARGO_MANIFEST_DIR 往上两级
    let root = match env_nonempty("AGENTREE_ROOT") {
        Some(r) => PathBuf::from(r),
        None => {
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            manifest
                .parent()
                .and_then(Path::parent)
                .map(Path::to_path_buf)
                .unwrap_or(manifest)
        }
    };
    let root = dunce_like(&root);

    let mut config_warning = None;
    let mut file_port: Option<u16> = None;
    let mut file_cmd: Option<String> = None;
    let config_path = root.join(CONFIG_FILE);
    if config_path.is_file() {
        match std::fs::read_to_string(&config_path)
            .map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str::<Value>(s.trim_start_matches('\u{feff}')).map_err(|e| e.to_string()))
        {
            Ok(v) => {
                file_port = v.get("port").and_then(Value::as_u64).and_then(|p| u16::try_from(p).ok());
                file_cmd = v
                    .get("serverCommand")
                    .and_then(Value::as_str)
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
            }
            Err(e) => {
                config_warning = Some(format!("配置文件 {} 解析失败，已忽略：{}", config_path.display(), e));
            }
        }
    }

    let port = env_nonempty("AGENTREE_PORT")
        .and_then(|p| p.parse::<u16>().ok())
        .filter(|p| *p != 0)
        .or(file_port)
        .unwrap_or(DEFAULT_PORT);

    let server_command = env_nonempty("AGENTREE_SERVER_CMD")
        .map(|c| (c, "环境变量 AGENTREE_SERVER_CMD"))
        .or(file_cmd.map(|c| (c, "配置文件 desktop/agentree-desktop.json")));

    Settings { root, port, server_command, config_warning }
}

/// 去掉 Windows 的 `\\?\` 前缀并规范化分隔符，只用于显示和作为工作目录
fn dunce_like(p: &Path) -> PathBuf {
    let s = p.to_string_lossy().replace('/', "\\");
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();
    let mut out = PathBuf::new();
    for comp in Path::new(&s).components() {
        match comp {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            c => out.push(c.as_os_str()),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 启动命令
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct LaunchPlan {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// 给用户看的命令描述
    pub display: String,
    /// 命令从哪里来
    pub source: String,
    pub node: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct LaunchError {
    pub title: String,
    pub message: String,
    pub hint: Option<String>,
}

fn node_missing_error() -> LaunchError {
    LaunchError {
        title: "找不到 Node.js".into(),
        message: "没有找到 node.exe，无法启动 agentree 后端。".into(),
        hint: Some(
            "请安装 Node.js 24 或更高版本（https://nodejs.org），并确认 node 在 PATH 中；\
             也可以设置环境变量 AGENTREE_NODE 为 node.exe 的完整路径。安装后点击“重试”。"
                .into(),
        ),
    }
}

/// 查找 node.exe
pub fn find_node() -> Option<PathBuf> {
    if let Some(p) = env_nonempty("AGENTREE_NODE") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(exe);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    #[cfg(windows)]
    {
        let mut candidates: Vec<PathBuf> = Vec::new();
        for key in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Some(v) = env_nonempty(key) {
                candidates.push(PathBuf::from(v).join("nodejs").join(exe));
            }
        }
        if let Some(v) = env_nonempty("LOCALAPPDATA") {
            candidates.push(PathBuf::from(v).join("Programs").join("nodejs").join(exe));
        }
        if let Some(v) = env_nonempty("NVM_SYMLINK") {
            candidates.push(PathBuf::from(v).join(exe));
        }
        if let Some(v) = env_nonempty("VOLTA_HOME") {
            candidates.push(PathBuf::from(v).join("bin").join(exe));
        }
        for c in candidates {
            if c.is_file() {
                return Some(c);
            }
        }
    }
    None
}

/// 简单的命令行分词：按空白分割，支持单双引号
pub fn tokenize(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut has = false;
    let mut quote: Option<char> = None;
    for ch in s.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => cur.push(ch),
            None => match ch {
                '"' | '\'' => {
                    quote = Some(ch);
                    has = true;
                }
                c if c.is_whitespace() => {
                    if has {
                        out.push(std::mem::take(&mut cur));
                        has = false;
                    }
                }
                c => {
                    cur.push(c);
                    has = true;
                }
            },
        }
    }
    if has {
        out.push(cur);
    }
    out
}

/// 命令里有 shell 语法（管道、串联、重定向等）时无法直接执行
fn has_shell_syntax(s: &str) -> bool {
    let mut quote: Option<char> = None;
    for ch in s.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => {}
            None => match ch {
                '"' | '\'' => quote = Some(ch),
                '&' | '|' | ';' | '>' | '<' | '`' | '$' | '%' | '(' | ')' => return true,
                _ => {}
            },
        }
    }
    false
}

fn is_env_assignment(tok: &str) -> Option<(String, String)> {
    let (k, v) = tok.split_once('=')?;
    let mut chars = k.chars();
    let first = chars.next()?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    Some((k.to_string(), v.to_string()))
}

fn is_node_token(tok: &str) -> bool {
    let t = tok.to_ascii_lowercase();
    t == "node" || t == "node.exe"
}

/// 在 server/node_modules 里找命令对应的 JS 入口（例如 tsx → node_modules/tsx/dist/cli.mjs）
fn resolve_bin(server_dir: &Path, name: &str) -> Option<PathBuf> {
    let nm = server_dir.join("node_modules");
    let from_pkg = |pkg_dir: &Path| -> Option<PathBuf> {
        let text = std::fs::read_to_string(pkg_dir.join("package.json")).ok()?;
        let v: Value = serde_json::from_str(&text).ok()?;
        let pkg_name = v.get("name").and_then(Value::as_str).unwrap_or("");
        let rel = match v.get("bin")? {
            Value::String(s) => {
                // bin 为字符串时命令名是包名（去掉作用域）
                let short = pkg_name.rsplit('/').next().unwrap_or(pkg_name);
                if short != name {
                    return None;
                }
                s.clone()
            }
            Value::Object(map) => map.get(name)?.as_str()?.to_string(),
            _ => return None,
        };
        let p = pkg_dir.join(rel);
        p.is_file().then_some(p)
    };
    // 先看同名包
    if let Some(p) = from_pkg(&nm.join(name)) {
        return Some(p);
    }
    // 再扫描所有顶层包（含作用域包）
    let entries = std::fs::read_dir(&nm).ok()?;
    for e in entries.flatten() {
        let path = e.path();
        let fname = e.file_name().to_string_lossy().to_string();
        if fname.starts_with('.') || !path.is_dir() {
            continue;
        }
        if fname.starts_with('@') {
            if let Ok(sub) = std::fs::read_dir(&path) {
                for s in sub.flatten() {
                    if let Some(p) = from_pkg(&s.path()) {
                        return Some(p);
                    }
                }
            }
        } else if let Some(p) = from_pkg(&path) {
            return Some(p);
        }
    }
    None
}

fn quote_arg(a: &str) -> String {
    if a.is_empty() || a.chars().any(|c| c.is_whitespace() || c == '"') {
        format!("\"{}\"", a.replace('"', "\\\""))
    } else {
        a.to_string()
    }
}

fn display_of(program: &Path, args: &[String]) -> String {
    let mut s = quote_arg(&program.to_string_lossy());
    for a in args {
        s.push(' ');
        s.push_str(&quote_arg(a));
    }
    s
}

/// 把一行 npm 脚本风格的命令转成"用 node 直接执行"的形式。解析不了返回 None。
fn plan_direct(
    cmdline: &str,
    node: &Path,
    server_dir: &Path,
) -> Option<(PathBuf, Vec<String>, Vec<(String, String)>)> {
    if has_shell_syntax(cmdline) {
        return None;
    }
    let tokens = tokenize(cmdline);
    let mut i = 0;
    let mut env = Vec::new();
    if tokens.get(i).map(|t| t == "cross-env").unwrap_or(false) {
        i += 1;
    }
    while let Some((k, v)) = tokens.get(i).and_then(|t| is_env_assignment(t)) {
        env.push((k, v));
        i += 1;
    }
    let cmd = tokens.get(i)?;
    let rest: Vec<String> = tokens[i + 1..].to_vec();
    if is_node_token(cmd) {
        return Some((node.to_path_buf(), rest, env));
    }
    // npm/npx/yarn/pnpm 这类包装器没法安全地直接执行
    let lower = cmd.to_ascii_lowercase();
    if ["npm", "npx", "yarn", "pnpm", "bun", "cmd", "sh", "bash"].contains(&lower.as_str()) {
        return None;
    }
    let script = resolve_bin(server_dir, cmd)?;
    let mut args = vec![script.to_string_lossy().to_string()];
    args.extend(rest);
    Some((node.to_path_buf(), args, env))
}

fn npm_fallback(node: Option<&Path>, source: String) -> LaunchPlan {
    let comspec = env_nonempty("ComSpec").unwrap_or_else(|| "cmd.exe".into());
    let program = PathBuf::from(comspec);
    let args: Vec<String> = ["/d", "/s", "/c", "npm run start"].iter().map(|s| s.to_string()).collect();
    LaunchPlan {
        display: "cmd /c npm run start".into(),
        program,
        args,
        env: Vec::new(),
        source,
        node: node.map(Path::to_path_buf),
    }
}

pub fn resolve_launch(settings: &Settings) -> Result<LaunchPlan, LaunchError> {
    let server_dir = settings.server_dir();
    if !server_dir.is_dir() {
        return Err(LaunchError {
            title: "找不到后端目录".into(),
            message: format!("后端目录不存在：{}", server_dir.display()),
            hint: Some(
                "请确认 agentree 项目完整；如果项目放在别处，请设置环境变量 AGENTREE_ROOT \
                 指向 agentree 项目根目录（包含 server/ 的那一级），然后重新打开。"
                    .into(),
            ),
        });
    }

    let node = find_node();

    // 1. 显式配置的命令
    if let Some((cmdline, source)) = &settings.server_command {
        let tokens = tokenize(cmdline);
        if let Some(first) = tokens.first() {
            if is_node_token(first) || !has_shell_syntax(cmdline) {
                if let Some(node) = node.as_deref() {
                    if let Some((program, args, env)) = plan_direct(cmdline, node, &server_dir) {
                        return Ok(LaunchPlan {
                            display: display_of(&program, &args),
                            program,
                            args,
                            env,
                            source: source.to_string(),
                            node: Some(node.to_path_buf()),
                        });
                    }
                } else if is_node_token(first) {
                    return Err(node_missing_error());
                }
            }
            // 不是 node 命令：直接执行可执行文件，否则交给 cmd
            let first_path = PathBuf::from(first);
            if !has_shell_syntax(cmdline)
                && first_path.extension().map(|e| e.eq_ignore_ascii_case("exe")).unwrap_or(false)
            {
                let program = if first_path.is_absolute() { first_path } else { server_dir.join(first_path) };
                let args = tokens[1..].to_vec();
                return Ok(LaunchPlan {
                    display: display_of(&program, &args),
                    program,
                    args,
                    env: Vec::new(),
                    source: source.to_string(),
                    node,
                });
            }
            let comspec = env_nonempty("ComSpec").unwrap_or_else(|| "cmd.exe".into());
            return Ok(LaunchPlan {
                display: format!("cmd /c {cmdline}"),
                program: PathBuf::from(comspec),
                args: vec!["/d".into(), "/s".into(), "/c".into(), cmdline.clone()],
                env: Vec::new(),
                source: source.to_string(),
                node,
            });
        }
    }

    // 2. server/package.json 的 start 脚本
    let Some(node) = node else {
        return Err(node_missing_error());
    };
    let pkg_path = server_dir.join("package.json");
    let pkg_text = std::fs::read_to_string(&pkg_path).map_err(|_| LaunchError {
        title: "找不到后端的 package.json".into(),
        message: format!("无法读取 {}", pkg_path.display()),
        hint: Some("后端代码可能还没有准备好。请确认 server/ 目录完整后点击“重试”。".into()),
    })?;
    let start = serde_json::from_str::<Value>(pkg_text.trim_start_matches('\u{feff}'))
        .ok()
        .and_then(|v| v.get("scripts")?.get("start")?.as_str().map(str::to_string));

    match start {
        Some(script) => match plan_direct(&script, &node, &server_dir) {
            Some((program, args, env)) => Ok(LaunchPlan {
                display: display_of(&program, &args),
                program,
                args,
                env,
                source: format!("server/package.json 的 start 脚本：{script}"),
                node: Some(node),
            }),
            None => Ok(npm_fallback(
                Some(&node),
                format!("server/package.json 的 start 脚本无法直接解析（{script}），改用 npm 执行"),
            )),
        },
        None => Ok(npm_fallback(
            Some(&node),
            "server/package.json 中没有找到 start 脚本，改用 npm 执行".into(),
        )),
    }
}

// ---------------------------------------------------------------------------
// 日志缓冲
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct LogBuffer {
    lines: Mutex<VecDeque<String>>,
}

impl LogBuffer {
    pub fn push(&self, line: String) {
        let mut g = lock(&self.lines);
        if g.len() >= LOG_CAPACITY {
            g.pop_front();
        }
        g.push_back(line);
    }
    pub fn clear(&self) {
        lock(&self.lines).clear();
    }
    pub fn tail(&self, n: usize) -> Vec<String> {
        let g = lock(&self.lines);
        let skip = g.len().saturating_sub(n);
        g.iter().skip(skip).cloned().collect()
    }
    pub fn contains(&self, needle: &str) -> bool {
        lock(&self.lines).iter().any(|l| l.contains(needle))
    }
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c2 in chars.by_ref() {
                    if ('@'..='~').contains(&c2) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn spawn_reader<R: Read + Send + 'static>(stream: R, logs: Arc<LogBuffer>, prefix: &'static str) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&buf);
                    let line = strip_ansi(text.trim_end_matches(['\r', '\n']));
                    logs.push(format!("{prefix}{line}"));
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// 后端子进程
// ---------------------------------------------------------------------------

pub struct BackendProcess {
    child: Child,
    #[cfg(windows)]
    job: Option<crate::job::Job>,
    pub pid: u32,
    killed: bool,
}

impl BackendProcess {
    /// 进程是否已退出，返回退出码描述
    pub fn try_exit(&mut self) -> Option<String> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(match status.code() {
                Some(c) => c.to_string(),
                None => "未知".into(),
            }),
            Ok(None) => None,
            Err(e) => Some(format!("未知（{e}）")),
        }
    }

    /// 结束后端进程及其全部子进程
    pub fn kill(&mut self) {
        if self.killed {
            return;
        }
        self.killed = true;
        #[cfg(windows)]
        {
            let mut done = false;
            if let Some(job) = &self.job {
                done = job.terminate().is_ok();
            }
            if !done {
                // 没有作业对象时退回 taskkill /T 结束整棵进程树
                use std::os::windows::process::CommandExt;
                let _ = Command::new("taskkill")
                    .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .creation_flags(0x0800_0000)
                    .status();
            }
        }
        let _ = self.child.kill();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for BackendProcess {
    fn drop(&mut self) {
        self.kill();
    }
}

pub fn spawn_backend(
    plan: &LaunchPlan,
    server_dir: &Path,
    port: u16,
    logs: Arc<LogBuffer>,
) -> io::Result<BackendProcess> {
    let mut cmd = Command::new(&plan.program);
    cmd.args(&plan.args)
        .current_dir(server_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("AGENTREE_PORT", port.to_string())
        .env("AGENTREE_DESKTOP", "1")
        .env("NO_COLOR", "1")
        .env_remove("FORCE_COLOR");
    if std::env::var_os("NODE_ENV").is_none() {
        cmd.env("NODE_ENV", "production");
    }
    // 把 node 所在目录放到 PATH 前面，保证 npm 回退方式和后端派生的 node 进程能找到它
    if let Some(node_dir) = plan.node.as_deref().and_then(Path::parent) {
        let mut paths: Vec<PathBuf> = vec![node_dir.to_path_buf()];
        if let Some(p) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&p));
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            cmd.env("PATH", joined);
        }
    }
    for (k, v) in &plan.env {
        cmd.env(k, v);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    }

    let mut child = cmd.spawn()?;
    let pid = child.id();

    #[cfg(windows)]
    let job = {
        use std::os::windows::io::AsRawHandle;
        let job = match crate::job::Job::new() {
            Ok(job) => match job.assign(child.as_raw_handle() as _) {
                Ok(()) => Some(job),
                Err(e) => {
                    logs.push(format!("[agentree-desktop] 无法把后端加入作业对象：{e}，退出时改用 taskkill"));
                    None
                }
            },
            Err(e) => {
                logs.push(format!("[agentree-desktop] 无法创建作业对象：{e}，退出时改用 taskkill"));
                None
            }
        };
        if let Err(e) = crate::job::resume_process_threads(pid) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(e.kind(), format!("无法恢复后端进程的线程：{e}")));
        }
        job
    };

    if let Some(out) = child.stdout.take() {
        spawn_reader(out, logs.clone(), "");
    }
    if let Some(err) = child.stderr.take() {
        spawn_reader(err, logs.clone(), "");
    }

    Ok(BackendProcess {
        child,
        #[cfg(windows)]
        job,
        pid,
        killed: false,
    })
}

// ---------------------------------------------------------------------------
// 健康检查
// ---------------------------------------------------------------------------

/// 请求 GET /api/live，返回 200 时为 true
pub fn probe_live(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(800)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let req = format!(
        "GET /api/live HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUser-Agent: agentree-desktop\r\nAccept: */*\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = Vec::with_capacity(256);
    let mut chunk = [0u8; 256];
    while !buf.windows(2).any(|w| w == b"\r\n") && buf.len() < 1024 {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let status_line = text.lines().next().unwrap_or("");
    let mut parts = status_line.split_whitespace();
    matches!((parts.next(), parts.next()), (Some(v), Some("200")) if v.starts_with("HTTP/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_quotes() {
        assert_eq!(tokenize(r#"node --a "b c" 'd'"#), vec!["node", "--a", "b c", "d"]);
    }

    #[test]
    fn shell_syntax() {
        assert!(has_shell_syntax("npm run build && node dist/index.js"));
        assert!(!has_shell_syntax("node --experimental-sqlite src/index.js"));
        assert!(!has_shell_syntax("node \"a&b.js\""));
    }

    #[test]
    fn direct_node() {
        let node = Path::new("C:/node/node.exe");
        let dir = Path::new("C:/nonexistent");
        let (p, a, e) = plan_direct("cross-env NODE_ENV=production node --x dist/index.js", node, dir).unwrap();
        assert_eq!(p, node);
        assert_eq!(a, vec!["--x", "dist/index.js"]);
        assert_eq!(e, vec![("NODE_ENV".to_string(), "production".to_string())]);
        assert!(plan_direct("npm run serve", node, dir).is_none());
        assert!(plan_direct("tsx src/index.ts", node, dir).is_none());
    }
}
