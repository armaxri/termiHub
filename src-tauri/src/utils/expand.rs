use std::env;

/// Expand a leading `~` or `~/` to the user's home directory.
///
/// On Unix, uses `$HOME`. On Windows, uses `%USERPROFILE%`.
/// Returns the input unchanged if no home directory is available.
pub fn expand_tilde(input: &str) -> String {
    if !input.starts_with('~') {
        return input.to_string();
    }

    // Only expand "~" alone or "~/..." — not "~user" patterns
    if input.len() > 1 && !input[1..].starts_with('/') && !input[1..].starts_with('\\') {
        return input.to_string();
    }

    #[cfg(unix)]
    let home = env::var("HOME").ok();
    #[cfg(windows)]
    let home = env::var("USERPROFILE").ok();
    #[cfg(not(any(unix, windows)))]
    let home: Option<String> = None;

    match home {
        Some(h) => {
            let mut result = h;
            if input.len() > 1 {
                result.push_str(&input[1..]);
            }
            result
        }
        None => input.to_string(),
    }
}

/// Replace `${env:VAR_NAME}` placeholders with the value of the environment
/// variable `VAR_NAME`. Unknown variables are left as-is.
pub fn expand_env_placeholders(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut rest = input;

    while let Some(start) = rest.find("${env:") {
        result.push_str(&rest[..start]);
        let after = &rest[start + 6..]; // skip "${env:"
        if let Some(end) = after.find('}') {
            let var_name = &after[..end];
            match env::var(var_name) {
                Ok(val) => result.push_str(&val),
                Err(_) => {
                    // Leave placeholder as-is when variable is not set
                    result.push_str(&rest[start..start + 6 + end + 1]);
                }
            }
            rest = &after[end + 1..];
        } else {
            // No closing brace — push rest as-is
            result.push_str(&rest[start..]);
            rest = "";
        }
    }

    result.push_str(rest);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_known_variable() {
        env::set_var("TERMIHUB_TEST_VAR", "hello");
        assert_eq!(expand_env_placeholders("${env:TERMIHUB_TEST_VAR}"), "hello");
        env::remove_var("TERMIHUB_TEST_VAR");
    }

    #[test]
    fn leaves_unknown_variable_as_is() {
        let input = "${env:TERMIHUB_NONEXISTENT_VAR_XYZ}";
        assert_eq!(expand_env_placeholders(input), input);
    }

    #[test]
    fn expands_multiple_placeholders() {
        env::set_var("TERMIHUB_TEST_A", "foo");
        env::set_var("TERMIHUB_TEST_B", "bar");
        assert_eq!(
            expand_env_placeholders("${env:TERMIHUB_TEST_A}@${env:TERMIHUB_TEST_B}"),
            "foo@bar"
        );
        env::remove_var("TERMIHUB_TEST_A");
        env::remove_var("TERMIHUB_TEST_B");
    }

    #[test]
    fn handles_no_placeholders() {
        assert_eq!(expand_env_placeholders("plain text"), "plain text");
    }

    #[test]
    fn handles_unclosed_brace() {
        assert_eq!(expand_env_placeholders("${env:MISSING"), "${env:MISSING");
    }

    #[test]
    fn handles_mixed_content() {
        env::set_var("TERMIHUB_TEST_USER", "alice");
        assert_eq!(
            expand_env_placeholders("ssh ${env:TERMIHUB_TEST_USER}@host"),
            "ssh alice@host"
        );
        env::remove_var("TERMIHUB_TEST_USER");
    }

    #[test]
    fn tilde_alone_expands_to_home() {
        let result = expand_tilde("~");
        assert!(
            !result.starts_with('~'),
            "expected ~ to expand, got: {result}"
        );
        assert!(!result.is_empty());
    }

    #[test]
    fn tilde_slash_expands_to_home_subpath() {
        let result = expand_tilde("~/work");
        assert!(
            result.ends_with("/work"),
            "expected path ending in /work, got: {result}"
        );
        assert!(!result.starts_with('~'));
    }

    #[test]
    fn tilde_user_is_not_expanded() {
        assert_eq!(expand_tilde("~user/foo"), "~user/foo");
    }

    #[test]
    fn no_tilde_is_unchanged() {
        assert_eq!(expand_tilde("/usr/local"), "/usr/local");
    }
}
