//! Reading signatures back: details, box position, and tamper detection.

use lopdf::Document as PdfDoc;
use stitchup_core::docops::new_blank;
use stitchup_core::sigcheck::signatures;
use stitchup_core::sign::{sign_bytes, sign_document, SignSpec};

fn spec(name: &str, visible: bool) -> SignSpec {
    SignSpec {
        name: name.into(),
        reason: "Zatwierdzam".into(),
        location: "Łódź".into(),
        contact: String::new(),
        page: Some(1),
        rect: visible.then_some([350.0, 40.0, 570.0, 110.0]),
    }
}

fn signed(name: &str, visible: bool) -> Vec<u8> {
    let doc: PdfDoc = new_blank(595.0, 842.0).unwrap();
    sign_document(&doc, &spec(name, visible)).unwrap()
}

#[test]
fn a_fresh_signature_is_valid_with_its_details_and_box() {
    let s = signatures(&signed("Jan Kowalski", true));
    assert_eq!(s.len(), 1);
    let g = &s[0];
    assert_eq!((g.name.as_str(), g.reason.as_str(), g.location.as_str()), ("Jan Kowalski", "Zatwierdzam", "Łódź"));
    assert_eq!(g.status, "valid", "{}", g.detail);
    assert!(g.self_signed);
    assert!(g.subject.contains("Jan Kowalski"), "{}", g.subject);
    assert_eq!(g.page, Some(1));
    let r = g.rect.unwrap();
    assert!((r[0] - 350.0).abs() < 0.01 && (r[3] - 110.0).abs() < 0.01, "{r:?}");
    assert!(g.date.ends_with("UTC") && g.date.len() >= 16, "{}", g.date);
    // Invisible: no box.
    let s = signatures(&signed("Anna", false));
    assert_eq!((s[0].page, s[0].rect, s[0].status.as_str()), (None, None, "valid"));
}

#[test]
fn tampering_and_later_changes_are_reported() {
    let mut b = signed("Jan Kowalski", true);
    // Change one byte inside the signed part (the page count digit area of the first object).
    let at = b.windows(6).position(|w| w == b"/Pages").unwrap();
    b[at + 1] = b'p';
    assert_eq!(signatures(&b)[0].status, "invalid");

    // A valid signature followed by an appended update: still valid, but "changed".
    let mut b = signed("Jan Kowalski", true);
    b.extend_from_slice(b"\n% appended later\n");
    assert_eq!(signatures(&b)[0].status, "changed");

    // Two signatures: the first is "changed" (the second came after), the second "valid".
    let first = signed("Jan Kowalski", false);
    let both = sign_bytes(first, &spec("Anna Nowak", true)).unwrap();
    let s = signatures(&both);
    assert_eq!(s.len(), 2);
    let get = |n: &str| s.iter().find(|x| x.name == n).unwrap().status.clone();
    assert_eq!(get("Jan Kowalski"), "changed");
    assert_eq!(get("Anna Nowak"), "valid");
}

#[test]
fn unsigned_or_broken_files_give_nothing() {
    let doc: PdfDoc = new_blank(595.0, 842.0).unwrap();
    let mut b = Vec::new();
    doc.clone().save_to(&mut b).unwrap();
    assert!(signatures(&b).is_empty());
    assert!(signatures(b"not a pdf").is_empty());
}
