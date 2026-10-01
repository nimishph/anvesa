use std::collections::{HashMap, HashSet};
use serde::{Deserialize, Serialize};

pub const DEFAULT_RRF_K: u32 = 60;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LaneHit<T> {
    pub key: String,
    pub item: T,
    pub score: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Lane<T> {
    pub name: String,
    pub weight: f64,
    pub hits: Vec<LaneHit<T>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Contribution {
    pub lane: String,
    pub rank: u32,
    pub weight: f64,
    pub score: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Fused<T> {
    pub key: String,
    pub item: T,
    pub score: f64,
    pub best_score: Option<f64>,
    pub found_by: Vec<Contribution>,
}

struct CombinedEntry<T> {
    item: T,
    score: f64,
    found_by: Vec<Contribution>,
}

/// Fuses multiple ranked lists ("lanes") using Reciprocal Rank Fusion (RRF).
/// Formula: sum_{lane} (weight / (k + rank))
pub fn fuse<T: Clone>(lanes: &[Lane<T>], k: u32) -> Vec<Fused<T>> {
    let mut combined: HashMap<String, CombinedEntry<T>> = HashMap::new();

    for lane in lanes {
        if lane.weight <= 0.0 {
            continue;
        }

        let mut counted: HashSet<String> = HashSet::new();
        let mut rank = 0u32;

        for hit in &lane.hits {
            if counted.contains(&hit.key) {
                continue;
            }
            counted.insert(hit.key.clone());
            rank += 1;

            let weight = lane.weight;
            let contribution_score = weight / ((k + rank) as f64);

            let entry = combined.entry(hit.key.clone()).or_insert_with(|| CombinedEntry {
                item: hit.item.clone(),
                score: 0.0,
                found_by: Vec::new(),
            });

            entry.score += contribution_score;
            entry.found_by.push(Contribution {
                lane: lane.name.clone(),
                rank,
                weight,
                score: hit.score,
            });
        }
    }

    let mut results: Vec<Fused<T>> = combined
        .into_iter()
        .map(|(key, entry)| {
            let best_score = entry
                .found_by
                .iter()
                .filter_map(|c| c.score)
                .fold(None, |acc: Option<f64>, s| match acc {
                    Some(prev) => Some(prev.max(s)),
                    None => Some(s),
                });

            Fused {
                key,
                item: entry.item,
                score: entry.score,
                best_score,
                found_by: entry.found_by,
            }
        })
        .collect();

    results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                let a_raw = a.best_score.unwrap_or(f64::NEG_INFINITY);
                let b_raw = b.best_score.unwrap_or(f64::NEG_INFINITY);
                b_raw
                    .partial_cmp(&a_raw)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| a.key.cmp(&b.key))
    });

    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reciprocal_rank_fusion() {
        let dense_lane = Lane {
            name: "dense".to_string(),
            weight: 1.0,
            hits: vec![
                LaneHit {
                    key: "card_A".to_string(),
                    item: "Symbol A",
                    score: Some(0.95),
                },
                LaneHit {
                    key: "card_B".to_string(),
                    item: "Symbol B",
                    score: Some(0.85),
                },
            ],
        };

        let structural_lane = Lane {
            name: "structural".to_string(),
            weight: 1.0,
            hits: vec![
                LaneHit {
                    key: "card_B".to_string(),
                    item: "Symbol B",
                    score: None,
                },
                LaneHit {
                    key: "card_C".to_string(),
                    item: "Symbol C",
                    score: None,
                },
            ],
        };

        let fused = fuse(&[dense_lane, structural_lane], 60);

        // card_B was rank 2 in dense and rank 1 in structural:
        // score = 1/(60+2) + 1/(60+1) = 1/62 + 1/61 = 0.016129 + 0.016393 = 0.032522
        // card_A was rank 1 in dense: 1/61 = 0.016393
        // card_B beats card_A!
        assert_eq!(fused[0].key, "card_B");
        assert_eq!(fused[1].key, "card_A");
        assert_eq!(fused[2].key, "card_C");

        assert_eq!(fused[0].best_score, Some(0.85));
        assert_eq!(fused[1].best_score, Some(0.95));
        assert_eq!(fused[2].best_score, None);
    }
}
