pub fn normalize_time(time: i64) -> i64 {
    if time < 0 {
        0
    } else {
        time
    }
}

pub fn normalize_range(start: i64, end: i64) -> (i64, i64) {
    let a = normalize_time(start);
    let b = normalize_time(end);
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

pub fn timeline_duration(start: i64, end: i64) -> i64 {
    let (a, b) = normalize_range(start, end);
    b.saturating_sub(a)
}

pub fn shift_time(time: i64, delta: i64) -> i64 {
    normalize_time(time.saturating_add(delta))
}
