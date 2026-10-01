use crate::errors::CoreError;
use crate::top_k::{ScoredIndex, TopKCollector};

/// Dot product using hardware SIMD acceleration (AVX2/FMA on x86_64, NEON on aarch64)
/// with 8-way unrolled scalar fallback.
#[inline]
pub fn dot_product_simd(a: &[f32], b: &[f32]) -> Result<f32, CoreError> {
    if a.len() != b.len() {
        return Err(CoreError::DimensionMismatch {
            expected: a.len(),
            actual: b.len(),
        });
    }

    Ok(dot_product_core(a, b, a.len()))
}

#[inline]
pub fn dot_product_core(a: &[f32], b: &[f32], len: usize) -> f32 {
    #[cfg(target_arch = "x86_64")]
    {
        if is_x86_feature_detected!("avx2") && is_x86_feature_detected!("fma") {
            return unsafe { dot_product_avx2(a, b, len) };
        }
    }
    #[cfg(target_arch = "aarch64")]
    {
        return unsafe { dot_product_neon(a, b, len) };
    }
    dot_product_unrolled(a, b, len)
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2,fma")]
unsafe fn dot_product_avx2(a: &[f32], b: &[f32], len: usize) -> f32 {
    use std::arch::x86_64::*;
    let chunks = len / 8;
    let mut acc = _mm256_setzero_ps();
    let a_ptr = a.as_ptr();
    let b_ptr = b.as_ptr();

    for i in 0..chunks {
        let va = _mm256_loadu_ps(a_ptr.add(i * 8));
        let vb = _mm256_loadu_ps(b_ptr.add(i * 8));
        acc = _mm256_fmadd_ps(va, vb, acc);
    }

    let hi = _mm256_extractf128_ps(acc, 1);
    let lo = _mm256_castps256_ps128(acc);
    let sum128 = _mm_add_ps(lo, hi);
    let shuf = _mm_movehl_ps(sum128, sum128);
    let sum64 = _mm_add_ps(sum128, shuf);
    let shuf2 = _mm_movehdup_ps(sum64);
    let sum32 = _mm_add_ss(sum64, shuf2);
    let mut total = _mm_cvtss_f32(sum32);

    for i in (chunks * 8)..len {
        total += *a_ptr.add(i) * *b_ptr.add(i);
    }
    total
}

#[cfg(target_arch = "aarch64")]
unsafe fn dot_product_neon(a: &[f32], b: &[f32], len: usize) -> f32 {
    use std::arch::aarch64::*;
    let chunks = len / 4;
    let mut acc = vdupq_n_f32(0.0);
    let a_ptr = a.as_ptr();
    let b_ptr = b.as_ptr();

    for i in 0..chunks {
        let va = vld1q_f32(a_ptr.add(i * 4));
        let vb = vld1q_f32(b_ptr.add(i * 4));
        acc = vfmaq_f32(acc, va, vb);
    }
    let mut total = vaddvq_f32(acc);
    for i in (chunks * 4)..len {
        total += *a_ptr.add(i) * *b_ptr.add(i);
    }
    total
}

#[inline]
fn dot_product_unrolled(a: &[f32], b: &[f32], len: usize) -> f32 {
    let mut acc0 = 0.0f32;
    let mut acc1 = 0.0f32;
    let mut acc2 = 0.0f32;
    let mut acc3 = 0.0f32;
    let mut acc4 = 0.0f32;
    let mut acc5 = 0.0f32;
    let mut acc6 = 0.0f32;
    let mut acc7 = 0.0f32;

    let chunks = len / 8;
    let rem = len % 8;

    for i in 0..chunks {
        let idx = i * 8;
        acc0 += a[idx] * b[idx];
        acc1 += a[idx + 1] * b[idx + 1];
        acc2 += a[idx + 2] * b[idx + 2];
        acc3 += a[idx + 3] * b[idx + 3];
        acc4 += a[idx + 4] * b[idx + 4];
        acc5 += a[idx + 5] * b[idx + 5];
        acc6 += a[idx + 6] * b[idx + 6];
        acc7 += a[idx + 7] * b[idx + 7];
    }

    let mut sum = acc0 + acc1 + acc2 + acc3 + acc4 + acc5 + acc6 + acc7;
    let offset = chunks * 8;
    for i in 0..rem {
        sum += a[offset + i] * b[offset + i];
    }
    sum
}

/// Normalizes a vector to unit Euclidean length using SIMD-accelerated dot product.
pub fn normalize_simd(v: &[f32]) -> Result<Vec<f32>, CoreError> {
    if v.is_empty() {
        return Err(CoreError::ZeroLengthVector);
    }

    let len = v.len();
    let sum_sq = dot_product_core(v, v, len);

    if !sum_sq.is_finite() || sum_sq <= 0.0 {
        return Err(CoreError::ZeroLengthVector);
    }

    let norm = sum_sq.sqrt();
    let inv_norm = 1.0 / norm;

    let mut out = Vec::with_capacity(len);
    for &val in v {
        out.push(val * inv_norm);
    }
    Ok(out)
}

/// Scans a contiguous byte buffer of float32 vectors against a query vector and collects top-k hits.
pub fn batch_scan_top_k(
    query: &[f32],
    vector_buffer: &[u8],
    dims: usize,
    limit: usize,
) -> Result<Vec<ScoredIndex>, CoreError> {
    if dims == 0 {
        return Err(CoreError::InvalidParameter {
            param: "dims",
            reason: "dimensions must be greater than zero".into(),
        });
    }

    let byte_stride = dims * 4;
    if vector_buffer.len() % byte_stride != 0 {
        return Err(CoreError::InvalidBufferLength {
            actual_bytes: vector_buffer.len(),
            expected_stride: byte_stride,
        });
    }

    let num_vectors = vector_buffer.len() / byte_stride;
    if num_vectors == 0 || limit == 0 {
        return Ok(Vec::new());
    }

    let mut collector = TopKCollector::new(limit);
    let raw_ptr = vector_buffer.as_ptr();

    for i in 0..num_vectors {
        let vec_bytes = unsafe { std::slice::from_raw_parts(raw_ptr.add(i * byte_stride), byte_stride) };
        let vec_floats = unsafe {
            std::slice::from_raw_parts(vec_bytes.as_ptr() as *const f32, dims)
        };

        let score = dot_product_core(query, vec_floats, dims) as f64;
        collector.add(i as u32, score);
    }

    Ok(collector.into_sorted_vec())
}

/// Evaluates dot products for a query vector across all vectors in a contiguous byte buffer.
pub fn batch_dot_product(
    query: &[f32],
    vector_buffer: &[u8],
    dims: usize,
) -> Result<Vec<f32>, CoreError> {
    if dims == 0 {
        return Err(CoreError::InvalidParameter {
            param: "dims",
            reason: "dimensions must be greater than zero".into(),
        });
    }

    let byte_stride = dims * 4;
    if vector_buffer.len() % byte_stride != 0 {
        return Err(CoreError::InvalidBufferLength {
            actual_bytes: vector_buffer.len(),
            expected_stride: byte_stride,
        });
    }

    let num_vectors = vector_buffer.len() / byte_stride;
    let mut results = Vec::with_capacity(num_vectors);
    let raw_ptr = vector_buffer.as_ptr();

    for i in 0..num_vectors {
        let vec_bytes = unsafe { std::slice::from_raw_parts(raw_ptr.add(i * byte_stride), byte_stride) };
        let vec_floats = unsafe {
            std::slice::from_raw_parts(vec_bytes.as_ptr() as *const f32, dims)
        };

        let score = dot_product_core(query, vec_floats, dims);
        results.push(score);
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dot_product_simd_parity() {
        let a = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0];
        let b = vec![0.5, -1.0, 2.0, 0.0, 1.0, -0.5, 3.0, 2.0, 1.0];

        let expected: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
        let actual = dot_product_simd(&a, &b).unwrap();
        assert!((actual - expected).abs() < 1e-5);
    }

    #[test]
    fn test_normalize_simd() {
        let v = vec![3.0, 4.0];
        let norm = normalize_simd(&v).unwrap();
        assert_eq!(norm.len(), 2);
        assert!((norm[0] - 0.6).abs() < 1e-5);
        assert!((norm[1] - 0.8).abs() < 1e-5);

        let length = dot_product_simd(&norm, &norm).unwrap();
        assert!((length - 1.0).abs() < 1e-5);
    }

    #[test]
    fn test_batch_scan_top_k() {
        let dims = 4;
        let query = vec![1.0, 0.0, 0.0, 0.0];
        let vectors = vec![
            1.0f32, 0.0, 0.0, 0.0,  // idx 0, score 1.0
            0.0, 1.0, 0.0, 0.0,      // idx 1, score 0.0
            0.8, 0.6, 0.0, 0.0,      // idx 2, score 0.8
            -1.0, 0.0, 0.0, 0.0,     // idx 3, score -1.0
        ];

        let buffer: Vec<u8> = vectors
            .iter()
            .flat_map(|f| f.to_ne_bytes())
            .collect();

        let top = batch_scan_top_k(&query, &buffer, dims, 2).unwrap();
        assert_eq!(top.len(), 2);
        assert_eq!(top[0].index, 0);
        assert!((top[0].score - 1.0).abs() < 1e-5);
        assert_eq!(top[1].index, 2);
        assert!((top[1].score - 0.8).abs() < 1e-5);
    }
}
