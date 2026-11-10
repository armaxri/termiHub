//! The connect that owns a prompt (#3437, #5243).
//!
//! An SSH connect may stop to ask the user something: a host-key trust
//! decision or a keyboard-interactive (one-time code) round. The frontend
//! needs to know which connect asked, so it can cancel the prompt when that
//! connect's tab closes and pause that tab's own connect deadline while the
//! prompt is open. The caller names the connect — for a terminal tab its
//! `connect_id` — by running it inside [`with_prompt_owner`]; the prompting
//! code reads it back with [`current_prompt_owner`].
//!
//! The owner is a **task-local scope**. The keyboard-interactive round runs on
//! the connecting task and sees it directly. The host-key check runs on
//! russh's spawned session task, where the scope is not visible, so the SSH
//! handler captures the owner when it is built and re-scopes the check with it.

use std::future::Future;

tokio::task_local! {
    /// The owner of the connect running in this task.
    static PROMPT_OWNER: String;
}

/// Run `fut` with `owner` recorded as the owner of any prompt it raises.
/// `None` runs `fut` unscoped (an inherited owner, if any, stays in effect).
pub async fn with_prompt_owner<F: Future>(owner: Option<&str>, fut: F) -> F::Output {
    match owner {
        Some(owner) => PROMPT_OWNER.scope(owner.to_string(), fut).await,
        None => fut.await,
    }
}

/// The owner scoped around the current task by [`with_prompt_owner`], if any.
pub fn current_prompt_owner() -> Option<String> {
    PROMPT_OWNER.try_with(Clone::clone).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn scope_is_visible_inside_and_not_outside() {
        assert_eq!(current_prompt_owner(), None);
        let inside = with_prompt_owner(Some("tab-a:0"), async { current_prompt_owner() }).await;
        assert_eq!(inside.as_deref(), Some("tab-a:0"));
        assert_eq!(current_prompt_owner(), None);
    }

    #[tokio::test]
    async fn none_keeps_the_inherited_owner() {
        let inner = with_prompt_owner(Some("tab-a:0"), async {
            with_prompt_owner(None, async { current_prompt_owner() }).await
        })
        .await;
        assert_eq!(inner.as_deref(), Some("tab-a:0"));
    }

    #[tokio::test]
    async fn scope_does_not_leak_into_spawned_tasks() {
        let inner = with_prompt_owner(Some("tab-a:0"), async {
            tokio::spawn(async { current_prompt_owner() }).await
        })
        .await
        .expect("join");
        assert_eq!(inner, None, "a spawned task must not inherit the owner");
    }
}
