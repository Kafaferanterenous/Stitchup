//! QuickSign: handwritten signatures (images) kept by Stitchup for reuse,
//! like Nitro's QuickSign. Each one is a small JSON file in the app's private
//! folder. A password-protected signature is stored ENCRYPTED: AES-256-GCM
//! with a key derived from the password by PBKDF2-HMAC-SHA256 (600 000
//! rounds, random salt) — without the password the image can't be read,
//! and a wrong password is detected (authenticated encryption).

use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::error::{EngineError, ErrorCode};

const ROUNDS: u32 = 600_000;
const MAX_PNG: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Stored {
    version: u32,
    id: String,
    name: String,
    created: u64,
    /// Unprotected: the PNG itself (base64).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    png: Option<String>,
    /// Protected: salt, nonce and AES-GCM ciphertext of the PNG (base64).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    salt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    nonce: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(default)]
    rounds: u32,
}

/// What the app shows in the QuickSign list.
#[derive(Debug, Clone, Serialize)]
pub struct SavedSignature {
    pub id: String,
    pub name: String,
    pub created: u64,
    pub protected: bool,
    /// PNG (base64) of unprotected signatures, for a preview; never for protected ones.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

fn rand_bytes<const N: usize>() -> Result<[u8; N], EngineError> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).map_err(|e| crate::err!(ErrorCode::IoError, "random: {e}"))?;
    Ok(b)
}

fn key(password: &str, salt: &[u8], rounds: u32) -> [u8; 32] {
    let mut k = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(password.as_bytes(), salt, rounds, &mut k);
    k
}

fn file_of(dir: &Path, id: &str) -> Result<PathBuf, EngineError> {
    if id.len() != 32 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(crate::err!(ErrorCode::ValidationFailed, "unknown signature"));
    }
    Ok(dir.join(format!("{id}.json")))
}

fn read(dir: &Path, id: &str) -> Result<Stored, EngineError> {
    let p = file_of(dir, id)?;
    let bytes = std::fs::read(&p).map_err(|_| crate::err!(ErrorCode::ValidationFailed, "that signature no longer exists"))?;
    serde_json::from_slice(&bytes).map_err(|e| crate::err!(ErrorCode::Malformed, "signature file: {e}"))
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), EngineError> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| crate::err!(ErrorCode::IoError, "could not write {}: {e}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    // Windows: retried while the new file is being scanned. A signature file
    // is always new, so if the rename still fails, write it in place instead.
    if let Err(e) = crate::ops::rename_retry(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        std::fs::write(path, bytes).map_err(|e2| crate::err!(ErrorCode::IoError, "could not save the signature in {} (rename: {e}; write: {e2})", path.display()))?;
    }
    Ok(())
}

/// Saved signatures, newest first.
pub fn list(dir: &Path) -> Vec<SavedSignature> {
    let mut out: Vec<SavedSignature> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|e| serde_json::from_slice::<Stored>(&std::fs::read(e.path()).ok()?).ok())
        .map(|s| SavedSignature { protected: s.data.is_some(), preview: s.png.clone(), id: s.id, name: s.name, created: s.created })
        .collect();
    out.sort_by(|a, b| b.created.cmp(&a.created).then(a.name.cmp(&b.name)));
    out
}

/// Keep a signature image (PNG). With a password it is stored encrypted.
pub fn save(dir: &Path, name: &str, png: &[u8], password: Option<&str>) -> Result<SavedSignature, EngineError> {
    if !png.starts_with(b"\x89PNG\r\n\x1a\n") || png.len() > MAX_PNG {
        return Err(crate::err!(ErrorCode::ValidationFailed, "the signature image is not a usable PNG"));
    }
    let name = name.trim();
    let name = if name.is_empty() { "Signature" } else { name };
    std::fs::create_dir_all(dir).map_err(|e| crate::err!(ErrorCode::IoError, "could not create the signature folder {}: {e}", dir.display()))?;
    let id: String = rand_bytes::<16>()?.iter().map(|b| format!("{b:02x}")).collect();
    let created = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let mut st = Stored { version: 1, id: id.clone(), name: name.into(), created, png: None, salt: None, nonce: None, data: None, rounds: 0 };
    match password {
        Some(pw) => {
            if pw.chars().count() < 4 {
                return Err(crate::err!(ErrorCode::ValidationFailed, "use a password of at least 4 characters"));
            }
            let salt = rand_bytes::<16>()?;
            let nonce = rand_bytes::<12>()?;
            let cipher = Aes256Gcm::new_from_slice(&key(pw, &salt, ROUNDS)).map_err(|e| crate::err!(ErrorCode::IoError, "{e}"))?;
            let data = cipher.encrypt(Nonce::from_slice(&nonce), png).map_err(|_| crate::err!(ErrorCode::IoError, "encryption failed"))?;
            st.salt = Some(B64.encode(salt));
            st.nonce = Some(B64.encode(nonce));
            st.data = Some(B64.encode(data));
            st.rounds = ROUNDS;
        }
        None => st.png = Some(B64.encode(png)),
    }
    write_private(&file_of(dir, &id)?, &serde_json::to_vec_pretty(&st).unwrap_or_default())?;
    Ok(SavedSignature { protected: password.is_some(), preview: st.png.clone(), id, name: st.name, created })
}

/// The PNG of a saved signature (asks for the password when it is protected).
pub fn load(dir: &Path, id: &str, password: Option<&str>) -> Result<Vec<u8>, EngineError> {
    let st = read(dir, id)?;
    if let Some(png) = st.png {
        return B64.decode(png).map_err(|e| crate::err!(ErrorCode::Malformed, "{e}"));
    }
    let pw = password.ok_or_else(|| crate::err!(ErrorCode::PasswordRequired, "this signature is protected by a password"))?;
    let dec = |s: &Option<String>| s.as_ref().and_then(|v| B64.decode(v).ok()).ok_or_else(|| crate::err!(ErrorCode::Malformed, "signature file damaged"));
    let (salt, nonce, data) = (dec(&st.salt)?, dec(&st.nonce)?, dec(&st.data)?);
    if nonce.len() != 12 {
        return Err(crate::err!(ErrorCode::Malformed, "signature file damaged"));
    }
    let cipher = Aes256Gcm::new_from_slice(&key(pw, &salt, st.rounds.max(1))).map_err(|e| crate::err!(ErrorCode::IoError, "{e}"))?;
    cipher.decrypt(Nonce::from_slice(&nonce), data.as_ref()).map_err(|_| crate::err!(ErrorCode::PermissionDenied, "wrong password"))
}

/// Forget a saved signature. A protected one needs its password.
pub fn delete(dir: &Path, id: &str, password: Option<&str>) -> Result<(), EngineError> {
    let st = read(dir, id)?;
    if st.data.is_some() {
        load(dir, id, password)?;
    }
    std::fs::remove_file(file_of(dir, id)?)?;
    Ok(())
}
