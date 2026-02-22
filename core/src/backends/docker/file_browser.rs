//! Docker container file browser implementing [`FileBrowser`].
//!
//! Uses bollard's exec API to run commands inside a running container
//! for file listing, reading, writing, deleting, renaming, and stat.

use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;

use crate::errors::FileError;
use crate::files::utils::{chrono_from_epoch, format_permissions};
use crate::files::{FileBrowser, FileEntry};

/// File browser for Docker containers via `docker exec`.
///
/// Created during [`Docker::connect()`](super::Docker) and stored for
/// the lifetime of the connection. Operations run commands inside the
/// container using bollard's exec API.
pub(crate) struct DockerFileBrowser {
    client: bollard::Docker,
    container_id: String,
}

impl DockerFileBrowser {
    pub(crate) fn new(client: bollard::Docker, container_id: String) -> Self {
        Self {
            client,
            container_id,
        }
    }
}

/// Run a command inside the container and return stdout as a string.
async fn exec_command(
    client: &bollard::Docker,
    container_id: &str,
    cmd: Vec<&str>,
) -> Result<String, FileError> {
    let exec_config = CreateExecOptions {
        attach_stdout: Some(true),
        attach_stderr: Some(true),
        cmd: Some(cmd),
        ..Default::default()
    };

    let exec = client
        .create_exec(container_id, exec_config)
        .await
        .map_err(|e| FileError::OperationFailed(format!("Failed to create exec: {e}")))?;

    let start_config = StartExecOptions {
        detach: false,
        ..Default::default()
    };

    let result = client
        .start_exec(&exec.id, Some(start_config))
        .await
        .map_err(|e| FileError::OperationFailed(format!("Failed to start exec: {e}")))?;

    match result {
        StartExecResults::Attached { mut output, .. } => {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            while let Some(chunk) = output.next().await {
                match chunk {
                    Ok(bollard::container::LogOutput::StdOut { message }) => {
                        stdout.extend_from_slice(&message);
                    }
                    Ok(bollard::container::LogOutput::StdErr { message }) => {
                        stderr.extend_from_slice(&message);
                    }
                    Ok(_) => {}
                    Err(e) => {
                        return Err(FileError::OperationFailed(format!(
                            "Exec output error: {e}"
                        )));
                    }
                }
            }

            // Check exec exit code to detect errors.
            let inspect = client.inspect_exec(&exec.id).await.ok();
            let exit_code = inspect.and_then(|i| i.exit_code).unwrap_or(0);

            if exit_code != 0 {
                let stderr_str = String::from_utf8_lossy(&stderr);
                return Err(map_docker_error(&stderr_str));
            }

            Ok(String::from_utf8_lossy(&stdout).to_string())
        }
        StartExecResults::Detached => Err(FileError::OperationFailed(
            "Exec started in detached mode".to_string(),
        )),
    }
}

/// Run a command inside the container with stdin data.
async fn exec_command_stdin(
    client: &bollard::Docker,
    container_id: &str,
    cmd: Vec<&str>,
    stdin_data: &[u8],
) -> Result<(), FileError> {
    let exec_config = CreateExecOptions {
        attach_stdin: Some(true),
        attach_stdout: Some(true),
        attach_stderr: Some(true),
        cmd: Some(cmd),
        ..Default::default()
    };

    let exec = client
        .create_exec(container_id, exec_config)
        .await
        .map_err(|e| FileError::OperationFailed(format!("Failed to create exec: {e}")))?;

    let start_config = StartExecOptions {
        detach: false,
        ..Default::default()
    };

    let result = client
        .start_exec(&exec.id, Some(start_config))
        .await
        .map_err(|e| FileError::OperationFailed(format!("Failed to start exec: {e}")))?;

    match result {
        StartExecResults::Attached {
            mut output, input, ..
        } => {
            // Write stdin data.
            let mut input = input;
            input
                .write_all(stdin_data)
                .await
                .map_err(|e| FileError::OperationFailed(format!("Failed to write stdin: {e}")))?;
            input
                .shutdown()
                .await
                .map_err(|e| FileError::OperationFailed(format!("Failed to close stdin: {e}")))?;

            // Drain output and collect stderr for error reporting.
            let mut stderr = Vec::new();
            while let Some(chunk) = output.next().await {
                match chunk {
                    Ok(bollard::container::LogOutput::StdErr { message }) => {
                        stderr.extend_from_slice(&message);
                    }
                    Ok(_) => {}
                    Err(e) => {
                        return Err(FileError::OperationFailed(format!(
                            "Exec output error: {e}"
                        )));
                    }
                }
            }

            let inspect = client.inspect_exec(&exec.id).await.ok();
            let exit_code = inspect.and_then(|i| i.exit_code).unwrap_or(0);

            if exit_code != 0 {
                let stderr_str = String::from_utf8_lossy(&stderr);
                return Err(map_docker_error(&stderr_str));
            }

            Ok(())
        }
        StartExecResults::Detached => Err(FileError::OperationFailed(
            "Exec started in detached mode".to_string(),
        )),
    }
}

#[async_trait::async_trait]
impl FileBrowser for DockerFileBrowser {
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        let output = exec_command(
            &self.client,
            &self.container_id,
            vec![
                "find",
                path,
                "-maxdepth",
                "1",
                "-not",
                "-name",
                ".",
                "-not",
                "-path",
                path,
                "-printf",
                "%f\t%y\t%s\t%T@\t%m\n",
            ],
        )
        .await?;
        parse_find_output(&output, path)
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, FileError> {
        let output = exec_command(&self.client, &self.container_id, vec!["base64", path]).await?;

        // base64 decode
        use std::io::Read;
        let cleaned: String = output.chars().filter(|c| !c.is_whitespace()).collect();
        let mut decoder = base64_decode_reader(cleaned.as_bytes());
        let mut data = Vec::new();
        decoder
            .read_to_end(&mut data)
            .map_err(|e| FileError::OperationFailed(format!("base64 decode failed: {e}")))?;
        Ok(data)
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        let encoded = base64_encode(data);
        let script = format!("base64 -d > '{}'", shell_escape(path));
        exec_command_stdin(
            &self.client,
            &self.container_id,
            vec!["sh", "-c", &script],
            encoded.as_bytes(),
        )
        .await
    }

    async fn delete(&self, path: &str) -> Result<(), FileError> {
        // Stat to determine if it's a directory.
        let stat = self.stat(path).await?;
        if stat.is_directory {
            exec_command(&self.client, &self.container_id, vec!["rm", "-rf", path]).await?;
        } else {
            exec_command(&self.client, &self.container_id, vec!["rm", path]).await?;
        }
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), FileError> {
        exec_command(&self.client, &self.container_id, vec!["mv", from, to]).await?;
        Ok(())
    }

    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        let output = exec_command(
            &self.client,
            &self.container_id,
            vec!["stat", "-c", "%n\t%F\t%s\t%Y\t%a", path],
        )
        .await?;
        parse_stat_output(&output, path)
    }
}

// --- Parsing helpers (ported from agent/src/files/docker.rs) ---

/// Parse the output of `find -printf '%f\t%y\t%s\t%T@\t%m\n'`.
fn parse_find_output(output: &str, parent_path: &str) -> Result<Vec<FileEntry>, FileError> {
    let mut entries = Vec::new();
    let parent = if parent_path.ends_with('/') {
        parent_path.to_string()
    } else {
        format!("{parent_path}/")
    };

    for line in output.lines() {
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.splitn(5, '\t').collect();
        if fields.len() < 5 {
            continue;
        }

        let name = fields[0].to_string();
        let is_directory = fields[1] == "d";
        let size: u64 = fields[2].parse().unwrap_or(0);
        let mtime_float: f64 = fields[3].parse().unwrap_or(0.0);
        let mode: u32 = u32::from_str_radix(fields[4].trim(), 8).unwrap_or(0);

        let path = format!("{parent}{name}");
        let modified = chrono_from_epoch(mtime_float as u64);
        let permissions = Some(format_permissions(mode));

        entries.push(FileEntry {
            name,
            path,
            is_directory,
            size,
            modified,
            permissions,
        });
    }

    Ok(entries)
}

/// Parse `stat -c '%n\t%F\t%s\t%Y\t%a'` output for a single file.
fn parse_stat_output(output: &str, path: &str) -> Result<FileEntry, FileError> {
    let line = output.trim();
    let fields: Vec<&str> = line.splitn(5, '\t').collect();
    if fields.len() < 5 {
        return Err(FileError::OperationFailed(format!(
            "Unexpected stat output: {line}"
        )));
    }

    let name = std::path::Path::new(fields[0])
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| fields[0].to_string());
    let is_directory = fields[1].contains("directory");
    let size: u64 = fields[2].parse().unwrap_or(0);
    let mtime: u64 = fields[3].parse().unwrap_or(0);
    let mode: u32 = u32::from_str_radix(fields[4].trim(), 8).unwrap_or(0);

    Ok(FileEntry {
        name,
        path: path.to_string(),
        is_directory,
        size,
        modified: chrono_from_epoch(mtime),
        permissions: Some(format_permissions(mode)),
    })
}

/// Map docker exec stderr to appropriate `FileError`.
fn map_docker_error(stderr: &str) -> FileError {
    let lower = stderr.to_lowercase();
    if lower.contains("no such file") || lower.contains("not found") {
        FileError::NotFound(stderr.trim().to_string())
    } else if lower.contains("permission denied") {
        FileError::PermissionDenied(stderr.trim().to_string())
    } else {
        FileError::OperationFailed(stderr.trim().to_string())
    }
}

/// Simple shell escaping for single-quoted strings.
fn shell_escape(s: &str) -> String {
    s.replace('\'', "'\\''")
}

/// Base64 encode bytes to a string (no-dependency implementation).
fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(data.len().div_ceil(3) * 4);

    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };

        let triple = (b0 << 16) | (b1 << 8) | b2;

        result.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);

        if chunk.len() > 1 {
            result.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }

        if chunk.len() > 2 {
            result.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }

    result
}

/// Create a base64 decoding reader (no-dependency implementation).
fn base64_decode_reader(input: &[u8]) -> Base64Decoder<'_> {
    Base64Decoder {
        input,
        pos: 0,
        buf: [0; 3],
        buf_len: 0,
        buf_pos: 0,
    }
}

struct Base64Decoder<'a> {
    input: &'a [u8],
    pos: usize,
    buf: [u8; 3],
    buf_len: usize,
    buf_pos: usize,
}

impl<'a> std::io::Read for Base64Decoder<'a> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let mut written = 0;
        while written < out.len() {
            if self.buf_pos < self.buf_len {
                out[written] = self.buf[self.buf_pos];
                self.buf_pos += 1;
                written += 1;
                continue;
            }
            // Decode next 4 chars.
            if self.pos >= self.input.len() {
                break;
            }
            let mut quad = [0u8; 4];
            let mut count = 0;
            let mut padding = 0;
            while count < 4 && self.pos < self.input.len() {
                let b = self.input[self.pos];
                self.pos += 1;
                if let Some(val) = decode_b64_char(b) {
                    quad[count] = val;
                    count += 1;
                } else if b == b'=' {
                    quad[count] = 0;
                    count += 1;
                    padding += 1;
                }
            }
            if count < 4 {
                break;
            }
            let triple = ((quad[0] as u32) << 18)
                | ((quad[1] as u32) << 12)
                | ((quad[2] as u32) << 6)
                | (quad[3] as u32);

            self.buf[0] = (triple >> 16) as u8;
            self.buf[1] = (triple >> 8) as u8;
            self.buf[2] = triple as u8;
            self.buf_len = 3 - padding;
            self.buf_pos = 0;
        }
        Ok(written)
    }
}

fn decode_b64_char(b: u8) -> Option<u8> {
    match b {
        b'A'..=b'Z' => Some(b - b'A'),
        b'a'..=b'z' => Some(b - b'a' + 26),
        b'0'..=b'9' => Some(b - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- parse_find_output tests ---

    #[test]
    fn parse_find_output_basic() {
        let output = "readme.md\tf\t1024\t1705321845.0\t644\n\
                       src\td\t4096\t1705321845.0\t755\n";
        let entries = parse_find_output(output, "/project").unwrap();
        assert_eq!(entries.len(), 2);

        let file = &entries[0];
        assert_eq!(file.name, "readme.md");
        assert_eq!(file.path, "/project/readme.md");
        assert!(!file.is_directory);
        assert_eq!(file.size, 1024);
        assert_eq!(file.permissions.as_deref(), Some("rw-r--r--"));

        let dir = &entries[1];
        assert_eq!(dir.name, "src");
        assert!(dir.is_directory);
        assert_eq!(dir.permissions.as_deref(), Some("rwxr-xr-x"));
    }

    #[test]
    fn parse_find_output_empty() {
        let entries = parse_find_output("", "/empty").unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn parse_find_output_trailing_slash() {
        let output = "file.txt\tf\t100\t1000000.0\t644\n";
        let entries = parse_find_output(output, "/dir/").unwrap();
        assert_eq!(entries[0].path, "/dir/file.txt");
    }

    // --- parse_stat_output tests ---

    #[test]
    fn parse_stat_output_file() {
        let output = "/project/readme.md\tregular file\t1024\t1705321845\t644\n";
        let result = parse_stat_output(output, "/project/readme.md").unwrap();
        assert_eq!(result.name, "readme.md");
        assert!(!result.is_directory);
        assert_eq!(result.size, 1024);
        assert_eq!(result.permissions.as_deref(), Some("rw-r--r--"));
    }

    #[test]
    fn parse_stat_output_directory() {
        let output = "/var/log\tdirectory\t4096\t1705321845\t755\n";
        let result = parse_stat_output(output, "/var/log").unwrap();
        assert_eq!(result.name, "log");
        assert!(result.is_directory);
        assert_eq!(result.permissions.as_deref(), Some("rwxr-xr-x"));
    }

    #[test]
    fn parse_stat_output_invalid() {
        let result = parse_stat_output("bad output", "/foo");
        assert!(result.is_err());
    }

    // --- shell_escape tests ---

    #[test]
    fn shell_escape_basic() {
        assert_eq!(shell_escape("hello"), "hello");
        assert_eq!(shell_escape("it's"), "it'\\''s");
    }

    // --- map_docker_error tests ---

    #[test]
    fn map_docker_error_not_found() {
        let err = map_docker_error("stat: cannot stat '/foo': No such file or directory");
        assert!(matches!(err, FileError::NotFound(_)));
    }

    #[test]
    fn map_docker_error_permission_denied() {
        let err = map_docker_error("cat: /etc/shadow: Permission denied");
        assert!(matches!(err, FileError::PermissionDenied(_)));
    }

    #[test]
    fn map_docker_error_generic() {
        let err = map_docker_error("something went wrong");
        assert!(matches!(err, FileError::OperationFailed(_)));
    }

    // --- base64 tests ---

    #[test]
    fn base64_encode_empty() {
        assert_eq!(base64_encode(b""), "");
    }

    #[test]
    fn base64_encode_hello() {
        assert_eq!(base64_encode(b"Hello, World!"), "SGVsbG8sIFdvcmxkIQ==");
    }

    #[test]
    fn base64_roundtrip() {
        let data = b"The quick brown fox jumps over the lazy dog";
        let encoded = base64_encode(data);
        let mut decoder = base64_decode_reader(encoded.as_bytes());
        let mut decoded = Vec::new();
        std::io::Read::read_to_end(&mut decoder, &mut decoded).unwrap();
        assert_eq!(decoded, data);
    }

    #[test]
    fn base64_roundtrip_binary() {
        let data: Vec<u8> = (0..=255).collect();
        let encoded = base64_encode(&data);
        let mut decoder = base64_decode_reader(encoded.as_bytes());
        let mut decoded = Vec::new();
        std::io::Read::read_to_end(&mut decoder, &mut decoded).unwrap();
        assert_eq!(decoded, data);
    }
}
