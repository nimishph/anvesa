use std::collections::BinaryHeap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScoredIndex {
    pub index: u32,
    pub score: f64,
}

#[derive(Debug, PartialEq)]
struct MinHeapItem {
    score: f64,
    index: u32,
}

impl Eq for MinHeapItem {}

impl Ord for MinHeapItem {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // Reverse ordering so lowest score sits at the root (min-heap)
        other
            .score
            .partial_cmp(&self.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    }
}

impl PartialOrd for MinHeapItem {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// Bounded min-heap collector that maintains the top-k highest scored items.
#[derive(Debug)]
pub struct TopKCollector {
    limit: usize,
    heap: BinaryHeap<MinHeapItem>,
}

impl TopKCollector {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            heap: BinaryHeap::with_capacity(limit),
        }
    }

    pub fn add(&mut self, index: u32, score: f64) {
        if self.limit == 0 {
            return;
        }

        if self.heap.len() < self.limit {
            self.heap.push(MinHeapItem { score, index });
        } else if let Some(min) = self.heap.peek() {
            if score > min.score {
                self.heap.pop();
                self.heap.push(MinHeapItem { score, index });
            }
        }
    }

    /// Consumes the collector and returns top items sorted descending by score.
    pub fn into_sorted_vec(self) -> Vec<ScoredIndex> {
        let mut items: Vec<ScoredIndex> = self
            .heap
            .into_iter()
            .map(|item| ScoredIndex {
                index: item.index,
                score: item.score,
            })
            .collect();

        items.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        items
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_top_k_collector() {
        let mut collector = TopKCollector::new(3);
        collector.add(0, 0.5);
        collector.add(1, 0.9);
        collector.add(2, 0.1);
        collector.add(3, 0.95);
        collector.add(4, 0.8);

        let results = collector.into_sorted_vec();
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].index, 3);
        assert_eq!(results[0].score, 0.95);
        assert_eq!(results[1].index, 1);
        assert_eq!(results[1].score, 0.9);
        assert_eq!(results[2].index, 4);
        assert_eq!(results[2].score, 0.8);
    }
}
