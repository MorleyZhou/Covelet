//! Bounded, import-free image operations for the packaged Covelet worker.
#![no_std]

use core::ptr::{addr_of, addr_of_mut};

const MAX_SIDE: usize = 256;
const OUTPUT_SIDE: usize = 128;
const CONTENT_SIDE: usize = 102;
const INPUT_BYTES: usize = MAX_SIDE * MAX_SIDE * 4;
const OUTPUT_BYTES: usize = OUTPUT_SIDE * OUTPUT_SIDE * 4;
const RESULT_WORDS: usize = 32;
const OK: u32 = 0;
const INVALID_SIZE: u32 = 1;
const TRANSPARENT: u32 = 2;

static mut INPUT: [u8; INPUT_BYTES] = [0; INPUT_BYTES];
static mut OUTPUT: [u8; OUTPUT_BYTES] = [0; OUTPUT_BYTES];
static mut RESULT: [u32; RESULT_WORDS] = [0; RESULT_WORDS];
// Reused bounded scratch/output for icon presentation. The host reads just
// these small records after normalize_icon; it never rescans the source RGBA.
static mut ICON_EDGE: [[u32; 4]; 4096] = [[0; 4]; 4096];
static mut ICON_INK: [u32; 64] = [0; 64];
static mut ICON_DETAILS: [u32; 8] = [0; 8];

// sRGB -> linear light, rounded to 0..10000. Fixed values keep builds and
// results deterministic; the image remains in its original sRGB color space.
const LINEAR: [u32; 256] = [
    0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 37, 40, 44, 48,
    52, 56, 60, 65, 70, 75, 80, 86, 91, 97, 103, 110, 116, 123, 130, 137,
    144, 152, 160, 168, 176, 185, 194, 203, 212, 222, 232, 242, 252, 262, 273, 284,
    296, 307, 319, 331, 343, 356, 369, 382, 395, 409, 423, 437, 452, 467, 482, 497,
    513, 529, 545, 561, 578, 595, 612, 630, 648, 666, 685, 704, 723, 742, 762, 782,
    802, 823, 844, 865, 887, 908, 931, 953, 976, 999, 1022, 1046, 1070, 1095, 1119, 1144,
    1170, 1195, 1221, 1248, 1274, 1301, 1329, 1356, 1384, 1413, 1441, 1470, 1500, 1529, 1559, 1590,
    1620, 1651, 1683, 1714, 1746, 1779, 1812, 1845, 1878, 1912, 1946, 1981, 2016, 2051, 2086, 2122,
    2159, 2195, 2232, 2270, 2307, 2346, 2384, 2423, 2462, 2502, 2542, 2582, 2623, 2664, 2705, 2747,
    2789, 2831, 2874, 2918, 2961, 3005, 3050, 3095, 3140, 3185, 3231, 3278, 3325, 3372, 3419, 3467,
    3515, 3564, 3613, 3663, 3712, 3763, 3813, 3864, 3916, 3968, 4020, 4072, 4125, 4179, 4233, 4287,
    4342, 4397, 4452, 4508, 4564, 4621, 4678, 4735, 4793, 4851, 4910, 4969, 5029, 5089, 5149, 5210,
    5271, 5333, 5395, 5457, 5520, 5583, 5647, 5711, 5776, 5841, 5906, 5972, 6038, 6105, 6172, 6240,
    6308, 6376, 6445, 6514, 6584, 6654, 6724, 6795, 6867, 6939, 7011, 7084, 7157, 7231, 7305, 7379,
    7454, 7529, 7605, 7682, 7758, 7835, 7913, 7991, 8070, 8148, 8228, 8308, 8388, 8469, 8550, 8632,
    8714, 8796, 8879, 8963, 9047, 9131, 9216, 9301, 9387, 9473, 9560, 9647, 9734, 9823, 9911, 10000,
];

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[no_mangle]
pub extern "C" fn abi_version() -> u32 { 1 }

#[no_mangle]
pub extern "C" fn input_ptr() -> *mut u8 { addr_of_mut!(INPUT).cast() }

#[no_mangle]
pub extern "C" fn output_ptr() -> *const u8 { addr_of!(OUTPUT).cast() }

#[no_mangle]
pub extern "C" fn result_ptr() -> *const u32 { addr_of!(RESULT).cast() }

#[no_mangle]
pub extern "C" fn icon_presentation_ptr() -> *const u32 { addr_of!(ICON_DETAILS).cast() }

#[no_mangle]
pub extern "C" fn icon_ink_ptr() -> *const u32 { addr_of!(ICON_INK).cast() }

unsafe fn begin(width: u32, height: u32) -> bool {
    core::ptr::write_bytes(addr_of_mut!(RESULT).cast::<u32>(), 0, RESULT_WORDS);
    RESULT[0] = 1;
    if width == 0 || height == 0 || width > MAX_SIDE as u32 || height > MAX_SIDE as u32 {
        RESULT[1] = INVALID_SIZE;
        return false;
    }
    true
}

fn rgb(red: u64, green: u64, blue: u64, weight: u64) -> u32 {
    (((red + weight / 2) / weight) as u32) << 16
        | (((green + weight / 2) / weight) as u32) << 8
        | ((blue + weight / 2) / weight) as u32
}

#[no_mangle]
pub extern "C" fn analyze_wallpaper(width: u32, height: u32) -> u32 {
    unsafe {
        if !begin(width, height) { return INVALID_SIZE; }
        let mut buckets = [[0u64; 4]; 512];
        let mut luminance_histogram = [0u64; 256];
        let mut total = [0u64; 5];
        for pixel in 0..width as usize * height as usize {
            let offset = pixel * 4;
            let a = INPUT[offset + 3] as u64;
            if a == 0 { continue; }
            let r = INPUT[offset] as usize;
            let g = INPUT[offset + 1] as usize;
            let b = INPUT[offset + 2] as usize;
            let index = (r >> 5) << 6 | (g >> 5) << 3 | (b >> 5);
            let luma = (LINEAR[r] * 2126 + LINEAR[g] * 7152 + LINEAR[b] * 722 + 5000) / 10000;
            buckets[index][0] += a;
            buckets[index][1] += r as u64 * a;
            buckets[index][2] += g as u64 * a;
            buckets[index][3] += b as u64 * a;
            luminance_histogram[((luma * 255 + 5000) / 10000) as usize] += a;
            total[0] += a;
            total[1] += r as u64 * a;
            total[2] += g as u64 * a;
            total[3] += b as u64 * a;
            total[4] += luma as u64 * a;
            RESULT[2] += 1;
        }
        if total[0] == 0 {
            RESULT[1] = TRANSPARENT;
            return TRANSPARENT;
        }
        RESULT[4] = rgb(total[1], total[2], total[3], total[0]);
        RESULT[5] = ((total[4] + total[0] / 2) / total[0]) as u32;
        let mut cumulative = 0u64;
        let mut quantile = 0;
        let quantiles = [10, 50, 90];
        for (index, weight) in luminance_histogram.iter().enumerate() {
            cumulative += weight;
            while quantile < 3 && cumulative * 100 >= total[0] * quantiles[quantile] {
                RESULT[6 + quantile] = ((index as u32 * 10000 + 127) / 255) as u32;
                quantile += 1;
            }
        }
        for palette in 0..3 {
            let mut top = 0;
            for index in 1..buckets.len() {
                if buckets[index][0] > buckets[top][0] { top = index; }
            }
            let bucket = buckets[top];
            if bucket[0] == 0 { break; }
            RESULT[9 + palette] = rgb(bucket[1], bucket[2], bucket[3], bucket[0]);
            RESULT[12 + palette] = ((bucket[0] * 10000 + total[0] / 2) / total[0]) as u32;
            buckets[top][0] = 0;
        }
        RESULT[3] = RESULT[9];
        OK
    }
}

unsafe fn input_luminance(pixel: usize) -> u32 {
    let offset = pixel * 4;
    (LINEAR[INPUT[offset] as usize] * 2126
        + LINEAR[INPUT[offset + 1] as usize] * 7152
        + LINEAR[INPUT[offset + 2] as usize] * 722 + 5000) / 10000
}

// RGB is the already-composited wallpaper; alpha is the caption's glyph mask.
// Assess each part of a word, not just the mean brightness of its rectangle.
// A narrow dark cable must not disappear into a bright region's average.
#[no_mangle]
pub extern "C" fn analyze_caption(width: u32, height: u32, previous: u32, scale: u32) -> u32 {
    unsafe {
        if !begin(width, height) { return INVALID_SIZE; }
        if height > 64 || previous > 2 || scale < 10 || scale > 200 {
            RESULT[1] = INVALID_SIZE;
            return INVALID_SIZE;
        }
        let (width, height) = (width as usize, height as usize);
        let (mut left, mut right) = (width, 0);
        for y in 0..height {
            for x in 0..width {
                if INPUT[(y * width + x) * 4 + 3] > 0 { left = left.min(x); right = right.max(x + 1); }
            }
        }
        if right <= left { RESULT[1] = TRANSPARENT; return TRANSPARENT; }
        let mut sums = [[0.0f64; 4]; 2];
        let mut bands = [[[0.0f64; 4]; 8]; 2];
        let mut band_weights = [0.0f64; 8];
        let (mut total, mut luminance_sum, mut texture) = (0.0f64, 0.0f64, 0.0f64);
        let step = ((scale + 50) / 100).max(1).min(2) as usize;
        for y in 0..height {
            for x in 0..width {
                let pixel = y * width + x;
                let alpha = INPUT[pixel * 4 + 3] as f64;
                if alpha == 0.0 { continue; }
                let luminance = input_luminance(pixel) as f64;
                let band = ((x - left) * 8 / (right - left)).min(7);
                let contrasts = [(luminance + 500.0) / 500.0, 10500.0 / (luminance + 500.0)];
                for candidate in 0..2 {
                    let contrast = contrasts[candidate];
                    let metrics = [(contrast >= 4.5) as u32 as f64, (contrast < 3.0) as u32 as f64,
                        (4.5 - contrast).max(0.0), contrast.min(12.0)];
                    for metric in 0..4 {
                        let value = metrics[metric] * alpha;
                        sums[candidate][metric] += value;
                        bands[candidate][band][metric] += value;
                    }
                }
                let mut edge = 0.0f64;
                for distance in [step, step * 2] {
                    for neighbor in [y * width + x.saturating_sub(distance),
                        y * width + (x + distance).min(width - 1),
                        y.saturating_sub(distance) * width + x,
                        (y + distance).min(height - 1) * width + x] {
                        edge = edge.max((luminance - input_luminance(neighbor) as f64).abs());
                    }
                }
                texture += alpha * ((edge - 600.0) / 2400.0).max(0.0).min(1.0);
                band_weights[band] += alpha;
                total += alpha; luminance_sum += luminance * alpha;
                RESULT[2] += 1;
            }
        }
        let mut scores = [0.0f64; 2];
        let mut worst_coverage = [1.0f64; 2];
        let mut worst_severe = [0.0f64; 2];
        for candidate in 0..2 {
            for metric in 0..4 { sums[candidate][metric] /= total; }
            let mut worst_penalty = 0.0f64;
            for band in 0..8 {
                let weight = band_weights[band];
                // Ignore nearly empty slices at punctuation/antialiased edges.
                if weight < total * 0.025 { continue; }
                worst_coverage[candidate] = worst_coverage[candidate].min(bands[candidate][band][0] / weight);
                worst_severe[candidate] = worst_severe[candidate].max(bands[candidate][band][1] / weight);
                worst_penalty = worst_penalty.max(bands[candidate][band][2] / weight);
            }
            scores[candidate] = sums[candidate][2] * 0.58 + worst_penalty * 0.42
                + sums[candidate][1] * 0.30 - sums[candidate][3] * 0.025;
        }
        let mut chosen = if (scores[0] - scores[1]).abs() < 0.001 {
            if luminance_sum / total >= 1791.0 { 0 } else { 1 }
        } else if scores[0] < scores[1] { 0 } else { 1 };
        if previous > 0 {
            let prior = (previous - 1) as usize;
            if scores[prior] - scores[chosen] < 0.045
                && sums[chosen][0] - sums[prior][0] < 0.015
                && sums[prior][1] - sums[chosen][1] < 0.015 { chosen = prior; }
        }
        let detail = texture / total;
        let support = if sums[chosen][1] > 0.08 || worst_severe[chosen] > 0.16
            || sums[chosen][0] < 0.72 || detail > 0.35 { 2 }
            else if sums[chosen][0] < 0.97 || worst_coverage[chosen] < 0.90 || detail > 0.14 { 1 }
            else { 0 };
        RESULT[5] = (luminance_sum / total + 0.5) as u32;
        RESULT[20] = chosen as u32 + 1;
        RESULT[21] = support;
        RESULT[22] = (sums[chosen][0] * 10000.0 + 0.5) as u32;
        RESULT[23] = (sums[chosen][1] * 10000.0 + 0.5) as u32;
        RESULT[24] = (sums[chosen][2] * 1000.0 + 0.5) as u32;
        RESULT[25] = (detail * 10000.0 + 0.5) as u32;
        OK
    }
}

#[no_mangle]
pub extern "C" fn normalize_icon(width: u32, height: u32) -> u32 {
    unsafe {
        core::ptr::write_bytes(addr_of_mut!(OUTPUT).cast::<u8>(), 0, OUTPUT_BYTES);
        if !begin(width, height) { return INVALID_SIZE; }
        let width = width as usize;
        let height = height as usize;
        let (mut left, mut top, mut right, mut bottom) = (width, height, 0, 0);
        for y in 0..height {
            for x in 0..width {
                if INPUT[(y * width + x) * 4 + 3] == 0 { continue; }
                left = left.min(x);
                top = top.min(y);
                right = right.max(x + 1);
                bottom = bottom.max(y + 1);
                RESULT[2] += 1;
            }
        }
        if RESULT[2] == 0 {
            RESULT[1] = TRANSPARENT;
            return TRANSPARENT;
        }
        let crop_width = right - left;
        let crop_height = bottom - top;
        RESULT[15] = left as u32;
        RESULT[16] = top as u32;
        RESULT[17] = crop_width as u32;
        RESULT[18] = crop_height as u32;
        describe_icon(width, height, left, top, crop_width, crop_height);
        let longest = crop_width.max(crop_height);
        let destination_width = ((crop_width * CONTENT_SIDE + longest / 2) / longest).max(1);
        let destination_height = ((crop_height * CONTENT_SIDE + longest / 2) / longest).max(1);
        let destination_left = (OUTPUT_SIDE - destination_width) / 2;
        let destination_top = (OUTPUT_SIDE - destination_height) / 2;
        for y in 0..destination_height {
            for x in 0..destination_width {
                let sample = if crop_width > destination_width || crop_height > destination_height {
                    area_sample(width, left, top, crop_width, crop_height, x, y, destination_width, destination_height)
                } else {
                    bilinear_sample(width, left, top, crop_width, crop_height, x, y, destination_width, destination_height)
                };
                let offset = ((destination_top + y) * OUTPUT_SIDE + destination_left + x) * 4;
                for channel in 0..4 { OUTPUT[offset + channel] = sample[channel]; }
            }
        }
        RESULT[19] = 1;
        if width == OUTPUT_SIDE && height == OUTPUT_SIDE {
            let mut identical = true;
            for index in 0..OUTPUT_BYTES {
                if INPUT[index] != OUTPUT[index] { identical = false; break; }
            }
            RESULT[19] = (!identical) as u32;
        }
        OK
    }
}

unsafe fn describe_icon(width: usize, height: usize, left: usize, top: usize, cw: usize, ch: usize) {
    core::ptr::write_bytes(addr_of_mut!(ICON_EDGE).cast::<u32>(), 0, 4096 * 4);
    core::ptr::write_bytes(addr_of_mut!(ICON_INK).cast::<u32>(), 0, 64);
    core::ptr::write_bytes(addr_of_mut!(ICON_DETAILS).cast::<u32>(), 0, 8);
    let (mut total, mut light, mut dark, mut edge, mut ink_weight) = (0u64, 0u64, 0u64, 0u64, 0u64);
    for y in 0..height {
        for x in 0..width {
            let at = (y * width + x) * 4;
            let a = INPUT[at + 3] as u32;
            if a < 26 { continue; }
            let (r, g, b) = (INPUT[at] as u32, INPUT[at + 1] as u32, INPUT[at + 2] as u32);
            total += a as u64;
            let (low, high) = (r.min(g).min(b), r.max(g).max(b));
            if high - low < 20 {
                if low > 215 { light += a as u64; }
                if high < 55 { dark += a as u64; }
            }
            if a >= 128 {
                let luma = (LINEAR[r as usize] * 2126 + LINEAR[g as usize] * 7152 + LINEAR[b as usize] * 722 + 5000) / 10000;
                let bin = ((luma * 63 + 5000) / 10000).min(63) as usize;
                ICON_INK[bin] += a; ink_weight += a as u64;
            }
            // Exact rational form of the outer 14% band, avoiding per-pixel
            // floating point divisions. Cropping contains every visible pixel.
            let dx = (2 * (x - left) + 1) * 50;
            let dy = (2 * (y - top) + 1) * 50;
            if a < 192 || dx > cw * 14 && dx < cw * 86 && dy > ch * 14 && dy < ch * 86 { continue; }
            let bucket = ((r >> 4) << 8 | (g >> 4) << 4 | (b >> 4)) as usize;
            // Max channel sum is 256*256*255*255, within a u32.
            ICON_EDGE[bucket][0] += a;
            ICON_EDGE[bucket][1] += r * a;
            ICON_EDGE[bucket][2] += g * a;
            ICON_EDGE[bucket][3] += b * a;
            edge += a as u64;
        }
    }
    let mut winner = 0;
    for index in 1..4096 {
        if ICON_EDGE[index][0] > ICON_EDGE[winner][0] { winner = index; }
    }
    let bucket = ICON_EDGE[winner];
    let square = width.min(height) * 10 > width.max(height) * 9;
    let area = width as u64 * height as u64 * 255;
    let solid_edge = square && total * 100 > area * 45 && edge > 0 && bucket[0] as u64 * 10 > edge * 9;
    let monochrome = if total * 10 < area * 9 && total > 0 {
        if light * 100 > total * 94 { 1 } else if dark * 100 > total * 94 { 2 } else { 0 }
    } else { 0 };
    ICON_DETAILS[0] = 1;
    ICON_DETAILS[1] = (solid_edge || square && total * 100 >= area * 94 && left == 0 && top == 0 && cw == width && ch == height) as u32;
    ICON_DETAILS[4] = monochrome;
    if solid_edge {
        ICON_DETAILS[2] = 1;
        ICON_DETAILS[3] = rgb(bucket[1] as u64, bucket[2] as u64, bucket[3] as u64, bucket[0] as u64);
    } else if monochrome == 1 {
        ICON_DETAILS[2] = 1; ICON_DETAILS[3] = 0x171719;
    }
    if ink_weight > 0 {
        ICON_DETAILS[5] = 1;
        for index in 0..64 {
            ICON_INK[index] = ((ICON_INK[index] as u64 * 10000 + ink_weight / 2) / ink_weight) as u32;
        }
    }
}

unsafe fn accumulate(sum: &mut [f64; 5], offset: usize, weight: f64) {
    let alpha = INPUT[offset + 3] as f64;
    sum[0] += weight;
    sum[1] += alpha * weight;
    sum[2] += INPUT[offset] as f64 * alpha * weight;
    sum[3] += INPUT[offset + 1] as f64 * alpha * weight;
    sum[4] += INPUT[offset + 2] as f64 * alpha * weight;
}

fn unpremultiply(sum: [f64; 5]) -> [u8; 4] {
    if sum[0] <= 0.0 || sum[1] <= 0.0 { return [0; 4]; }
    let alpha = (sum[1] / sum[0] + 0.5).min(255.0) as u8;
    if alpha == 0 { return [0; 4]; }
    [
        (sum[2] / sum[1] + 0.5).min(255.0) as u8,
        (sum[3] / sum[1] + 0.5).min(255.0) as u8,
        (sum[4] / sum[1] + 0.5).min(255.0) as u8,
        alpha,
    ]
}

#[allow(clippy::too_many_arguments)]
unsafe fn area_sample(width: usize, left: usize, top: usize, cw: usize, ch: usize,
    dx: usize, dy: usize, dw: usize, dh: usize) -> [u8; 4] {
    let x0 = dx as f64 * cw as f64 / dw as f64;
    let y0 = dy as f64 * ch as f64 / dh as f64;
    let x1 = (dx + 1) as f64 * cw as f64 / dw as f64;
    let y1 = (dy + 1) as f64 * ch as f64 / dh as f64;
    let mut sum = [0.0; 5];
    // Integer truncation is floor because every coordinate is nonnegative.
    let end_x = (x1 as usize + ((x1 as usize as f64) < x1) as usize).min(cw);
    let end_y = (y1 as usize + ((y1 as usize as f64) < y1) as usize).min(ch);
    for sy in y0 as usize..end_y {
        let wy = (y1.min((sy + 1) as f64) - y0.max(sy as f64)).max(0.0);
        for sx in x0 as usize..end_x {
            let wx = (x1.min((sx + 1) as f64) - x0.max(sx as f64)).max(0.0);
            accumulate(&mut sum, ((top + sy) * width + left + sx) * 4, wx * wy);
        }
    }
    unpremultiply(sum)
}

#[allow(clippy::too_many_arguments)]
unsafe fn bilinear_sample(width: usize, left: usize, top: usize, cw: usize, ch: usize,
    dx: usize, dy: usize, dw: usize, dh: usize) -> [u8; 4] {
    let sx = (((dx as f64 + 0.5) * cw as f64 / dw as f64) - 0.5).max(0.0).min((cw - 1) as f64);
    let sy = (((dy as f64 + 0.5) * ch as f64 / dh as f64) - 0.5).max(0.0).min((ch - 1) as f64);
    let x0 = sx as usize;
    let y0 = sy as usize;
    let x1 = (x0 + 1).min(cw - 1);
    let y1 = (y0 + 1).min(ch - 1);
    let fx = sx - x0 as f64;
    let fy = sy - y0 as f64;
    let mut sum = [0.0; 5];
    accumulate(&mut sum, ((top + y0) * width + left + x0) * 4, (1.0 - fx) * (1.0 - fy));
    accumulate(&mut sum, ((top + y0) * width + left + x1) * 4, fx * (1.0 - fy));
    accumulate(&mut sum, ((top + y1) * width + left + x0) * 4, (1.0 - fx) * fy);
    accumulate(&mut sum, ((top + y1) * width + left + x1) * 4, fx * fy);
    unpremultiply(sum)
}
