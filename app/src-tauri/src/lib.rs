//! Tauri shell: owns the window and the Python data-service sidecar.
//!
//! Dev mode: `make dev` runs the server itself and passes `NDX_DEV_PORT` / `NDX_DEV_TOKEN` in the
//! environment; the shell then only connects. Bundled app: the shell picks a random free port and
//! a per-launch random token (no fixed-port fallback; startup fails instead), spawns the
//! `ndx-server` sidecar with `--parent-pid` (so it exits if we crash) and writes the token to the
//! sidecar's stdin — never argv, which every local user can read with `ps` (SPEC §1.5).

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Emitter, Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Clone, Serialize)]
struct BackendInfo {
    port: u16,
    token: String,
}

struct Backend {
    info: BackendInfo,
    child: Mutex<Option<CommandChild>>,
    spawn_error: Mutex<Option<String>>,
}

fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

/// 32 random bytes as hex. Fails loudly instead of returning a predictable token.
fn random_token() -> std::io::Result<String> {
    let mut buf = [0u8; 32];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut buf)?;
    if buf.iter().all(|b| *b == 0) {
        return Err(std::io::Error::other("/dev/urandom returned zeros"));
    }
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

fn health_ok(port: u16, token: &str) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let Ok(mut stream) = TcpStream::connect_timeout(&addr.parse().unwrap(), Duration::from_millis(300))
    else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let req = format!(
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nx-ndx-token: {token}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    match stream.read(&mut buf) {
        Ok(n) => String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200"),
        Err(_) => false,
    }
}

/// Resolves once the data service answers `/health` (up to 45 s for a cold PyInstaller start).
#[tauri::command]
async fn backend_info(state: tauri::State<'_, Backend>) -> Result<BackendInfo, String> {
    let info = state.info.clone();
    if let Some(err) = state.spawn_error.lock().unwrap().clone() {
        return Err(err);
    }
    let port = info.port;
    let token = info.token.clone();
    let ok = tauri::async_runtime::spawn_blocking(move || {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(45) {
            if health_ok(port, &token) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        false
    })
    .await
    .map_err(|e| e.to_string())?;
    if ok {
        Ok(info)
    } else {
        Err(format!("data service did not respond on port {port}"))
    }
}

fn failed(msg: String) -> Backend {
    Backend {
        info: BackendInfo { port: 0, token: String::new() },
        child: Mutex::new(None),
        spawn_error: Mutex::new(Some(msg)),
    }
}

fn start_backend(app: &tauri::AppHandle) -> Backend {
    if let Ok(port) = std::env::var("NDX_DEV_PORT") {
        let Ok(port) = port.parse::<u16>() else {
            return failed("NDX_DEV_PORT must be a port number".into());
        };
        let token = std::env::var("NDX_DEV_TOKEN").unwrap_or_default();
        if token.len() < 32 {
            return failed("NDX_DEV_TOKEN missing or too short (run `make dev`)".into());
        }
        return Backend {
            info: BackendInfo { port, token },
            child: Mutex::new(None),
            spawn_error: Mutex::new(None),
        };
    }

    let port = match free_port() {
        Ok(p) => p,
        Err(e) => return failed(format!("no free local port: {e}")),
    };
    let token = match random_token() {
        Ok(t) => t,
        Err(e) => return failed(format!("cannot generate launch token: {e}")),
    };
    let app_name = app.package_info().name.clone();
    let mut backend = Backend {
        info: BackendInfo { port, token: token.clone() },
        child: Mutex::new(None),
        spawn_error: Mutex::new(None),
    };
    let spawned = app.shell().sidecar("ndx-server").map(|cmd| {
        cmd.args([
            "--port",
            &port.to_string(),
            "--token-stdin",
            "--parent-pid",
            &std::process::id().to_string(),
        ])
        .env("NDX_APP_NAME", app_name)
        .spawn()
    });
    match spawned {
        Ok(Ok((mut rx, mut child))) => {
            if let Err(e) = child.write(format!("{token}\n").as_bytes()) {
                let _ = child.kill();
                *backend.spawn_error.get_mut().unwrap() =
                    Some(format!("failed to pass the launch token to the sidecar: {e}"));
                return backend;
            }
            *backend.child.get_mut().unwrap() = Some(child);
            // Drain the sidecar's output; the server writes its own rotating log file.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    if let CommandEvent::Terminated(payload) = event {
                        eprintln!("ndx-server exited: {payload:?}");
                    }
                }
            });
        }
        Ok(Err(e)) | Err(e) => {
            *backend.spawn_error.get_mut().unwrap() = Some(format!("failed to start sidecar: {e}"));
        }
    }
    backend
}

/// OFF (SPEC §4.9): the UI saves the session first, then asks the app to quit; the Exit event
/// below stops the backend sidecar.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![backend_info, quit_app])
        .on_window_event(|window, event| {
            // Closing the window quits the app: let the UI save the session first, like OFF and
            // the menu's Quit (review 1b #23). It calls quit_app when done; a UI that does not
            // answer still quits after a few seconds.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("ndx://quit-requested", ());
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    app.exit(0);
                });
            }
        })
        .setup(|app| {
            let backend = start_backend(app.handle());
            app.manage(backend);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<Backend>() {
                if let Some(child) = state.child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        }
    });
}
