# 密码加密完整备份 v1

这是 Covelet 可移植文件封装，不是设备密钥格式，也不改变同步协议。内层为现有 `covelet-complete-backup` version 1 UTF-8 JSON，最大 50 MiB。文件使用 `.covelet` 扩展名，但读取以字节验证，不信任扩展名或 MIME。

## 固定 profile 1

| 字节偏移 | 长度 | 内容 |
| --- | --- | --- |
| 0 | 8 | ASCII `CVLTBAK` 加一个零字节 |
| 8 | 1 | 文件版本 1 |
| 9 | 1 | profile 1 |
| 10 | 2 | 保留，必须为零 |
| 12 | 4 | 大端 uint32，PBKDF2 次数 600000 |
| 16 | 4 | 大端 uint32，内层 UTF-8 明文字节数 |
| 20 | 16 | 每文件独立随机 salt |
| 36 | 12 | 每文件独立随机 GCM IV |
| 48 | 明文长度 + 16 | AES-GCM 密文与 128-bit tag |

密码按原样 UTF-8 编码，接受 8–256 个 UTF-16 码元，拒绝 NUL 和未配对代理项；不 trim、不 Unicode 规范化。使用 PBKDF2-HMAC-SHA256 派生不可导出的 AES-GCM 256-bit 密钥。完整 48-byte 头作为 AAD，tag 为 128-bit，总开销固定 64 字节。实现直接调用浏览器原生 WebCrypto；API 和认证语义依据 [W3C Web Cryptography](https://www.w3.org/TR/2017/REC-WebCryptoAPI-20170126/)。

600000 次采用 [OWASP PBKDF2-HMAC-SHA256 的密码存储建议](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#pbkdf2) 作为本文件 profile 的成本参考。这是本项目对离线备份的参数选择，不宣称 OWASP 或 [NIST SP 800-132](https://csrc.nist.gov/pubs/sp/800/132/final) 强制该备份次数，也不宣称浏览器模块通过 FIPS 认证。未来调整算法或成本必须使用新 profile，不能放宽现 profile 来接受任意输入参数。

## 验证和取消

先校验头、版本、保留位、固定成本、明文上限及文件精确长度，再进行 KDF 或读取整个密文。认证失败不返回部分明文，错密码及认证数据损坏使用同一提示。成功解密后，以 fatal UTF-8 解码，再验证完整 JSON 和全部业务域；预览和取消没有业务写入。

每个异步步骤前后检查取消。WebCrypto 的原生操作没有本实现可用的中止接口，取消意味着丢弃后续结果，不能描述为已经停止底层计算。密码和 key 不持久保存，临时字节做尽力清理；JavaScript 字符串、浏览器副本和密钥句柄不能保证同步清零。恢复前副本和事务沿用现有恢复机制。

独立 Node `crypto` 加解密测试验证线格式互操作，不依赖本机设备 key。真实 Chrome→全新 Edge 验证不同不可导出设备 key 下的同密码全数据恢复。对应证据及成本测量见 [本批验收](0.4.12.md)。
