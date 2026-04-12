#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod native_core;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use native_core::commands::{
    native_timeline_apply_event, native_timeline_apply_events, native_timeline_delete_event,
    native_timeline_delete_time_range, native_timeline_get_state_at_time,
    native_timeline_insert_event, native_timeline_insert_time_gap, native_timeline_max_time,
    native_timeline_move_event, native_timeline_ripple_delete_time_range,
    native_timeline_split_timeline,
};

#[derive(serde::Serialize)]
struct PickedFilePayload {
    name: String,
    bytes: Vec<u8>,
}

fn sanitize_filename(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        return "input.pptx".to_string();
    }
    out
}

fn ensure_ext(name: &str) -> String {
    let lower = name.to_lowercase();
    if lower.ends_with(".ppt") || lower.ends_with(".pptx") {
        return name.to_string();
    }
    format!("{name}.pptx")
}

fn find_pdf_output(out_dir: &Path, input_name: &str) -> Option<PathBuf> {
    let stem = Path::new(input_name)
        .file_stem()?
        .to_string_lossy()
        .to_string();
    let candidate = out_dir.join(format!("{stem}.pdf"));
    if candidate.exists() {
        return Some(candidate);
    }

    let mut newest: Option<(PathBuf, SystemTime)> = None;
    let read = fs::read_dir(out_dir).ok()?;
    for entry in read.flatten() {
        let path = entry.path();
        let ext = path.extension().map(|v| v.to_string_lossy().to_lowercase());
        if ext.as_deref() != Some("pdf") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(UNIX_EPOCH);
        match &newest {
            Some((_, current)) if *current >= modified => {}
            _ => newest = Some((path, modified)),
        }
    }
    newest.map(|(path, _)| path)
}

#[tauri::command]
fn convert_office_to_pdf(bytes: Vec<u8>, file_name: String) -> Result<Vec<u8>, String> {
    if bytes.is_empty() {
        return Err("input bytes empty".to_string());
    }

    let tick = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let work_dir = std::env::temp_dir().join(format!("uniflow-office-{tick}"));
    fs::create_dir_all(&work_dir).map_err(|e| format!("create temp dir failed: {e}"))?;

    let safe_name = ensure_ext(&sanitize_filename(&file_name));
    let input_path = work_dir.join(&safe_name);
    fs::write(&input_path, bytes).map_err(|e| format!("write input failed: {e}"))?;

    let status = Command::new("soffice")
        .arg("--headless")
        .arg("--convert-to")
        .arg("pdf")
        .arg("--outdir")
        .arg(&work_dir)
        .arg(&input_path)
        .status()
        .map_err(|e| format!("launch soffice failed: {e}"))?;

    if !status.success() {
        let _ = fs::remove_dir_all(&work_dir);
        return Err(format!("soffice convert failed: status={status}"));
    }

    let pdf_path = find_pdf_output(&work_dir, &safe_name)
        .ok_or_else(|| "converted pdf not found".to_string())?;
    let result = fs::read(&pdf_path).map_err(|e| format!("read pdf failed: {e}"))?;

    let _ = fs::remove_dir_all(&work_dir);
    Ok(result)
}

fn normalize_extension_tokens(extensions: Vec<String>) -> Vec<String> {
    let mut normalized: Vec<String> = Vec::new();
    for token in extensions {
        let trimmed = token.trim().trim_start_matches('.').to_lowercase();
        if trimmed.is_empty() {
            continue;
        }
        if normalized.iter().any(|existing| existing == &trimmed) {
            continue;
        }
        normalized.push(trimmed);
    }
    normalized
}

#[tauri::command]
fn pick_files_by_extensions(
    extensions: Vec<String>,
    multiple: bool,
) -> Result<Vec<PickedFilePayload>, String> {
    let normalized = normalize_extension_tokens(extensions);
    let mut dialog = rfd::FileDialog::new();
    if !normalized.is_empty() {
        let refs: Vec<&str> = normalized.iter().map(|value| value.as_str()).collect();
        dialog = dialog.add_filter("Allowed files", &refs);
    }
    let picked_paths: Vec<PathBuf> = if multiple {
        dialog.pick_files().unwrap_or_default()
    } else {
        dialog
            .pick_file()
            .map(|path| vec![path])
            .unwrap_or_default()
    };

    let mut picked_files = Vec::with_capacity(picked_paths.len());
    for path in picked_paths {
        let bytes = fs::read(&path).map_err(|e| format!("read selected file failed: {e}"))?;
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| value.to_string())
            .unwrap_or_else(|| "selected.bin".to_string());
        picked_files.push(PickedFilePayload { name, bytes });
    }
    Ok(picked_files)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            convert_office_to_pdf,
            pick_files_by_extensions,
            native_timeline_apply_event,
            native_timeline_apply_events,
            native_timeline_get_state_at_time,
            native_timeline_insert_event,
            native_timeline_delete_event,
            native_timeline_delete_time_range,
            native_timeline_ripple_delete_time_range,
            native_timeline_split_timeline,
            native_timeline_move_event,
            native_timeline_insert_time_gap,
            native_timeline_max_time
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
