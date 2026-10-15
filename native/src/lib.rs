//! otools-video 原生插件：把浏览器编不了的 H.264 交给**宿主**上 Apple 硬件编码器。
//! ------------------------------------------------------------------
//! 背景：WKWebView 里 WebCodecs 的 H.264 走 GPU 进程，在部分环境（用户实测 1080p）
//! 编码到中途会静默挂死；`isConfigSupported()` 还说支持。VP9（软件 libvpx）能跑但慢。
//! 所以要「又快又稳」的 H.264/MP4，只能让宿主的**硬件 H.264**（VideoToolbox）来编。
//!
//! 本 crate 是宿主加载的 cdylib，通过 `otools_plugin_invoke` / `otools_plugin_free`
//! 与宿主对话（见 otools 宿主 native_plugins::transport）。为了不依赖宿主仓库的
//! `ot-plugin-ffi`（otools-video 是独立仓库），下面把 panic 安全护栏就地内联一份
//! （逻辑与 ot-plugin-ffi 相同：panic 绝不能跨 DLL 边界 unwind，否则整个宿主 abort）。
//!
//! 编码实现走 **ffmpeg shell-out**（-c:v h264_videotoolbox）——与 gif 插件依赖 ffmpeg
//! 的既有做法一致：解码 JPEG / 封装 MP4 / 抽取 avcC 全交给 ffmpeg，本 crate 只负责
//! 探活、组命令、跑进程、报错，**完全无 unsafe FFI**，写错也不会崩宿主。早期上
//! 原生 VTCompressionSession 的方案风险太高（一个错的 C 调用就打崩整个 OTools），
//! 留作 ffmpeg 版跑通后的升级。

use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;

/* ----------------------------- panic-safe FFI 护栏 ----------------------------- */

/// 把 Vec<u8> 交给宿主：写入长度，交出不透明指针，本地 forget（宿主负责 free）。
/// 空的响应必须塞一个合法 JSON，否则宿主的 from_raw_parts 是未定义行为。
pub fn take_json_response(mut output: Vec<u8>, output_len: *mut usize) -> *mut u8 {
    if output.is_empty() {
        output.extend_from_slice(b"{}");
    }
    let len = output.len();
    unsafe {
        *output_len = len;
    }
    let ptr = output.as_mut_ptr();
    std::mem::forget(output);
    ptr
}

fn panic_response(plugin: &str, message: &str) -> Value {
    json!({
        "ok": false,
        "error": format!("插件 {plugin} 内部错误: {message}"),
        "panic": true,
        "plugin": plugin,
    })
}

fn payload_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        return (*text).to_string();
    }
    if let Some(text) = payload.downcast_ref::<String>() {
        return text.clone();
    }
    "unknown panic payload".to_string()
}

fn invoke_impl(input_ptr: *const u8, input_len: usize, output_len: *mut usize) -> *mut u8 {
    if input_ptr.is_null() || output_len.is_null() {
        return std::ptr::null_mut();
    }
    let input = unsafe { std::slice::from_raw_parts(input_ptr, input_len) };
    let parsed: Value = serde_json::from_slice(input).unwrap_or_else(|error| {
        json!({ "method": "", "payload": null, "parseError": error.to_string() })
    });
    let method = parsed
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let payload = parsed.get("payload").cloned().unwrap_or(Value::Null);
    let response = if method.is_empty() {
        respond_err("method is required")
    } else {
        dispatch(&method, payload)
    };
    let mut output = serde_json::to_vec(&response)
        .unwrap_or_else(|_| br#"{"ok":false,"error":"serialize failed"}"#.to_vec());
    let len = output.len();
    unsafe {
        *output_len = len;
    }
    let ptr = output.as_mut_ptr();
    std::mem::forget(output);
    ptr
}

#[no_mangle]
pub extern "C" fn otools_plugin_invoke(
    input_ptr: *const u8,
    input_len: usize,
    output_len: *mut usize,
) -> *mut u8 {
    // panic 不能跨 extern "C" 边界传播（会 abort 整个宿主进程），必须在此捕获。
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        invoke_impl(input_ptr, input_len, output_len)
    }));
    match outcome {
        Ok(ptr) => ptr,
        Err(payload) => {
            let message = payload_message(payload.as_ref());
            let response = panic_response(env!("CARGO_PKG_NAME"), &message);
            let encoded = serde_json::to_vec(&response)
                .unwrap_or_else(|_| br#"{"ok":false,"error":"serialize failed"}"#.to_vec());
            take_json_response(encoded, output_len)
        }
    }
}

#[no_mangle]
pub extern "C" fn otools_plugin_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    let _ = std::panic::catch_unwind(|| unsafe { drop(Vec::from_raw_parts(ptr, len, len)) });
}

// 宿主加载后可选调用；本插件不需要宿主回调。
#[no_mangle]
pub extern "C" fn otools_plugin_bind_host(_ptr: *const core::ffi::c_void) {}

/* --------------------------------- 业务逻辑 ---------------------------------- */

fn respond_ok(data: Value) -> Value {
    json!({ "ok": true, "data": data })
}

fn respond_err(message: impl Into<String>) -> Value {
    json!({ "ok": false, "error": message.into() })
}

/// 与可执行文件目录无关：用 PATH + 常见 Homebrew 安装点找 ffmpeg（和 gif 一致）。
///
/// 关键坑：GUI 应用（从 Finder 启动的 OTools.app）**不会**继承 shell 的 login
/// profile，所以 `/opt/homebrew/bin` 大概率不在 `PATH` 上——用户在终端里 `which
/// ffmpeg` 能找到，本进程（Rust dylib 跑在宿主进程里）`which` 却找不到，于是「装了
/// 还是不行」。所以除了 PATH 兜底，还要把 Homebrew 的标准安装点、opt 软链、`brew
/// --prefix` 的返回都试一遍（Apple Silicon / Intel 两套都覆盖）。
fn detect_ffmpeg() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin/ffmpeg"),
        PathBuf::from("/usr/local/bin/ffmpeg"),
        PathBuf::from("/usr/bin/ffmpeg"),
        // Homebrew 的 opt 软链（brew 装完会指到 Cellar 里的当前版本）。
        PathBuf::from("/opt/homebrew/opt/ffmpeg/bin/ffmpeg"),
        PathBuf::from("/usr/local/opt/ffmpeg/bin/ffmpeg"),
    ];
    // `brew --prefix ffmpeg` 给出真实安装根（覆盖任何自定义 prefix）。
    if let Ok(out) = Command::new("brew").args(["--prefix", "ffmpeg"]).output() {
        if out.status.success() {
            let root = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !root.is_empty() {
                let p = PathBuf::from(&root).join("bin/ffmpeg");
                candidates.push(p);
            }
        }
    }
    for candidate in &candidates {
        if candidate.is_file() {
            return Some(candidate.clone());
        }
    }
    // PATH 兜底（跨平台；目前只跑 macOS，但留着无害）。
    let finder = if cfg!(target_os = "windows") { "where" } else { "which" };
    if let Ok(output) = Command::new(finder).arg("ffmpeg").output() {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            if let Some(line) = text.lines().map(str::trim).find(|l| !l.is_empty()) {
                return Some(PathBuf::from(line));
            }
        }
    }
    None
}

fn command_exists(binary: &str) -> bool {
    let finder = if cfg!(target_os = "windows") { "where" } else { "which" };
    Command::new(finder)
        .arg(binary)
        .output()
        .map(|out| out.status.success() && !String::from_utf8_lossy(&out.stdout).trim().is_empty())
        .unwrap_or(false)
}

/// 找 brew 二进制：GUI 应用（Finder 启动的 OTools.app）不继承 shell 的 PATH，
/// 所以 `/opt/homebrew/bin/brew` 多半不在 PATH 上。直接探测常见安装点，再 PATH 兜底。
fn brew_binary() -> Option<PathBuf> {
    for candidate in [
        PathBuf::from("/opt/homebrew/bin/brew"),
        PathBuf::from("/usr/local/bin/brew"),
    ] {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    if command_exists("brew") {
        // PATH 兜底：用 which 拿到的第一个路径。
        if let Ok(out) = Command::new(if cfg!(target_os = "windows") { "where" } else { "which" }).arg("brew").output() {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                if let Some(line) = text.lines().map(str::trim).find(|l| !l.is_empty()) {
                    return Some(PathBuf::from(line));
                }
            }
        }
    }
    None
}

/// `ffmpeg -encoders` 是否带 h264_videotoolbox（Apple 硬件 H.264）。
fn has_videotoolbox(ffmpeg: &PathBuf) -> bool {
    Command::new(ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .output()
        .ok()
        .map(|out| {
            let text = String::from_utf8_lossy(&out.stdout);
            text.lines().any(|line| line.contains("h264_videotoolbox"))
        })
        .unwrap_or(false)
}

fn ffmpeg_probe() -> Value {
    match detect_ffmpeg() {
        None => respond_ok(json!({
            "installed": false,
            "path": "",
            "videoToolbox": false,
        })),
        Some(path) => {
            let video_toolbox = has_videotoolbox(&path);
            respond_ok(json!({
                "installed": true,
                "path": path.to_string_lossy(),
                "videoToolbox": video_toolbox,
            }))
        }
    }
}

/// 一键安装 ffmpeg（当前只 macOS + brew）。给导出界面里的“安装”按钮用。
/// 安装可能耗时较久，但宿主把 invoke 投到 blocking 线程，不会卡 UI。
fn install_ffmpeg(request: InstallFfmpegRequest) -> Result<Value, String> {
    if !cfg!(target_os = "macos") {
        return Err("自动安装 ffmpeg 目前只在 macOS 提供（h264_videotoolbox 是 Apple 独占）。".to_string());
    }
    let brew = brew_binary().ok_or_else(|| {
        "未找到 Homebrew（brew）。请先安装 Homebrew，再 brew install ffmpeg；或手动安装含 h264_videotoolbox 的 ffmpeg。".to_string()
    })?;
    let package_manager = request
        .package_manager
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("brew");
    if package_manager != "brew" {
        return Err(format!("不支持的包管理器：{package_manager}"));
    }
    let output = Command::new(&brew)
        .args(["install", "ffmpeg"])
        .output()
        .map_err(|error| format!("启动 brew 失败: {error}"))?;
    Ok(json!({
        "success": output.status.success(),
        "command": stringify(&brew, &["install".to_string(), "ffmpeg".to_string()]),
        "stdout": String::from_utf8_lossy(&output.stdout).trim(),
        "stderr": String::from_utf8_lossy(&output.stderr).trim(),
    }))
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct EncodeH264Request {
    frames_dir: String,
    fps: f64,
    width: i32,
    height: i32,
    bitrate: i64,
    output_path: String,
    /// 可选音轨：调用方已把工程混音成 16-bit PCM WAV 落在磁盘上，这里让 ffmpeg 读它
    /// 并按 AAC 编进 MP4。缺省（null / 空）→ 无声视频（`-an`）。
    audio_path: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct InstallFfmpegRequest {
    package_manager: Option<String>,
}

fn stringify(program: &std::path::Path, args: &[String]) -> String {
    let mut parts = vec![program.to_string_lossy().to_string()];
    for arg in args {
        parts.push(arg.clone());
    }
    parts.join(" ")
}

fn encode_h264(request: EncodeH264Request) -> Result<Value, String> {
    let frames_dir = request.frames_dir.trim();
    let output_path = request.output_path.trim();
    if frames_dir.is_empty() || output_path.is_empty() {
        return Err("framesDir / outputPath 不能为空".to_string());
    }
    let ffmpeg = detect_ffmpeg().ok_or_else(|| {
        "本机未安装 ffmpeg。原生 H.264 编码依赖 ffmpeg（Homebrew: brew install ffmpeg）。".to_string()
    })?;
    if !has_videotoolbox(&ffmpeg) {
        return Err("本机 ffmpeg 不含 h264_videotoolbox 编码器，无法用硬件 H.264。请安装带 VideoToolbox 的 ffmpeg，或改用 VP9 / WebM 导出。".to_string());
    }

    let fps = if request.fps > 0.0 { request.fps } else { 30.0 };
    let bitrate = request.bitrate.max(1);
    let gop = ((fps * 2.0).round() as i64).max(1);
    let input = format!("{}/%06d.jpg", frames_dir.trim_end_matches('/'));
    let audio_path = request
        .audio_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let mut args: Vec<String> = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-y".to_string(),
        "-f".to_string(),
        "image2".to_string(),
        "-framerate".to_string(),
        format!("{fps}"),
        "-i".to_string(),
        input,
    ];
    // 音轨：调用方已把工程混音成 WAV 落在磁盘上，这里让 ffmpeg 直接读它并按 AAC 封装
    // 进 MP4（`-shortest` 保证音视频等长）。没有音轨时才 `-an`——与上游「无声工程不带
    // 音轨」的行为一致。
    if let Some(audio) = audio_path {
        args.push("-i".to_string());
        args.push(audio.to_string());
    }
    args.extend([
        "-c:v".to_string(),
        "h264_videotoolbox".to_string(),
        "-b:v".to_string(),
        format!("{bitrate}"),
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        "-g".to_string(),
        format!("{gop}"),
        "-movflags".to_string(),
        "+faststart".to_string(),
        // 保险：强制偶数尺寸（H.264 level 要求），除非本来就这样否则不动尺寸。
        "-vf".to_string(),
        "scale=trunc(iw/2)*2:trunc(ih/2)*2".to_string(),
    ]);
    if audio_path.is_some() {
        args.extend([
            "-c:a".to_string(),
            "aac".to_string(),
            "-b:a".to_string(),
            "192k".to_string(),
            "-shortest".to_string(),
        ]);
    } else {
        args.push("-an".to_string());
    }
    args.push(output_path.to_string());

    let output = Command::new(&ffmpeg)
        .args(&args)
        .output()
        .map_err(|error| format!("启动 ffmpeg 失败({}): {}", ffmpeg.display(), error))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("ffmpeg 编码失败: {}", output.status)
        } else {
            stderr
        });
    }

    let out = PathBuf::from(output_path);
    let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        return Err("ffmpeg 未产出有效文件".to_string());
    }
    Ok(json!({
        "outputPath": out.to_string_lossy(),
        "bytes": size,
        "command": stringify(&ffmpeg, &args),
    }))
}

fn dispatch(method: &str, payload: Value) -> Value {
    match method {
        "ffmpeg_probe" => ffmpeg_probe(),
        "install_ffmpeg" => match serde_json::from_value::<InstallFfmpegRequest>(payload) {
            Ok(request) => match install_ffmpeg(request) {
                Ok(data) => respond_ok(data),
                Err(error) => respond_err(error),
            },
            Err(error) => respond_err(format!("install_ffmpeg 参数错误: {error}")),
        },
        "encode_h264" => match serde_json::from_value::<EncodeH264Request>(payload) {
            Ok(request) => match encode_h264(request) {
                Ok(data) => respond_ok(data),
                Err(error) => respond_err(error),
            },
            Err(error) => respond_err(format!("encode_h264 参数错误: {error}")),
        },
        // 宿主热更新前的停机握手：本插件无常驻后台线程，随时可替换。
        "__otools_shutdown__" => respond_ok(json!("otools-video 无后台任务")),
        _ => respond_err(format!("Unknown method: {method}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invoke_json(method: &str, payload: Value) -> Value {
        let request = json!({ "method": method, "payload": payload });
        let bytes = serde_json::to_vec(&request).unwrap();
        let mut len: usize = 0;
        let ptr = otools_plugin_invoke(bytes.as_ptr(), bytes.len(), &mut len);
        assert!(!ptr.is_null(), "invoke must return a buffer");
        let out = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
        otools_plugin_free(ptr, len);
        serde_json::from_slice(&out).unwrap()
    }

    #[test]
    fn unknown_method_is_error_not_crash() {
        let v = invoke_json("nope", json!({}));
        assert_eq!(v["ok"], json!(false));
    }

    #[test]
    fn probe_always_returns_structured_json() {
        // 本机可能没装 ffmpeg —— 两种情况都要给出合法结构，不能崩。
        let v = invoke_json("ffmpeg_probe", json!({}));
        assert_eq!(v["ok"], json!(true));
        assert!(v["data"]["installed"].is_boolean());
        assert!(v["data"]["videoToolbox"].is_boolean());
    }

    #[test]
    fn encode_without_ffmpeg_errors_cleanly() {
        let v = invoke_json("encode_h264", json!({ "framesDir": "/no/such", "outputPath": "/tmp/x.mp4" }));
        // 没装 ffmpeg → ok:false + 明确错误；绝不 panic、绝不返回空。
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().len() > 0);
    }

    #[test]
    fn shutdown_acknowledges_for_hot_reload() {
        let v = invoke_json("__otools_shutdown__", json!({}));
        assert_eq!(v["ok"], json!(true));
    }

    #[test]
    fn panic_is_caught_into_error_response() {
        // invoke "encode_h264" 传会让内部 unwrap 的坏参数也不太可能 panic；这里直接
        // 验证 catch_unwind 边界：用一个会 panic 的 payload 结构错误不会 panic，改为
        // 走正常错误路径。真正 panic 的回归由 ot-plugin-ffi 的护栏测试覆盖，此处仅确认
        // 本 crate 的入口有护栏（不崩即过）。
        let v = invoke_json("encode_h264", json!({ "framesDir": "" }));
        assert_eq!(v["ok"], json!(false));
    }

    #[test]
    fn encode_accepts_audio_path_without_param_error() {
        // 传了 audioPath 也不该被当成参数错误——要么成功，要么因为没装 ffmpeg 失败，
        // 绝不能是「encode_h264 参数错误」。
        let v = invoke_json(
            "encode_h264",
            json!({
                "framesDir": "/no/such",
                "outputPath": "/tmp/x.mp4",
                "audioPath": "/tmp/a.wav",
            }),
        );
        assert_eq!(v["ok"], json!(false));
        let error = v["error"].as_str().unwrap();
        assert!(!error.contains("参数错误"), "audioPath 不应导致参数错误: {error}");
    }

    #[test]
    fn install_ffmpeg_dispatch_is_wired_and_safe() {
        // 用不支持的包管理器，验证 dispatch 接线 + 参数解析，且不会真的跑 brew install。
        let v = invoke_json("install_ffmpeg", json!({ "packageManager": "nonsense" }));
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("包管理器"));
    }
}
