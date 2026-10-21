# Clock core

Scalar WASM functions compute elapsed time, remaining time and analog clock angles. The binary has no imports, linear memory, network or executable configuration. `scripts/clock-wasm.mjs --write` deterministically encodes the checked-in implementation; this operation only creates files, without instantiating or testing the module. `--check` is used by future packaging to compare source/binary checksums.

Host JavaScript handles system time, UI, local persistence and Chrome alarms/notifications. Timer and alarm state is device-local and excluded from portable navigation configuration.
