pub mod errors;
pub mod fusion;
pub mod primer;
pub mod top_k;
pub mod vector;

pub use errors::CoreError;
pub use fusion::{fuse, Contribution, Fused, Lane, LaneHit, DEFAULT_RRF_K};
pub use primer::{get_primer_topic, list_primer_topics, PrimerTopicInfo, PRIMER_TOPICS};
pub use top_k::{ScoredIndex, TopKCollector};
pub use vector::{
    batch_dot_product, batch_scan_top_k, dot_product_core, dot_product_simd, normalize_simd,
};
