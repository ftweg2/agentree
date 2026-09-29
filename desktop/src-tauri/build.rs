fn main() {
    // 声明应用自定义命令的权限清单：命令默认不可调用，
    // 只有 capabilities/ 里授予了权限的窗口（且是本地页面）才能调用。
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["get_status", "retry"])),
    )
    .expect("tauri-build 执行失败");
}
