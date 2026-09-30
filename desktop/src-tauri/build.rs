fn main() {
    #[cfg(feature = "portable")]
    portable_payload();

    // 声明应用自定义命令的权限清单：命令默认不可调用，
    // 只有 capabilities/ 里授予了权限的窗口（且是本地页面）才能调用。
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["get_status", "retry"])),
    )
    .expect("tauri-build 执行失败");
}

/// 便携版：找到构建脚本生成的 payload，把路径和哈希交给 src/portable.rs。
/// 默认位置是 target-portable/payload/，可以用 AGENTREE_PAYLOAD_DIR 覆盖。
#[cfg(feature = "portable")]
fn portable_payload() {
    use std::path::PathBuf;

    println!("cargo:rerun-if-env-changed=AGENTREE_PAYLOAD_DIR");
    let dir = match std::env::var_os("AGENTREE_PAYLOAD_DIR").filter(|v| !v.is_empty()) {
        Some(v) => PathBuf::from(v),
        None => PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("target-portable")
            .join("payload"),
    };
    let file = dir.join("payload.tar.br");
    let id_file = dir.join("payload.id");
    if !file.is_file() || !id_file.is_file() {
        panic!(
            "便携版需要的 payload 不存在：{}。请在项目根目录执行 npm run portable，不要直接用 cargo 开启 portable 特性",
            dir.display()
        );
    }
    let id = std::fs::read_to_string(&id_file).unwrap().trim().to_string();
    if id.len() != 16 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        panic!("payload.id 格式不对（应为 16 位十六进制）：{id}");
    }
    println!("cargo:rerun-if-changed={}", file.display());
    println!("cargo:rerun-if-changed={}", id_file.display());
    println!("cargo:rustc-env=AGENTREE_PAYLOAD_FILE={}", file.display());
    println!("cargo:rustc-env=AGENTREE_PAYLOAD_ID={id}");
}
