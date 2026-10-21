//! Import-free hashing, request signing primitives and three-way sync planning.
//! Network access and authenticated encryption remain in browser APIs.
#![no_std]

use core::ptr::{addr_of, addr_of_mut};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

const MAX_INPUT: usize = 1024 * 1024;
const MAX_KEY: usize = 512;
static mut INPUT: [u8; MAX_INPUT] = [0; MAX_INPUT];
static mut KEY: [u8; MAX_KEY] = [0; MAX_KEY];
static mut OUTPUT: [u8; 32] = [0; 32];

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[no_mangle]
pub extern "C" fn abi_version() -> u32 { 1 }

#[no_mangle]
pub extern "C" fn max_input_bytes() -> u32 { MAX_INPUT as u32 }

#[no_mangle]
pub extern "C" fn max_key_bytes() -> u32 { MAX_KEY as u32 }

#[no_mangle]
pub extern "C" fn input_ptr() -> *mut u8 { addr_of_mut!(INPUT).cast() }

#[no_mangle]
pub extern "C" fn key_ptr() -> *mut u8 { addr_of_mut!(KEY).cast() }

#[no_mangle]
pub extern "C" fn output_ptr() -> *const u8 { addr_of!(OUTPUT).cast() }

#[no_mangle]
pub extern "C" fn sha256_hash(length: u32) -> u32 {
    if length as usize > MAX_INPUT { return 1; }
    unsafe {
        let bytes = core::slice::from_raw_parts(addr_of!(INPUT).cast::<u8>(), length as usize);
        let digest = Sha256::digest(bytes);
        core::ptr::copy_nonoverlapping(digest.as_ptr(), addr_of_mut!(OUTPUT).cast::<u8>(), 32);
    }
    0
}

#[no_mangle]
pub extern "C" fn hmac_sha256(key_length: u32, data_length: u32) -> u32 {
    if key_length as usize > MAX_KEY || data_length as usize > MAX_INPUT { return 1; }
    unsafe {
        let key = core::slice::from_raw_parts(addr_of!(KEY).cast::<u8>(), key_length as usize);
        let data = core::slice::from_raw_parts(addr_of!(INPUT).cast::<u8>(), data_length as usize);
        let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(key) else { return 1; };
        mac.update(data);
        let digest = mac.finalize().into_bytes();
        core::ptr::copy_nonoverlapping(digest.as_ptr(), addr_of_mut!(OUTPUT).cast::<u8>(), 32);
    }
    0
}

// INPUT[0..32] = local, [32..64] = common base, [64..96] = remote.
// This only chooses an action. The JS controller owns merging and persistence.
#[no_mangle]
pub extern "C" fn sync_plan() -> u32 {
    unsafe {
        let bytes = core::slice::from_raw_parts(addr_of!(INPUT).cast::<u8>(), 96);
        let (local, base, remote) = (&bytes[..32], &bytes[32..64], &bytes[64..96]);
        if local == remote { 0 }
        else if remote == base { 1 }
        else if local == base { 2 }
        else { 3 }
    }
}
