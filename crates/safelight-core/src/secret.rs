//! Keeps the Claude API key protected at rest. On Windows it's encrypted with the user's own
//! Windows data protection (DPAPI), so only this Windows account can read it back.

use base64::Engine;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[cfg(windows)]
pub fn protect(plain: &str) -> Result<String, String> {
    win::run(plain.as_bytes(), true).map(|v| B64.encode(v))
}

#[cfg(windows)]
pub fn unprotect(stored: &str) -> Result<String, String> {
    let data = B64.decode(stored).map_err(|e| e.to_string())?;
    String::from_utf8(win::run(&data, false)?).map_err(|e| e.to_string())
}

/// Elsewhere (only used for tests) the key is just encoded.
#[cfg(not(windows))]
pub fn protect(plain: &str) -> Result<String, String> {
    Ok(B64.encode(plain))
}

#[cfg(not(windows))]
pub fn unprotect(stored: &str) -> Result<String, String> {
    String::from_utf8(B64.decode(stored).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[cfg(windows)]
mod win {
    use windows::Win32::{
        Foundation::{LocalFree, HLOCAL},
        Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB},
    };

    pub fn run(data: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            if encrypt {
                CryptProtectData(&input, windows::core::PCWSTR::null(), None, None, None, 0, &mut out)
            } else {
                CryptUnprotectData(&input, None, None, None, None, 0, &mut out)
            }
            .map_err(|e| format!("Windows couldn't protect the key: {e}"))?;
            let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            let _ = LocalFree(HLOCAL(out.pbData as _));
            Ok(v)
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn round_trips() {
        let s = super::protect("sk-ant-test").unwrap();
        assert_ne!(s, "sk-ant-test");
        assert_eq!(super::unprotect(&s).unwrap(), "sk-ant-test");
    }
}
