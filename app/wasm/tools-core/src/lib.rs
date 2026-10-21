#![no_std]

use core::{panic::PanicInfo, str};

const CAPACITY: usize = 262144;
static mut INPUT: [u8; CAPACITY] = [0; CAPACITY];
static mut OTHER: [u8; CAPACITY] = [0; CAPACITY];
static mut OUTPUT: [u32; 2048] = [0; 2048];

#[panic_handler]
fn panic(_: &PanicInfo) -> ! { core::arch::wasm32::unreachable() }

#[no_mangle] pub extern "C" fn abi_version() -> u32 { 1 }
#[no_mangle] pub extern "C" fn input_ptr() -> *mut u8 { core::ptr::addr_of_mut!(INPUT).cast() }
#[no_mangle] pub extern "C" fn other_ptr() -> *mut u8 { core::ptr::addr_of_mut!(OTHER).cast() }
#[no_mangle] pub extern "C" fn output_ptr() -> *const u32 { core::ptr::addr_of!(OUTPUT).cast() }

#[no_mangle]
pub unsafe extern "C" fn text_metrics(length: usize) -> u32 {
    if length > CAPACITY { return 0; }
    let Ok(text) = str::from_utf8(&INPUT[..length]) else { return 0; };
    OUTPUT[0] = text.chars().count() as u32;
    OUTPUT[1] = text.chars().filter(|c| !c.is_whitespace()).count() as u32;
    OUTPUT[2] = if text.is_empty() { 0 } else { text.bytes().filter(|&c| c == b'\n').count() as u32 + 1 };
    OUTPUT[3] = text.split_whitespace().count() as u32;
    1
}

#[no_mangle]
pub unsafe extern "C" fn text_contains(length: usize, query: usize) -> u32 {
    if length > CAPACITY || query > CAPACITY { return 0; }
    if query == 0 { return 1; }
    INPUT[..length].windows(query).any(|window| window == &OTHER[..query]) as u32
}

#[no_mangle]
pub unsafe extern "C" fn diff_summary(before: usize, after: usize) -> u32 {
    if before > CAPACITY || after > CAPACITY { return 0; }
    let (Ok(a), Ok(b)) = (str::from_utf8(&INPUT[..before]), str::from_utf8(&OTHER[..after])) else { return 0; };
    let mut prefix = 0;
    for (left, right) in a.chars().zip(b.chars()) { if left != right { break; } prefix += left.len_utf8(); }
    let mut suffix = 0;
    for (left, right) in a[prefix..].chars().rev().zip(b[prefix..].chars().rev()) { if left != right { break; } suffix += left.len_utf8(); }
    OUTPUT[0] = a[prefix..before - suffix].chars().count() as u32;
    OUTPUT[1] = b[prefix..after - suffix].chars().count() as u32;
    OUTPUT[2] = prefix as u32;
    OUTPUT[3] = suffix as u32;
    1
}

// Input is a bounded newline-delimited list of already validated HTTP(S) URLs.
// Return the first occurrence indices, comparing full URLs without truncation.
#[no_mangle]
pub unsafe extern "C" fn unique_lines(length: usize) -> u32 {
    if length > CAPACITY { return 0; }
    let Ok(text) = str::from_utf8(&INPUT[..length]) else { return 0; };
    let mut starts = [0usize; 2048];
    let mut ends = [0usize; 2048];
    let mut count = 0usize;
    let mut start = 0usize;
    for (index, line) in text.split('\n').enumerate() {
        if index >= 2048 { return 0; }
        let end = start + line.len();
        if !line.is_empty() && !(0..count).any(|at| INPUT[starts[at]..ends[at]] == INPUT[start..end]) {
            starts[count] = start; ends[count] = end; OUTPUT[count] = index as u32; count += 1;
        }
        start = end + 1;
    }
    count as u32
}
