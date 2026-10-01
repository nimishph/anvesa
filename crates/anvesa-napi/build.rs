extern crate napi_build;

fn main() {
    #[cfg(all(windows, target_env = "gnu"))]
    {
        if std::env::var("LIBNODE_PATH").is_err() {
            let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
            let lib_dir = out_dir.join("napi_libnode");
            std::fs::create_dir_all(&lib_dir).ok();
            let libnode_path = lib_dir.join("libnode.dll");
            if !libnode_path.exists() {
                let candidates = [
                    std::path::PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
                    std::path::PathBuf::from(r"C:\Program Files (x86)\nodejs\node.exe"),
                ];
                let found = candidates
                    .iter()
                    .find(|p| p.is_file())
                    .cloned()
                    .or_else(|| {
                        if let Ok(paths) = std::env::var("PATH") {
                            for p in std::env::split_paths(&paths) {
                                let n = p.join("node.exe");
                                if n.is_file() {
                                    return Some(n);
                                }
                            }
                        }
                        None
                    });

                if let Some(node_exe) = found {
                    let _ = std::fs::copy(&node_exe, &libnode_path);
                }
            }
            if libnode_path.exists() {
                std::env::set_var("LIBNODE_PATH", &lib_dir);
            }
        }
    }

    napi_build::setup();
}
