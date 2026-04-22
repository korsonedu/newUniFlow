use serde_json::{Map, Value};
use std::collections::HashSet;

use super::time::{normalize_range, normalize_time, shift_time, timeline_duration};
use super::types::{
    create_empty_page_state, PageState, Point, ProjectState, Stroke, TimelineEvent,
    TimelineEventType, TimelineSplit, WhiteboardObject, WhiteboardObjectType,
};

fn event_priority(event_type: TimelineEventType) -> i32 {
    match event_type {
        TimelineEventType::PageSet => 0,
        TimelineEventType::StrokeCreate | TimelineEventType::ObjectCreate => 10,
        TimelineEventType::ObjectUpdate | TimelineEventType::ViewportSet => 20,
        TimelineEventType::StrokeErase | TimelineEventType::ObjectDelete => 30,
    }
}

fn payload_as_object(event: &TimelineEvent) -> Option<&Map<String, Value>> {
    event.payload.as_ref()?.as_object()
}

fn payload_string(payload: &Map<String, Value>, key: &str) -> Option<String> {
    payload.get(key)?.as_str().map(|value| value.to_string())
}

fn payload_number(payload: &Map<String, Value>, key: &str) -> Option<f64> {
    payload.get(key)?.as_f64()
}

fn payload_object<'a>(
    payload: &'a Map<String, Value>,
    key: &str,
) -> Option<&'a Map<String, Value>> {
    payload.get(key)?.as_object()
}

fn payload_string_list(payload: &Map<String, Value>, key: &str) -> Vec<String> {
    payload
        .get(key)
        .and_then(|value| value.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.as_str())
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn payload_number_list(payload: &Map<String, Value>, key: &str) -> Vec<i64> {
    payload
        .get(key)
        .and_then(|value| value.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    if let Some(int) = row.as_i64() {
                        return Some(normalize_time(int));
                    }
                    row.as_f64().map(|num| normalize_time(num.round() as i64))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn payload_points(payload: &Map<String, Value>, key: &str) -> Vec<Point> {
    payload
        .get(key)
        .and_then(|value| value.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let object = row.as_object()?;
                    let x = object.get("x")?.as_f64()?;
                    let y = object.get("y")?.as_f64()?;
                    Some(Point { x, y })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn ensure_page_mut<'a>(state: &'a mut ProjectState, page_id: &str) -> &'a mut PageState {
    state
        .pages
        .entry(page_id.to_string())
        .or_insert_with(|| create_empty_page_state(page_id.to_string()))
}

pub fn sort_events(events: &[TimelineEvent]) -> Vec<TimelineEvent> {
    let mut indexed: Vec<(usize, TimelineEvent)> = events
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, mut event)| {
            event.time = normalize_time(event.time);
            (index, event)
        })
        .collect();

    indexed.sort_by(|(ia, a), (ib, b)| {
        normalize_time(a.time)
            .cmp(&normalize_time(b.time))
            .then_with(|| event_priority(a.event_type).cmp(&event_priority(b.event_type)))
            .then_with(|| ia.cmp(ib))
    });

    indexed.into_iter().map(|(_, event)| event).collect()
}

fn sanitize_stroke_point_times(points: &[Point], raw: &[i64], created_at: i64) -> Option<Vec<i64>> {
    if points.is_empty() || raw.len() != points.len() {
        return None;
    }
    let mut next = Vec::with_capacity(raw.len());
    let mut last = created_at;
    for value in raw {
        let t = normalize_time((*value).max(last).max(created_at));
        next.push(t);
        last = t;
    }
    Some(next)
}

fn apply_page_set(mut state: ProjectState, event: &TimelineEvent) -> ProjectState {
    let payload = payload_as_object(event);
    let page_id = event
        .target_id
        .clone()
        .or_else(|| payload.and_then(|obj| payload_string(obj, "pageId")))
        .or_else(|| {
            if event.page_id.is_empty() {
                None
            } else {
                Some(event.page_id.clone())
            }
        })
        .unwrap_or_else(|| state.current_page_id.clone());
    if page_id.is_empty() {
        return state;
    }

    if !state.pages.contains_key(&page_id) {
        state
            .pages
            .insert(page_id.clone(), create_empty_page_state(page_id.clone()));
    }
    state.current_page_id = page_id;
    state
}

fn apply_stroke_create(mut state: ProjectState, event: &TimelineEvent) -> ProjectState {
    let page_id = if event.page_id.is_empty() {
        state.current_page_id.clone()
    } else {
        event.page_id.clone()
    };
    let page = ensure_page_mut(&mut state, &page_id);
    let payload = payload_as_object(event);
    let points = payload
        .map(|obj| payload_points(obj, "points"))
        .unwrap_or_default();
    let point_times_raw = payload
        .map(|obj| payload_number_list(obj, "pointTimes"))
        .unwrap_or_default();
    let created_at = normalize_time(event.time);
    let point_times = sanitize_stroke_point_times(&points, &point_times_raw, created_at);

    let stroke_id = event
        .target_id
        .clone()
        .or_else(|| payload.and_then(|obj| payload_string(obj, "id")))
        .unwrap_or_else(|| event.id.clone());

    let color = payload
        .and_then(|obj| payload_string(obj, "color"))
        .unwrap_or_else(|| "#111111".to_string());
    let width = payload
        .and_then(|obj| payload_number(obj, "width"))
        .unwrap_or(2.0);

    page.strokes.insert(
        stroke_id.clone(),
        Stroke {
            id: stroke_id,
            points,
            point_times,
            color,
            width,
            created_at,
            deleted_at: None,
        },
    );
    state
}

fn resolve_stroke_ids(page: &PageState, event: &TimelineEvent) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    if let Some(target) = &event.target_id {
        if !target.is_empty() {
            ids.push(target.clone());
        }
    }
    if let Some(payload) = payload_as_object(event) {
        if let Some(id) = payload_string(payload, "strokeId") {
            ids.push(id);
        }
        ids.extend(payload_string_list(payload, "strokeIds"));
    }
    let mut unique = HashSet::new();
    ids.into_iter()
        .filter(|id| page.strokes.contains_key(id))
        .filter(|id| unique.insert(id.clone()))
        .collect()
}

fn apply_stroke_erase(mut state: ProjectState, event: &TimelineEvent) -> ProjectState {
    let page_id = if event.page_id.is_empty() {
        state.current_page_id.clone()
    } else {
        event.page_id.clone()
    };
    let page = ensure_page_mut(&mut state, &page_id);
    let stroke_ids = resolve_stroke_ids(page, event);
    if stroke_ids.is_empty() {
        return state;
    }
    let erase_time = normalize_time(event.time);
    for stroke_id in stroke_ids {
        if let Some(current) = page.strokes.get_mut(&stroke_id) {
            let effective = erase_time.max(current.created_at);
            current.deleted_at = Some(match current.deleted_at {
                Some(existing) => existing.min(effective),
                None => effective,
            });
        }
    }
    state
}

fn resolve_object_type(payload: Option<&Map<String, Value>>) -> WhiteboardObjectType {
    let raw = payload
        .and_then(|obj| payload_string(obj, "type"))
        .unwrap_or_else(|| "rect".to_string())
        .to_lowercase();
    match raw.as_str() {
        "rect" => WhiteboardObjectType::Rect,
        _ => WhiteboardObjectType::Rect,
    }
}

fn apply_object_create(mut state: ProjectState, event: &TimelineEvent) -> ProjectState {
    let page_id = if event.page_id.is_empty() {
        state.current_page_id.clone()
    } else {
        event.page_id.clone()
    };
    let page = ensure_page_mut(&mut state, &page_id);
    let payload = payload_as_object(event);
    let object_id = event
        .target_id
        .clone()
        .or_else(|| payload.and_then(|obj| payload_string(obj, "id")))
        .unwrap_or_else(|| event.id.clone());

    let style = payload
        .and_then(|obj| payload_object(obj, "style"))
        .map(|object| object.clone());

    page.objects.insert(
        object_id.clone(),
        WhiteboardObject {
            id: object_id,
            object_type: resolve_object_type(payload),
            x: payload
                .and_then(|obj| payload_number(obj, "x"))
                .unwrap_or(0.0),
            y: payload
                .and_then(|obj| payload_number(obj, "y"))
                .unwrap_or(0.0),
            width: payload
                .and_then(|obj| payload_number(obj, "width"))
                .unwrap_or(100.0),
            height: payload
                .and_then(|obj| payload_number(obj, "height"))
                .unwrap_or(70.0),
            rotation: payload.and_then(|obj| payload_number(obj, "rotation")),
            style,
            created_at: normalize_time(event.time),
            deleted_at: None,
        },
    );

    state
}

fn apply_object_update(mut state: ProjectState, event: &TimelineEvent) -> ProjectState {
    let page_id = if event.page_id.is_empty() {
        state.current_page_id.clone()
    } else {
        event.page_id.clone()
    };
    let page = ensure_page_mut(&mut state, &page_id);
    let payload = payload_as_object(event);
    let target_id = event
        .target_id
        .clone()
        .or_else(|| payload.and_then(|obj| payload_string(obj, "id")));

    let Some(target) = target_id else {
        return state;
    };
    let Some(current) = page.objects.get_mut(&target) else {
        return state;
    };

    let transform = payload.and_then(|obj| payload_object(obj, "transform"));
    let x = transform
        .and_then(|obj| payload_number(obj, "x"))
        .or_else(|| payload.and_then(|obj| payload_number(obj, "x")));
    let y = transform
        .and_then(|obj| payload_number(obj, "y"))
        .or_else(|| payload.and_then(|obj| payload_number(obj, "y")));
    let width = transform
        .and_then(|obj| payload_number(obj, "width"))
        .or_else(|| payload.and_then(|obj| payload_number(obj, "width")));
    let height = transform
        .and_then(|obj| payload_number(obj, "height"))
        .or_else(|| payload.and_then(|obj| payload_number(obj, "height")));
    let rotation = transform
        .and_then(|obj| payload_number(obj, "rotation"))
        .or_else(|| payload.and_then(|obj| payload_number(obj, "rotation")));

    if let Some(value) = x {
        current.x = value;
    }
    if let Some(value) = y {
        current.y = value;
    }
    if let Some(value) = width {
        current.width = value;
    }
    if let Some(value) = height {
        current.height = value;
    }
    if let Some(value) = rotation {
        current.rotation = Some(value);
    }

    if let Some(style_patch) = payload.and_then(|obj| payload_object(obj, "style")) {
        let mut merged = current.style.clone().unwrap_or_default();
        for (key, value) in style_patch {
            merged.insert(key.clone(), value.clone());
        }
        current.style = Some(merged);
    }

    state
}

fn resolve_object_ids(page: &PageState, event: &TimelineEvent) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    if let Some(target) = &event.target_id {
        if !target.is_empty() {
            ids.push(target.clone());
        }
    }
    if let Some(payload) = payload_as_object(event) {
        if let Some(id) = payload_string(payload, "objectId") {
            ids.push(id);
        }
        ids.extend(payload_string_list(payload, "objectIds"));
    }
    let mut unique = HashSet::new();
    ids.into_iter()
        .filter(|id| page.objects.contains_key(id))
        .filter(|id| unique.insert(id.clone()))
        .collect()
}

fn apply_object_delete(mut state: ProjectState, event: &TimelineEvent) -> ProjectState {
    let page_id = if event.page_id.is_empty() {
        state.current_page_id.clone()
    } else {
        event.page_id.clone()
    };
    let page = ensure_page_mut(&mut state, &page_id);
    let target_ids = resolve_object_ids(page, event);
    if target_ids.is_empty() {
        return state;
    }
    let delete_time = normalize_time(event.time);
    for object_id in target_ids {
        if let Some(current) = page.objects.get_mut(&object_id) {
            let effective = delete_time.max(current.created_at);
            current.deleted_at = Some(match current.deleted_at {
                Some(existing) => existing.min(effective),
                None => effective,
            });
        }
    }
    state
}

fn apply_viewport_set(mut state: ProjectState, event: &TimelineEvent) -> ProjectState {
    let page_id = if event.page_id.is_empty() {
        state.current_page_id.clone()
    } else {
        event.page_id.clone()
    };
    let page = ensure_page_mut(&mut state, &page_id);
    if let Some(payload) = payload_as_object(event) {
        if let Some(value) = payload_number(payload, "x") {
            page.viewport.x = value;
        }
        if let Some(value) = payload_number(payload, "y") {
            page.viewport.y = value;
        }
        if let Some(value) = payload_number(payload, "zoom") {
            page.viewport.zoom = value;
        }
    }
    state
}

pub fn apply_event(state: &ProjectState, event: &TimelineEvent) -> ProjectState {
    match event.event_type {
        TimelineEventType::PageSet => apply_page_set(state.clone(), event),
        TimelineEventType::StrokeCreate => apply_stroke_create(state.clone(), event),
        TimelineEventType::StrokeErase => apply_stroke_erase(state.clone(), event),
        TimelineEventType::ObjectCreate => apply_object_create(state.clone(), event),
        TimelineEventType::ObjectUpdate => apply_object_update(state.clone(), event),
        TimelineEventType::ObjectDelete => apply_object_delete(state.clone(), event),
        TimelineEventType::ViewportSet => apply_viewport_set(state.clone(), event),
    }
}

pub fn apply_events(initial_state: &ProjectState, events: &[TimelineEvent]) -> ProjectState {
    sort_events(events)
        .iter()
        .fold(initial_state.clone(), |acc, event| apply_event(&acc, event))
}

pub fn get_state_at_time(
    initial_state: &ProjectState,
    events: &[TimelineEvent],
    time: i64,
) -> ProjectState {
    let target = normalize_time(time);
    let visible = sort_events(events)
        .into_iter()
        .filter(|event| normalize_time(event.time) <= target)
        .collect::<Vec<_>>();
    apply_events(initial_state, &visible)
}

fn stroke_event_end_time(event: &TimelineEvent) -> i64 {
    if event.event_type != TimelineEventType::StrokeCreate {
        return normalize_time(event.time);
    }
    let Some(payload) = payload_as_object(event) else {
        return normalize_time(event.time);
    };
    let point_times = payload_number_list(payload, "pointTimes");
    if point_times.is_empty() {
        return normalize_time(event.time);
    }
    point_times
        .into_iter()
        .max()
        .unwrap_or_else(|| normalize_time(event.time))
}

pub fn get_event_end_time(event: &TimelineEvent) -> i64 {
    if event.event_type == TimelineEventType::StrokeCreate {
        return stroke_event_end_time(event);
    }
    normalize_time(event.time)
}

fn shift_stroke_point_times(event: &TimelineEvent, delta: i64) -> TimelineEvent {
    if event.event_type != TimelineEventType::StrokeCreate || delta == 0 {
        return event.clone();
    }
    let Some(payload) = payload_as_object(event) else {
        return event.clone();
    };
    let point_times = payload_number_list(payload, "pointTimes");
    if point_times.is_empty() {
        return event.clone();
    }
    let mut next_payload = payload.clone();
    next_payload.insert(
        "pointTimes".to_string(),
        Value::Array(
            point_times
                .into_iter()
                .map(|value| Value::from(shift_time(value, delta)))
                .collect(),
        ),
    );
    let mut next = event.clone();
    next.payload = Some(Value::Object(next_payload));
    next
}

fn shift_stroke_point_times_from(
    event: &TimelineEvent,
    from_time: i64,
    delta: i64,
) -> TimelineEvent {
    if event.event_type != TimelineEventType::StrokeCreate || delta == 0 {
        return event.clone();
    }
    let Some(payload) = payload_as_object(event) else {
        return event.clone();
    };
    let point_times = payload_number_list(payload, "pointTimes");
    if point_times.is_empty() {
        return event.clone();
    }
    let from = normalize_time(from_time);
    let mut changed = false;
    let next_times = point_times
        .into_iter()
        .map(|value| {
            if value >= from {
                changed = true;
                shift_time(value, delta)
            } else {
                value
            }
        })
        .collect::<Vec<_>>();
    if !changed {
        return event.clone();
    }
    let mut next_payload = payload.clone();
    next_payload.insert(
        "pointTimes".to_string(),
        Value::Array(next_times.into_iter().map(Value::from).collect()),
    );
    let mut next = event.clone();
    next.payload = Some(Value::Object(next_payload));
    next
}

fn retime_event_keeping_relative_time(event: &TimelineEvent, new_time: i64) -> TimelineEvent {
    let current = normalize_time(event.time);
    let target = normalize_time(new_time);
    if current == target {
        return event.clone();
    }
    let mut next = event.clone();
    next.time = target;
    shift_stroke_point_times(&next, target - current)
}

pub fn insert_event(events: &[TimelineEvent], event: TimelineEvent) -> Vec<TimelineEvent> {
    let mut normalized = event.clone();
    normalized.time = normalize_time(normalized.time);
    let mut next = events
        .iter()
        .filter(|row| row.id != normalized.id)
        .cloned()
        .collect::<Vec<_>>();
    next.push(normalized);
    sort_events(&next)
}

pub fn delete_event(events: &[TimelineEvent], event_id: &str) -> Vec<TimelineEvent> {
    sort_events(
        &events
            .iter()
            .filter(|event| event.id != event_id)
            .cloned()
            .collect::<Vec<_>>(),
    )
}

pub fn delete_time_range(events: &[TimelineEvent], start: i64, end: i64) -> Vec<TimelineEvent> {
    let (range_start, range_end) = normalize_range(start, end);
    sort_events(
        &events
            .iter()
            .filter(|event| event.time < range_start || event.time > range_end)
            .cloned()
            .collect::<Vec<_>>(),
    )
}

pub fn ripple_delete_time_range(
    events: &[TimelineEvent],
    start: i64,
    end: i64,
) -> Vec<TimelineEvent> {
    let (range_start, range_end) = normalize_range(start, end);
    let duration = timeline_duration(range_start, range_end);
    let kept = events
        .iter()
        .filter(|event| event.time < range_start || event.time >= range_end)
        .cloned()
        .collect::<Vec<_>>();
    if duration <= 0 {
        return sort_events(&kept);
    }
    sort_events(
        &kept
            .into_iter()
            .map(|event| {
                if event.time >= range_end {
                    retime_event_keeping_relative_time(&event, shift_time(event.time, -duration))
                } else {
                    event
                }
            })
            .collect::<Vec<_>>(),
    )
}

pub fn split_timeline(events: &[TimelineEvent], time: i64) -> TimelineSplit {
    let pivot = normalize_time(time);
    let sorted = sort_events(events);
    let left = sorted
        .iter()
        .filter(|event| event.time <= pivot)
        .cloned()
        .collect::<Vec<_>>();
    let right = sorted
        .iter()
        .filter(|event| event.time > pivot)
        .map(|event| retime_event_keeping_relative_time(event, shift_time(event.time, -pivot)))
        .collect::<Vec<_>>();
    TimelineSplit { left, right }
}

pub fn move_event(events: &[TimelineEvent], event_id: &str, new_time: i64) -> Vec<TimelineEvent> {
    let target = normalize_time(new_time);
    sort_events(
        &events
            .iter()
            .map(|event| {
                if event.id == event_id {
                    retime_event_keeping_relative_time(event, target)
                } else {
                    event.clone()
                }
            })
            .collect::<Vec<_>>(),
    )
}

pub fn insert_time_gap(
    events: &[TimelineEvent],
    start_time: i64,
    duration: i64,
    event_ids: Option<&[String]>,
) -> Vec<TimelineEvent> {
    let from = normalize_time(start_time);
    let delta = normalize_time(duration);
    if delta <= 0 {
        return sort_events(events);
    }
    let selected: Option<HashSet<String>> = event_ids.map(|ids| ids.iter().cloned().collect());

    sort_events(
        &events
            .iter()
            .map(|event| {
                if let Some(only) = &selected {
                    if !only.contains(&event.id) {
                        return event.clone();
                    }
                }
                if event.time >= from {
                    return retime_event_keeping_relative_time(
                        event,
                        shift_time(event.time, delta),
                    );
                }
                shift_stroke_point_times_from(event, from, delta)
            })
            .collect::<Vec<_>>(),
    )
}

pub fn timeline_max_time(events: &[TimelineEvent]) -> i64 {
    events.iter().map(get_event_end_time).max().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_core::types::create_initial_project_state;

    fn make_event(id: &str, event_type: TimelineEventType, time: i64) -> TimelineEvent {
        TimelineEvent {
            id: id.to_string(),
            project_id: "p".to_string(),
            page_id: "page-1".to_string(),
            actor_id: "a".to_string(),
            time,
            event_type,
            target_id: None,
            payload: None,
        }
    }

    #[test]
    fn ripple_delete_shifts_future_events() {
        let events = vec![
            make_event("e1", TimelineEventType::ViewportSet, 100),
            make_event("e2", TimelineEventType::ViewportSet, 300),
            make_event("e3", TimelineEventType::ViewportSet, 600),
        ];
        let next = ripple_delete_time_range(&events, 200, 400);
        let times = next.iter().map(|event| event.time).collect::<Vec<_>>();
        assert_eq!(times, vec![100, 400]);
    }

    #[test]
    fn move_event_keeps_stroke_relative_times() {
        let mut stroke = make_event("s1", TimelineEventType::StrokeCreate, 500);
        stroke.payload = Some(serde_json::json!({
          "points": [{"x": 0, "y": 0}, {"x": 10, "y": 10}],
          "pointTimes": [500, 620],
          "color": "#000000",
          "width": 2
        }));

        let moved = move_event(&vec![stroke], "s1", 800);
        let payload = moved[0].payload.as_ref().unwrap().as_object().unwrap();
        let point_times = payload
            .get("pointTimes")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_i64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(moved[0].time, 800);
        assert_eq!(point_times, vec![800, 920]);
    }

    #[test]
    fn apply_stroke_create_then_erase() {
        let mut create = make_event("s1", TimelineEventType::StrokeCreate, 120);
        create.target_id = Some("stroke-1".to_string());
        create.payload = Some(serde_json::json!({
          "points": [{"x": 0, "y": 0}, {"x": 12, "y": 8}],
          "pointTimes": [120, 220],
          "color": "#ff0000",
          "width": 3
        }));

        let mut erase = make_event("e1", TimelineEventType::StrokeErase, 300);
        erase.target_id = Some("stroke-1".to_string());

        let state = apply_events(
            &create_initial_project_state("p", "page-1"),
            &vec![create, erase],
        );
        let stroke = state.pages["page-1"].strokes.get("stroke-1").unwrap();
        assert_eq!(stroke.deleted_at, Some(300));
    }

    #[test]
    fn get_state_at_time_filters_future_events() {
        let e1 = make_event("e1", TimelineEventType::ViewportSet, 100);
        let mut e2 = make_event("e2", TimelineEventType::ViewportSet, 400);
        e2.payload = Some(serde_json::json!({ "x": 20, "y": 0, "zoom": 1 }));
        let state = get_state_at_time(
            &create_initial_project_state("p", "page-1"),
            &vec![e1, e2],
            200,
        );
        assert_eq!(state.pages["page-1"].viewport.x, 0.0);
    }

    #[test]
    fn split_timeline_moves_right_part_to_zero_based_time() {
        let events = vec![
            make_event("e1", TimelineEventType::ViewportSet, 100),
            make_event("e2", TimelineEventType::ViewportSet, 350),
            make_event("e3", TimelineEventType::ViewportSet, 700),
        ];
        let split = split_timeline(&events, 350);
        let right_times = split
            .right
            .iter()
            .map(|event| event.time)
            .collect::<Vec<_>>();
        assert_eq!(split.left.len(), 2);
        assert_eq!(right_times, vec![350]);
    }

    #[test]
    fn delete_time_range_removes_middle_events() {
        let events = vec![
            make_event("e1", TimelineEventType::ViewportSet, 100),
            make_event("e2", TimelineEventType::ViewportSet, 260),
            make_event("e3", TimelineEventType::ViewportSet, 480),
        ];
        let next = delete_time_range(&events, 120, 300);
        let ids = next.iter().map(|event| event.id.as_str()).collect::<Vec<_>>();
        assert_eq!(ids, vec!["e1", "e3"]);
    }

    #[test]
    fn insert_time_gap_shifts_only_selected_events() {
        let events = vec![
            make_event("e1", TimelineEventType::ViewportSet, 100),
            make_event("e2", TimelineEventType::ViewportSet, 260),
            make_event("e3", TimelineEventType::ViewportSet, 480),
        ];
        let next = insert_time_gap(&events, 220, 120, Some(&["e3".to_string()]));
        let times = next.iter().map(|event| event.time).collect::<Vec<_>>();
        assert_eq!(times, vec![100, 260, 600]);
        assert_eq!(timeline_max_time(&next), 600);
    }
}
