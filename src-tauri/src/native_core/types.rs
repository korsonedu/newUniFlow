use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TimelineEventType {
    StrokeCreate,
    StrokeErase,
    ObjectCreate,
    ObjectUpdate,
    ObjectDelete,
    ViewportSet,
    PageSet,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEvent {
    pub id: String,
    pub project_id: String,
    pub page_id: String,
    pub actor_id: String,
    pub time: i64,
    #[serde(rename = "type")]
    pub event_type: TimelineEventType,
    pub target_id: Option<String>,
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stroke {
    pub id: String,
    pub points: Vec<Point>,
    pub point_times: Option<Vec<i64>>,
    pub color: String,
    pub width: f64,
    pub created_at: i64,
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WhiteboardObjectType {
    Rect,
}

impl Default for WhiteboardObjectType {
    fn default() -> Self {
        WhiteboardObjectType::Rect
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WhiteboardObject {
    pub id: String,
    #[serde(default, rename = "type")]
    pub object_type: WhiteboardObjectType,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: Option<f64>,
    pub style: Option<Map<String, Value>>,
    pub created_at: i64,
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ViewportState {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageState {
    pub id: String,
    pub strokes: HashMap<String, Stroke>,
    pub objects: HashMap<String, WhiteboardObject>,
    pub viewport: ViewportState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectState {
    pub id: String,
    pub pages: HashMap<String, PageState>,
    pub current_page_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSplit {
    pub left: Vec<TimelineEvent>,
    pub right: Vec<TimelineEvent>,
}

pub fn create_empty_page_state(id: impl Into<String>) -> PageState {
    PageState {
        id: id.into(),
        strokes: HashMap::new(),
        objects: HashMap::new(),
        viewport: ViewportState {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
        },
    }
}

#[allow(dead_code)]
pub fn create_initial_project_state(
    project_id: impl Into<String>,
    page_id: impl Into<String>,
) -> ProjectState {
    let pid = project_id.into();
    let first_page_id = page_id.into();
    let mut pages = HashMap::new();
    pages.insert(
        first_page_id.clone(),
        create_empty_page_state(first_page_id.clone()),
    );
    ProjectState {
        id: pid,
        pages,
        current_page_id: first_page_id,
    }
}
