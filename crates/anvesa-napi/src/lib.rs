use napi::bindgen_prelude::{Float32Array, Uint8Array};
use napi_derive::napi;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct ScoredIndex {
    pub index: u32,
    pub score: f64,
}

// ----------------------------------------------------------------------------
// VECTOR OPERATIONS (delegated to anvesa-core)
// ----------------------------------------------------------------------------

#[napi]
pub fn dot_product_simd(a: Float32Array, b: Float32Array) -> f64 {
    let a_slice = a.as_ref();
    let b_slice = b.as_ref();
    let len = a_slice.len().min(b_slice.len());
    anvesa_core::dot_product_core(a_slice, b_slice, len) as f64
}

#[napi]
pub fn normalize_simd(vector: Float32Array) -> napi::Result<Float32Array> {
    let v_slice = vector.as_ref();
    match anvesa_core::normalize_simd(v_slice) {
        Ok(out) => Ok(Float32Array::new(out)),
        Err(e) => Err(napi::Error::from_reason(e.to_string())),
    }
}

#[napi]
pub fn batch_scan_top_k(
    query: Float32Array,
    vectors_buffer: Uint8Array,
    dims: u32,
    limit: u32,
) -> napi::Result<Vec<ScoredIndex>> {
    let q_slice = query.as_ref();
    let buf = vectors_buffer.as_ref();

    match anvesa_core::batch_scan_top_k(q_slice, buf, dims as usize, limit as usize) {
        Ok(items) => Ok(items
            .into_iter()
            .map(|item| ScoredIndex {
                index: item.index,
                score: item.score,
            })
            .collect()),
        Err(e) => Err(napi::Error::from_reason(e.to_string())),
    }
}

#[napi]
pub fn batch_dot_product(
    query: Float32Array,
    vectors_buffer: Uint8Array,
    dims: u32,
) -> napi::Result<Float32Array> {
    let q_slice = query.as_ref();
    let buf = vectors_buffer.as_ref();

    match anvesa_core::batch_dot_product(q_slice, buf, dims as usize) {
        Ok(scores) => Ok(Float32Array::new(scores)),
        Err(e) => Err(napi::Error::from_reason(e.to_string())),
    }
}

// ----------------------------------------------------------------------------
// RECIPROCAL RANK FUSION (RRF)
// ----------------------------------------------------------------------------

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiLaneHit {
    pub key: String,
    pub score: Option<f64>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiLane {
    pub name: String,
    pub weight: f64,
    pub hits: Vec<NapiLaneHit>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiContribution {
    pub lane: String,
    pub rank: u32,
    pub weight: f64,
    pub score: Option<f64>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiFusedResult {
    pub key: String,
    pub score: f64,
    pub best_score: Option<f64>,
    pub found_by: Vec<NapiContribution>,
}

#[napi]
pub fn fuse_rankings_native(lanes: Vec<NapiLane>, k: Option<u32>) -> Vec<NapiFusedResult> {
    let k_val = k.unwrap_or(anvesa_core::DEFAULT_RRF_K);
    let core_lanes: Vec<anvesa_core::Lane<()>> = lanes
        .into_iter()
        .map(|l| anvesa_core::Lane {
            name: l.name,
            weight: l.weight,
            hits: l
                .hits
                .into_iter()
                .map(|h| anvesa_core::LaneHit {
                    key: h.key,
                    item: (),
                    score: h.score,
                })
                .collect(),
        })
        .collect();

    let fused = anvesa_core::fuse(&core_lanes, k_val);
    fused
        .into_iter()
        .map(|f| NapiFusedResult {
            key: f.key,
            score: f.score,
            best_score: f.best_score,
            found_by: f
                .found_by
                .into_iter()
                .map(|c| NapiContribution {
                    lane: c.lane,
                    rank: c.rank,
                    weight: c.weight,
                    score: c.score,
                })
                .collect(),
        })
        .collect()
}

// ----------------------------------------------------------------------------
// AST OUTLINE EXTRACTION (delegated to anvesa-syntax)
// ----------------------------------------------------------------------------

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiSymbol {
    pub name: String,
    pub kind: String,
    pub start_line: u32,
    pub end_line: u32,
    pub signature: Option<String>,
    pub doc: Option<String>,
    pub exported: bool,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiCall {
    pub name: String,
    pub line: u32,
    pub kind: String,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiImport {
    pub specifier: String,
    pub kind: String,
    pub line: u32,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiFileOutline {
    pub path: String,
    pub language: String,
    pub symbols: Vec<NapiSymbol>,
    pub calls: Vec<NapiCall>,
    pub imports: Vec<NapiImport>,
    pub has_syntax_errors: bool,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct FileInput {
    pub path: String,
    pub language: String,
    pub source: String,
}

fn map_outline(o: anvesa_syntax::NativeFileOutline) -> NapiFileOutline {
    NapiFileOutline {
        path: o.path,
        language: o.language,
        symbols: o
            .symbols
            .into_iter()
            .map(|s| NapiSymbol {
                name: s.name,
                kind: s.kind,
                start_line: s.start_line,
                end_line: s.end_line,
                signature: s.signature,
                doc: s.doc,
                exported: s.exported,
            })
            .collect(),
        calls: o
            .calls
            .into_iter()
            .map(|c| NapiCall {
                name: c.name,
                line: c.line,
                kind: c.kind,
            })
            .collect(),
        imports: o
            .imports
            .into_iter()
            .map(|i| NapiImport {
                specifier: i.specifier,
                kind: i.kind,
                line: i.line,
            })
            .collect(),
        has_syntax_errors: o.has_syntax_errors,
    }
}

#[napi]
pub fn extract_file_outline_native(
    path: String,
    language: String,
    source: String,
) -> NapiFileOutline {
    let outline = anvesa_syntax::extract_file_outline(&path, &language, &source);
    map_outline(outline)
}

#[napi]
pub fn parse_files_batch_native(files: Vec<FileInput>) -> Vec<NapiFileOutline> {
    let tuples = files
        .into_iter()
        .map(|f| (f.path, f.language, f.source))
        .collect();
    let outlines = anvesa_syntax::parse_files_batch(tuples);
    outlines.into_iter().map(map_outline).collect()
}

// --- outlines from a LanguageMapping ---------------------------------------------------------------

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct NapiEncodeOptions {
    pub path: Option<String>,
    pub docs: Option<bool>,
    pub positions: Option<bool>,
    pub max_depth: Option<u32>,
}

fn encode_options(options: Option<NapiEncodeOptions>) -> anvesa_syntax::outline::EncodeOptions {
    let options = options.unwrap_or_default();
    anvesa_syntax::outline::EncodeOptions {
        path: options.path,
        docs: options.docs.unwrap_or(false),
        positions: options.positions.unwrap_or(false),
        max_depth: options.max_depth,
    }
}

fn parse_mapping(json: &str) -> napi::Result<anvesa_syntax::outline::LanguageMapping> {
    serde_json::from_str(json)
        .map_err(|e| napi::Error::from_reason(format!("the mapping is not valid: {e}")))
}

fn to_json(encoded: &anvesa_syntax::outline::EncodedFile) -> napi::Result<String> {
    serde_json::to_string(encoded).map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Encode one file with a mapping (its JSON, as a mapping file holds it). Returns the encoded
/// file as JSON, or `null` when no grammar for `language` is compiled in.
#[napi]
pub fn encode_outline_native(
    source: String,
    language: String,
    mapping_json: String,
    options: Option<NapiEncodeOptions>,
) -> napi::Result<Option<String>> {
    let mapping = parse_mapping(&mapping_json)?;
    let options = encode_options(options);
    anvesa_syntax::outline::encode_source(&source, &language, &mapping, &options)
        .map(|encoded| to_json(&encoded))
        .transpose()
}

/// Encode many files on every core. `mappings_json` maps language keys to mappings. Each entry
/// is the encoded file as JSON, or `null` for a language with no mapping or compiled grammar.
#[napi]
pub fn encode_outlines_batch_native(
    files: Vec<FileInput>,
    mappings_json: String,
    options: Option<NapiEncodeOptions>,
) -> napi::Result<Vec<Option<String>>> {
    let mappings: std::collections::HashMap<String, anvesa_syntax::outline::LanguageMapping> =
        serde_json::from_str(&mappings_json)
            .map_err(|e| napi::Error::from_reason(format!("the mappings are not valid: {e}")))?;
    let inputs: Vec<anvesa_syntax::OutlineInput> = files
        .into_iter()
        .map(|f| anvesa_syntax::OutlineInput {
            path: f.path,
            language: f.language,
            source: f.source,
        })
        .collect();
    anvesa_syntax::encode_files_batch(&inputs, &mappings, &encode_options(options))
        .iter()
        .map(|encoded| encoded.as_ref().map(to_json).transpose())
        .collect()
}

// --- facts for indexing ----------------------------------------------------------------------------

/// The language keys with a grammar compiled in.
#[napi]
pub fn native_languages() -> Vec<String> {
    anvesa_syntax::NATIVE_LANGUAGES
        .iter()
        .map(|language| language.to_string())
        .collect()
}

/// One parse: the file's outline (with docs and positions) and its facts (symbols, calls, imports,
/// exports, declared types), as JSON; `null` when no grammar for `language` is compiled in.
#[napi]
pub fn extract_facts_native(
    path: String,
    language: String,
    source: String,
    mapping_json: String,
) -> napi::Result<Option<String>> {
    let mapping = parse_mapping(&mapping_json)?;
    anvesa_syntax::facts::extract_file(&path, &language, &source, &mapping)
        .map(|extracted| {
            serde_json::to_string(&extracted).map_err(|e| napi::Error::from_reason(e.to_string()))
        })
        .transpose()
}

/// Many files on every core; `mappings_json` maps language keys to mappings.
#[napi]
pub fn extract_facts_batch_native(
    files: Vec<FileInput>,
    mappings_json: String,
) -> napi::Result<Vec<Option<String>>> {
    use rayon::prelude::*;
    let mappings: std::collections::HashMap<String, anvesa_syntax::outline::LanguageMapping> =
        serde_json::from_str(&mappings_json)
            .map_err(|e| napi::Error::from_reason(format!("the mappings are not valid: {e}")))?;
    files
        .par_iter()
        .map(|file| {
            let Some(mapping) = mappings.get(&file.language) else {
                return Ok(None);
            };
            anvesa_syntax::facts::extract_file(&file.path, &file.language, &file.source, mapping)
                .map(|extracted| {
                    serde_json::to_string(&extracted)
                        .map_err(|e| napi::Error::from_reason(e.to_string()))
                })
                .transpose()
        })
        .collect()
}

/// Node-type statistics of samples in a language with a compiled grammar, as JSON (types and
/// their counts as `[key, value]` pairs, in first-seen order); `null` without the grammar.
#[napi]
pub fn inspect_topology_native(
    language: String,
    files: Vec<FileInput>,
) -> napi::Result<Option<String>> {
    let samples: Vec<(String, String)> = files.into_iter().map(|f| (f.path, f.source)).collect();
    anvesa_syntax::topology::inspect_topology(&language, &samples)
        .map(|topology| {
            serde_json::to_string(&topology).map_err(|e| napi::Error::from_reason(e.to_string()))
        })
        .transpose()
}

// ----------------------------------------------------------------------------
// VECTOR STORE SCAN (delegated to anvesa-store)
// ----------------------------------------------------------------------------

#[napi(object)]
pub struct NapiScanHit {
    pub id: String,
    pub score: f64,
}

#[napi(object)]
pub struct NapiCorruptVector {
    pub id: String,
    pub expected_bytes: u32,
    pub actual_bytes: u32,
}

/// What a scan found, or why it stopped. Exactly one of the three is set; a failure to open or read
/// the database is thrown instead, so the caller can fall back to its own scan.
#[napi(object)]
pub struct NapiScanResult {
    pub hits: Option<Vec<NapiScanHit>>,
    pub corrupt: Option<NapiCorruptVector>,
    pub expired: Option<bool>,
}

/// One read-only connection per index file, kept between searches: a fresh connection maps the
/// file anew and faults in every page it reads, which costs more than the scan. The caller releases
/// it with [`release_vector_scan`] when it closes its own connection to the file, so it holds the
/// file open no longer than the caller already does.
static SCANNERS: std::sync::Mutex<
    Option<std::collections::HashMap<String, anvesa_store::Connection>>,
> = std::sync::Mutex::new(None);

/// Exact search over the `card_vectors` of one channel and model in the index at `db_path`, ranked
/// as `SqliteVectorStore` ranks. `query` must already be unit length. `remaining_ms` is the time
/// left on the caller's deadline, if it has one.
#[napi]
pub fn scan_vectors_native(
    db_path: String,
    channel: String,
    model: String,
    query: Float32Array,
    limit: u32,
    collapse: bool,
    remaining_ms: Option<f64>,
) -> napi::Result<NapiScanResult> {
    use anvesa_store::{open_for_scan, scan_vectors, ScanError, ScanOptions};
    let deadline = remaining_ms.map(|ms| {
        std::time::Instant::now() + std::time::Duration::from_secs_f64(ms.max(0.0) / 1000.0)
    });
    let mut guard = SCANNERS
        .lock()
        .map_err(|_| napi::Error::from_reason("the vector scan cache is poisoned"))?;
    let scanners = guard.get_or_insert_with(Default::default);
    if !scanners.contains_key(&db_path) {
        let conn = open_for_scan(&db_path).map_err(|e| napi::Error::from_reason(e.to_string()))?;
        scanners.insert(db_path.clone(), conn);
    }
    let conn = &scanners[&db_path];
    let scanned = scan_vectors(
        &conn,
        &ScanOptions {
            channel: &channel,
            model: &model,
            query: query.as_ref(),
            limit: limit as usize,
            collapse,
            deadline,
        },
    );
    Ok(match scanned {
        Ok(hits) => NapiScanResult {
            hits: Some(
                hits.into_iter()
                    .map(|hit| NapiScanHit {
                        id: hit.id,
                        score: hit.score,
                    })
                    .collect(),
            ),
            corrupt: None,
            expired: None,
        },
        Err(ScanError::Corrupt {
            id,
            expected_bytes,
            actual_bytes,
        }) => NapiScanResult {
            hits: None,
            corrupt: Some(NapiCorruptVector {
                id,
                expected_bytes: expected_bytes as u32,
                actual_bytes: actual_bytes as u32,
            }),
            expired: None,
        },
        Err(ScanError::DeadlineExpired) => NapiScanResult {
            hits: None,
            corrupt: None,
            expired: Some(true),
        },
        Err(ScanError::Store(e)) => {
            // Whatever went wrong may be the connection's own state; the next search starts over.
            scanners.remove(&db_path);
            return Err(napi::Error::from_reason(e.to_string()));
        }
    })
}

/// Close the connection [`scan_vectors_native`] keeps for `db_path`, if it has one.
#[napi]
pub fn release_vector_scan(db_path: String) {
    if let Ok(mut guard) = SCANNERS.lock() {
        if let Some(scanners) = guard.as_mut() {
            scanners.remove(&db_path);
        }
    }
}

// ----------------------------------------------------------------------------
// FACTS FOR MANY FILES, OFF THE JAVASCRIPT THREAD
// ----------------------------------------------------------------------------

/// One file's outcome: its extraction as JSON (`json`: outline, stats and facts), or for the index
/// its facts as JSON and its outline as W-expression text (`facts` and `wexpr`); `unsupported`
/// when native extraction cannot serve it (the caller reads it another way); or `error` when
/// extracting it failed.
#[napi(object)]
pub struct NapiExtractOutcome {
    pub json: Option<String>,
    pub facts: Option<String>,
    pub wexpr: Option<String>,
    pub unsupported: Option<bool>,
    pub error: Option<String>,
}

pub struct ExtractMany {
    files: Vec<FileInput>,
    mappings_json: String,
    /// For the index: facts and W-expression text, leaving out these attributes, instead of JSON.
    for_index: Option<Vec<String>>,
}

impl napi::Task for ExtractMany {
    type Output = Vec<NapiExtractOutcome>;
    type JsValue = Vec<NapiExtractOutcome>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        use rayon::prelude::*;
        let mappings: std::collections::HashMap<String, anvesa_syntax::outline::LanguageMapping> =
            serde_json::from_str(&self.mappings_json).map_err(|e| {
                napi::Error::from_reason(format!("the mappings are not valid: {e}"))
            })?;
        Ok(self
            .files
            .par_iter()
            .map(|file| {
                let Some(mapping) = mappings.get(&file.language) else {
                    return unsupported();
                };
                // One file that brings the parser down must not take the others with it: it is
                // reported as that file's failure, as a failed single extraction would be.
                let extracted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    anvesa_syntax::facts::extract_file(
                        &file.path,
                        &file.language,
                        &file.source,
                        mapping,
                    )
                }));
                match extracted {
                    Ok(None) => unsupported(),
                    Ok(Some(extracted)) => match &self.for_index {
                        // The outline goes as text and the facts alone as JSON: the outline is
                        // what the index caches, and rebuilding it as objects only to print it
                        // again was most of the work left on the JavaScript thread.
                        Some(omit) => match serde_json::to_string(&extracted.facts) {
                            Ok(facts) => NapiExtractOutcome {
                                json: None,
                                facts: Some(facts),
                                wexpr: Some(anvesa_syntax::outline::serialize_wexpr(
                                    &extracted.root,
                                    omit,
                                )),
                                unsupported: None,
                                error: None,
                            },
                            Err(e) => failed(e.to_string()),
                        },
                        None => match serde_json::to_string(&extracted) {
                            Ok(json) => NapiExtractOutcome {
                                json: Some(json),
                                facts: None,
                                wexpr: None,
                                unsupported: None,
                                error: None,
                            },
                            Err(e) => failed(e.to_string()),
                        },
                    },
                    Err(panic) => failed(format!(
                        "the native parser failed: {}",
                        panic
                            .downcast_ref::<&str>()
                            .map(|s| s.to_string())
                            .or_else(|| panic.downcast_ref::<String>().cloned())
                            .unwrap_or_else(|| "no message".to_string())
                    )),
                }
            })
            .collect())
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

fn unsupported() -> NapiExtractOutcome {
    NapiExtractOutcome {
        json: None,
        facts: None,
        wexpr: None,
        unsupported: Some(true),
        error: None,
    }
}

fn failed(error: String) -> NapiExtractOutcome {
    NapiExtractOutcome {
        json: None,
        facts: None,
        wexpr: None,
        unsupported: None,
        error: Some(error),
    }
}

/// The facts of many files, each as `extract_facts_native` would give them, extracted on every
/// core away from the JavaScript thread. `mappings_json` maps language keys to mappings; a file
/// whose language it lacks is `unsupported`.
#[napi]
pub fn extract_facts_many_native(
    files: Vec<FileInput>,
    mappings_json: String,
) -> napi::bindgen_prelude::AsyncTask<ExtractMany> {
    napi::bindgen_prelude::AsyncTask::new(ExtractMany {
        files,
        mappings_json,
        for_index: None,
    })
}

/// As [`extract_facts_many_native`], but each file comes back ready for the index: its facts as
/// JSON and its outline as W-expression text without the attributes in `omit`, exactly as
/// `serializeWExpr` would print it.
#[napi]
pub fn extract_for_index_many_native(
    files: Vec<FileInput>,
    mappings_json: String,
    omit: Vec<String>,
) -> napi::bindgen_prelude::AsyncTask<ExtractMany> {
    napi::bindgen_prelude::AsyncTask::new(ExtractMany {
        files,
        mappings_json,
        for_index: Some(omit),
    })
}
