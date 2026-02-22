//! Docker container filesystem operations via `docker exec`.
//!
//! **Deprecated**: This file backend is superseded by the unified
//! [`termihub_core::backends::docker::file_browser::DockerFileBrowser`]
//! implementation (see #358). It will be removed once the agent is
//! migrated to the core backend.

use termihub_core::files::FileEntry;

use super::{chrono_from_epoch, format_permissions, FileBackend, FileError};

/// File operations inside a Docker container.
///
/// Uses `docker exec <container> ...` to run commands inside the container.
/// The container must be running.
pub struct DockerFileBackend {
    container_name: String,
}

impl DockerFileBackend {
    pub fn new(container_name: String) -> Self {
        Self { container_name }
    }
}

#[async_trait::async_trait]
impl FileBackend for DockerFileBackend {
    async fn list(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        let output = docker_exec(&self.container_name, &build_find_args(path)).await?;
        parse_find_output(&output, path)
    }

    async fn read(&self, path: &str) -> Result<Vec<u8>, FileError> {
        let output = docker_exec(&self.container_name, &["base64", path]).await?;
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, output.trim())
            .map_err(|e| FileError::OperationFailed(format!("base64 decode failed: {e}")))
    }

    async fn write(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, data);
        let script = format!("base64 -d > '{}'", shell_escape(path));
        docker_exec_stdin(
            &self.container_name,
            &["sh", "-c", &script],
            encoded.as_bytes(),
        )
        .await
    }

    async fn delete(&self, path: &str, is_directory: bool) -> Result<(), FileError> {
        let args: Vec<&str> = if is_directory {
            vec!["rm", "-rf", path]
        } else {
            vec!["rm", path]
        };
        docker_exec(&self.container_name, &args).await?;
        Ok(())
    }

    async fn rename(&self, old_path: &str, new_path: &str) -> Result<(), FileError> {
        docker_exec(&self.container_name, &["mv", old_path, new_path]).await?;
        Ok(())
    }

    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        let output = docker_exec(
            &self.container_name,
            &["stat", "-c", "%n\t%F\t%s\t%Y\t%a", path],
        )
        .await?;
        parse_stat_output(&output, path)
    }
}

/// Build `find` arguments for directory listing.
fn build_find_args(path: &str) -> Vec<String> {
    vec![
        "find".to_string(),
        path.to_string(),
        "-maxdepth".to_string(),
        "1".to_string(),
        "-not".to_string(),
        "-name".to_string(),
        ".".to_string(),
        // Skip the directory itself in results
        "-not".to_string(),
        "-path".to_string(),
        path.to_string(),
        "-printf".to_string(),
        "%f\t%y\t%s\t%T@\t%m\n".to_string(),
    ]
}

/// Run a command inside a Docker container and return stdout.
async fn docker_exec(container: &str, args: &[impl AsRef<str>]) -> Result<String, FileError> {
    let mut cmd = tokio::process::Command::new("docker");
    cmd.arg("exec").arg(container);
    for arg in args {
        cmd.arg(arg.as_ref());
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| FileError::OperationFailed(format!("Failed to run docker exec: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(map_docker_error(&stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Run a command inside a Docker container with stdin data.
async fn docker_exec_stdin(
    container: &str,
    args: &[&str],
    stdin_data: &[u8],
) -> Result<(), FileError> {
    use tokio::io::AsyncWriteExt;

    let mut cmd = tokio::process::Command::new("docker");
    cmd.arg("exec")
        .arg("-i")
        .arg(container)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    for arg in args {
        cmd.arg(arg);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| FileError::OperationFailed(format!("Failed to spawn docker exec: {e}")))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(stdin_data)
            .await
            .map_err(|e| FileError::OperationFailed(format!("Failed to write stdin: {e}")))?;
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| FileError::OperationFailed(format!("docker exec failed: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(map_docker_error(&stderr));
    }

    Ok(())
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

/// Parse the output of `find -printf '%f\t%y\t%s\t%T@\t%m\n'`.
fn parse_find_output(output: &str, parent_path: &str) -> Result<Vec<FileEntry>, FileError> {
    let mut entries = Vec::new();
    let parent = if parent_path.ends_with('/') {
        parent_path.to_string()
    } else {
        format!("{}/", parent_path)
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

        let path = format!("{}{}", parent, name);
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
            "Unexpected stat output: {}",
            line
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn shell_escape_basic() {
        assert_eq!(shell_escape("hello"), "hello");
        assert_eq!(shell_escape("it's"), "it'\\''s");
    }

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
}
