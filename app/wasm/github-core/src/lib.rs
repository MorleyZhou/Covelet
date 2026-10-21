//! Pure, bounded contribution-calendar calculations. All networking is in the host.
#![no_std]
use core::ptr::{addr_of, addr_of_mut};
const MAX_DAYS: usize = 378;
static mut INPUT: [u32; MAX_DAYS * 3] = [0; MAX_DAYS * 3];
static mut OUTPUT: [u32; MAX_DAYS + 14] = [0; MAX_DAYS + 14];
static mut RESULT: [u32; 8] = [0; 8];

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! { core::arch::wasm32::unreachable() }

#[no_mangle]
pub extern "C" fn abi_version() -> u32 { 1 }
#[no_mangle]
pub extern "C" fn input_ptr() -> *mut u32 { addr_of_mut!(INPUT).cast() }
#[no_mangle]
pub extern "C" fn output_ptr() -> *const u32 { addr_of!(OUTPUT).cast() }
#[no_mangle]
pub extern "C" fn result_ptr() -> *const u32 { addr_of!(RESULT).cast() }

#[no_mangle]
pub extern "C" fn analyze_calendar(length: u32) -> u32 {
    unsafe {
        OUTPUT = [0; MAX_DAYS + 14];
        RESULT = [0; 8];
        let n = length as usize;
        if n == 0 || n > MAX_DAYS { return 1; }
        let offset = ((INPUT[0] + 4) % 7) as usize;
        let mut total = 0u32;
        let mut active = 0u32;
        let mut best = 0u32;
        let mut streak = 0u32;
        for i in 0..n {
            let day = INPUT[i * 3];
            let count = INPUT[i * 3 + 1];
            let level = INPUT[i * 3 + 2];
            if day < 10957 || day > 109572 || count > 1_000_000 || level > 4
                || (i > 0 && day != INPUT[(i - 1) * 3] + 1)
                || (count == 0 && level != 0) || (count > 0 && level == 0) { return 2; }
            total += count;
            if count > 0 { active += 1; streak += 1; } else { streak = 0; }
            if streak > best { best = streak; }
            OUTPUT[offset + i] = level + 1;
        }
        RESULT = [total, active, best, streak, offset as u32, ((offset + n + 6) / 7) as u32,
            INPUT[(n - 1) * 3 + 1], n as u32];
        0
    }
}
