// 发布版不弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
#[cfg(windows)]
mod job;
#[cfg(feature = "portable")]
mod portable;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, RunEvent, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use backend::{BackendProcess, LogBuffer, Settings};

const MAIN: &str = "main";
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(300);
/// 复用外部后端时，连续多少次健康检查失败才认为它停了
const REUSED_FAILURES_BEFORE_ERROR: u32 = 3;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn window_state_flags() -> StateFlags {
    // 不记忆可见性：窗口总是等加载页面准备好之后再显示
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Phase {
    Starting,
    Ready,
    Error,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Mode {
    /// 后端由桌面壳启动，退出时结束它
    Spawned,
    /// 复用已经在运行的后端，退出时不动它
    Reused,
}

/// 发给加载页面的状态
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    phase: Phase,
    title: String,
    message: String,
    hint: Option<String>,
    mode: Option<Mode>,
    command: Option<String>,
    command_source: Option<String>,
    pid: Option<u32>,
    url: String,
    root: String,
    /// 是否是便携版（加载页据此把"项目目录"显示成"运行环境"）
    portable: bool,
    port: u16,
    elapsed_ms: u64,
    timeout_ms: u64,
    logs: Vec<String>,
}

struct AppState {
    settings: Settings,
    status: Mutex<Status>,
    attempt_started: Mutex<Instant>,
    generation: AtomicU64,
    process: Mutex<Option<BackendProcess>>,
    logs: Arc<LogBuffer>,
    loading_url: Mutex<Option<Url>>,
    shown: AtomicBool,
    quitting: AtomicBool,
}

type Shared = Arc<AppState>;

impl AppState {
    fn new(settings: Settings) -> Self {
        let status = Status {
            phase: Phase::Starting,
            title: "正在启动".into(),
            message: "正在准备…".into(),
            hint: None,
            mode: None,
            command: None,
            command_source: None,
            pid: None,
            url: app_url(settings.port),
            root: settings.root.display().to_string(),
            portable: cfg!(feature = "portable"),
            port: settings.port,
            elapsed_ms: 0,
            timeout_ms: READY_TIMEOUT.as_millis() as u64,
            logs: Vec::new(),
        };
        AppState {
            settings,
            status: Mutex::new(status),
            attempt_started: Mutex::new(Instant::now()),
            generation: AtomicU64::new(0),
            process: Mutex::new(None),
            logs: Arc::new(LogBuffer::default()),
            loading_url: Mutex::new(None),
            shown: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
        }
    }

    fn is_current(&self, gen: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == gen && !self.quitting.load(Ordering::SeqCst)
    }

    fn update(&self, gen: u64, f: impl FnOnce(&mut Status)) -> bool {
        let mut s = lock(&self.status);
        if !self.is_current(gen) {
            return false;
        }
        f(&mut s);
        true
    }

    fn set_starting(&self, gen: u64, message: &str) {
        self.update(gen, |s| {
            s.phase = Phase::Starting;
            s.title = "正在启动".into();
            s.message = message.into();
        });
    }

    fn set_error(&self, gen: u64, title: &str, message: String, hint: Option<String>) -> bool {
        let mut hint = hint;
        if hint.is_none() {
            hint = self.diagnose();
        }
        if let Some(w) = &self.settings.config_warning {
            hint = Some(match hint {
                Some(h) => format!("{h}\n{w}"),
                None => w.clone(),
            });
        }
        self.update(gen, |s| {
            s.phase = Phase::Error;
            s.title = title.into();
            s.message = message;
            s.hint = hint;
        })
    }

    /// 根据后端输出给出排查建议
    fn diagnose(&self) -> Option<String> {
        let port = self.settings.port;
        if self.logs.contains("EADDRINUSE") {
            return Some(format!(
                "端口 {port} 已被其他程序占用。请关闭占用该端口的程序，或设置环境变量 AGENTREE_PORT 使用其他端口。"
            ));
        }
        let server_dir = self.settings.server_dir();
        // 便携版的后端是单文件，没有 node_modules，不适用下面的提示
        if !cfg!(feature = "portable") && server_dir.is_dir() && !server_dir.join("node_modules").is_dir() {
            return Some(
                "server/node_modules 不存在，后端依赖可能还没有安装。请在项目根目录执行 npm run setup 后点击“重试”。".into(),
            );
        }
        if self.logs.contains("ERR_MODULE_NOT_FOUND") || self.logs.contains("Cannot find module") {
            return Some("后端缺少依赖或构建产物。请在项目根目录执行 npm run setup 和 npm run build 后点击“重试”。".into());
        }
        None
    }

    fn snapshot(&self) -> Status {
        let mut s = lock(&self.status).clone();
        s.elapsed_ms = lock(&self.attempt_started).elapsed().as_millis() as u64;
        s.logs = self.logs.tail(if s.phase == Phase::Error { 60 } else { 12 });
        s
    }

    /// 结束自己启动的后端（复用的外部后端不会出现在这里）
    fn stop_backend(&self) {
        let proc = lock(&self.process).take();
        if let Some(mut p) = proc {
            p.kill();
        }
    }
}

fn app_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

/// webview 只允许加载本地加载页面和本机后端
fn is_allowed_url(url: &Url, port: u16) -> bool {
    if is_local_page(url) {
        return true;
    }
    match url.scheme() {
        "about" => url.as_str() == "about:blank",
        "http" => url.host_str() == Some("127.0.0.1") && url.port_or_known_default() == Some(port),
        _ => false,
    }
}

/// 是否是打包在程序里的本地加载页面
fn is_local_page(url: &Url) -> bool {
    url.scheme() == "tauri"
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

fn show_main(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn navigate_to_app(app: &AppHandle, st: &Shared) {
    if let (Some(w), Ok(url)) = (main_window(app), Url::parse(&app_url(st.settings.port))) {
        let _ = w.navigate(url);
    }
}

fn navigate_to_loading(app: &AppHandle, st: &Shared) {
    let Some(w) = main_window(app) else { return };
    let url = lock(&st.loading_url)
        .clone()
        .or_else(|| Url::parse("http://tauri.localhost/index.html").ok());
    if let Some(url) = url {
        if w.url().map(|cur| cur != url).unwrap_or(true) {
            let _ = w.navigate(url);
        }
    }
}

/// 开始一次启动尝试（首次启动和"重试"都走这里）
fn start_attempt(app: &AppHandle, st: &Shared) {
    if st.quitting.load(Ordering::SeqCst) {
        return;
    }
    let gen = {
        // 持有状态锁递增代数，保证旧尝试不会再写入状态
        let mut s = lock(&st.status);
        let gen = st.generation.fetch_add(1, Ordering::SeqCst) + 1;
        s.phase = Phase::Starting;
        s.title = "正在启动".into();
        s.message = "正在检查后端服务是否已在运行…".into();
        s.hint = None;
        s.mode = None;
        s.command = None;
        s.command_source = None;
        s.pid = None;
        gen
    };
    *lock(&st.attempt_started) = Instant::now();
    st.stop_backend();
    st.logs.clear();

    let app = app.clone();
    let st = st.clone();
    thread::spawn(move || run_attempt(app, st, gen));
}

fn run_attempt(app: AppHandle, st: Shared, gen: u64) {
    let port = st.settings.port;

    // 1. 已有后端在运行：直接复用
    if backend::probe_live(port) {
        if st.update(gen, |s| {
            s.phase = Phase::Ready;
            s.title = "已就绪".into();
            s.message = "检测到已在运行的后端，直接使用".into();
            s.mode = Some(Mode::Reused);
        }) {
            navigate_to_app(&app, &st);
            monitor(app, st, gen, Mode::Reused);
        }
        return;
    }
    if !st.is_current(gen) {
        return;
    }

    // 便携版：先确保内置的运行环境已经解压好
    #[cfg(feature = "portable")]
    if !prepare_portable_runtime(&st, gen) {
        return;
    }

    // 2. 解析启动命令
    let plan = match backend::resolve_launch(&st.settings) {
        Ok(p) => p,
        Err(e) => {
            st.set_error(gen, &e.title, e.message, e.hint);
            return;
        }
    };
    st.update(gen, |s| {
        s.command = Some(plan.display.clone());
        s.command_source = Some(plan.source.clone());
    });
    st.set_starting(gen, "正在启动后端服务…");

    // 3. 启动子进程
    let proc = match backend::spawn_backend(&plan, &st.settings.server_dir(), port, st.logs.clone()) {
        Ok(p) => p,
        Err(e) => {
            st.set_error(gen, "无法启动后端进程", format!("启动命令执行失败：{e}"), None);
            return;
        }
    };
    let pid = proc.pid;
    {
        let mut guard = lock(&st.process);
        if !st.is_current(gen) {
            drop(guard);
            drop(proc); // Drop 会结束进程
            return;
        }
        *guard = Some(proc);
    }
    st.update(gen, |s| s.pid = Some(pid));
    st.set_starting(gen, "正在等待后端就绪…");

    // 4. 等待就绪
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        if !st.is_current(gen) {
            return;
        }
        let exited = {
            let mut guard = lock(&st.process);
            match guard.as_mut() {
                Some(p) if p.pid == pid => p.try_exit(),
                _ => return,
            }
        };
        if let Some(code) = exited {
            // 等输出读取线程把最后几行读完
            thread::sleep(Duration::from_millis(300));
            if st.is_current(gen) {
                st.stop_backend();
                st.set_error(
                    gen,
                    "后端进程已退出",
                    format!("后端进程在就绪之前退出了（退出码 {code}）。"),
                    None,
                );
            }
            return;
        }
        if backend::probe_live(port) {
            if st.update(gen, |s| {
                s.phase = Phase::Ready;
                s.title = "已就绪".into();
                s.message = "后端已就绪".into();
                s.mode = Some(Mode::Spawned);
            }) {
                navigate_to_app(&app, &st);
                monitor(app, st, gen, Mode::Spawned);
            }
            return;
        }
        if Instant::now() >= deadline {
            if st.is_current(gen) {
                st.stop_backend();
                st.set_error(
                    gen,
                    "后端启动超时",
                    format!(
                        "后端在 {} 秒内没有就绪（http://127.0.0.1:{port}/api/live 没有返回 200），已结束后端进程。",
                        READY_TIMEOUT.as_secs()
                    ),
                    None,
                );
            }
            return;
        }
        thread::sleep(POLL_INTERVAL);
    }
}

/// 便携版：解压（或复用）内置的运行环境。失败时设置错误状态并返回 false
#[cfg(feature = "portable")]
fn prepare_portable_runtime(st: &Shared, gen: u64) -> bool {
    let dir = portable::runtime_dir();
    if !portable::is_ready(&dir) {
        st.set_starting(gen, &format!("正在准备运行环境（首次启动需要解压到 {}）…", dir.display()));
    }
    match portable::ensure_runtime() {
        Ok(p) => {
            if p.extracted {
                st.logs.push(format!(
                    "[agentree-desktop] 运行环境已解压到 {}，耗时 {} ms",
                    p.dir.display(),
                    p.elapsed.as_millis()
                ));
                // 解压的时间不算进后端启动的进度条
                *lock(&st.attempt_started) = Instant::now();
            }
            // 旧版本留下的运行环境放到后台清理
            thread::spawn(portable::cleanup_old);
            st.is_current(gen)
        }
        Err(e) => {
            st.set_error(
                gen,
                "无法准备运行环境",
                e,
                Some(format!(
                    "请确认 {} 可以写入、磁盘至少有 150 MB 空闲，并且杀毒软件没有拦截；\
                     也可以设置环境变量 AGENTREE_RUNTIME_DIR 指定别的解压位置。然后点击“重试”。",
                    portable::runtime_base().display()
                )),
            );
            false
        }
    }
}

/// 就绪后持续监视后端；后端意外停止时回到加载页面显示错误
fn monitor(app: AppHandle, st: Shared, gen: u64, mode: Mode) {
    let mut failures = 0u32;
    let mut tick = 0u64;
    loop {
        thread::sleep(Duration::from_secs(1));
        tick += 1;
        if !st.is_current(gen) {
            return;
        }
        match mode {
            Mode::Spawned => {
                let exited = {
                    let mut guard = lock(&st.process);
                    match guard.as_mut() {
                        Some(p) => p.try_exit(),
                        None => return,
                    }
                };
                if let Some(code) = exited {
                    thread::sleep(Duration::from_millis(300));
                    st.stop_backend();
                    if st.set_error(
                        gen,
                        "后端进程意外退出",
                        format!("后端进程已退出（退出码 {code}）。"),
                        None,
                    ) {
                        navigate_to_loading(&app, &st);
                    }
                    return;
                }
            }
            Mode::Reused => {
                if tick % 5 != 0 {
                    continue;
                }
                if backend::probe_live(st.settings.port) {
                    failures = 0;
                    continue;
                }
                failures += 1;
                if failures >= REUSED_FAILURES_BEFORE_ERROR {
                    if st.set_error(
                        gen,
                        "后端已停止响应",
                        "之前已在运行的后端（不是由桌面壳启动的）已经停止响应。".into(),
                        Some("点击“重试”，桌面壳会自己启动后端。".into()),
                    ) {
                        navigate_to_loading(&app, &st);
                    }
                    return;
                }
            }
        }
    }
}

/// 退出前的清理：只结束自己启动的后端
fn shutdown(st: &Shared) {
    st.quitting.store(true, Ordering::SeqCst);
    st.generation.fetch_add(1, Ordering::SeqCst);
    st.stop_backend();
}

#[tauri::command]
fn get_status(state: State<'_, Shared>) -> Status {
    state.snapshot()
}

#[tauri::command]
fn retry(app: AppHandle, state: State<'_, Shared>) {
    let st = state.inner().clone();
    let phase = lock(&st.status).phase;
    if phase == Phase::Error {
        start_attempt(&app, &st);
    }
}

fn build_main_window(app: &AppHandle, st: &Shared) -> tauri::Result<WebviewWindow> {
    let port = st.settings.port;
    let nav_app = app.clone();
    let load_state = st.clone();
    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("agentree")
        .inner_size(1280.0, 800.0)
        .min_inner_size(960.0, 600.0)
        .center()
        .visible(false)
        .background_color(tauri::window::Color(15, 17, 21, 255))
        .on_navigation(move |url| is_allowed_url(url, port))
        .on_new_window(move |url, _features| {
            // 不开新窗口；指向本机后端的链接在主窗口里打开
            if is_allowed_url(&url, port) && url.scheme() == "http" {
                if let Some(w) = nav_app.get_webview_window(MAIN) {
                    let _ = w.navigate(url);
                }
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |w, payload| {
            // 记下本地加载页面的实际地址（各平台和 dev/release 下不同），后端意外停止时用它回到加载页面
            let url = payload.url();
            if is_local_page(url) {
                let mut u = url.clone();
                u.set_query(None);
                u.set_fragment(None);
                *lock(&load_state.loading_url) = Some(u);
            }
            if payload.event() == PageLoadEvent::Finished && !load_state.shown.swap(true, Ordering::SeqCst) {
                let _ = w.show();
                let _ = w.set_focus();
            }
        })
        .build()?;

    // 关闭按钮：隐藏到托盘。顺便把窗口位置和大小写盘，
    // 这样即使之后是关机或被结束进程（不会触发正常退出），下次也能恢复。
    let w = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = w.app_handle().save_window_state(window_state_flags());
            let _ = w.hide();
        }
    });

    // 兜底：如果页面加载事件迟迟没来，3 秒后也显示窗口
    let w = window.clone();
    let st2 = st.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(3));
        if !st2.shown.swap(true, Ordering::SeqCst) {
            let _ = w.show();
            let _ = w.set_focus();
        }
    });

    Ok(window)
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "打开主界面", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("agentree")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "quit" => quit_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn quit_app(app: &AppHandle) {
    let _ = app.save_window_state(window_state_flags());
    if let Some(st) = app.try_state::<Shared>() {
        shutdown(st.inner());
    }
    app.exit(0);
}

fn main() {
    // 重复启动时，第二个进程通常是用户刚点开的前台进程。先把"切换前台"的权限放出去，
    // 已有实例收到单实例通知后才能把自己的窗口真正调到前台（否则只会在任务栏闪烁）。
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};
        AllowSetForegroundWindow(ASFW_ANY);
    }

    let settings = backend::load_settings();
    let state: Shared = Arc::new(AppState::new(settings));

    let mut builder = tauri::Builder::default();
    // 单实例插件必须最先注册。
    // AGENTREE_ALLOW_MULTI=1 时不注册：只用于开发测试（在已有实例开着时再起一个测试实例），
    // 平时不要设置，否则两个实例会抢同一个端口。
    if std::env::var("AGENTREE_ALLOW_MULTI").map(|v| v.trim() != "1").unwrap_or(true) {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }));
    }
    let app = builder
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(window_state_flags())
                .build(),
        )
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![get_status, retry])
        .setup(move |app| {
            let handle = app.handle().clone();
            build_main_window(&handle, &state)?;
            build_tray(&handle)?;
            start_attempt(&handle, &state);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("agentree 桌面壳初始化失败");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { code, api, .. } => {
            // 关掉所有窗口不退出（窗口只是隐藏到托盘）；只有显式 exit 才退出
            if code.is_none() {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => {
            if let Some(st) = app.try_state::<Shared>() {
                shutdown(st.inner());
            }
        }
        _ => {}
    });
}
