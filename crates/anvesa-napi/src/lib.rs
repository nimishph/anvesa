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
