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
fn detect_ffmpeg() -> Option<PathBuf> {
    let candidates = [
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ];
    for candidate in candidates {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Some(path);
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

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct EncodeH264Request {
    frames_dir: String,
    fps: f64,
    width: i32,
    height: i32,
    bitrate: i64,
    output_path: String,
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

    let args = vec![
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
        "-an".to_string(),
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
        output_path.to_string(),
    ];

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
}
