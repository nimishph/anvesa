use thiserror::Error;

#[derive(Error, Debug, PartialEq, Eq, Clone)]
pub enum CoreError {
    #[error("Vector dimension mismatch: expected {expected}, got {actual}")]
    DimensionMismatch { expected: usize, actual: usize },

    #[error("Vector cannot be normalized: vector has zero or non-finite length")]
    ZeroLengthVector,

    #[error("Invalid buffer length: buffer size {actual_bytes} bytes is not a multiple of {expected_stride} bytes")]
    InvalidBufferLength {
        actual_bytes: usize,
        expected_stride: usize,
    },

    #[error("Invalid parameter: {param} - {reason}")]
    InvalidParameter {
        param: &'static str,
        reason: String,
    },
}
