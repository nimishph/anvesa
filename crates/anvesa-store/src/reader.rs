use std::path::Path;
use rusqlite::{params, Connection, OpenFlags};
use crate::errors::StoreError;
use crate::models::{CallEdge, IndexStats, StoredHit, SymbolRow};

pub struct IndexReader {
    conn: Connection,
}

impl IndexReader {
    /// Opens an existing Anvesa SQLite index database in read-only mode with WAL support.
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, StoreError> {
        let p = path.as_ref();
        if !p.exists() {
            return Err(StoreError::NotFound(p.display().to_string()));
        }

        let conn = Connection::open_with_flags(
            p,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )?;

        // Pragmas for fast read performance
        conn.execute_batch(
            "PRAGMA busy_timeout = 5000;
             PRAGMA cache_size = -32000;
             PRAGMA mmap_size = 268435456;
             PRAGMA query_only = ON;",
        )?;

        Ok(Self { conn })
    }

    /// Opens an in-memory database for testing or ephemeral staging.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        Ok(Self { conn })
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    pub fn connection_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    /// High-performance native vector scan directly over SQLite BLOB storage.
    /// Evaluates all candidate vectors in native C memory via SIMD without row-by-row crossing into JS.
    pub fn search_vectors(
        &self,
        channel: &str,
        model: &str,
        query: &[f32],
        limit: usize,
    ) -> Result<Vec<StoredHit>, StoreError> {
        let dims = query.len();
        let byte_stride = dims * 4;

        let mut stmt = self.conn.prepare(
            "SELECT id, group_key, dims, vector, card FROM cards WHERE channel = ?1 AND model = ?2",
        )?;

        struct ScoredCandidate {
            id: String,
            group_key: String,
            score: f64,
            card_raw: String,
        }

        // Min-heap for bounded top-k
        let mut candidates: Vec<ScoredCandidate> = Vec::new();

        let mut rows = stmt.query(params![channel, model])?;
        while let Some(row) = rows.next()? {
            let row_dims: usize = row.get(2)?;
            if row_dims != dims {
                continue;
            }

            let blob: Vec<u8> = row.get(3)?;
            if blob.len() != byte_stride {
                continue;
            }

            let floats = unsafe {
                std::slice::from_raw_parts(blob.as_ptr() as *const f32, dims)
            };

            let score = anvesa_core::dot_product_core(query, floats, dims) as f64;

            let id: String = row.get(0)?;
            let group_key: String = row.get(1)?;
            let card_raw: String = row.get(4)?;

            candidates.push(ScoredCandidate {
                id,
                group_key,
                score,
                card_raw,
            });
        }

        // Sort descending by score
        candidates.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        // Take top `limit` and parse JSON cards
        let mut hits = Vec::with_capacity(limit.min(candidates.len()));
        for c in candidates.into_iter().take(limit) {
            let card_json: serde_json::Value = serde_json::from_str(&c.card_raw)
                .unwrap_or_else(|_| serde_json::Value::String(c.card_raw));

            hits.push(StoredHit {
                id: c.id,
                score: c.score,
                group_key: c.group_key,
                card: card_json,
            });
        }

        Ok(hits)
    }

    /// Finds symbol definitions by exact or prefix name.
    pub fn find_symbols(&self, name: &str) -> Result<Vec<SymbolRow>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT path, id, name, kind, start_line, end_line, signature, doc 
             FROM symbols 
             WHERE name = ?1 OR base_name = ?1
             ORDER BY path, seq",
        )?;

        let rows = stmt.query_map(params![name], |row| {
            Ok(SymbolRow {
                path: row.get(0)?,
                id: row.get(1)?,
                name: row.get(2)?,
                kind: row.get(3)?,
                start_line: row.get(4)?,
                end_line: row.get(5)?,
                signature: row.get(6)?,
                doc: row.get(7)?,
            })
        })?;

        let mut results = Vec::new();
        for r in rows {
            results.push(r?);
        }
        Ok(results)
    }

    /// Finds symbols that call the given symbol name.
    pub fn find_callers(&self, symbol_name: &str) -> Result<Vec<CallEdge>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT source_path, from_ref, to_ref, kind 
             FROM edges 
             WHERE to_ref LIKE ?1 AND kind = 'calls'
             ORDER BY source_path, seq",
        )?;

        let pattern = format!("%{}", symbol_name);
        let rows = stmt.query_map(params![pattern], |row| {
            Ok(CallEdge {
                source_path: row.get(0)?,
                from_ref: row.get(1)?,
                to_ref: row.get(2)?,
                kind: row.get(3)?,
            })
        })?;

        let mut results = Vec::new();
        for r in rows {
            results.push(r?);
        }
        Ok(results)
    }

    /// Finds files that import or depend on the given path (blast radius).
    pub fn find_dependents(&self, file_path: &str) -> Result<Vec<String>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT path 
             FROM imports 
             WHERE specifier LIKE ?1
             ORDER BY path",
        )?;

        let pattern = format!("%{}", file_path);
        let rows = stmt.query_map(params![pattern], |row| row.get(0))?;

        let mut results = Vec::new();
        for r in rows {
            results.push(r?);
        }
        Ok(results)
    }

    /// Gathers structural and vector counts across the entire index.
    pub fn get_stats(&self) -> Result<IndexStats, StoreError> {
        let files: u64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))
            .unwrap_or(0);

        let symbols: u64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM symbols", [], |r| r.get(0))
            .unwrap_or(0);

        let calls: u64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM calls", [], |r| r.get(0))
            .unwrap_or(0);

        let cards: u64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM cards", [], |r| r.get(0))
            .unwrap_or(0);

        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT channel FROM cards ORDER BY channel")?;
        let channels_res = stmt.query_map([], |r| r.get(0))?;

        let mut channels = Vec::new();
        for ch in channels_res {
            if let Ok(c) = ch {
                channels.push(c);
            }
        }

        Ok(IndexStats {
            files,
            symbols,
            calls,
            cards,
            channels,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_test_db() -> IndexReader {
        let reader = IndexReader::open_in_memory().unwrap();
        reader
            .conn
            .execute_batch(
                "CREATE TABLE cards (
                    channel TEXT, id TEXT, path TEXT, model TEXT,
                    group_key TEXT, card TEXT, dims INTEGER, vector BLOB,
                    PRIMARY KEY (channel, id)
                );
                CREATE TABLE symbols (
                    path TEXT, seq INTEGER, id TEXT, name TEXT, base_name TEXT,
                    kind TEXT, parent_id TEXT, exported INTEGER, start_line INTEGER,
                    end_line INTEGER, signature TEXT, doc TEXT,
                    PRIMARY KEY (path, seq)
                );
                CREATE TABLE calls (
                    path TEXT, seq INTEGER, from_symbol TEXT, name TEXT,
                    receiver_kind TEXT, receiver_name TEXT, kind TEXT, line INTEGER,
                    PRIMARY KEY (path, seq)
                );
                CREATE TABLE imports (
                    path TEXT, seq INTEGER, specifier TEXT, kind TEXT,
                    relative INTEGER, type_only INTEGER, bindings TEXT, line INTEGER,
                    PRIMARY KEY (path, seq)
                );
                CREATE TABLE edges (
                    source_path TEXT, seq INTEGER, from_ref TEXT, to_ref TEXT, kind TEXT,
                    PRIMARY KEY (source_path, seq)
                );
                CREATE TABLE files (
                    path TEXT PRIMARY KEY, language TEXT, package_root TEXT, repo TEXT,
                    size INTEGER, mtime_ms REAL, content_hash TEXT, has_syntax_errors INTEGER,
                    imports_supported INTEGER, unnamed_calls INTEGER, computed_imports INTEGER
                );",
            )
            .unwrap();
        reader
    }

    #[test]
    fn test_search_vectors_native() {
        let reader = setup_test_db();
        let _dims = 4;
        let v1 = vec![1.0f32, 0.0, 0.0, 0.0];
        let v2 = vec![0.0f32, 1.0, 0.0, 0.0];
        let v3 = vec![0.7071f32, 0.7071, 0.0, 0.0];

        let b1: Vec<u8> = v1.iter().flat_map(|f| f.to_ne_bytes()).collect();
        let b2: Vec<u8> = v2.iter().flat_map(|f| f.to_ne_bytes()).collect();
        let b3: Vec<u8> = v3.iter().flat_map(|f| f.to_ne_bytes()).collect();

        reader
            .conn
            .execute(
                "INSERT INTO cards VALUES ('symbols', 'c1', 'a.ts', 'minilm', 'g1', '{\"text\":\"card1\"}', 4, ?1)",
                params![b1],
            )
            .unwrap();
        reader
            .conn
            .execute(
                "INSERT INTO cards VALUES ('symbols', 'c2', 'b.ts', 'minilm', 'g2', '{\"text\":\"card2\"}', 4, ?1)",
                params![b2],
            )
            .unwrap();
        reader
            .conn
            .execute(
                "INSERT INTO cards VALUES ('symbols', 'c3', 'c.ts', 'minilm', 'g3', '{\"text\":\"card3\"}', 4, ?1)",
                params![b3],
            )
            .unwrap();

        let query = vec![1.0f32, 0.0, 0.0, 0.0];
        let hits = reader
            .search_vectors("symbols", "minilm", &query, 2)
            .unwrap();

        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].id, "c1");
        assert!((hits[0].score - 1.0).abs() < 1e-4);
        assert_eq!(hits[1].id, "c3");
        assert!((hits[1].score - 0.7071).abs() < 1e-4);
    }
}
