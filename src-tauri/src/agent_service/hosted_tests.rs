//! The states of agent-hosted services (#6028, F-2, F-3), over a scripted agent.

use std::collections::HashMap;
use std::sync::atomic::Ordering;

use serde_json::json;

use super::*;
use crate::test_support::FakeAgent;

struct Kind;

impl HostedKind for Kind {
    type State = u64;
    fn unknown_state(_id: &str) -> u64 {
        0
    }
    fn stop_request(id: &str) -> (&'static str, Value) {
        ("stop", json!({"id": id}))
    }
    fn status_request(id: &str) -> (&'static str, Value) {
        ("status", json!({"id": id}))
    }
    fn read_status(_id: &str, reply: &Value, _last: &u64) -> Reading<u64> {
        match reply {
            Value::Null => Reading::NotRunning,
            Value::Number(n) => Reading::Running(n.as_u64().unwrap()),
            _ => Reading::Unreadable,
        }
    }
    fn is_news(before: &u64, after: &u64) -> bool {
        before != after
    }
}

type Services = HostedServices<Kind>;

/// What the agent answers to `status` per service; a missing one is not running.
type Answers = Arc<Mutex<HashMap<String, Result<Value, ()>>>>;

/// An agent that answers `status` from `answers` (`Err`: no answer in time) and
/// confirms every `stop`.
fn agent() -> (Arc<FakeAgent>, Answers) {
    let answers = Answers::default();
    let mut agent = FakeAgent::session_host();
    let read = Arc::clone(&answers);
    agent.responder = Some(Box::new(move |method, params| {
        let id = params["id"].as_str().unwrap_or_default();
        Some(match method {
            "stop" => Ok(json!({"stopped": true})),
            _ => match read.lock().unwrap().get(id) {
                Some(Ok(value)) => Ok(value.clone()),
                Some(Err(())) => Err(TerminalError::agent_timeout(STATUS_TIMEOUT)),
                None => Ok(Value::Null),
            },
        })
    }));
    (Arc::new(agent), answers)
}

fn online(agent: &FakeAgent, online: bool) {
    agent.host().connected.store(online, Ordering::SeqCst);
}

fn say(answers: &Answers, id: &str, answer: Result<Value, ()>) {
    answers.lock().unwrap().insert(id.to_string(), answer);
}

fn tick_at(services: &Services, agent: &FakeAgent, now: Instant) -> Vec<Change> {
    let samples = Services::poll(agent, &services.targets());
    services.apply(samples, now)
}

fn tick(services: &Services, agent: &FakeAgent) -> Vec<Change> {
    tick_at(services, agent, Instant::now())
}

fn started(services: &Services, id: &str) {
    let ticket = services.begin(id).expect("not busy");
    let outcome = Outcome::Started {
        agent_id: "edge".into(),
        state: 0,
    };
    assert_eq!(
        services.finish(ticket, outcome, Instant::now()),
        Finished::Done
    );
}

fn unanswered(services: &Services, id: &str, now: Instant) -> Finished {
    let ticket = services.begin(id).expect("not busy");
    let outcome = Outcome::Unanswered {
        agent_id: "edge".into(),
        state: 0,
    };
    services.finish(ticket, outcome, now)
}

fn running(state: u64) -> Option<View<u64>> {
    Some(View::Running {
        agent_id: "edge".into(),
        state,
    })
}

fn away(state: u64, why: Away) -> Option<View<u64>> {
    Some(View::NotReachable {
        agent_id: "edge".into(),
        state,
        why,
    })
}

fn stopping() -> Option<View<u64>> {
    Some(View::Stopping {
        agent_id: "edge".into(),
    })
}

fn sampled(news: bool) -> Vec<Change> {
    vec![Change::Sampled {
        id: "a".into(),
        news,
    }]
}

fn presence() -> Vec<Change> {
    vec![Change::Presence("a".into())]
}

fn gone(unanswered: bool) -> Vec<Change> {
    vec![Change::Gone {
        id: "a".into(),
        agent_id: "edge".into(),
        unanswered,
    }]
}

fn view(services: &Services) -> Option<View<u64>> {
    services.view("a", Some("edge"))
}

fn stops_sent(agent: &FakeAgent) -> usize {
    let sent = agent.requests();
    sent.iter().filter(|(method, _)| method == "stop").count()
}

#[test]
fn it_is_not_running_while_its_agent_is_gone_and_running_again_when_it_still_runs() {
    let (agent, answers) = agent();
    let services = Services::default();
    say(&answers, "a", Ok(json!(7)));
    started(&services, "a");
    assert_eq!(tick(&services, &agent), sampled(true));
    assert_eq!(tick(&services, &agent), sampled(false));
    assert_eq!(view(&services), running(7));

    online(&agent, false);
    let asked = agent.requests().len();
    assert_eq!(tick(&services, &agent), presence());
    assert_eq!(tick(&services, &agent), vec![], "said once");
    assert_eq!(view(&services), away(7, Away::Offline));
    assert!(!services.is_running("a"));
    assert!(services.running().is_empty(), "no live numbers");
    assert_eq!(
        agent.requests().len(),
        asked,
        "an offline agent is not asked"
    );

    online(&agent, true);
    assert_eq!(tick(&services, &agent), presence());
    assert_eq!(view(&services), running(7));
}

#[test]
fn it_is_stopped_when_its_agent_is_back_without_it() {
    let (agent, answers) = agent();
    let services = Services::default();
    say(&answers, "a", Ok(json!(1)));
    started(&services, "a");
    online(&agent, false);
    tick(&services, &agent);
    answers.lock().unwrap().clear();
    online(&agent, true);
    assert_eq!(tick(&services, &agent), gone(false));
    assert_eq!(view(&services), None);
    assert!(!services.any(), "nothing left to poll");
}

#[test]
fn a_silent_agent_is_not_reachable_after_three_misses_and_one_answer_resets_them() {
    let (agent, answers) = agent();
    let services = Services::default();
    started(&services, "a");
    say(&answers, "a", Err(()));
    assert_eq!(tick(&services, &agent), vec![]);
    assert_eq!(tick(&services, &agent), vec![]);
    say(&answers, "a", Ok(json!(0)));
    assert_eq!(tick(&services, &agent), sampled(false));
    say(&answers, "a", Err(()));
    assert_eq!(tick(&services, &agent), vec![]);
    assert_eq!(tick(&services, &agent), vec![]);
    assert_eq!(view(&services), running(0), "a slow answer is no outage");
    assert_eq!(tick(&services, &agent), presence());
    assert_eq!(view(&services), away(0, Away::Silent));
}

#[test]
fn an_answer_that_cannot_be_read_does_not_say_it_stopped() {
    let (agent, answers) = agent();
    let services = Services::default();
    started(&services, "a");
    say(&answers, "a", Ok(json!("?")));
    assert_eq!(tick(&services, &agent), vec![]);
    assert_eq!(view(&services), running(0));
}

#[test]
fn a_closed_transport_is_an_agent_that_is_gone() {
    let mut agent = FakeAgent::session_host();
    agent.responder = Some(Box::new(|_, _| {
        Some(Err(TerminalError::agent_transport_closed("gone")))
    }));
    let services = Services::default();
    started(&services, "a");
    assert_eq!(tick(&services, &agent), presence());
    assert_eq!(view(&services), away(0, Away::Offline));
}

#[test]
fn one_unanswered_request_ends_the_batch_for_that_agent_only() {
    let (agent, answers) = agent();
    let services = Services::default();
    started(&services, "a");
    started(&services, "b");
    let ticket = services.begin("c").unwrap();
    let outcome = Outcome::Started {
        agent_id: "other".into(),
        state: 0,
    };
    services.finish(ticket, outcome, Instant::now());
    say(&answers, "a", Err(()));
    say(&answers, "b", Err(()));
    say(&answers, "c", Ok(json!(3)));
    tick(&services, &agent);
    let ids: Vec<String> = agent
        .requests()
        .iter()
        .map(|(_, params)| params["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        ids.iter().filter(|id| *id != "c").count(),
        1,
        "the silent agent is asked once: {ids:?}"
    );
    assert!(ids.contains(&"c".to_string()));
}

#[test]
fn an_unanswered_start_is_not_reachable_until_the_agent_says_it_runs() {
    let (agent, answers) = agent();
    let services = Services::default();
    let now = Instant::now();
    assert_eq!(unanswered(&services, "a", now), Finished::Done);
    assert_eq!(view(&services), away(0, Away::StartUnanswered));
    online(&agent, false);
    assert_eq!(tick_at(&services, &agent, now), vec![]);
    assert_eq!(view(&services), away(0, Away::StartUnanswered));
    online(&agent, true);
    say(&answers, "a", Ok(json!(4)));
    assert_eq!(tick_at(&services, &agent, now), presence());
    assert_eq!(view(&services), running(4));
    // Settled: from here on "not running" is the truth at once.
    answers.lock().unwrap().clear();
    assert_eq!(tick_at(&services, &agent, now), gone(false));
}

#[test]
fn an_unanswered_start_may_still_take_effect_for_a_while() {
    let (agent, _answers) = agent();
    let services = Services::default();
    let now = Instant::now();
    unanswered(&services, "a", now);
    let before = now + UNKNOWN_SETTLE - Duration::from_millis(1);
    assert_eq!(tick_at(&services, &agent, before), vec![]);
    assert_eq!(view(&services), away(0, Away::StartUnanswered));
    assert_eq!(
        tick_at(&services, &agent, now + UNKNOWN_SETTLE),
        gone(true),
        "it never ran there"
    );
}

#[test]
fn a_stop_pressed_while_the_agent_is_gone_wins_when_it_is_back() {
    let (agent, answers) = agent();
    let services = Services::default();
    say(&answers, "a", Ok(json!(1)));
    started(&services, "a");
    online(&agent, false);
    tick(&services, &agent);
    assert_eq!(services.stop("a"), StopPlan::StopThere("edge".into()));
    assert_eq!(view(&services), stopping());
    assert!(!services.send_owed_stop(agent.as_ref(), "edge", "a", Instant::now()));
    assert_eq!(tick(&services, &agent), vec![]);
    assert_eq!(view(&services), stopping(), "kept, however long it is away");
    assert!(services.any(), "polled on");
    assert_eq!(stops_sent(&agent), 0);

    online(&agent, true);
    assert_eq!(
        tick(&services, &agent),
        vec![Change::Stopped("a".into())],
        "never running in between"
    );
    assert_eq!(stops_sent(&agent), 1);
    assert_eq!(view(&services), None);
    assert!(!services.any());
}

#[test]
fn a_stop_of_an_unanswered_start_is_repeated_until_that_start_cannot_come_late() {
    let (agent, _answers) = agent();
    let services = Services::default();
    let now = Instant::now();
    unanswered(&services, "a", now);
    services.stop("a");
    assert!(!services.send_owed_stop(agent.as_ref(), "edge", "a", now));
    assert_eq!(tick_at(&services, &agent, now), vec![]);
    assert_eq!(view(&services), stopping());
    assert_eq!(
        tick_at(&services, &agent, now + UNKNOWN_SETTLE),
        vec![Change::Stopped("a".into())]
    );
    assert_eq!(stops_sent(&agent), 3);
}

#[test]
fn a_stop_during_a_start_stops_what_it_started() {
    let services = Services::default();
    let ticket = services.begin("a").unwrap();
    assert_eq!(view(&services), Some(View::Starting));
    assert_eq!(services.stop("a"), StopPlan::StartWillStop);
    assert_eq!(view(&services), stopping());
    let outcome = Outcome::Started {
        agent_id: "edge".into(),
        state: 0,
    };
    assert_eq!(
        services.finish(ticket, outcome, Instant::now()),
        Finished::StopThere("edge".into())
    );
    assert_eq!(view(&services), stopping(), "owed until confirmed");

    let ticket = services.begin("b").unwrap();
    services.stop("b");
    assert_eq!(
        services.finish(ticket, Outcome::Failed, Instant::now()),
        Finished::Stopped
    );
}

#[test]
fn a_stop_during_a_start_that_gets_no_answer_is_owed_until_it_settles() {
    let (agent, _answers) = agent();
    let services = Services::default();
    let now = Instant::now();
    let ticket = services.begin("a").unwrap();
    services.stop("a");
    let outcome = Outcome::Unanswered {
        agent_id: "edge".into(),
        state: 0,
    };
    assert_eq!(
        services.finish(ticket, outcome, now),
        Finished::StopThere("edge".into())
    );
    assert!(!services.send_owed_stop(agent.as_ref(), "edge", "a", now));
    assert!(services.send_owed_stop(agent.as_ref(), "edge", "a", now + UNKNOWN_SETTLE));
}

#[test]
fn there_is_one_start_at_a_time_and_none_while_it_may_run() {
    let (agent, _answers) = agent();
    let services = Services::default();
    let ticket = services.begin("a").unwrap();
    assert_eq!(services.begin("a").unwrap_err(), Busy::Starting);
    assert!(!services.wait("a", WaitFor::CredentialStore, Instant::now()));
    services.finish(ticket, Outcome::Failed, Instant::now());
    started(&services, "a");
    online(&agent, false);
    tick(&services, &agent);
    assert_eq!(services.begin("a").unwrap_err(), Busy::Running);
    assert!(
        !services.wait("a", WaitFor::Agent("edge".into()), Instant::now()),
        "what may run there does not wait to start"
    );
}

/// "a" waits for `on`, and the row can say until when: in [`WAIT_LIMIT`].
fn assert_waits_for(services: &Services, on: &WaitFor) {
    let Some(View::Waiting { on: shown, until }) = view(services) else {
        panic!("not waiting");
    };
    assert_eq!(&shown, on);
    assert_eq!(services.waits_until("a"), Some(until));
    let left = (until - Local::now()).num_seconds();
    let limit = WAIT_LIMIT.as_secs() as i64;
    assert!((limit - 60..=limit).contains(&left), "{left} s");
}

#[test]
fn a_wait_starts_once_and_a_stop_ends_it_for_good() {
    let services = Services::default();
    let now = Instant::now();
    let edge = WaitFor::Agent("edge".into());
    assert!(services.wait("a", edge.clone(), now));
    assert!(!services.wait("a", edge.clone(), now), "no change");
    assert_waits_for(&services, &edge);
    let ticket = services.begin_waiting("a").expect("waits");
    assert!(services.begin_waiting("a").is_none(), "not twice");
    services.finish(ticket, Outcome::Failed, now);
    assert!(!services.waits_until("a").is_some());

    services.wait("a", edge, now);
    assert_eq!(services.stop("a"), StopPlan::StoppedWaiting);
    assert!(services.begin_waiting("a").is_none());
    assert_eq!(view(&services), None);
    assert!(!services.any());
    assert_eq!(services.stop("a"), StopPlan::Nothing);
}

#[test]
fn a_wait_is_bounded_and_waiting_for_something_else_does_not_extend_it() {
    let services = Services::default();
    let now = Instant::now();
    services.wait("a", WaitFor::Agent("edge".into()), now);
    assert!(services.wait("a", WaitFor::CredentialStore, now + WAIT_LIMIT / 2));
    let before = now + WAIT_LIMIT - Duration::from_millis(1);
    assert!(services.take_expired(before).is_empty());
    assert_eq!(
        services.take_expired(now + WAIT_LIMIT),
        vec![("a".to_string(), WaitFor::CredentialStore)]
    );
    assert_eq!(view(&services), None);
}

#[test]
fn only_the_user_undoes_the_users_stop() {
    let services = Services::default();
    started(&services, "a");
    services.stop("a");
    for (by, wins) in [
        (StartedBy::User, false),
        (StartedBy::Itself, true),
        (StartedBy::Wait, true),
    ] {
        assert_eq!(services.stop_wins("edge", "a", by), wins, "{by:?}");
    }
    // On another agent there is no stop to undo.
    assert!(!services.stop_wins("other", "a", StartedBy::Itself));
    // A restart is a stop and a start: the first half does not cancel the second.
    let edge = WaitFor::Agent("edge".into());
    services.wait_to_restart("a", edge.clone(), Instant::now());
    assert!(!services.stop_wins("edge", "a", StartedBy::Wait));
    assert_waits_for(&services, &edge);
    // A stop after it does.
    services.stop("a");
    assert!(services.stop_wins("edge", "a", StartedBy::Wait));
    assert_eq!(view(&services), stopping());
}

#[test]
fn a_moved_service_still_owes_its_stop_on_the_old_agent() {
    let (agent, _answers) = agent();
    let services = Services::default();
    started(&services, "a");
    online(&agent, false);
    services.stop("a");
    assert_eq!(services.view("a", Some("other")), None);
    assert_eq!(services.view("a", None), None, "moved to this computer");
    let ticket = services.begin("a").unwrap();
    let outcome = Outcome::Started {
        agent_id: "other".into(),
        state: 0,
    };
    services.finish(ticket, outcome, Instant::now());
    online(&agent, true);
    tick(&services, &agent);
    assert_eq!(stops_sent(&agent), 1, "stopped on the old one");
}

#[test]
fn a_good_start_settles_an_older_stop() {
    let (agent, answers) = agent();
    let services = Services::default();
    started(&services, "a");
    services.stop("a");
    started(&services, "a");
    say(&answers, "a", Ok(json!(2)));
    tick(&services, &agent);
    assert_eq!(stops_sent(&agent), 0, "the new run is not stopped");
    assert_eq!(view(&services), running(2));
}

#[test]
fn an_answer_about_an_earlier_run_is_dropped() {
    let (agent, _answers) = agent();
    let services = Services::default();
    started(&services, "a");
    let old = Services::poll(agent.as_ref(), &services.targets());
    services.stop("a");
    started(&services, "a");
    assert_eq!(services.apply(old, Instant::now()), vec![]);
    assert_eq!(view(&services), running(0));

    // The same for a confirmed stop of an earlier run.
    services.stop("a");
    let old = Services::poll(agent.as_ref(), &services.targets());
    started(&services, "a");
    services.stop("a");
    assert_eq!(services.apply(old, Instant::now()), vec![]);
    assert_eq!(view(&services), stopping());
}

#[test]
fn a_stop_that_a_removed_agent_owes_is_forgotten() {
    let services = Services::default();
    started(&services, "a");
    services.stop("a");
    assert!(services.forget_removed_agents(|_| false).is_empty());
    assert_eq!(view(&services), stopping());
    assert_eq!(
        services.forget_removed_agents(|agent| agent == "edge"),
        vec!["a".to_string()]
    );
    assert_eq!(view(&services), None);
    assert!(!services.any());
}

/// "Keep running" (#6076).
#[test]
fn a_stop_the_agent_has_not_got_can_be_taken_back() {
    let (agent, answers) = agent();
    let services = Services::default();
    let now = Instant::now();
    assert!(!services.keep("edge", "a"), "nothing to take back");
    started(&services, "a");
    assert!(!services.keep("edge", "a"), "it is not being stopped");
    services.stop("a");
    assert!(!services.keep("other", "a"), "owed elsewhere");
    assert!(services.keep("edge", "a"));
    assert!(matches!(view(&services), Some(View::NotReachable { .. })));
    // The stop is not sent any more, and it is followed again.
    assert!(services.send_owed_stop(agent.as_ref(), "edge", "a", now));
    assert!(agent.requests().is_empty());
    answers.lock().unwrap().insert("a".into(), Ok(json!(7)));
    let targets = services.targets();
    services.apply(Services::poll(agent.as_ref(), &targets), now);
    assert!(matches!(
        view(&services),
        Some(View::Running { state: 7, .. })
    ));
}

#[test]
fn a_restart_is_not_a_stop_to_take_back() {
    let services = Services::default();
    started(&services, "a");
    services.stop("a");
    services.wait_to_restart("a", WaitFor::Agent("edge".into()), Instant::now());
    assert!(!services.keep("edge", "a"));
}

#[test]
fn what_runs_again_is_not_taken_back() {
    let services = Services::default();
    started(&services, "a");
    services.stop("a");
    started(&services, "a");
    assert!(!services.keep("edge", "a"));
    assert_eq!(view(&services), running(0));
}
