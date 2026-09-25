//! Stable, namespaced connection-type ids for plugin-provided backends (PLG-007).
//!
//! A plugin's `terminalBackend.connectionType` is registered under
//! `plugin:<plugin-id>:<connectionType>` — a pure function of the plugin's own
//! manifest. It never depends on load order or on what else is registered, so:
//!
//! * two plugins declaring the same `connectionType` can never collide,
//! * a plugin can never shadow (or be demoted by) a built-in type, and
//! * the id a saved connection persists stays valid across launches.
//!
//! Built-in types keep their bare ids (`ssh`, `local`, …); the `plugin:` prefix
//! is reserved for plugins (a bare id never contains a `:`). Plugin themes use the
//! same `plugin:<pluginId>:<themeId>` shape.
//!
//! Before this scheme, the host gave the **first registrant** the bare declared
//! name and suffixed later colliders with `-<plugin-id>` (then `-<n>`). Persisted
//! data may still carry such a *legacy* id; [`LegacyTypeIdResolver`] maps one back
//! to its namespaced form from the set of installed plugins.

use std::collections::HashSet;

/// The prefix every plugin-provided connection-type id starts with.
pub const PLUGIN_TYPE_ID_PREFIX: &str = "plugin:";

/// Build the stable registry id of a plugin-provided connection type:
/// `plugin:<plugin_id>:<connection_type>`.
#[must_use]
pub fn plugin_type_id(plugin_id: &str, connection_type: &str) -> String {
    format!("{PLUGIN_TYPE_ID_PREFIX}{plugin_id}:{connection_type}")
}

/// Split a namespaced plugin type id into `(plugin_id, connection_type)`.
///
/// Returns `None` for anything that is not of the form
/// `plugin:<plugin-id>:<connectionType>` with both parts non-empty (a built-in
/// id, a legacy plugin id, or a malformed value). A plugin id never contains a
/// `:`, so the first `:` after the prefix is the separator.
#[must_use]
pub fn parse_plugin_type_id(type_id: &str) -> Option<(&str, &str)> {
    let rest = type_id.strip_prefix(PLUGIN_TYPE_ID_PREFIX)?;
    let (plugin_id, connection_type) = rest.split_once(':')?;
    if plugin_id.is_empty() || connection_type.is_empty() {
        return None;
    }
    Some((plugin_id, connection_type))
}

/// Whether `type_id` is a namespaced plugin-provided connection-type id.
#[must_use]
pub fn is_plugin_type_id(type_id: &str) -> bool {
    parse_plugin_type_id(type_id).is_some()
}

/// The outcome of resolving one persisted connection-type id with a
/// [`LegacyTypeIdResolver`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LegacyResolution {
    /// Not a legacy plugin id — a built-in id or an already-namespaced id. Keep
    /// it as is.
    Current,
    /// Exactly one installed plugin could have produced this legacy id; the
    /// payload is its namespaced id.
    Resolved(String),
    /// Several installed plugins could have produced this legacy id. `resolved`
    /// is the deterministic pick (see [`LegacyTypeIdResolver::resolve`]);
    /// `candidates` lists every namespaced id that matched, for logging.
    Ambiguous {
        resolved: String,
        candidates: Vec<String>,
    },
    /// Not a built-in and no installed plugin declares a matching connection
    /// type — the connection references a missing plugin. Keep the id unchanged
    /// (never delete the connection); it resolves once the plugin is installed.
    Missing,
}

/// Maps a *legacy* (load-order-disambiguated) plugin connection-type id to its
/// stable namespaced form, given the installed plugins.
///
/// The legacy host registered a plugin's declared `connectionType` `ct` as:
/// `ct` (first registrant), `ct-<plugin-id>` (a later collider), or
/// `ct-<plugin-id>-<n>` (`n >= 2`, a collider whose suffix was also taken).
/// Resolution is a pure function of the persisted id and the installed set — it
/// never depends on which plugins happen to be loaded.
#[derive(Debug, Clone, Default)]
pub struct LegacyTypeIdResolver {
    /// `(plugin_id, connection_type)` of every installed plugin that declares a
    /// terminal backend, sorted by plugin id so iteration is deterministic.
    plugins: Vec<(String, String)>,
    /// Built-in connection-type ids; a bare id in this set is never a plugin's.
    builtins: HashSet<String>,
}

/// How a legacy id matched one plugin's declared connection type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum MatchKind {
    /// The legacy id is exactly the declared `connectionType`.
    Plain,
    /// The legacy id is `connectionType-<plugin-id>` (optionally `-<n>`).
    Suffixed,
}

impl LegacyTypeIdResolver {
    /// Build a resolver from the installed plugins' `(plugin_id, connectionType)`
    /// pairs and the host's built-in connection-type ids.
    pub fn new<P, B>(plugins: P, builtins: B) -> Self
    where
        P: IntoIterator<Item = (String, String)>,
        B: IntoIterator,
        B::Item: Into<String>,
    {
        let mut plugins: Vec<(String, String)> = plugins.into_iter().collect();
        plugins.sort();
        plugins.dedup();
        Self {
            plugins,
            builtins: builtins.into_iter().map(Into::into).collect(),
        }
    }

    /// Resolve one persisted connection-type id.
    ///
    /// A built-in id or an already-namespaced id is [`LegacyResolution::Current`].
    /// Otherwise every installed plugin whose legacy id could equal `type_id` is
    /// a candidate. One candidate → [`LegacyResolution::Resolved`]; none →
    /// [`LegacyResolution::Missing`]. Several → [`LegacyResolution::Ambiguous`],
    /// resolved deterministically: an exact (plain) match of the declared
    /// `connectionType` wins over a suffixed one, then the lowest plugin id wins.
    /// That mirrors the historical startup behavior — enabled plugins were loaded
    /// sorted by id, so the lowest id got the plain name.
    #[must_use]
    pub fn resolve(&self, type_id: &str) -> LegacyResolution {
        if type_id.is_empty()
            || self.builtins.contains(type_id)
            || type_id.starts_with(PLUGIN_TYPE_ID_PREFIX)
        {
            return LegacyResolution::Current;
        }

        let mut candidates: Vec<(MatchKind, &str, &str)> = self
            .plugins
            .iter()
            .filter_map(|(plugin_id, ct)| {
                legacy_match(type_id, plugin_id, ct)
                    .map(|kind| (kind, plugin_id.as_str(), ct.as_str()))
            })
            .collect();
        candidates.sort();

        match candidates.as_slice() {
            [] => LegacyResolution::Missing,
            [(_, plugin_id, ct)] => LegacyResolution::Resolved(plugin_type_id(plugin_id, ct)),
            [(_, plugin_id, ct), ..] => LegacyResolution::Ambiguous {
                resolved: plugin_type_id(plugin_id, ct),
                candidates: candidates
                    .iter()
                    .map(|(_, p, c)| plugin_type_id(p, c))
                    .collect(),
            },
        }
    }
}

/// Whether `legacy` is an id the legacy host could have given plugin
/// `plugin_id` declaring `connection_type`, and how.
fn legacy_match(legacy: &str, plugin_id: &str, connection_type: &str) -> Option<MatchKind> {
    if legacy == connection_type {
        return Some(MatchKind::Plain);
    }
    let suffixed = format!("{connection_type}-{plugin_id}");
    if legacy == suffixed {
        return Some(MatchKind::Suffixed);
    }
    let counter = legacy.strip_prefix(&suffixed)?.strip_prefix('-')?;
    let is_counter = !counter.is_empty()
        && counter.bytes().all(|b| b.is_ascii_digit())
        && counter.parse::<u64>().is_ok_and(|n| n >= 2);
    is_counter.then_some(MatchKind::Suffixed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolver(plugins: &[(&str, &str)]) -> LegacyTypeIdResolver {
        LegacyTypeIdResolver::new(
            plugins
                .iter()
                .map(|(p, c)| ((*p).to_string(), (*c).to_string())),
            ["local", "ssh", "serial"],
        )
    }

    #[test]
    fn plugin_type_id_is_namespaced_by_plugin() {
        assert_eq!(plugin_type_id("k8s-tools", "k8s"), "plugin:k8s-tools:k8s");
    }

    #[test]
    fn parse_round_trips_and_rejects_non_plugin_ids() {
        assert_eq!(
            parse_plugin_type_id("plugin:k8s-tools:k8s"),
            Some(("k8s-tools", "k8s"))
        );
        assert_eq!(parse_plugin_type_id("ssh"), None);
        assert_eq!(parse_plugin_type_id("k8s-k8s-tools"), None);
        assert_eq!(parse_plugin_type_id("plugin:"), None);
        assert_eq!(parse_plugin_type_id("plugin:x"), None);
        assert_eq!(parse_plugin_type_id("plugin::k8s"), None);
        assert_eq!(parse_plugin_type_id("plugin:x:"), None);
        assert!(is_plugin_type_id("plugin:a:b"));
        assert!(!is_plugin_type_id("local"));
    }

    #[test]
    fn two_plugins_with_the_same_connection_type_never_collide() {
        assert_ne!(
            plugin_type_id("alpha", "k8s"),
            plugin_type_id("beta", "k8s")
        );
    }

    #[test]
    fn builtins_and_namespaced_ids_are_current() {
        let r = resolver(&[("alpha", "ssh"), ("beta", "k8s")]);
        assert_eq!(r.resolve("ssh"), LegacyResolution::Current);
        assert_eq!(r.resolve("plugin:beta:k8s"), LegacyResolution::Current);
        assert_eq!(r.resolve(""), LegacyResolution::Current);
    }

    #[test]
    fn plain_legacy_id_resolves_to_its_only_declarer() {
        let r = resolver(&[("beta", "k8s")]);
        assert_eq!(
            r.resolve("k8s"),
            LegacyResolution::Resolved("plugin:beta:k8s".into())
        );
    }

    #[test]
    fn suffixed_legacy_ids_resolve_to_the_named_plugin() {
        let r = resolver(&[("alpha", "k8s"), ("beta", "k8s"), ("gamma", "ssh")]);
        assert_eq!(
            r.resolve("k8s-beta"),
            LegacyResolution::Resolved("plugin:beta:k8s".into())
        );
        assert_eq!(
            r.resolve("k8s-alpha-2"),
            LegacyResolution::Resolved("plugin:alpha:k8s".into())
        );
        // A plugin that collided with a built-in was always suffixed.
        assert_eq!(
            r.resolve("ssh-gamma"),
            LegacyResolution::Resolved("plugin:gamma:ssh".into())
        );
        // A counter below 2 or a non-numeric tail was never produced.
        assert_eq!(r.resolve("k8s-beta-1"), LegacyResolution::Missing);
        assert_eq!(r.resolve("k8s-beta-x"), LegacyResolution::Missing);
    }

    #[test]
    fn ambiguous_plain_id_resolves_to_the_lowest_plugin_id() {
        let r = resolver(&[("beta", "k8s"), ("alpha", "k8s")]);
        assert_eq!(
            r.resolve("k8s"),
            LegacyResolution::Ambiguous {
                resolved: "plugin:alpha:k8s".into(),
                candidates: vec!["plugin:alpha:k8s".into(), "plugin:beta:k8s".into()],
            }
        );
    }

    #[test]
    fn plain_match_beats_suffixed_match() {
        // `k8s-beta` is both plugin `other`'s declared type and plugin `beta`'s
        // suffixed `k8s`. The exact declaration wins, deterministically.
        let r = resolver(&[("beta", "k8s"), ("other", "k8s-beta")]);
        match r.resolve("k8s-beta") {
            LegacyResolution::Ambiguous { resolved, .. } => {
                assert_eq!(resolved, "plugin:other:k8s-beta");
            }
            other => panic!("expected ambiguous, got {other:?}"),
        }
    }

    #[test]
    fn unknown_id_is_missing() {
        let r = resolver(&[("beta", "k8s")]);
        assert_eq!(r.resolve("mqtt"), LegacyResolution::Missing);
    }

    #[test]
    fn resolution_is_independent_of_plugin_input_order() {
        let pairs = [("gamma", "k8s"), ("alpha", "k8s"), ("beta", "k8s")];
        let ids = ["k8s", "k8s-beta", "k8s-gamma-3", "nope"];
        let reference = resolver(&pairs);
        let mut permuted = pairs;
        for _ in 0..pairs.len() {
            permuted.rotate_left(1);
            let r = resolver(&permuted);
            let mut reversed = permuted;
            reversed.reverse();
            let rr = resolver(&reversed);
            for id in ids {
                assert_eq!(r.resolve(id), reference.resolve(id));
                assert_eq!(rr.resolve(id), reference.resolve(id));
            }
        }
    }
}
