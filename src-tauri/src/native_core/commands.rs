use super::timeline;
use super::types::{ProjectState, TimelineEvent, TimelineSplit};

#[tauri::command]
pub fn native_timeline_apply_event(state: ProjectState, event: TimelineEvent) -> ProjectState {
    timeline::apply_event(&state, &event)
}

#[tauri::command]
pub fn native_timeline_apply_events(
    initial_state: ProjectState,
    events: Vec<TimelineEvent>,
) -> ProjectState {
    timeline::apply_events(&initial_state, &events)
}

#[tauri::command]
pub fn native_timeline_get_state_at_time(
    initial_state: ProjectState,
    events: Vec<TimelineEvent>,
    time: i64,
) -> ProjectState {
    timeline::get_state_at_time(&initial_state, &events, time)
}

#[tauri::command]
pub fn native_timeline_insert_event(
    events: Vec<TimelineEvent>,
    event: TimelineEvent,
) -> Vec<TimelineEvent> {
    timeline::insert_event(&events, event)
}

#[tauri::command]
pub fn native_timeline_delete_event(
    events: Vec<TimelineEvent>,
    event_id: String,
) -> Vec<TimelineEvent> {
    timeline::delete_event(&events, &event_id)
}

#[tauri::command]
pub fn native_timeline_delete_time_range(
    events: Vec<TimelineEvent>,
    start: i64,
    end: i64,
) -> Vec<TimelineEvent> {
    timeline::delete_time_range(&events, start, end)
}

#[tauri::command]
pub fn native_timeline_ripple_delete_time_range(
    events: Vec<TimelineEvent>,
    start: i64,
    end: i64,
) -> Vec<TimelineEvent> {
    timeline::ripple_delete_time_range(&events, start, end)
}

#[tauri::command]
pub fn native_timeline_split_timeline(events: Vec<TimelineEvent>, time: i64) -> TimelineSplit {
    timeline::split_timeline(&events, time)
}

#[tauri::command]
pub fn native_timeline_move_event(
    events: Vec<TimelineEvent>,
    event_id: String,
    new_time: i64,
) -> Vec<TimelineEvent> {
    timeline::move_event(&events, &event_id, new_time)
}

#[tauri::command]
pub fn native_timeline_insert_time_gap(
    events: Vec<TimelineEvent>,
    start_time: i64,
    duration: i64,
    event_ids: Option<Vec<String>>,
) -> Vec<TimelineEvent> {
    timeline::insert_time_gap(&events, start_time, duration, event_ids.as_deref())
}

#[tauri::command]
pub fn native_timeline_max_time(events: Vec<TimelineEvent>) -> i64 {
    timeline::timeline_max_time(&events)
}
