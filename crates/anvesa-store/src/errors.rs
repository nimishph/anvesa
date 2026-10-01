use thiserror::Error;

#[derive(Error, Debug)]
pub enum StoreError {
    #[error("SQLite database error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("Serialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Index corrupt: {channel}/{id} - {reason}")]
    Corrupt {
        channel: String,
        id: String,
        reason: String,
    },

    #[error("Vector dimension mismatch: expected {expected}, got {actual}")]
    DimensionMismatch { expected: usize, actual: usize },

    #[error("Store not found at {0}")]
    NotFound(String),
}
