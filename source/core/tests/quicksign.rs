use stitchup_core::error::ErrorCode;
use stitchup_core::quicksign;

fn png() -> Vec<u8> {
    // Minimal valid-looking PNG payload (signature + some bytes).
    let mut v = b"\x89PNG\r\n\x1a\n".to_vec();
    v.extend((0..2000u32).map(|i| (i * 7 % 251) as u8));
    v
}

fn dir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("stitchup-qs-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

#[test]
fn unprotected_signature_round_trips_with_a_preview() {
    let d = dir("plain");
    let s = quicksign::save(&d, "  My signature ", &png(), None).unwrap();
    assert_eq!(s.name, "My signature");
    assert!(!s.protected && s.preview.is_some());
    let l = quicksign::list(&d);
    assert_eq!(l.len(), 1);
    assert_eq!(quicksign::load(&d, &s.id, None).unwrap(), png());
    quicksign::delete(&d, &s.id, None).unwrap();
    assert!(quicksign::list(&d).is_empty());
}

#[test]
fn protected_signature_is_encrypted_and_needs_the_right_password() {
    let d = dir("locked");
    let s = quicksign::save(&d, "Locked", &png(), Some("tajne hasło")).unwrap();
    assert!(s.protected && s.preview.is_none());
    // Nothing readable on disk: no PNG bytes, no base64 of them.
    let raw = std::fs::read_to_string(d.join(format!("{}.json", s.id))).unwrap();
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(png());
    // (Random ciphertext may spell "PNG" by chance; the base64 PNG signature cannot.)
    assert!(!raw.contains(&b64[..40]) && !raw.contains("iVBORw0KGgo"), "stored encrypted");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(d.join(format!("{}.json", s.id))).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "private to the user");
    }
    assert!(quicksign::list(&d)[0].preview.is_none(), "no preview of a locked signature");
    assert_eq!(quicksign::load(&d, &s.id, None).unwrap_err().code, ErrorCode::PasswordRequired);
    assert_eq!(quicksign::load(&d, &s.id, Some("wrong")).unwrap_err().code, ErrorCode::PermissionDenied);
    assert_eq!(quicksign::load(&d, &s.id, Some("tajne hasło")).unwrap(), png());
    assert!(quicksign::delete(&d, &s.id, Some("nope")).is_err(), "can't delete without the password");
    quicksign::delete(&d, &s.id, Some("tajne hasło")).unwrap();
    assert!(quicksign::list(&d).is_empty());
}

#[test]
fn bad_input_is_refused() {
    let d = dir("bad");
    assert!(quicksign::save(&d, "x", b"GIF89a....", None).is_err(), "only PNG is stored");
    assert!(quicksign::save(&d, "x", &png(), Some("abc")).is_err(), "too-short password");
    assert!(quicksign::load(&d, "../../etc/passwd", None).is_err(), "ids can't escape the folder");
}
