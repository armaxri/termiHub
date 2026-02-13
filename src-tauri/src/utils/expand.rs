use std::env;

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
}
