//! Exact vector search over the `card_vectors` table (schema version 9 and later), the native twin of `SqliteVectorStore.#scan`.
//!
//! It must rank exactly as the TypeScript scan does, so the two are interchangeable: the same dot
//! product (`anvesa_core::dot_product_core`, which the TypeScript side also calls when the addon is
//! loaded), the same order (higher score first, equal scores by the earlier id compared as UTF-16,
//! as JavaScript compares strings), the same best-card-per-group collapse, and the same refusal of
//! a vector whose stored length is wrong.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};
use std::path::Path;
use std::time::Instant;

pub use rusqlite::Connection;
use rusqlite::{params, OpenFlags};

use crate::errors::StoreError;

/// How often the scan reads the clock. A pacing interval, not a limit on what is searched.
const DEADLINE_CHECK_EVERY: u64 = 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct ScanHit {
    pub id: String,
    pub score: f64,
}

pub struct ScanOptions<'a> {
    pub channel: &'a str,
    pub model: &'a str,
    /// Already unit length, as the stored vectors are.
    pub query: &'a [f32],
    pub limit: usize,
    /// Keep only the best card of each `group_key`.
    pub collapse: bool,
    pub deadline: Option<Instant>,
}

#[derive(Debug)]
pub enum ScanError {
    Store(StoreError),
    /// A stored vector does not have `dims` floats.
    Corrupt {
        id: String,
        expected_bytes: usize,
        actual_bytes: usize,
    },
    DeadlineExpired,
}

impl From<rusqlite::Error> for ScanError {
    fn from(failure: rusqlite::Error) -> Self {
        ScanError::Store(StoreError::Sqlite(failure))
    }
}

/// Open `path` for scans: read-only, so it can never write to an index another connection owns.
///
/// The file is memory-mapped: read page by page, a scan spends most of its time in one system call
/// per page. Windows refuses to truncate a mapped file, and only VACUUM truncates an index (when a
/// migration runs it, before anything in that process searches), so keep the connection no longer
/// than the writer's own.
pub fn open_for_scan<P: AsRef<Path>>(path: P) -> Result<Connection, StoreError> {
    let path = path.as_ref();
    if !path.exists() {
        return Err(StoreError::NotFound(path.display().to_string()));
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    // SQLite caps the mapping at its compile-time limit and never maps more than the file.
    conn.execute_batch(
        "PRAGMA busy_timeout = 5000; PRAGMA query_only = ON; PRAGMA mmap_size = 2147418112;",
    )?;
    Ok(conn)
}

/// The best `limit` cards of a channel and model, best first.
pub fn scan_vectors(conn: &Connection, options: &ScanOptions) -> Result<Vec<ScanHit>, ScanError> {
    let dims = options.query.len();
    let stride = dims * std::mem::size_of::<f32>();
    let sql = if options.collapse {
        "SELECT id, dims, vector, group_key FROM card_vectors WHERE channel = ?1 AND model = ?2"
    } else {
        "SELECT id, dims, vector FROM card_vectors WHERE channel = ?1 AND model = ?2"
    };
    let mut statement = conn.prepare(sql)?;
    let mut rows = statement.query(params![options.channel, options.model])?;

    // Aligned: a blob's bytes may start at any address.
    let mut scratch = vec![0f32; dims];
    let mut top = TopK::new(options.limit);
    let mut groups: HashMap<String, ScanHit> = HashMap::new();
    let mut seen: u64 = 0;

    while let Some(row) = rows.next()? {
        seen += 1;
        if seen % DEADLINE_CHECK_EVERY == 0 {
            if let Some(deadline) = options.deadline {
                if Instant::now() >= deadline {
                    return Err(ScanError::DeadlineExpired);
                }
            }
        }
        let row_dims: i64 = row.get(1)?;
        let blob = row.get_ref(2)?.as_blob().unwrap_or(&[]);
        if blob.len() != stride || row_dims != dims as i64 {
            return Err(ScanError::Corrupt {
                id: row.get(0)?,
                expected_bytes: stride,
                actual_bytes: blob.len(),
            });
        }
        // SAFETY: `blob` holds exactly `dims` f32 in the machine's byte order (checked above), and
        // `scratch` is a distinct allocation of `dims` f32.
        unsafe {
            std::ptr::copy_nonoverlapping(blob.as_ptr(), scratch.as_mut_ptr().cast::<u8>(), stride);
        }
        let score = anvesa_core::dot_product_core(options.query, &scratch, dims) as f64;

        if options.collapse {
            let group = row.get_ref(3)?.as_str().map_err(rusqlite::Error::from)?;
            match groups.get_mut(group) {
                Some(current) => {
                    if score >= current.score {
                        let id: String = row.get(0)?;
                        let candidate = ScanHit { id, score };
                        if ranked_above(&candidate, current) {
                            *current = candidate;
                        }
                    }
                }
                None => {
                    let id: String = row.get(0)?;
                    groups.insert(group.to_owned(), ScanHit { id, score });
                }
            }
        } else if top.would_keep(score) {
            let id: String = row.get(0)?;
            top.add(ScanHit { id, score });
        }
    }

    if options.collapse {
        for (_, hit) in groups {
            top.add(hit);
        }
    }
    Ok(top.into_sorted())
}

/// Whether `a` outranks `b`: higher score, or on equal scores the earlier id (UTF-16 order).
fn ranked_above(a: &ScanHit, b: &ScanHit) -> bool {
    a.score > b.score || (a.score == b.score && utf16_cmp(&a.id, &b.id) == Ordering::Less)
}

fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// Heap entry ordered so the worst-ranked hit is at the top of a max-heap.
struct Worst(ScanHit);

impl PartialEq for Worst {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Worst {}
impl PartialOrd for Worst {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Worst {
    fn cmp(&self, other: &Self) -> Ordering {
        if ranked_above(&other.0, &self.0) {
            Ordering::Greater
        } else if ranked_above(&self.0, &other.0) {
            Ordering::Less
        } else {
            Ordering::Equal
        }
    }
}

/// A bounded collector of the best `limit` hits.
struct TopK {
    limit: usize,
    heap: BinaryHeap<Worst>,
}

impl TopK {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            heap: BinaryHeap::with_capacity(limit.min(4096)),
        }
    }

    /// Whether a hit with this score could enter, so a loser's id is never read from the row.
    fn would_keep(&self, score: f64) -> bool {
        if self.limit == 0 {
            return false;
        }
        match self.heap.peek() {
            Some(worst) if self.heap.len() >= self.limit => score >= worst.0.score,
            _ => true,
        }
    }

    fn add(&mut self, hit: ScanHit) {
        if self.limit == 0 {
            return;
        }
        if self.heap.len() < self.limit {
            self.heap.push(Worst(hit));
        } else if let Some(worst) = self.heap.peek() {
            if ranked_above(&hit, &worst.0) {
                self.heap.pop();
                self.heap.push(Worst(hit));
            }
        }
    }

    fn into_sorted(self) -> Vec<ScanHit> {
        // A max-heap of "worst" sorts ascending from best to worst.
        self.heap
            .into_sorted_vec()
            .into_iter()
            .map(|w| w.0)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(rows: &[(&str, &str, &[f32])]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE card_vectors (channel TEXT, id TEXT, model TEXT, group_key TEXT, dims INTEGER, vector BLOB)",
        )
        .unwrap();
        for (id, group, vector) in rows {
            let bytes: Vec<u8> = vector.iter().flat_map(|f| f.to_ne_bytes()).collect();
            conn.execute(
                "INSERT INTO card_vectors VALUES ('code', ?1, 'm', ?2, ?3, ?4)",
                params![id, group, vector.len() as i64, bytes],
            )
            .unwrap();
        }
        conn
    }

    fn scan(conn: &Connection, limit: usize, collapse: bool) -> Result<Vec<ScanHit>, ScanError> {
        scan_vectors(
            conn,
            &ScanOptions {
                channel: "code",
                model: "m",
                query: &[1.0, 0.0],
                limit,
                collapse,
                deadline: None,
            },
        )
    }

    fn ids(hits: &[ScanHit]) -> Vec<&str> {
        hits.iter().map(|h| h.id.as_str()).collect()
    }

    #[test]
    fn ranks_best_first_and_breaks_ties_by_id() {
        let conn = store(&[
            ("c", "g1", &[0.5, 0.5]),
            ("a", "g2", &[0.9, 0.1]),
            ("b", "g3", &[0.5, 0.5]),
            ("d", "g4", &[0.1, 0.9]),
        ]);
        assert_eq!(ids(&scan(&conn, 3, false).unwrap()), ["a", "b", "c"]);
        assert_eq!(ids(&scan(&conn, 0, false).unwrap()), Vec::<&str>::new());
    }

    #[test]
    fn collapses_to_the_best_card_of_each_group() {
        let conn = store(&[
            ("a1", "a", &[0.2, 0.8]),
            ("a2", "a", &[0.9, 0.1]),
            ("b1", "b", &[0.5, 0.5]),
        ]);
        assert_eq!(ids(&scan(&conn, 10, true).unwrap()), ["a2", "b1"]);
    }

    #[test]
    fn ties_compare_ids_as_utf16_like_javascript() {
        // U+1F600 sorts after U+FF5E in UTF-8 bytes, but before it in UTF-16 (a surrogate pair).
        let conn = store(&[
            ("\u{FF5E}", "g1", &[1.0, 0.0]),
            ("\u{1F600}", "g2", &[1.0, 0.0]),
        ]);
        assert_eq!(
            ids(&scan(&conn, 2, false).unwrap()),
            ["\u{1F600}", "\u{FF5E}"]
        );
    }

    #[test]
    fn refuses_a_vector_of_the_wrong_length() {
        let conn = store(&[("ok", "g", &[1.0, 0.0]), ("bad", "g", &[1.0, 0.0, 0.0])]);
        match scan(&conn, 5, false) {
            Err(ScanError::Corrupt {
                id,
                expected_bytes,
                actual_bytes,
            }) => assert_eq!((id.as_str(), expected_bytes, actual_bytes), ("bad", 8, 12)),
            other => panic!("expected a corrupt row, got {other:?}"),
        }
    }

    #[test]
    fn stops_at_an_expired_deadline() {
        let rows: Vec<(String, [f32; 2])> =
            (0..2048).map(|i| (format!("{i}"), [1.0, 0.0])).collect();
        let borrowed: Vec<(&str, &str, &[f32])> = rows
            .iter()
            .map(|(id, v)| (id.as_str(), "g", &v[..]))
            .collect();
        let conn = store(&borrowed);
        let result = scan_vectors(
            &conn,
            &ScanOptions {
                channel: "code",
                model: "m",
                query: &[1.0, 0.0],
                limit: 5,
                collapse: false,
                deadline: Some(Instant::now()),
            },
        );
        assert!(matches!(result, Err(ScanError::DeadlineExpired)));
    }
}
