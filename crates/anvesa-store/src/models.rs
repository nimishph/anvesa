use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredHit {
    pub id: String,
    pub score: f64,
    pub group_key: String,
    pub card: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolRow {
    pub path: String,
    pub id: String,
    pub name: String,
    pub kind: String,
    pub start_line: u32,
    pub end_line: u32,
    pub signature: Option<String>,
    pub doc: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallEdge {
    pub source_path: String,
    pub from_ref: String,
    pub to_ref: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexStats {
    pub files: u64,
    pub symbols: u64,
    pub calls: u64,
    pub cards: u64,
    pub channels: Vec<String>,
}
