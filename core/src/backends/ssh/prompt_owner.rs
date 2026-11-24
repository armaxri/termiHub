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
//!
//! Beside the owner, a connect may name the **connection** it runs for — a
//! saved connection, a tunnel, an agent, a resumed transfer — with
//! [`with_prompt_connection_name`] (#5943). The host-key prompt carries it so a
//! prompt with no owning terminal tab (a tunnel, an SFTP browser, an agent)
//! still tells the user which connection asks. It is scoped the same way and
//! carried across to russh's session task by the SSH handler the same way.

use std::future::Future;

tokio::task_local! {
    /// The owner of the connect running in this task.
    static PROMPT_OWNER: String;
    /// The user-facing name of the connection the connect in this task runs
    /// for (#5943).
    static PROMPT_CONNECTION_NAME: String;
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

/// Run `fut` with `name` recorded as the name of the connection behind any
/// prompt it raises (#5943). `None` (or a blank name) runs `fut` unscoped (an
/// inherited name, if any, stays in effect).
///
/// `fut` is boxed: it wraps whole SSH connects, whose state machines are large,
/// and an unoptimized build would otherwise keep a second inline copy of it in
/// this wrapper's own state — enough to overflow a test thread's stack.
pub async fn with_prompt_connection_name<F: Future>(name: Option<&str>, fut: F) -> F::Output {
    let fut = Box::pin(fut);
    match name.map(str::trim).filter(|n| !n.is_empty()) {
        Some(name) => PROMPT_CONNECTION_NAME.scope(name.to_string(), fut).await,
        None => fut.await,
    }
}

/// [`with_prompt_connection_name`] for a synchronous call — one that connects
/// through `block_in_place` + `Handle::block_on` on the calling thread, which
/// still sees the scope (#5943). A `spawn_blocking` closure does not inherit
/// it: scope inside the closure instead.
pub fn with_prompt_connection_name_sync<R>(name: Option<&str>, f: impl FnOnce() -> R) -> R {
    match name.map(str::trim).filter(|n| !n.is_empty()) {
        Some(name) => PROMPT_CONNECTION_NAME.sync_scope(name.to_string(), f),
        None => f(),
    }
}

/// The connection name scoped around the current task by
/// [`with_prompt_connection_name`], if any.
pub fn current_prompt_connection_name() -> Option<String> {
    PROMPT_CONNECTION_NAME.try_with(Clone::clone).ok()
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

    #[tokio::test]
    async fn connection_name_scope_is_visible_inside_and_not_outside() {
        assert_eq!(current_prompt_connection_name(), None);
        let inside = with_prompt_connection_name(Some("prod db"), async {
            current_prompt_connection_name()
        })
        .await;
        assert_eq!(inside.as_deref(), Some("prod db"));
        assert_eq!(current_prompt_connection_name(), None);
    }

    #[tokio::test]
    async fn a_blank_connection_name_keeps_the_inherited_one() {
        let inner = with_prompt_connection_name(Some("web"), async {
            with_prompt_connection_name(Some("  "), async { current_prompt_connection_name() })
                .await
        })
        .await;
        assert_eq!(inner.as_deref(), Some("web"));
        let unnamed =
            with_prompt_connection_name(Some(" "), async { current_prompt_connection_name() })
                .await;
        assert_eq!(unnamed, None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_sync_scope_reaches_a_block_in_place_connect() {
        let seen = with_prompt_connection_name_sync(Some(" tunnel web "), || {
            tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current()
                    .block_on(async { current_prompt_connection_name() })
            })
        });
        assert_eq!(seen.as_deref(), Some("tunnel web"));
        assert_eq!(current_prompt_connection_name(), None);
    }
}
